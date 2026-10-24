import { useSyncExternalStore } from 'react'
import { monaco } from './monaco-setup'
import { getSettings, subscribeSettings } from './settings'
import { appendOutput } from './outputStore'

// The editor side of the Language Server Protocol. For a file in a language that has a server (Go, Python, Rust, C and
// C++), the server is started for the project folder, the file is kept in step with it, and the answers become what Monaco
// shows: errors in the Problems panel, completions, hovers, go to definition, references, symbols, signature help,
// formatting and rename. JavaScript and TypeScript keep using Monaco's own TypeScript service.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

export const LSP_CHANNEL = 'Language Servers'

interface Live {
  key: string
  server: string
  language: string
  label: string
  root: string // the folder as the editor spells it
  realRoot: string // as the operating system spells it (long names, real case): what servers insist on
  caps: Json
}

let getRoots: () => string[] = () => []
let openFileAt: (path: string, line: number, column: number) => void = () => undefined
let say: (text: string, kind?: string) => void = () => undefined

const languageOfEditor = new Map<string, string>() // editor language id -> server language
const started = new Map<string, Promise<Live | null>>() // language|root -> server
const liveByServer = new Map<string, Live>()
const modelServer = new Map<string, Live>() // model uri -> its server
const versions = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const warned = new Set<string>()
const ghosts = new Set<string>() // models made only so a result in another file can be shown
const registeredProviders = new Set<string>()

// ---- what is running, for the status bar ----

let status: { label: string; root: string }[] = []
const listeners = new Set<() => void>()
const emitStatus = (): void => {
  status = [...liveByServer.values()].map((l) => ({ label: l.label, root: l.root }))
  listeners.forEach((l) => l())
}
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export const useLspServers = (): { label: string; root: string }[] => useSyncExternalStore(subscribe, () => status)

// ---- conversions ----

const uriOf = (model: monaco.editor.ITextModel): string => model.uri.toString()
const norm = (p: string): string => p.split('\\').join('/').toLowerCase()
const toServerPath = (l: Live, p: string): string => (norm(p).startsWith(norm(l.root) + '/') ? l.realRoot + p.slice(l.root.length) : p)
const fromServerPath = (l: Live, p: string): string => (norm(p).startsWith(norm(l.realRoot) + '/') ? l.root + p.slice(l.realRoot.length) : p)
// The address a server knows a file by, and back to the editor's.
const sUri = (l: Live, model: monaco.editor.ITextModel): string => monaco.Uri.file(toServerPath(l, model.uri.fsPath)).toString()
const fromServerUri = (l: Live, uri: string): monaco.Uri => {
  const u = monaco.Uri.parse(uri)
  return u.scheme === 'file' ? monaco.Uri.file(fromServerPath(l, u.fsPath)) : u
}
const posOf = (p: monaco.IPosition): { line: number; character: number } => ({ line: p.lineNumber - 1, character: p.column - 1 })
const rangeOf = (r: Json): monaco.IRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 })

function rootFor(path: string): string {
  const norm = path.replace(/\\/g, '/').toLowerCase()
  const roots = getRoots().filter((r) => norm.startsWith(r.replace(/\\/g, '/').toLowerCase() + '/'))
  if (roots.length) return roots.sort((a, b) => b.length - a.length)[0]
  return path.replace(/[\\/][^\\/]*$/, '')
}

async function ask(l: Live, method: string, params: unknown): Promise<Json> {
  const r = await window.api.lspRequest(l.server, method, params)
  return r.ok ? r.result : null
}

// ---- keeping documents in step with the server ----

function sendFull(l: Live, model: monaco.editor.ITextModel): void {
  const id = uriOf(model)
  const v = (versions.get(id) ?? 0) + 1
  versions.set(id, v)
  void window.api.lspNotify(l.server, 'textDocument/didChange', { textDocument: { uri: sUri(l, model), version: v }, contentChanges: [{ text: model.getValue() }] })
}

