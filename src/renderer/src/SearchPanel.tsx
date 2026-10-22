import { useEffect, useRef, useState } from 'react'

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

export function SearchPanel({
  root,
  focusSignal,
  onOpen,
  isDirty,
  onReplaced
}: {
  root: string | null
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
  // What the results on screen were searched with. A replace must use this, not whatever is typed now.
  const used = useRef<UsedSearch | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const runId = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  const run = async (keepNote = false): Promise<void> => {
    if (!root || !query) return
    const id = ++runId.current
    setBusy(true)
    if (!keepNote) setNote(null)
    const res = await window.api.searchText(root, query, { caseSensitive, regex })
    if (id !== runId.current) return // a newer search superseded this one
    used.current = { query, caseSensitive, regex }
    setMatches(res.matches)
    setTruncated(res.truncated)
    setError(res.error ?? null)
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
    const res = await window.api.fsReplace(root, u.query, replacement, { caseSensitive: u.caseSensitive, regex: u.regex }, editable)
    if (!res.ok) return setNote({ kind: 'error', text: res.error })
    const skipped = [...(dirty.length ? [`${names} (unsaved changes)`] : []), ...res.skipped]
    setNote({
      kind: skipped.length ? 'error' : 'ok',
      text: `Replaced ${res.replaced} occurrence(s) in ${res.files} file(s).` + (skipped.length ? ` Skipped: ${skipped.join('; ')}` : '')
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
          placeholder="Search (Enter)"
          data-search-query
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run()}
        />
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
      </div>
      {showReplace && (
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
        {!busy && !error && searched && matches.length === 0 && <div className="empty">No results.</div>}
        {!busy &&
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
        {truncated && !busy && (
          <div className="empty">Showing the first {matches.length} results. Narrow the search to see others.</div>
        )}
      </div>
    </div>
  )
}
