import { ReactNode, useEffect, useState } from 'react'
import { monaco } from './monaco-setup'
import { expectsServer, outlineSymbols } from './lspClient'

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const dirName = (p: string): string => {
  const parts = p.split(/[\\/]/)
  parts.pop()
  return parts.slice(-2).join('/')
}
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

// A collapsible part of the Explorer. Open or closed is remembered.
export function Section({ id, title, count, actions, children, grow }: { id: string; title: string; count?: number; actions?: ReactNode; children: ReactNode; grow?: boolean }): JSX.Element {
  const key = 'ex-open-' + id
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) !== '0'
    } catch {
      return true
    }
  })
  const toggle = (): void => {
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? '0' : '1')
      } catch {
        // not remembered
      }
      return !o
    })
  }
  return (
    <section className={'ex-section' + (open ? ' open' : '') + (grow ? ' grow' : '')} data-ex-section={id} aria-label={title}>
      <div className="ex-head">
        <button className="ex-toggle" aria-expanded={open} onClick={toggle} data-ex-toggle={id}>
          <span className={'ex-chevron' + (open ? ' open' : '')}>▸</span>
          <span className="ex-title">{title}</span>
          {count !== undefined && <span className="ex-count">{count}</span>}
        </button>
        {open && actions && <span className="ex-actions">{actions}</span>}
      </div>
      {open && <div className="ex-body">{children}</div>}
    </section>
  )
}

// ---- Open Editors ----

export function OpenEditors({
  tabs,
  active,
  onActivate,
  onClose,
  onSaveAll,
  onCloseAll
}: {
  tabs: { path: string; dirty: boolean }[]
  active: string | null
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onSaveAll: () => void
  onCloseAll: () => void
}): JSX.Element | null {
  if (tabs.length === 0) return null
  const dirty = tabs.filter((t) => t.dirty).length
  return (
    <Section
      id="open-editors"
      title="Open Editors"
      count={dirty || undefined}
      actions={
        <>
          <button className="ex-act" title="Save all" aria-label="Save all" onClick={onSaveAll}>
            ⤓
          </button>
          <button className="ex-act" title="Close all editors" aria-label="Close all editors" onClick={onCloseAll}>
            ✕
          </button>
        </>
      }
    >
      <div role="listbox" aria-label="Open editors">
        {tabs.map((t) => (
          <div
            key={t.path}
            role="option"
            aria-selected={t.path === active}
            tabIndex={0}
            className={'oe-row' + (t.path === active ? ' on' : '')}
            data-oe-path={t.path}
            title={t.path}
            onClick={() => onActivate(t.path)}
            onKeyDown={(e) => e.key === 'Enter' && onActivate(t.path)}
          >
            <span className="oe-name">{baseName(t.path)}</span>
            <span className="oe-dir">{dirName(t.path)}</span>
            <span
              className={'oe-close' + (t.dirty ? ' dirty' : '')}
              title={t.dirty ? 'Unsaved changes: close' : 'Close'}
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.path)
              }}
            >
              {t.dirty ? '●' : '×'}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ---- Outline: the symbols of the open file ----

interface Sym {
  name: string
  kind: string
  line: number
  depth: number
}

const KIND_ICON: Record<string, string> = { class: 'C', interface: 'I', function: 'ƒ', method: 'ƒ', property: 'p', const: 'c', var: 'v', let: 'v', enum: 'E', module: 'M', type: 'T', constructor: 'ƒ', getter: 'p', setter: 'p', heading: '#', struct: 'S' }

interface NavItem {
  text: string
  kind: string
  spans: { start: number; length: number }[]
  childItems?: NavItem[]
}

async function tsSymbols(model: monaco.editor.ITextModel): Promise<Sym[]> {
  const lang = model.getLanguageId()
  const getWorker = lang === 'typescript' ? monaco.languages.typescript.getTypeScriptWorker : monaco.languages.typescript.getJavaScriptWorker
  const worker = await getWorker()
  const client = (await worker(model.uri)) as unknown as { getNavigationBarItems(file: string): Promise<NavItem[]> }
  const items = await client.getNavigationBarItems(model.uri.toString())
  const out: Sym[] = []
  const walk = (list: NavItem[], depth: number): void => {
    for (const it of list) {
      const span = it.spans?.[0]
      const isRoot = it.text === '<global>' || /^".*"$/.test(it.text) || it.kind === 'script'
      if (span && !isRoot) out.push({ name: it.text, kind: it.kind, line: model.getPositionAt(span.start).lineNumber, depth })
      if (it.childItems?.length) walk(it.childItems, isRoot ? depth : depth + 1)
    }
  }
  walk(items, 0)
  return out
}

// Other languages: headings in Markdown, and lines that look like a declaration elsewhere.
function patternSymbols(model: monaco.editor.ITextModel): Sym[] {
  const out: Sym[] = []
  const lang = model.getLanguageId()
  const decl = /^\s*(?:export\s+|pub\s+|public\s+|private\s+|static\s+|async\s+)*(class|interface|struct|enum|trait|type|func|fn|def|function|module|impl)\s+([A-Za-z_][\w.<>]*)/
  const max = Math.min(model.getLineCount(), 5000)
  for (let n = 1; n <= max && out.length < 400; n++) {
    const line = model.getLineContent(n)
    if (lang === 'markdown') {
      const m = /^(#{1,6})\s+(.+)$/.exec(line)
      if (m) out.push({ name: m[2].trim(), kind: 'heading', line: n, depth: m[1].length - 1 })
    } else {
      const m = decl.exec(line)
      if (m) out.push({ name: m[2], kind: m[1] === 'def' || m[1] === 'func' || m[1] === 'fn' ? 'function' : m[1], line: n, depth: /^\s/.test(line) ? 1 : 0 })
    }
  }
  return out
}

export function Outline({ model, onReveal }: { model: monaco.editor.ITextModel | null; onReveal: (line: number) => void }): JSX.Element {
  const [syms, setSyms] = useState<Sym[]>([])
  const [note, setNote] = useState('')
  useEffect(() => {
    if (!model || model.isDisposed()) {
      setSyms([])
      setNote('No file is open.')
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let retries = 0
    const gone = (): boolean => cancelled || model.isDisposed() // the file was closed, or another folder opened, meanwhile
    const compute = async (): Promise<void> => {
      if (gone()) return
      try {
        let list: Sym[] = (await outlineSymbols(model).catch(() => null)) ?? [] // a language server, when there is one
        const fromServer = list.length > 0
        if (gone()) return
        if (!list.length) {
          try {
            const lang = model.getLanguageId()
            list = lang === 'typescript' || lang === 'javascript' ? await tsSymbols(model) : patternSymbols(model)
          } catch {
            list = []
          }
        }
        if (gone()) return
        // The language service may not know the file yet (or is not up): the declarations found by pattern are better than nothing.
        if (!list.length) list = patternSymbols(model)
        setSyms(list)
        setNote(list.length ? '' : 'No symbols were found in this file.')
        // Nothing yet, or only the pattern guess while a language server is still starting: look again shortly.
        if ((!list.length || (!fromServer && expectsServer(model))) && retries++ < (expectsServer(model) ? 12 : 3)) timer = setTimeout(() => void compute(), 2500)
      } catch {
        // the model went away while it was being read
      }
    }
    void compute()
    const sub = model.onDidChangeContent(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void compute(), 600)
    })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      sub.dispose()
    }
  }, [model])
  return (
    <Section id="outline" title="Outline" count={syms.length || undefined}>
      <div role="list" aria-label="Symbols">
        {syms.map((s, i) => (
          <div
            key={i}
            role="listitem"
            tabIndex={0}
            className="ol-row"
            data-outline-row
            style={{ paddingLeft: 12 + s.depth * 12 }}
            onClick={() => onReveal(s.line)}
            onKeyDown={(e) => e.key === 'Enter' && onReveal(s.line)}
          >
            <span className={'ol-icon ol-' + s.kind}>{KIND_ICON[s.kind] ?? '·'}</span>
            <span className="ol-name">{s.name}</span>
            <span className="ol-line">{s.line}</span>
          </div>
        ))}
        {note && <div className="ex-empty">{note}</div>}
      </div>
    </Section>
  )
}

// ---- Timeline: the commits that changed the open file ----

interface Commit {
  hash: string
  short: string
  author: string
  date: number
  subject: string
}

const ago = (ms: number): string => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]
  for (const [n, name] of units) if (s >= n) return `${Math.floor(s / n)} ${name}${Math.floor(s / n) === 1 ? '' : 's'} ago`
  return 'just now'
}