// Sends a change that is still waiting, so a request is answered for what is on the screen.
function flush(model: monaco.editor.ITextModel): void {
  const id = uriOf(model)
  const t = timers.get(id)
  if (!t) return
  clearTimeout(t)
  timers.delete(id)
  const l = modelServer.get(id)
  if (l) sendFull(l, model)
}

function open(l: Live, model: monaco.editor.ITextModel): void {
  const id = uriOf(model)
  modelServer.set(id, l)
  versions.set(id, 1)
  void window.api.lspNotify(l.server, 'textDocument/didOpen', { textDocument: { uri: sUri(l, model), languageId: model.getLanguageId(), version: 1, text: model.getValue() } })
}

function close(model: monaco.editor.ITextModel): void {
  const id = uriOf(model)
  const l = modelServer.get(id)
  if (!l) return
  modelServer.delete(id)
  versions.delete(id)
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  void window.api.lspNotify(l.server, 'textDocument/didClose', { textDocument: { uri: sUri(l, model) } })
  if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'lsp', [])
}

async function ensureServer(language: string, root: string): Promise<Live | null> {
  const key = language + '|' + root.toLowerCase()
  const cached = started.get(key)
  if (cached) {
    const l = await cached
    if (l && liveByServer.has(l.server)) return l
    started.delete(key)
  }
  const p = window.api.lspStart(language, root).then((r): Live | null => {
    if (!r.ok) {
      appendOutput(LSP_CHANNEL, `${language}: ${r.error}`)
      if (!warned.has(language)) {
        warned.add(language)
        say(`No language server for ${language}: ${r.error.split('\n')[0]}`, 'info')
      }
      return null
    }
    const l: Live = { key, server: r.server, language, label: r.label, root, realRoot: r.realRoot, caps: r.capabilities }
    liveByServer.set(l.server, l)
    appendOutput(LSP_CHANNEL, `${r.label} started for ${root}`)
    emitStatus()
    return l
  })
  started.set(key, p)
  return p
}

function attach(model: monaco.editor.ITextModel): void {
  if (!getSettings().languageServers) return
  if (model.isDisposed() || model.uri.scheme !== 'file' || ghosts.has(uriOf(model))) return
  const language = languageOfEditor.get(model.getLanguageId())
  if (!language) return
  void ensureServer(language, rootFor(model.uri.fsPath)).then((l) => {
    if (!l || model.isDisposed() || modelServer.has(uriOf(model))) return
    open(l, model)
  })
}

// ---- providers ----

const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text, 2: monaco.languages.CompletionItemKind.Method, 3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor, 5: monaco.languages.CompletionItemKind.Field, 6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class, 8: monaco.languages.CompletionItemKind.Interface, 9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property, 11: monaco.languages.CompletionItemKind.Unit, 12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum, 14: monaco.languages.CompletionItemKind.Keyword, 15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color, 17: monaco.languages.CompletionItemKind.File, 18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder, 20: monaco.languages.CompletionItemKind.EnumMember, 21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct, 23: monaco.languages.CompletionItemKind.Event, 24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter
}

const markdown = (v: Json): monaco.IMarkdownString | undefined => {
  if (!v) return undefined
  if (typeof v === 'string') return { value: v }
  if (typeof v.value === 'string' && typeof v.language === 'string') return { value: '```' + v.language + '\n' + v.value + '\n```' }
  if (typeof v.value === 'string') return { value: v.value }
  return undefined
}

const toEdits = (edits: Json[] | undefined): monaco.languages.TextEdit[] => (edits ?? []).map((e) => ({ range: rangeOf(e.range), text: e.newText ?? '' }))

// Results in files that are not open need a model before Monaco can show them (peek views); this makes one that the
// app drops again when it opens that file for real.
async function ensureModels(paths: string[], limit = 20): Promise<void> {
  for (const p of [...new Set(paths)].slice(0, limit)) {
    const uri = monaco.Uri.file(p)
    if (monaco.editor.getModel(uri)) continue
    try {
      const text = await window.api.readFile(p)
      if (monaco.editor.getModel(uri)) continue
      ghosts.add(uri.toString())
      monaco.editor.createModel(text, undefined, uri)
    } catch {
      // an unreadable file just cannot be shown
    }
  }
}

