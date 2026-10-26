import * as Y from 'yjs'
import { useSyncExternalStore } from 'react'
import { monaco } from './monaco-setup'
import { announce } from './a11y'

// Live Share, the editor's side (the transport and the file server are in src/main/liveshare.ts).
//
// Every shared file has one Yjs document (a CRDT, so two people typing at the same place or at the same time end up with the same
// text). The text of an open editor model is bound to it in both directions:
//   model changes  ->  changes of the Y.Text      (origin 'local', and only these are sent)
//   Y.Text changes ->  edits of the model         (when they came from somebody else)
// The host holds the first copy of each document (from its open editor, else from disk) and gives a guest the state when the guest
// opens the file; after that both send each other the updates. Cursors and selections travel as plain offsets.

export interface Peer {
  id: string
  name: string
}
export interface SharedTerm {
  id: number // the host's terminal id
  title: string
  write: boolean // guests may type in it
  cols: number
  rows: number
}
export interface LiveState {
  role: 'none' | 'host' | 'guest'
  readOnly: boolean
  peers: Peer[]
  sid: string
  join: string // the code to give to guests (host only)
  me: string
  message: string // why a session ended, when it was not by choice
  terms: SharedTerm[] // terminals the host shares
}

const NONE: LiveState = { role: 'none', readOnly: false, peers: [], sid: '', join: '', me: '', message: '', terms: [] }
let state: LiveState = NONE
const listeners = new Set<() => void>()
const emit = (next: Partial<LiveState>): void => {
  state = { ...state, ...next }
  for (const l of listeners) l()
}
export const useLiveShare = (): LiveState => useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => state)
export const getLiveShare = (): LiveState => state

let hostRoot: string | null = null
let started = false
let closedCb: ((reason: string) => void) | null = null
export const onLiveShareClosed = (cb: (reason: string) => void): void => void (closedCb = cb)

// ---- documents ----

interface Shared {
  rel: string
  ydoc: Y.Doc
  ytext: Y.Text
  model: monaco.editor.ITextModel | null
  ready: boolean // a guest has the host's state; the host's is ready as soon as it exists
  applying: boolean // the model is being changed by us (not by the person typing)
  subs: monaco.IDisposable[]
}
const docs = new Map<string, Shared>()
const keyOf = (rel: string): string => rel.toLowerCase()

const toB64 = (u: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const send = (msg: Record<string, unknown>): void => void window.api.lsSend(msg)

/** The shared-folder-relative path (`src/a.ts`) of a file, or null if it is not part of the session. */
function relOf(path: string): string | null {
  if (state.role === 'guest') {
    const m = /^\\\\liveshare\.[0-9a-f]{6}(\\.*)?$/i.exec(path)
    return m ? (m[1] ?? '').replace(/\\/g, '/').replace(/^\/+/, '') || null : null
  }
  if (state.role === 'host' && hostRoot) {
    const a = path.replace(/\\/g, '/'), r = hostRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    return a.toLowerCase().startsWith(r.toLowerCase() + '/') ? a.slice(r.length + 1) : null
  }
  return null
}
const absOf = (rel: string): string => (hostRoot ?? '').replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\')

function applyDelta(model: monaco.editor.ITextModel, delta: { insert?: unknown; delete?: number; retain?: number }[]): void {
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = []
  let idx = 0
  for (const op of delta) {
    if (op.retain !== undefined) idx += op.retain
    else if (op.insert !== undefined) {
      const p = model.getPositionAt(idx)
      edits.push({ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text: String(op.insert), forceMoveMarkers: true })
    } else if (op.delete !== undefined) {
      edits.push({ range: monaco.Range.fromPositions(model.getPositionAt(idx), model.getPositionAt(idx + op.delete)), text: '' })
      idx += op.delete
    }
  }
  if (edits.length) model.applyEdits(edits)
}

function makeDoc(rel: string, initial: string | null): Shared {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('t')
  const d: Shared = { rel, ydoc, ytext, model: null, ready: initial !== null, applying: false, subs: [] }
  if (initial !== null) ydoc.transact(() => ytext.insert(0, initial), 'init')
  ytext.observe((ev, tr) => {
    if (tr.origin === 'local' || tr.origin === 'init' || !d.model || !d.ready) return
    d.applying = true
    try {
      applyDelta(d.model, ev.delta as never)
    } finally {
      d.applying = false
    }
  })
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'local') send({ t: 'doc-update', rel, update: toB64(update) })
  })
  docs.set(keyOf(rel), d)
  return d
}

