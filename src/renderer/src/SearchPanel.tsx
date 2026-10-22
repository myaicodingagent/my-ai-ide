import { useEffect, useRef, useState } from 'react'
import { announce } from './a11y'

interface Match {
  path: string
  rel: string
  line: number
  text: string
}

interface UsedSearch {
  query: string
  caseSensitive: boolean
  regex: boolean
}

type Note = { kind: 'ok' | 'error'; text: string } | null

interface SemanticHit {
  root: string
  rel: string
  abs: string
  start: number
  end: number
  text: string
}
interface SemanticState {
  hits: SemanticHit[]
  expanded: string[] | null
  reranked: boolean
  indexed: { files: number; chunks: number }
  meaning: { used: boolean; state: string; done: number; total: number; error?: string } | null
}

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
const inside = (root: string, p: string): boolean => norm(p).startsWith(norm(root).replace(/\/$/, '') + '/')
const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export function SearchPanel({
  roots,
  focusSignal,
  onOpen,
  isDirty,
  onReplaced
}: {
  // The workspace folders (the first is the main one).
  roots: string[]
  // Changes each time the panel should grab keyboard focus (e.g. after Ctrl+Shift+F).
  focusSignal: number
  onOpen: (path: string, line: number) => void
  // True if the file has unsaved edits in the editor (such files are never replaced in behind your back).
  isDirty: (absPath: string) => boolean
  // Called after files were rewritten on disk, so open tabs and the tree can refresh.
  onReplaced: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [matches, setMatches] = useState<Match[]>([])
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  // "Ask the codebase": search by meaning instead of by the exact text.
  const [semantic, setSemantic] = useState(false)
  const [sem, setSem] = useState<SemanticState | null>(null)
  const root = roots[0] ?? null
  // What the results on screen were searched with. A replace must use this, not whatever is typed now.
  const used = useRef<UsedSearch | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const runId = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  const runSemantic = async (): Promise<void> => {
    if (!root || !query.trim()) return
    const id = ++runId.current
    setBusy(true)
    setNote(null)
    const res = await window.api.indexSearch(roots, query, { limit: 15 })
    if (id !== runId.current) return
    setSem(res.ok ? { hits: res.hits, expanded: res.expanded, reranked: res.reranked, indexed: res.indexed, meaning: res.semantic ? { used: res.semantic.used, state: res.semantic.model.state, done: res.semantic.done, total: res.semantic.total, error: res.semantic.error } : null } : null)
    announce(res.ok ? `${res.hits.length} matching place${res.hits.length === 1 ? '' : 's'} found` : 'The search failed', res.ok ? 'polite' : 'assertive')
    setError(res.ok ? null : (res.error ?? 'The search failed.'))
    setSearched(true)
    setBusy(false)
  }

  const run = async (keepNote = false): Promise<void> => {
    if (semantic) return runSemantic()
    if (!root || !query) return
    const id = ++runId.current
    setBusy(true)
    if (!keepNote) setNote(null)
    const results = await Promise.all(roots.map((r) => window.api.searchText(r, query, { caseSensitive, regex })))
    if (id !== runId.current) return // a newer search superseded this one
    used.current = { query, caseSensitive, regex }
    // With several folders each file shows the folder it is in.
    const all = results.flatMap((res, i) => res.matches.map((m) => (roots.length > 1 ? { ...m, rel: folderName(roots[i]) + '/' + m.rel } : m)))
    setMatches(all.slice(0, 500))
    announce(all.length === 0 ? 'No results' : `${Math.min(all.length, 500)} result${all.length === 1 ? '' : 's'} in ${new Set(all.map((m) => m.path)).size} file${new Set(all.map((m) => m.path)).size === 1 ? '' : 's'}`)
    setTruncated(results.some((res) => res.truncated) || all.length > 500)
    setError(results.find((res) => res.error)?.error ?? null)
    setSearched(true)
    setBusy(false)
  }

  // Group by file, keeping the order files were found in.
  const groups: { rel: string; path: string; items: Match[] }[] = []
  for (const m of matches) {
    const last = groups[groups.length - 1]
    if (last && last.path === m.path) last.items.push(m)
    else groups.push({ rel: m.rel, path: m.path, items: [m] })
  }

  const apply = async (targets: { path: string; lines: number[] }[]): Promise<void> => {
    const u = used.current
    if (!root || !u) return
    const editable = targets.filter((t) => !isDirty(t.path))
    const dirty = targets.filter((t) => isDirty(t.path))
    const names = dirty.map((t) => t.path.split(/[\\/]/).pop()).join(', ')
    if (editable.length === 0) {
      return setNote({ kind: 'error', text: `Not replaced: ${names} has unsaved changes in the editor. Save it first.` })
    }
    const lineCount = editable.reduce((n, t) => n + t.lines.length, 0)
    const what = replacement === '' ? 'delete it' : `replace it with "${replacement}"`
    const limited = truncated && targets.length > 1 ? '\n\nThe results were limited to the first 500 lines, so only those are changed.' : ''
    if (!window.confirm(`Search for "${u.query}" and ${what} on ${lineCount} line(s) in ${editable.length} file(s)?${limited}`)) return
    // Each folder rewrites its own files.
    let replaced = 0
    let files = 0
    const skippedByFolder: string[] = []
    for (const r of roots) {
      const mine = editable.filter((t) => inside(r, t.path))
      if (mine.length === 0) continue
      const res = await window.api.fsReplace(r, u.query, replacement, { caseSensitive: u.caseSensitive, regex: u.regex }, mine)
      if (!res.ok) return setNote({ kind: 'error', text: res.error })
      replaced += res.replaced
      files += res.files
      skippedByFolder.push(...res.skipped)
    }
    const skipped = [...(dirty.length ? [`${names} (unsaved changes)`] : []), ...skippedByFolder]
    setNote({
      kind: skipped.length ? 'error' : 'ok',
      text: `Replaced ${replaced} occurrence(s) in ${files} file(s).` + (skipped.length ? ` Skipped: ${skipped.join('; ')}` : '')
    })
    onReplaced()
    await run(true)
  }

  const replaceAll = (): Promise<void> => apply(groups.map((g) => ({ path: g.path, lines: g.items.map((m) => m.line) })))

  return (
    <div className="search">
      <div className="search-box">
        <button
          className={'search-toggle' + (showReplace ? ' on' : '')}
          data-search-action="toggle-replace"
          title="Toggle Replace"
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? '▾' : '▸'}
        </button>
        <input
          ref={inputRef}
          value={query}
          placeholder={semantic ? 'Ask about the code, e.g. where are users logged in? (Enter)' : 'Search (Enter)'}
          data-search-query
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run()}
        />
        <button
          className={semantic ? 'on' : ''}
          data-search-semantic
          title="Search by meaning: describe what you are looking for in plain words"
          onClick={() => {
            setSemantic((v) => !v)
            setSearched(false)
            setError(null)
            setShowReplace(false)
          }}
        >
          ✦
        </button>
        {!semantic && (
          <>
            <button
              className={caseSensitive ? 'on' : ''}
              title="Match case"
              onClick={() => setCaseSensitive((v) => !v)}
            >
              Aa
            </button>
            <button className={regex ? 'on' : ''} title="Use regular expression" onClick={() => setRegex((v) => !v)}>
              .*
            </button>
          </>
        )}
      </div>
      {showReplace && !semantic && (
        <div className="search-box search-replace">
          <input
            value={replacement}
            placeholder={regex ? 'Replace (use $1, $& for groups)' : 'Replace'}
            data-search-replace
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void replaceAll()}
          />
          <button
            className="search-replace-all"
            data-search-action="replace-all"
            title="Replace in every file listed below"
            disabled={matches.length === 0}
            onClick={() => void replaceAll()}
          >
            Replace All
          </button>
        </div>
      )}
      <div className="search-results">
        {!root && <div className="empty">Open a folder to search.</div>}
        {busy && <div className="empty">Searching…</div>}
        {error && <div className="chat-error search-msg">{error}</div>}
        {note && (
          <div className={'search-note ' + note.kind} data-search-note>
            {note.text}
          </div>
        )}
        {semantic && !busy && sem && (
          <div className="search-sem" data-search-sem>
            <div className="search-sem-info" data-search-sem-info>
              {sem.indexed.files} files indexed
              {sem.expanded && sem.expanded.length > 0 && <> · also looked for: {sem.expanded.slice(0, 6).join(', ')}</>}
              {sem.reranked && <> · ordered by Claude</>}
              {sem.meaning?.used && <> · matched by meaning</>}
            </div>
            {sem.meaning && !sem.meaning.error && sem.meaning.done < sem.meaning.total && (
              <div className="search-note info" data-search-meaning="indexing">
                Learning your code's meaning: {sem.meaning.done} of {sem.meaning.total} pieces. Search again in a moment for fuller results.
              </div>
            )}
            {sem.meaning?.error && (
              <div className="search-note error" data-search-meaning="error">
                Matching by meaning is not available ({sem.meaning.error}). Results use words only.
              </div>
            )}
            {sem.hits.length === 0 && <div className="empty">Nothing relevant found.</div>}
            {sem.hits.map((h) => (
              <div key={h.abs + ':' + h.start} className="search-sem-hit" data-sem-hit={h.rel} onClick={() => onOpen(h.abs, h.start)}>
                <div className="search-sem-file">
                  {(roots.length > 1 ? folderName(h.root) + '/' : '') + h.rel} <span className="qp-detail">{h.start}-{h.end}</span>
                </div>
                <pre className="search-sem-code">{h.text.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n')}</pre>
              </div>
            ))}
          </div>
        )}
        {!semantic && !busy && !error && searched && matches.length === 0 && <div className="empty">No results.</div>}
        {!semantic &&
          !busy &&
          groups.map((g) => (
            <div key={g.path}>
              <div className="search-file">
                <span className="search-file-name">
                  {g.rel} <span className="qp-detail">{g.items.length}</span>
                </span>
                {showReplace && (
                  <button
                    className="search-row-btn"
                    data-search-action="replace-file"
                    title="Replace in this file"
                    onClick={() => void apply([{ path: g.path, lines: g.items.map((m) => m.line) }])}
                  >
                    Replace
                  </button>
                )}
              </div>
              {g.items.map((m) => (
                <div key={m.line} className="search-hit" onClick={() => onOpen(m.path, m.line)}>
                  <span className="search-line">{m.line}</span>
                  <span className="search-hit-text">{m.text}</span>
                  {showReplace && (
                    <button
                      className="search-row-btn"
                      data-search-action="replace-line"
                      title="Replace on this line"
                      onClick={(e) => {
                        e.stopPropagation()
                        void apply([{ path: m.path, lines: [m.line] }])
                      }}
                    >
                      Replace
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        {!semantic && truncated && !busy && (
          <div className="empty">Showing the first {matches.length} results. Narrow the search to see others.</div>
        )}
      </div>
    </div>
  )
}