/** Called by the app before it creates the model for a file it opens: a stand-in made for a peek view must make way. */
export function releaseGhost(path: string): void {
  const uri = monaco.Uri.file(path)
  const m = monaco.editor.getModel(uri)
  if (m && ghosts.has(uri.toString())) {
    ghosts.delete(uri.toString())
    m.dispose()
  }
}

async function locations(l: Live, res: Json): Promise<monaco.languages.Location[]> {
  const list: Json[] = !res ? [] : Array.isArray(res) ? res : [res]
  const out = list.map((x) => ({ uri: fromServerUri(l, x.uri ?? x.targetUri), range: rangeOf(x.range ?? x.targetSelectionRange ?? x.targetRange) }))
  await ensureModels(out.filter((o) => o.uri.scheme === 'file').map((o) => o.uri.fsPath))
  return out
}

function toSymbols(list: Json[]): monaco.languages.DocumentSymbol[] {
  return list.map((s) => ({
    name: s.name,
    detail: s.detail ?? '',
    kind: Math.max(0, (s.kind ?? 13) - 1) as monaco.languages.SymbolKind,
    tags: [],
    range: rangeOf(s.range ?? s.location.range),
    selectionRange: rangeOf(s.selectionRange ?? s.range ?? s.location.range),
    children: s.children ? toSymbols(s.children) : undefined
  }))
}