/** Binds an editor model to the shared document of its file (and starts the document if this side has the first copy). */
async function attach(model: monaco.editor.ITextModel): Promise<void> {
  if (state.role === 'none' || model.uri.scheme !== 'file') return
  const rel = relOf(model.uri.fsPath)
  if (!rel) return
  let d = docs.get(keyOf(rel))
  if (d?.model === model) return
  if (state.role === 'host') {
    // The host's copy: what is already there from a guest's edits, else the text of this editor.
    d ??= makeDoc(rel, model.getValue())
    d.model = model
    if (d.ytext.toString() !== model.getValue()) setModelText(d, d.ytext.toString())
  } else {
    d ??= makeDoc(rel, null)
    d.model = model
    if (!d.ready) send({ t: 'doc-open', rel })
  }
  bindLocal(d, model)
}

function setModelText(d: Shared, text: string): void {
  if (!d.model || d.model.getValue() === text) return
  d.applying = true
  try {
    d.model.setValue(text)
  } finally {
    d.applying = false
  }
}

function bindLocal(d: Shared, model: monaco.editor.ITextModel): void {
  d.subs.forEach((s) => s.dispose())
  d.subs = [
    model.onDidChangeContent((e) => {
      if (d.applying || !d.ready || (state.role === 'guest' && state.readOnly)) return
      d.ydoc.transact(() => {
        for (const c of [...e.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
          if (c.rangeLength) d.ytext.delete(c.rangeOffset, c.rangeLength)
          if (c.text) d.ytext.insert(c.rangeOffset, c.text)
        }
      }, 'local')
    }),
    model.onWillDispose(() => {
      d.subs.forEach((s) => s.dispose())
      d.subs = []
      d.model = null
      if (state.role === 'guest') docs.delete(keyOf(d.rel))
      clearCursorsOf(d.rel)
    })
  ]
}

// ---- cursors ----

interface Cursor {
  rel: string
  start: number
  end: number
  name: string
}
const cursors = new Map<string, Cursor>() // peer id -> where they are
const decorations = new Map<string, { model: monaco.editor.ITextModel; ids: string[] }>()
const COLORS = ['#e06c75', '#61afef', '#98c379', '#d19a66', '#c678dd', '#56b6c2', '#e5c07b', '#be5046']
const colorOf = (id: string): string => COLORS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length]
let styleEl: HTMLStyleElement | null = null
const styled = new Set<string>()
function ensureStyle(id: string, name: string): void {
  if (styled.has(id + name)) return
  styled.add(id + name)
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'ls-peer-styles'
    document.head.appendChild(styleEl)
  }
  const c = colorOf(id)
  const cls = `ls-${id.replace(/[^a-z0-9]/gi, '')}`
  styleEl.textContent += `.${cls}-caret{border-left:2px solid ${c};margin-left:-1px}.${cls}-caret::after{content:${JSON.stringify(name)};position:absolute;transform:translateY(-100%);background:${c};color:#111;font-size:10px;line-height:12px;padding:0 3px;border-radius:2px;white-space:nowrap;pointer-events:none}.${cls}-sel{background:${c}44}`
}
function drawCursor(id: string): void {
  const c = cursors.get(id)
  const old = decorations.get(id)
  const d = c ? docs.get(keyOf(c.rel)) : undefined
  if (old && (!d || d.model !== old.model)) {
    if (!old.model.isDisposed()) old.model.deltaDecorations(old.ids, [])
    decorations.delete(id)
  }
  if (!c || !d?.model || d.model.isDisposed()) return
  ensureStyle(id, c.name)
  const cls = `ls-${id.replace(/[^a-z0-9]/gi, '')}`
  const m = d.model
  const a = m.getPositionAt(Math.min(c.start, c.end)), b = m.getPositionAt(Math.max(c.start, c.end)), caret = m.getPositionAt(c.end)
  const ids = m.deltaDecorations(decorations.get(id)?.ids ?? [], [
    { range: new monaco.Range(caret.lineNumber, caret.column, caret.lineNumber, caret.column), options: { beforeContentClassName: `${cls}-caret`, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } },
    ...(c.start !== c.end ? [{ range: monaco.Range.fromPositions(a, b), options: { className: `${cls}-sel` } }] : [])
  ])
  decorations.set(id, { model: m, ids })
}
function clearCursorsOf(rel: string): void {
  for (const [id, c] of cursors) if (keyOf(c.rel) === keyOf(rel)) drawCursor(id)
}
function forgetPeer(id: string): void {
  cursors.delete(id)
  const old = decorations.get(id)
  if (old && !old.model.isDisposed()) old.model.deltaDecorations(old.ids, [])
  decorations.delete(id)
}