export function Timeline({ roots, file, refreshKey, onOpen }: { roots: string[]; file: string | null; refreshKey: string; onOpen: (abs: string) => void }): JSX.Element {
  const [commits, setCommits] = useState<Commit[]>([])
  const [note, setNote] = useState('')
  useEffect(() => {
    setCommits([])
    if (!file) return setNote('No file is open.')
    const root = roots.find((r) => norm(file).startsWith(norm(r) + '/'))
    if (!root) return setNote('This file is outside the open folders.')
    const rel = file.replace(/\\/g, '/').slice(root.length + 1)
    let cancelled = false
    setNote('Loading…')
    void window.api
      .gitLog(root, rel, 0, 20)
      .then((r) => {
        if (cancelled) return
        if (!r.ok) return setNote('No history: this folder is not in a Git repository.')
        setCommits(r.commits)
        setNote(r.commits.length ? '' : 'This file has no commits yet.')
      })
      .catch(() => !cancelled && setNote('No history is available.'))
    return () => {
      cancelled = true
    }
  }, [file, roots, refreshKey])
  return (
    <Section id="timeline" title="Timeline" count={commits.length || undefined}>
      <div role="list" aria-label="Commits that changed this file">
        {commits.map((c) => (
          <div key={c.hash} role="listitem" tabIndex={0} className="tl-row" data-timeline-row title={`${c.short} · ${c.author}`} onClick={() => file && onOpen(file)} onKeyDown={(e) => e.key === 'Enter' && file && onOpen(file)}>
            <span className="tl-subject">{c.subject}</span>
            <span className="tl-meta">
              {c.author} · {ago(c.date)}
            </span>
          </div>
        ))}
        {note && <div className="ex-empty">{note}</div>}
      </div>
    </Section>
  )
}