function registerProviders(editorLanguage: string): void {
  if (registeredProviders.has(editorLanguage)) return
  registeredProviders.add(editorLanguage)
  const serverOf = async (model: monaco.editor.ITextModel): Promise<Live | null> => {
    const l = modelServer.get(uriOf(model))
    if (!l) return null
    flush(model)
    return l
  }

  monaco.languages.registerCompletionItemProvider(editorLanguage, {
    triggerCharacters: ['.', ':', '(', '/', '@'],
    async provideCompletionItems(model, position, context) {
      const l = await serverOf(model)
      if (!l || !l.caps.completionProvider) return { suggestions: [] }
      const res = await ask(l, 'textDocument/completion', {
        textDocument: { uri: sUri(l, model) },
        position: posOf(position),
        context: { triggerKind: context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? 2 : 1, triggerCharacter: context.triggerCharacter }
      })
      const items: Json[] = Array.isArray(res) ? res : (res?.items ?? [])
      const word = model.getWordUntilPosition(position)
      const fallback = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn }
      const suggestions = items.slice(0, 400).map((it): monaco.languages.CompletionItem => {
        const edit = it.textEdit
        const range = edit ? rangeOf(edit.range ?? edit.insert) : fallback
        return {
          label: typeof it.label === 'string' ? it.label : it.label?.label ?? '',
          kind: COMPLETION_KIND[it.kind] ?? monaco.languages.CompletionItemKind.Text,
          detail: it.detail,
          documentation: markdown(it.documentation),
          insertText: edit?.newText ?? it.insertText ?? it.label,
          insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range,
          filterText: it.filterText,
          sortText: it.sortText,
          preselect: it.preselect,
          commitCharacters: it.commitCharacters,
          additionalTextEdits: toEdits(it.additionalTextEdits)
        }
      })
      return { suggestions, incomplete: res?.isIncomplete === true }
    }
  })

  monaco.languages.registerHoverProvider(editorLanguage, {
    async provideHover(model, position) {
      const l = await serverOf(model)
      if (!l || !l.caps.hoverProvider) return null
      const res = await ask(l, 'textDocument/hover', { textDocument: { uri: sUri(l, model) }, position: posOf(position) })
      if (!res?.contents) return null
      const parts = (Array.isArray(res.contents) ? res.contents : [res.contents]).map(markdown).filter((x: monaco.IMarkdownString | undefined): x is monaco.IMarkdownString => !!x)
      return parts.length ? { contents: parts, range: res.range ? rangeOf(res.range) : undefined } : null
    }
  })

  monaco.languages.registerDefinitionProvider(editorLanguage, {
    async provideDefinition(model, position) {
      const l = await serverOf(model)
      if (!l || !l.caps.definitionProvider) return null
      return locations(l, await ask(l, 'textDocument/definition', { textDocument: { uri: sUri(l, model) }, position: posOf(position) }))
    }
  })

  monaco.languages.registerReferenceProvider(editorLanguage, {
    async provideReferences(model, position, context) {
      const l = await serverOf(model)
      if (!l || !l.caps.referencesProvider) return null
      return locations(l, await ask(l, 'textDocument/references', { textDocument: { uri: sUri(l, model) }, position: posOf(position), context: { includeDeclaration: context.includeDeclaration } }))
    }
  })

  monaco.languages.registerDocumentSymbolProvider(editorLanguage, {
    async provideDocumentSymbols(model) {
      const l = await serverOf(model)
      if (!l || !l.caps.documentSymbolProvider) return []
      const res = await ask(l, 'textDocument/documentSymbol', { textDocument: { uri: sUri(l, model) } })
      return Array.isArray(res) ? toSymbols(res) : []
    }
  })

  monaco.languages.registerSignatureHelpProvider(editorLanguage, {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      const l = await serverOf(model)
      if (!l || !l.caps.signatureHelpProvider) return null
      const res = await ask(l, 'textDocument/signatureHelp', { textDocument: { uri: sUri(l, model) }, position: posOf(position) })
      if (!res?.signatures?.length) return null
      return {
        value: {
          activeSignature: res.activeSignature ?? 0,
          activeParameter: res.activeParameter ?? 0,
          signatures: res.signatures.map((s: Json) => ({
            label: s.label,
            documentation: markdown(s.documentation),
            parameters: (s.parameters ?? []).map((p: Json) => ({ label: p.label, documentation: markdown(p.documentation) }))
          }))
        },
        dispose: () => undefined
      }
    }
  })

  monaco.languages.registerDocumentFormattingEditProvider(editorLanguage, {
    async provideDocumentFormattingEdits(model, options) {
      const l = await serverOf(model)
      if (!l || !l.caps.documentFormattingProvider) return []
      const res = await ask(l, 'textDocument/formatting', { textDocument: { uri: sUri(l, model) }, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } })
      return toEdits(res)
    }
  })

  monaco.languages.registerRenameProvider(editorLanguage, {
    async provideRenameEdits(model, position, newName) {
      const l = await serverOf(model)
      if (!l || !l.caps.renameProvider) return { edits: [], rejectReason: 'This language server cannot rename.' }
      const res = await ask(l, 'textDocument/rename', { textDocument: { uri: sUri(l, model) }, position: posOf(position), newName })
      if (!res) return { edits: [], rejectReason: 'Nothing can be renamed here.' }
      const byUri: Record<string, Json[]> = res.changes ?? {}
      for (const dc of res.documentChanges ?? []) if (dc.textDocument && dc.edits) byUri[dc.textDocument.uri] = [...(byUri[dc.textDocument.uri] ?? []), ...dc.edits]
      // Files that are not open are changed through a stand-in model (as peek views use) and written to disk when it changes.
      const closed = Object.keys(byUri).map((u) => fromServerUri(l, u)).filter((u) => u.scheme === 'file' && !monaco.editor.getModel(u)).map((u) => u.fsPath)
      if (closed.length > 50) return { edits: [], rejectReason: `The name is used in ${closed.length} files that are not open; renaming that many at once is not supported.` }
      await ensureModels(closed, 50)
      const edits: monaco.languages.IWorkspaceTextEdit[] = []
      const others: monaco.editor.ITextModel[] = []
      for (const [uri, list] of Object.entries(byUri)) {
        const target = monaco.editor.getModel(fromServerUri(l, uri))
        if (!target) return { edits: [], rejectReason: 'The name is also used in a file that could not be read: ' + fromServerUri(l, uri).fsPath }
        if (ghosts.has(target.uri.toString())) saveWhenChanged(target, l)
        for (const e of list) edits.push({ resource: target.uri, versionId: undefined, textEdit: { range: rangeOf(e.range), text: e.newText } })
        if (target !== model) others.push(target)
      }
      linkUndo(model, others)
      return { edits }
    }
  })
}