let cursorTimer: ReturnType<typeof setTimeout> | null = null
function watchEditor(ed: monaco.editor.ICodeEditor): void {
  // A guest of a read-only session can look but not type.
  ed.onDidChangeModel(() => {
    const m = ed.getModel()
    if (state.role === 'guest' && state.readOnly && m && relOf(m.uri.fsPath)) ed.updateOptions({ readOnly: true })
  })
  ed.onDidChangeCursorSelection((e) => {
    const model = ed.getModel()
    if (state.role === 'none' || !model) return
    const rel = relOf(model.uri.fsPath)
    if (!rel) return
    if (cursorTimer) clearTimeout(cursorTimer)
    cursorTimer = setTimeout(() => {
      const me = state.peers.find((p) => p.id === state.me)
      send({ t: 'cursor', rel, name: me?.name ?? 'Guest', start: model.getOffsetAt(e.selection.getSelectionStart()), end: model.getOffsetAt(e.selection.getPosition()) })
    }, 60)
  })
}

// ---- shared terminals ----
// The host chooses a terminal to share. Its output goes to the guests as it comes (and the last part of it to a guest who opens it
// later); a guest sees it in a tab next to the terminals, sized like the host's. Typing is only possible where the host allowed it.

const SNAPSHOT = 200_000
const hostTerms = new Map<number, { info: SharedTerm; buf: string; total: number; pending: string; timer: ReturnType<typeof setTimeout> | null }>()
const publishTerms = (): void => {
  const terms = [...hostTerms.values()].map((t) => t.info)
  emit({ terms })
  void window.api.lsTerms(terms.map((t) => ({ id: t.id, write: t.write })))
  send({ t: 'terms', terms })
}

/** The host shares a terminal (`seed`: what it shows now, as plain text). */
export function shareTerminal(id: number, title: string, write: boolean, cols: number, rows: number, seed: string): boolean {
  if (state.role !== 'host') return false
  const buf = seed ? seed.replace(/\n/g, '\r\n') + '\r\n' : ''
  hostTerms.set(id, { info: { id, title, write: write && !state.readOnly, cols, rows }, buf, total: buf.length, pending: '', timer: null })
  publishTerms()
  return true
}
export function unshareTerminal(id: number): void {
  const t = hostTerms.get(id)
  if (!t) return
  if (t.timer) clearTimeout(t.timer)
  hostTerms.delete(id)
  publishTerms()
}
export const isTerminalShared = (id: number): boolean => hostTerms.has(id)

/** Output of one of the host's terminals; sent on to the guests when it is shared. */
export function feedTerminal(id: number, data: string): void {
  const t = hostTerms.get(id)
  if (!t) return
  t.buf = (t.buf + data).slice(-SNAPSHOT)
  t.total += data.length
  t.pending += data
  t.timer ??= setTimeout(() => {
    t.timer = null
    const chunk = t.pending
    t.pending = ''
    if (chunk) send({ t: 'term-data', tid: id, data: chunk, end: t.total })
  }, 16)
}
export function resizeSharedTerminal(id: number, cols: number, rows: number): void {
  const t = hostTerms.get(id)
  if (!t || (t.info.cols === cols && t.info.rows === rows)) return
  t.info = { ...t.info, cols, rows }
  publishTerms()
}

interface Watch {
  sink: (data: string) => void
  snap: boolean
  end: number // output up to here is written
  queued: { data: string; end: number }[]
}
const watching = new Map<number, Watch>()
/** A guest watches a shared terminal: `sink` gets its output, first what it showed before. Returns the way to stop. */
export function watchSharedTerminal(id: number, sink: (data: string) => void): () => void {
  watching.set(id, { sink, snap: false, end: 0, queued: [] })
  send({ t: 'term-open', tid: id })
  return () => void watching.delete(id)
}
export const sendTerminalInput = (id: number, data: string): void => send({ t: 'term-input', tid: id, data })

// ---- messages from the other side ----

async function onMessage(from: string, name: string | undefined, msg: Record<string, any>): Promise<void> {
  const rel = typeof msg.rel === 'string' ? msg.rel : ''
  if (msg.t === 'doc-open' && state.role === 'host') {
    let d = docs.get(keyOf(rel))
    if (!d) {
      // Not open in the host's editor: the file as it is on disk.
      const text = await window.api.readFile(absOf(rel)).catch(() => null)
      if (text === null) return
      d = docs.get(keyOf(rel)) ?? makeDoc(rel, text)
    }
    send({ t: 'doc-state', rel, to: from, update: toB64(Y.encodeStateAsUpdate(d.ydoc)) })
  } else if (msg.t === 'doc-state' && state.role === 'guest') {
    const d = docs.get(keyOf(rel))
    if (!d) return
    Y.applyUpdate(d.ydoc, fromB64(String(msg.update)), 'init')
    d.ready = true
    setModelText(d, d.ytext.toString())
  } else if (msg.t === 'doc-update') {
    const d = docs.get(keyOf(rel))
    if (!d) return // nobody here has this file open
    Y.applyUpdate(d.ydoc, fromB64(String(msg.update)), 'remote')
  } else if (msg.t === 'terms' && state.role === 'guest') {
    const terms = Array.isArray(msg.terms) ? (msg.terms as SharedTerm[]) : []
    if (state.terms.length > terms.length) announce('The host stopped sharing a terminal')
    emit({ terms })
  } else if (msg.t === 'term-open' && state.role === 'host') {
    const t = hostTerms.get(Number(msg.tid))
    if (t) send({ t: 'term-data', tid: t.info.id, data: t.buf, end: t.total, snap: true, to: from })
  } else if (msg.t === 'term-input' && state.role === 'host') {
    const t = hostTerms.get(Number(msg.tid))
    if (t?.info.write && typeof msg.data === 'string') window.api.termWrite(t.info.id, msg.data)
  } else if (msg.t === 'term-data' && state.role === 'guest') {
    const w = watching.get(Number(msg.tid))
    if (!w) return
    const data = String(msg.data ?? ''), end = Number(msg.end) || 0
    // Every piece says where the output stood after it; whatever the snapshot already has is not written twice.
    const write = (chunk: string, chunkEnd: number): void => {
      if (chunkEnd <= w.end) return
      const start = chunkEnd - chunk.length
      w.sink(start >= w.end ? chunk : chunk.slice(w.end - start))
      w.end = chunkEnd
    }
    if (msg.snap === true) {
      w.sink(data)
      w.end = end
      w.snap = true
      for (const q of w.queued) write(q.data, q.end)
      w.queued = []
    } else if (w.snap) write(data, end)
    else w.queued.push({ data, end })
  } else if (msg.t === 'cursor') {
    cursors.set(from, { rel, start: Number(msg.start) || 0, end: Number(msg.end) || 0, name: String(msg.name ?? name ?? 'Guest') })
    drawCursor(from)
  }
}

function reset(message: string): void {
  for (const d of docs.values()) {
    d.subs.forEach((s) => s.dispose())
    d.ydoc.destroy()
  }
  docs.clear()
  for (const id of [...cursors.keys()]) forgetPeer(id)
  hostRoot = null
  for (const t of hostTerms.values()) if (t.timer) clearTimeout(t.timer)
  hostTerms.clear()
  watching.clear()
  emit({ ...NONE, message })
}

/** Starts listening to the main process and to the editor's models; safe to call more than once. */
export function initLiveShare(): void {
  if (started) return
  started = true
  window.api.onLsEvent((e) => {
    if (e.type === 'peers') {
      // Who came and who went is only visible in the status bar and the cursors: say it.
      const was = state.peers, now = e.peers as Peer[]
      if (was.length) {
        for (const p of now) if (p.id !== state.me && !was.some((w) => w.id === p.id)) announce(`${p.name} joined the Live Share session`)
        for (const w of was) if (w.id !== state.me && !now.some((p) => p.id === w.id)) announce(`${w.name} left the Live Share session`)
      }
      emit({ peers: e.peers as Peer[] })
      if (state.role === 'host' && hostTerms.size) send({ t: 'terms', terms: [...hostTerms.values()].map((t) => t.info) }) // for whoever just came in
    }
    else if (e.type === 'gone') forgetPeer(String(e.id))
    else if (e.type === 'closed') {
      const had = state.role !== 'none'
      reset(String(e.reason ?? ''))
      if (had && e.reason) closedCb?.(String(e.reason))
    } else if (e.type === 'msg') void onMessage(String(e.from), e.name as string | undefined, e.msg as Record<string, any>)
  })
  monaco.editor.onDidCreateModel((m) => void attach(m))
  for (const ed of monaco.editor.getEditors()) watchEditor(ed)
  monaco.editor.onDidCreateEditor((ed) => watchEditor(ed))
}

// ---- commands ----

export async function startSession(root: string, opts: { readOnly: boolean; network: boolean; name?: string }): Promise<{ ok: true; join: string } | { ok: false; error: string }> {
  initLiveShare()
  const r = await window.api.lsHost({ root, ...opts })
  if (!r.ok) return r
  hostRoot = root
  const me = { id: 'host', name: opts.name || 'Host' }
  emit({ role: 'host', readOnly: opts.readOnly, sid: r.sid, join: r.join, me: 'host', peers: [me], message: '' })
  for (const m of monaco.editor.getModels()) void attach(m) // files that are open already are shared from now on
  return { ok: true, join: r.join }
}

export async function joinSession(code: string, name: string): Promise<{ ok: true; root: string; hostName: string } | { ok: false; error: string }> {
  initLiveShare()
  const r = await window.api.lsJoin(code, name)
  if (!r.ok) return r
  emit({ role: 'guest', readOnly: r.readOnly, sid: r.sid, join: '', me: r.id, peers: r.peers, message: '' })
  return { ok: true, root: r.root, hostName: r.hostName }
}

export async function endSession(): Promise<void> {
  await window.api.lsStop()
  reset('')
}