// Monaco keeps one undo history per file, so undoing a rename in the editor that started it would leave the other files renamed.
// While that editor's history is at the state before the rename (or after it) the other files follow it.
function linkUndo(main: monaco.editor.ITextModel, others: monaco.editor.ITextModel[]): void {
  if (!others.length) return
  const before = main.getAlternativeVersionId()
  let after = -1
  const sub = main.onDidChangeContent((e) => {
    if (main.isDisposed()) return sub.dispose()
    if (after < 0 && !e.isUndoing && !e.isRedoing) {
      after = main.getAlternativeVersionId() // the rename itself
    } else if (e.isUndoing && main.getAlternativeVersionId() === before) {
      for (const o of others) if (!o.isDisposed()) (o as unknown as { undo(): void }).undo() // the model's own history (not in the public type)
    } else if (e.isRedoing && main.getAlternativeVersionId() === after) {
      for (const o of others) if (!o.isDisposed()) (o as unknown as { redo(): void }).redo()
    } else if (!e.isUndoing && !e.isRedoing) {
      sub.dispose() // the file was edited after the rename: it no longer leads
    }
  })
}

// A file that is not open, changed by a rename (or by undoing one): written back to disk a moment after its stand-in model changes,
// and the server is told that the file changed. When the file is opened for real, its tab takes over and this stops.
const savingGhosts = new Set<string>()
function saveWhenChanged(model: monaco.editor.ITextModel, l: Live): void {
  const key = model.uri.toString()
  if (savingGhosts.has(key)) return
  savingGhosts.add(key)
  let timer: ReturnType<typeof setTimeout> | undefined
  const sub = model.onDidChangeContent(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (model.isDisposed() || !ghosts.has(key)) {
        sub.dispose()
        savingGhosts.delete(key)
        return
      }
      void window.api.writeFile(model.uri.fsPath, model.getValue()).then(() => window.api.lspNotify(l.server, 'workspace/didChangeWatchedFiles', { changes: [{ uri: sUri(l, model), type: 2 }] })).catch((e) => say(`Could not save ${model.uri.fsPath}: ${e instanceof Error ? e.message : String(e)}`, 'error'))
    }, 400)
  })
}

// ---- messages from the servers ----

const SEVERITY: Record<number, monaco.MarkerSeverity> = { 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint }

function onMessage(m: { server: string; method: string; params: Json }): void {
  if (m.method === 'textDocument/publishDiagnostics') {
    const l = liveByServer.get(m.server)
    if (!l) return
    const model = monaco.editor.getModel(fromServerUri(l, m.params.uri))
    if (!model || model.isDisposed()) return
    monaco.editor.setModelMarkers(
      model,
      'lsp',
      (m.params.diagnostics as Json[]).map((d) => ({
        ...rangeOf(d.range),
        severity: SEVERITY[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
        message: d.message,
        source: d.source ?? l.label,
        code: d.code !== undefined ? String(d.code) : undefined
      }))
    )
  } else if (m.method === 'window/logMessage' || m.method === 'window/showMessage') {
    appendOutput(LSP_CHANNEL, `[${liveByServer.get(m.server)?.label ?? m.server}] ${m.params.message}`)
  }
}

// ---- start and stop ----

let initialised = false
export function initLanguageServers(opts: { getRoots: () => string[]; openFile: (path: string, line: number, column: number) => void; notify: (text: string, kind?: string) => void }): void {
  if (initialised) return
  initialised = true
  // The Settings switch: off stops every server and clears what they reported; on starts them for the open files.
  let wasOn = getSettings().languageServers
  subscribeSettings(() => {
    const on = getSettings().languageServers
    if (on === wasOn) return
    wasOn = on
    if (on) void restartLanguageServers()
    else void stopLanguageServers()
  })
  getRoots = opts.getRoots
  openFileAt = opts.openFile
  say = opts.notify
  void window.api.lspLanguages().then((list) => {
    for (const s of list) for (const id of s.languages) languageOfEditor.set(id, s.language)
    for (const id of languageOfEditor.keys()) registerProviders(id)
    monaco.editor.getModels().forEach(attach)
  })
  monaco.editor.onDidCreateModel((model) => {
    attach(model)
    model.onDidChangeContent(() => {
      const id = uriOf(model)
      const l = modelServer.get(id)
      if (!l) return
      const t = timers.get(id)
      if (t) clearTimeout(t)
      timers.set(id, setTimeout(() => {
        timers.delete(id)
        if (!model.isDisposed()) sendFull(l, model)
      }, 150))
    })
    model.onDidChangeLanguage(() => {
      close(model)
      attach(model)
    })
    model.onWillDispose(() => close(model))
  })
  window.api.onLspMessage(onMessage)
  window.api.onLspExited(({ server }) => {
    const l = liveByServer.get(server)
    if (!l) return
    liveByServer.delete(server)
    started.delete(l.key)
    for (const [uri, s] of [...modelServer]) {
      if (s !== l) continue
      modelServer.delete(uri)
      const model = monaco.editor.getModel(monaco.Uri.parse(uri))
      if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, 'lsp', [])
    }
    appendOutput(LSP_CHANNEL, `${l.label} stopped`)
    emitStatus()
  })
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file' || monaco.editor.getEditors().some((e) => e.getModel()?.uri.toString() === resource.toString())) return false
      const sel = selectionOrPosition as { lineNumber?: number; column?: number; startLineNumber?: number; startColumn?: number } | undefined
      openFileAt(resource.fsPath, sel?.startLineNumber ?? sel?.lineNumber ?? 1, sel?.startColumn ?? sel?.column ?? 1)
      return true
    }
  })
}

/** Does this file's language have a language server (running or still starting)? */
export const expectsServer = (model: monaco.editor.ITextModel): boolean => model.uri.scheme === 'file' && languageOfEditor.has(model.getLanguageId())

/** Stops every language server and forgets what they said about the open files. */
export async function stopLanguageServers(): Promise<void> {
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === 'file' && modelServer.has(uriOf(model))) close(model)
  }
  for (const l of [...liveByServer.values()]) await window.api.lspStop(l.server)
  started.clear()
  emitStatus()
}

/** Stops every language server and starts them again for the files that are open (after installing one, say). */
export async function restartLanguageServers(): Promise<void> {
  warned.clear()
  for (const l of [...liveByServer.values()]) await window.api.lspStop(l.server)
  await new Promise((r) => setTimeout(r, 800))
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === 'file') {
      modelServer.delete(uriOf(model))
      attach(model)
    }
  }
}

/** Tell the server a file was saved (some servers check files then). */
export function notifySaved(model: monaco.editor.ITextModel): void {
  const l = modelServer.get(uriOf(model))
  if (l) void window.api.lspNotify(l.server, 'textDocument/didSave', { textDocument: { uri: sUri(l, model) }, text: model.getValue() })
}

// ---- for the Outline ----

const OUTLINE_KIND: Record<number, string> = { 2: 'module', 3: 'module', 4: 'module', 5: 'class', 6: 'method', 7: 'property', 8: 'property', 9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'var', 14: 'const', 22: 'enum', 23: 'struct', 26: 'type' }

export async function outlineSymbols(model: monaco.editor.ITextModel): Promise<{ name: string; kind: string; line: number; depth: number }[] | null> {
  const l = modelServer.get(uriOf(model))
  if (!l || !l.caps.documentSymbolProvider) return null
  flush(model)
  const res = await ask(l, 'textDocument/documentSymbol', { textDocument: { uri: sUri(l, model) } })
  if (!Array.isArray(res)) return null
  const out: { name: string; kind: string; line: number; depth: number }[] = []
  const walk = (list: Json[], depth: number): void => {
    for (const s of list) {
      const range = s.selectionRange ?? s.range ?? s.location?.range
      out.push({ name: s.name, kind: OUTLINE_KIND[s.kind] ?? 'var', line: range.start.line + 1, depth })
      if (s.children?.length) walk(s.children, depth + 1)
    }
  }
  walk(res, 0)
  return out
}

