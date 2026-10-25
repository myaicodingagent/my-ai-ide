'use strict'
// The extension host: runs inside its own Node process (started by extensions.ts) and talks to the editor through
// process.send / process.on('message'). It loads two kinds of extension:
//   native   written for this editor ("engines": { "my-ai-ide": ... }) and given the small `ide` object
//   vscode   written for VS Code: `require('vscode')` gives them a partial implementation of that API (see VSCODE below)
// Extension code is not sandboxed; it runs with the user's permissions.
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

let nextId = 1
const waiting = new Map()
const ask = (method, params) =>
  new Promise((resolve, reject) => {
    const reqId = nextId++
    waiting.set(reqId, { resolve, reject })
    process.send({ type: 'request', reqId, method, params })
  })
// A path on another computer opened over SSH (\\ssh.name\folder): file access goes through the editor's connection, not Node's fs.
const isRemote = (p) => typeof p === 'string' && /^\\\\ssh[.]/i.test(p)
const rfs = (op, p, extra) => ask('remoteFs', { op, path: p, ...extra })
const tell = (method, params) => process.send({ type: 'request', reqId: 0, method, params })
const log = (text) => process.send({ type: 'log', text: String(text) })

let root = null
let editorState = null // what the editor last said about the open file: { path, language, text, selections, ... }
const handlers = new Map() // "extension id:command" -> function (commands of native extensions)
const commandRegistry = new Map() // command id -> function (VS Code style, across extensions)
const providers = new Map() // provider id -> { kind, provider, extId }
const configDefaults = {} // "section.key" -> default value, from the extensions' package.json
const listeners = { activeEditor: [], selection: [], textChange: [] }

// ============================================================ the `ide` object of native extensions
function makeIdeApi(ext) {
  return {
    version: '1',
    workspace: {
      get root() { return root },
      readFile: (rel) => ask('readFile', { rel }),
      writeFile: (rel, text) => ask('writeFile', { rel, text })
    },
    commands: { register: (id, fn) => { handlers.set(ext.id + ':' + id, fn) } },
    window: {
      showMessage: (text, kind) => ask('message', { text: String(text), kind: kind || 'info' }),
      showInput: (opts) => ask('input', opts || {})
    },
    editor: {
      getActive: () => ask('getEditor', {}),
      replaceSelection: (text) => ask('replaceSelection', { text: String(text) }),
      insert: (text) => ask('insert', { text: String(text) }),
      openFile: (file, line) => ask('openFile', { file, line })
    },
    ai: { ask: (prompt) => ask('aiAsk', { prompt: String(prompt) }) }
  }
}

// ============================================================ the `vscode` module (partial)
class Position {
  constructor(line, character) { this.line = line; this.character = character }
  isEqual(o) { return this.line === o.line && this.character === o.character }
  isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character) }
  isBeforeOrEqual(o) { return !o.isBefore(this) }
  isAfter(o) { return o.isBefore(this) }
  isAfterOrEqual(o) { return !this.isBefore(o) }
  compareTo(o) { return this.isBefore(o) ? -1 : this.isAfter(o) ? 1 : 0 }
  translate(dl, dc) { return new Position(this.line + (typeof dl === 'object' ? dl.lineDelta || 0 : dl || 0), this.character + (typeof dl === 'object' ? dl.characterDelta || 0 : dc || 0)) }
  with(l, c) { return new Position(typeof l === 'object' ? (l.line !== undefined ? l.line : this.line) : l !== undefined ? l : this.line, typeof l === 'object' ? (l.character !== undefined ? l.character : this.character) : c !== undefined ? c : this.character) }
}
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d) } else { this.start = a; this.end = b }
    if (this.end.isBefore(this.start)) { const t = this.start; this.start = this.end; this.end = t }
  }
  get isEmpty() { return this.start.isEqual(this.end) }
  get isSingleLine() { return this.start.line === this.end.line }
  contains(x) { return x instanceof Range ? this.contains(x.start) && this.contains(x.end) : !x.isBefore(this.start) && !x.isAfter(this.end) }
  isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end) }
  intersection(o) { const s = this.start.isAfter(o.start) ? this.start : o.start; const e = this.end.isBefore(o.end) ? this.end : o.end; return s.isAfter(e) ? undefined : new Range(s, e) }
  union(o) { return new Range(this.start.isBefore(o.start) ? this.start : o.start, this.end.isAfter(o.end) ? this.end : o.end) }
  with(s, e) { return new Range(s || this.start, e || this.end) }
}
class Selection extends Range {
  constructor(a, b, c, d) {
    super(a, b, c, d)
    const anchor = typeof a === 'number' ? new Position(a, b) : a
    const active = typeof a === 'number' ? new Position(c, d) : b
    this.anchor = anchor
    this.active = active
  }
  get isReversed() { return this.anchor.isAfter(this.active) }
}
class Uri {
  constructor(scheme, authority, p, query, fragment) { this.scheme = scheme; this.authority = authority || ''; this.path = p || ''; this.query = query || ''; this.fragment = fragment || '' }
  static file(p) { return new Uri('file', '', String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:'), '', '') }
  static parse(s) {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(String(s))
    return m ? new Uri(m[1], m[2], decodeURIComponent(m[3] || ''), m[4], m[5]) : Uri.file(s)
  }
  static joinPath(base, ...parts) { const unc = base.path.startsWith('//') ? '/' : ''; return new Uri(base.scheme, base.authority, unc + path.posix.join(base.path, ...parts), base.query, base.fragment) }
  get fsPath() { return this.scheme === 'file' ? this.path.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, process.platform === 'win32' ? '\\' : '/') : this.path }
  with(c) { return new Uri(c.scheme !== undefined ? c.scheme : this.scheme, c.authority !== undefined ? c.authority : this.authority, c.path !== undefined ? c.path : this.path, c.query !== undefined ? c.query : this.query, c.fragment !== undefined ? c.fragment : this.fragment) }
  toString() { return this.scheme + '://' + this.authority + encodeURI(this.path) + (this.query ? '?' + this.query : '') + (this.fragment ? '#' + this.fragment : '') }
  toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path, fsPath: this.fsPath } }
}
class Disposable {
  constructor(fn) { this._fn = fn }
  dispose() { if (this._fn) { const f = this._fn; this._fn = null; f() } }
  static from(...items) { return new Disposable(() => items.forEach((i) => i && i.dispose && i.dispose())) }
}
class EventEmitter {
  constructor() { this._l = []; this.event = (cb, thisArg, disposables) => { const f = thisArg ? cb.bind(thisArg) : cb; this._l.push(f); const d = new Disposable(() => { this._l = this._l.filter((x) => x !== f) }); if (disposables) disposables.push(d); return d } }
  fire(e) { for (const f of [...this._l]) { try { f(e) } catch (err) { log('Error in an event handler: ' + (err && err.stack || err)) } } }
  dispose() { this._l = [] }
}
class CancellationTokenSource {
  constructor() { this._e = new EventEmitter(); this.token = { isCancellationRequested: false, onCancellationRequested: this._e.event } }
  cancel() { if (!this.token.isCancellationRequested) { this.token.isCancellationRequested = true; this._e.fire() } }
  dispose() { this._e.dispose() }
}
class MarkdownString {
  constructor(value, supportThemeIcons) { this.value = value || ''; this.isTrusted = false; this.supportThemeIcons = !!supportThemeIcons }
  appendText(t) { this.value += String(t).replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&'); return this }
  appendMarkdown(t) { this.value += t; return this }
  appendCodeblock(code, lang) { this.value += '\n```' + (lang || '') + '\n' + code + '\n```\n'; return this }
}
class SnippetString {
  constructor(value) { this.value = value || '' }
  appendText(t) { this.value += String(t).replace(/[$}\\]/g, '\\$&'); return this }
  appendTabstop(n) { this.value += '$' + (n === undefined ? 0 : n); return this }
  appendPlaceholder(v, n) { this.value += '${' + (n === undefined ? 1 : n) + ':' + (typeof v === 'function' ? '' : v) + '}'; return this }
}
class TextEdit {
  constructor(range, newText) { this.range = range; this.newText = newText }
  static replace(range, text) { return new TextEdit(range, text) }
  static insert(pos, text) { return new TextEdit(new Range(pos, pos), text) }
  static delete(range) { return new TextEdit(range, '') }
}
class WorkspaceEdit {
  constructor() { this._edits = [] }
  replace(uri, range, text) { this._edits.push({ uri, edit: new TextEdit(range, text) }) }
  insert(uri, pos, text) { this._edits.push({ uri, edit: TextEdit.insert(pos, text) }) }
  delete(uri, range) { this._edits.push({ uri, edit: TextEdit.delete(range) }) }
  set(uri, edits) { for (const e of edits) this._edits.push({ uri, edit: e }) }
  get size() { return this._edits.length }
}
class Diagnostic {
  constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity === undefined ? 0 : severity }
}
class Hover { constructor(contents, range) { this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range } }
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind } }
class ThemeColor { constructor(id) { this.id = id } }
class ThemeIcon { constructor(id) { this.id = id } }
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 }
class TreeItem {
  constructor(labelOrUri, collapsibleState) {
    if (typeof labelOrUri === 'string' || (labelOrUri && typeof labelOrUri === 'object' && 'label' in labelOrUri)) this.label = labelOrUri
    else { this.resourceUri = labelOrUri; this.label = labelOrUri && labelOrUri.path ? String(labelOrUri.path).split('/').pop() : '' }
    this.collapsibleState = collapsibleState === undefined ? 0 : collapsibleState
  }
}

// ---- tree views: the editor asks for the children of a node, and what to do when one is clicked ----
// A node keeps its number (its "handle") across refreshes: it is found by the item's id, or by its label below the same parent.
const treeViews = new Map() // view id -> { provider, byKey: Map<string, number>, keys: Map<number, string>, nodes: Map<number, element>, items: Map<number, TreeItem>, byElement: Map<element, number>, next }
let vscodeApi = null

// ---- webview panels: an extension's own HTML page, shown as a tab ----
const webviews = new Map() // id -> { panel, messages: EventEmitter, disposed: EventEmitter, closed }
let webviewCounter = 1
const serializers = new Map() // view type -> WebviewPanelSerializer
let pendingRestore = [] // panels that were open when the editor was closed: { viewType, title, extId, state }
const webviewViewProviders = new Map() // view id -> provider (registerWebviewViewProvider)
const handleFor = (st, key, element) => {
  let h = st.byKey.get(key)
  if (h === undefined) { h = st.next++; st.byKey.set(key, h); st.keys.set(h, key) }
  st.nodes.set(h, element)
  st.byElement.set(element, h)
  return h
}
// An icon given as a file (a path or a Uri, or {light, dark}) is sent to the editor as a data: URL: small image files only.
const ICON_TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp' }
const MAX_ICON = 32 * 1024
const iconCache = new Map() // file -> { mtime, url }
let iconBudget = 0
function iconData(p) {
  try {
    const file = typeof p === 'string' ? p : p && typeof p === 'object' ? (p.fsPath || (p.scheme === 'file' ? p.path : '')) : ''
    const mime = file ? ICON_TYPES[path.extname(file).toLowerCase()] : undefined
    if (!mime) return undefined
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_ICON) return undefined
    let c = iconCache.get(file)
    if (!c || c.mtime !== st.mtimeMs) { c = { mtime: st.mtimeMs, url: 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64') }; iconCache.set(file, c) }
    if ((iconBudget -= c.url.length) < 0) return undefined
    return c.url
  } catch { return undefined }
}
function iconFiles(icon) {
  if (!icon || icon.id !== undefined) return undefined
  const both = icon && typeof icon === 'object' && (icon.light !== undefined || icon.dark !== undefined) && icon.fsPath === undefined && icon.scheme === undefined
  const light = iconData(both ? icon.light : icon)
  const dark = iconData(both ? icon.dark : icon)
  return light || dark ? { light: light || dark, dark: dark || light } : undefined
}
const plain = (v) => (v === undefined || v === null ? undefined : typeof v === 'string' ? v : v.value !== undefined ? String(v.value) : v.label !== undefined ? String(v.label) : String(v))
function serializeItem(item, handle) {
  const label = item.label && typeof item.label === 'object' ? item.label.label : item.label
  const icon = item.iconPath
  return {
    handle,
    label: String(label !== undefined ? label : item.resourceUri ? String(item.resourceUri.path).split('/').pop() : ''),
    description: item.description === true ? '' : plain(item.description),
    tooltip: plain(item.tooltip),
    collapsible: item.collapsibleState || 0,
    codicon: icon && icon.id ? icon.id : undefined,
    iconFile: iconFiles(icon),
    resource: item.resourceUri ? item.resourceUri.fsPath || String(item.resourceUri.path) : undefined,
    contextValue: item.contextValue,
    hasCommand: !!(item.command && item.command.command)
  }
}
async function webviewProvide(msg) {
  if (msg.kind === 'webviewViewResolve') {
    // The editor shows a sidebar view that an extension fills with a web page: ask the extension for its page.
    const rec = webviewViewProviders.get(msg.params.viewId)
    if (!rec) return null
    const provider = rec.provider
    const { id, panel } = rec.make(msg.params.viewId, '', {}, msg.params.viewId)
    let visible = true
    const view = {
      webview: panel.webview, viewType: msg.params.viewId, title: undefined, description: undefined, badge: undefined,
      get visible() { return visible }, show() {}, onDidDispose: panel.onDidDispose, onDidChangeVisibility: panel.onDidChangeViewState
    }
    await provider.resolveWebviewView(view, { state: undefined }, new CancellationTokenSource().token)
    return id
  }
  const w = webviews.get(msg.params.id)
  if (!w) return null
  if (msg.kind === 'webviewMessage') { w.messages.fire(msg.params.message); return true }
  if (msg.kind === 'webviewClosed') { w.closed = true; w.panel.dispose(); return true }
  return null
}
async function treeProvide(msg) {
  const st = treeViews.get(msg.params.viewId)
  if (!st) return null
  if (msg.kind === 'treeChildren') {
    const parent = msg.params.handle == null ? undefined : st.nodes.get(msg.params.handle)
    if (msg.params.handle != null && parent === undefined) return []
    const kids = (await st.provider.getChildren(parent)) || []
    const parentKey = msg.params.handle == null ? '' : st.keys.get(msg.params.handle) || ''
    const out = []
    iconBudget = 1_500_000
    for (const k of kids.slice(0, 2000)) {
      const item = await st.provider.getTreeItem(k)
      const label = item.label && typeof item.label === 'object' ? item.label.label : item.label
      const h = handleFor(st, item.id ? 'id:' + item.id : parentKey + '/' + String(label), k)
      st.items.set(h, item)
      out.push(serializeItem(item, h))
    }
    return out
  }
  if (msg.kind === 'treeCommand') {
    // A command chosen in a node's menu gets the node (the element the extension gave) and the selection.
    const el = st.nodes.get(msg.params.handle)
    if (el === undefined) return false
    await vscodeApi.commands.executeCommand(String(msg.params.command), el, [el])
    return true
  }
  if (msg.kind === 'treeAction') {
    const item = st.items.get(msg.params.handle)
    if (item && item.command && item.command.command) await vscodeApi.commands.executeCommand(item.command.command, ...(item.command.arguments || []))
    return true
  }
  return null
}

const lineStarts = (text) => { const s = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') s.push(i + 1); return s }

// A TextDocument made from text the editor sent.
function makeDocument(p, language, text) {
  const starts = lineStarts(text)
  const lineText = (n) => { const end = n + 1 < starts.length ? starts[n + 1] - 1 : text.length; return text.slice(starts[n], end).replace(/\r$/, '') }
  const uri = Uri.file(p)
  const doc = {
    uri, fileName: p, languageId: language || 'plaintext', version: 1, isDirty: false, isUntitled: false, isClosed: false, eol: text.indexOf('\r\n') >= 0 ? 2 : 1,
    get lineCount() { return starts.length },
    getText(range) { return range ? text.slice(doc.offsetAt(range.start), doc.offsetAt(range.end)) : text },
    lineAt(x) {
      const n = typeof x === 'number' ? x : x.line
      if (n < 0 || n >= starts.length) throw new Error('Illegal value for `line`')
      const t = lineText(n)
      const rest = text.slice(starts[n], n + 1 < starts.length ? starts[n + 1] - 1 : text.length)
      void rest
      return { lineNumber: n, text: t, range: new Range(n, 0, n, t.length), rangeIncludingLineBreak: new Range(n, 0, n + 1 < starts.length ? n + 1 : n, n + 1 < starts.length ? 0 : t.length), firstNonWhitespaceCharacterIndex: t.search(/\S|$/), isEmptyOrWhitespace: t.trim() === '' }
    },
    offsetAt(pos) { const l = Math.max(0, Math.min(pos.line, starts.length - 1)); return Math.min(starts[l] + pos.character, l + 1 < starts.length ? starts[l + 1] - 1 : text.length) },
    positionAt(offset) {
      let lo = 0, hi = starts.length - 1
      const o = Math.max(0, Math.min(offset, text.length))
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= o) lo = mid; else hi = mid - 1 }
      return new Position(lo, o - starts[lo])
    },
    getWordRangeAtPosition(pos, regex) {
      const t = lineText(pos.line)
      const re = regex ? new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g') : /[A-Za-z0-9_$]+/g
      let m
      while ((m = re.exec(t))) { if (m.index <= pos.character && pos.character <= m.index + m[0].length) return new Range(pos.line, m.index, pos.line, m.index + m[0].length); if (m[0] === '') re.lastIndex++ }
      return undefined
    },
    validateRange(r) { return r }, validatePosition(pos) { return pos },
    save() { return Promise.resolve(true) }
  }
  return doc
}

function posOf(o) { return new Position(o.line, o.character) }

function makeEditor(state) {
  const doc = makeDocument(state.path, state.language, state.text)
  const selections = (state.selections && state.selections.length ? state.selections : [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }]).map((s) => new Selection(posOf(s.anchor), posOf(s.active)))
  const editor = {
    document: doc, selection: selections[0], selections, visibleRanges: [new Range(0, 0, Math.min(doc.lineCount - 1, 50), 0)], options: { tabSize: 2, insertSpaces: true }, viewColumn: 1,
    edit(cb) {
      const edits = []
      const builder = {
        replace: (loc, text) => edits.push({ range: loc instanceof Position ? new Range(loc, loc) : loc, text }),
        insert: (pos, text) => edits.push({ range: new Range(pos, pos), text }),
        delete: (range) => edits.push({ range, text: '' }),
        setEndOfLine: () => {}
      }
      cb(builder)
      return ask('applyEdits', { path: state.path, edits: edits.map((e) => ({ range: { start: { line: e.range.start.line, character: e.range.start.character }, end: { line: e.range.end.line, character: e.range.end.character } }, text: e.text })) }).then(() => true)
    },
    insertSnippet(snippet, location) {
      const target = location || editor.selection
      return ask('applyEdits', { path: state.path, snippet: true, edits: [{ range: { start: { line: target.start.line, character: target.start.character }, end: { line: target.end.line, character: target.end.character } }, text: snippet.value }] }).then(() => true)
    },
    revealRange() {}, setDecorations() {}, show() {}, hide() {}
  }
  return editor
}

const unsupported = (name) => () => { throw new Error(name + ' is not supported in My AI IDE') }
const stub = (name) => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : unsupported(name + '.' + String(prop))) })

function selectorLanguages(selector) {
  const list = Array.isArray(selector) ? selector : [selector]
  const langs = []
  for (const s of list) {
    if (typeof s === 'string') langs.push(s)
    else if (s && s.language) langs.push(s.language)
    else langs.push('*')
  }
  return langs
}

function makeVscode(ext) {
  const subscriptionsOf = (d) => d
  const outputChannels = []
  const diagnosticsCollections = []
  const vscode = {
    version: '1.85.0',
    Position, Range, Selection, Uri, Disposable, EventEmitter, CancellationTokenSource, MarkdownString, SnippetString, TextEdit, WorkspaceEdit, Diagnostic, Hover, CompletionItem, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    EndOfLine: { LF: 1, CRLF: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    commands: {
      registerCommand(id, fn, thisArg) { const f = thisArg ? fn.bind(thisArg) : fn; commandRegistry.set(id, f); handlers.set(ext.id + ':' + id, f); return new Disposable(() => { commandRegistry.delete(id); handlers.delete(ext.id + ':' + id) }) },
      registerTextEditorCommand(id, fn, thisArg) {
        const run = async () => { if (!editorState) throw new Error('Open a file first.'); const ed = makeEditor(editorState); return fn.call(thisArg, ed, { replace: () => {}, insert: () => {}, delete: () => {} }) }
        commandRegistry.set(id, run); handlers.set(ext.id + ':' + id, run)
        return new Disposable(() => { commandRegistry.delete(id); handlers.delete(ext.id + ':' + id) })
      },
      async executeCommand(id, ...args) {
        const f = commandRegistry.get(id)
        if (f) return f(...args)
        if (id === 'vscode.open' && args[0]) return ask('openFile', { file: args[0].fsPath || String(args[0]) })
        if (id === 'workbench.action.files.save') return ask('editorAction', { id: 'save' })
        if (id === 'editor.action.formatDocument') return ask('editorAction', { id: 'editor.action.formatDocument' })
        throw new Error("command '" + id + "' not found")
      },
      getCommands: () => Promise.resolve([...commandRegistry.keys()])
    },
    window: {
      get activeTextEditor() { return editorState ? makeEditor(editorState) : undefined },
      get visibleTextEditors() { return editorState ? [makeEditor(editorState)] : [] },
      get activeColorTheme() { return { kind: 2 } },
      state: { focused: true },
      showInformationMessage: (m, ...a) => showMessage('info', m, a),
      showWarningMessage: (m, ...a) => showMessage('warning', m, a),
      showErrorMessage: (m, ...a) => showMessage('error', m, a),
      showInputBox: (o) => ask('input', { prompt: (o && (o.prompt || o.title)) || '', value: o && o.value, placeholder: o && o.placeHolder }).then((v) => (v === null ? undefined : v)),
      async showQuickPick(items, options) {
        const list = await items
        const norm = list.map((i) => (typeof i === 'string' ? { label: i } : { label: i.label, description: i.description, detail: i.detail }))
        const chosen = await ask('quickPick', { items: norm, placeholder: options && options.placeHolder, canPickMany: !!(options && options.canPickMany) })
        if (chosen === null || chosen === undefined) return undefined
        if (options && options.canPickMany) return chosen.map((i) => list[i])
        return list[chosen]
      },
      async showTextDocument(docOrUri, opts) { const u = docOrUri.uri || docOrUri; await ask('openFile', { file: u.fsPath || String(u), line: opts && opts.selection ? opts.selection.start.line + 1 : undefined }); return editorState ? makeEditor(editorState) : undefined },
      createOutputChannel(name) { const ch = { name, append: (t) => log('[' + name + '] ' + t), appendLine: (t) => log('[' + name + '] ' + t), clear() {}, show() {}, hide() {}, replace: (t) => log('[' + name + '] ' + t), dispose() {} }; outputChannels.push(ch); return ch },
      createStatusBarItem(a, b) {
        const id = ext.id + ':' + Math.random().toString(36).slice(2)
        let shown = false
        const item = { alignment: typeof a === 'number' ? a : 1, priority: b, text: '', tooltip: '', command: undefined, color: undefined, backgroundColor: undefined, name: '' }
        const push = () => tell('statusBar', { id, extId: ext.id, text: String(item.text), tooltip: item.tooltip ? String(item.tooltip.value || item.tooltip) : '', command: typeof item.command === 'string' ? item.command : item.command && item.command.command, visible: shown })
        item.show = () => { shown = true; push() }
        item.hide = () => { shown = false; push() }
        item.dispose = () => { shown = false; push() }
        return new Proxy(item, { set(t, k, v) { t[k] = v; if (shown && (k === 'text' || k === 'tooltip' || k === 'command')) push(); return true } })
      },
      setStatusBarMessage(text, hideAfter) { const id = ext.id + ':msg'; tell('statusBar', { id, extId: ext.id, text: String(text), visible: true }); const hide = () => tell('statusBar', { id, extId: ext.id, text: '', visible: false }); if (typeof hideAfter === 'number') setTimeout(hide, hideAfter); return new Disposable(hide) },
      withProgress: (opts, task) => Promise.resolve(task({ report() {} }, new CancellationTokenSource().token)),
      onDidChangeActiveTextEditor: (cb, t, d) => { const f = t ? cb.bind(t) : cb; listeners.activeEditor.push(f); const x = new Disposable(() => { listeners.activeEditor = listeners.activeEditor.filter((y) => y !== f) }); if (d) d.push(x); return x },
      onDidChangeTextEditorSelection: (cb, t, d) => { const f = t ? cb.bind(t) : cb; listeners.selection.push(f); const x = new Disposable(() => { listeners.selection = listeners.selection.filter((y) => y !== f) }); if (d) d.push(x); return x },
      onDidChangeVisibleTextEditors: () => new Disposable(() => {}),
      onDidChangeActiveColorTheme: () => new Disposable(() => {}),
      onDidChangeWindowState: () => new Disposable(() => {}),
      createTextEditorDecorationType: () => ({ key: 'decoration', dispose() {} }),
      registerTreeDataProvider: (viewId, provider) => makeTreeView(viewId, provider, {}).disposable,
      createTreeView: (viewId, options) => makeTreeView(viewId, options.treeDataProvider, options).view,
      registerWebviewViewProvider: (viewId, provider) => { webviewViewProviders.set(viewId, { provider, make: makeWebviewPanel }); tell('treeView', { viewId, extId: ext.id }); return new Disposable(() => webviewViewProviders.delete(viewId)) },
      createWebviewPanel: (viewType, title, showOptions, options) => makeWebviewPanel(viewType, title, options || {}).panel,
      registerWebviewPanelSerializer: (viewType, serializer) => {
        serializers.set(viewType, serializer)
        // Panels of this type that were open last time are brought back, one after the other.
        setImmediate(async () => {
          for (const e of pendingRestore.filter((x) => x.viewType === viewType && x.extId === ext.id)) {
            pendingRestore.splice(pendingRestore.indexOf(e), 1)
            try {
              const { panel } = makeWebviewPanel(viewType, e.title, {}, undefined, e.state)
              await serializer.deserializeWebviewPanel(panel, e.state === null ? undefined : e.state)
            } catch (err) { log('Restoring a ' + viewType + ' panel failed: ' + (err && err.stack || err)) }
          }
        })
        return new Disposable(() => serializers.delete(viewType))
      },
      createTerminal: unsupported('window.createTerminal'),
      showOpenDialog: () => Promise.resolve(undefined),
      showSaveDialog: () => Promise.resolve(undefined)
    },
    workspace: {
      get workspaceFolders() { return root ? [{ uri: Uri.file(root), name: path.basename(root), index: 0 }] : undefined },
      get rootPath() { return root || undefined },
      get name() { return root ? path.basename(root) : undefined },
      get textDocuments() { return editorState ? [makeDocument(editorState.path, editorState.language, editorState.text)] : [] },
      getWorkspaceFolder: (uri) => (root && uri && uri.fsPath && uri.fsPath.toLowerCase().startsWith(root.toLowerCase()) ? { uri: Uri.file(root), name: path.basename(root), index: 0 } : undefined),
      asRelativePath: (p) => { const s = typeof p === 'string' ? p : p.fsPath; return root && s.toLowerCase().startsWith(root.toLowerCase()) ? s.slice(root.length + 1).replace(/\\/g, '/') : s },
      getConfiguration(section) {
        const prefix = section ? section + '.' : ''
        const get = (key, dflt) => { const v = configDefaults[prefix + key]; return v === undefined ? dflt : v }
        return { get, has: (k) => configDefaults[prefix + k] !== undefined, inspect: (k) => ({ key: prefix + k, defaultValue: configDefaults[prefix + k] }), update: () => Promise.resolve(), async: undefined }
      },
      async openTextDocument(arg) {
        { const rp = typeof arg === 'string' ? arg : arg && arg.fsPath; if (isRemote(rp) && !(editorState && rp.toLowerCase() === editorState.path.toLowerCase())) return makeDocument(rp, path.extname(rp).slice(1), Buffer.from(await rfs('readFile', rp), 'base64').toString('utf-8')) }
        if (editorState && arg && (arg.fsPath || arg) && String(arg.fsPath || arg).toLowerCase() === editorState.path.toLowerCase()) return makeDocument(editorState.path, editorState.language, editorState.text)
        const p = typeof arg === 'string' ? arg : arg && arg.fsPath
        if (p) return makeDocument(p, path.extname(p).slice(1), fs.readFileSync(p, 'utf-8'))
        return makeDocument('untitled', 'plaintext', (arg && arg.content) || '')
      },
      async applyEdit(edit) {
        const byFile = new Map()
        for (const e of edit._edits) { const k = e.uri.fsPath; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(e.edit) }
        for (const [file, edits] of byFile) {
          await ask('applyEdits', { path: file, edits: edits.map((e) => ({ range: { start: { line: e.range.start.line, character: e.range.start.character }, end: { line: e.range.end.line, character: e.range.end.character } }, text: e.newText })) })
        }
        return true
      },
      async findFiles(include, exclude, maxResults) {
        if (!root) return []
        if (isRemote(root)) {
          const inc = globToRegex(typeof include === 'string' ? include : include && include.pattern || '**/*')
          const exc = exclude ? globToRegex(typeof exclude === 'string' ? exclude : exclude.pattern) : /(^|\/)(node_modules|\.git)(\/|$)/
          const base = root.replace(/[\\/]+$/, '')
          const out = []
          for (const full of await rfs('listFiles', root)) {
            const rel = full.slice(base.length + 1).replace(/\\/g, '/')
            if (!exc.test(rel) && inc.test(rel)) out.push(Uri.file(full))
            if (out.length >= (maxResults || 5000)) break
          }
          return out
        }
        const inc = globToRegex(typeof include === 'string' ? include : include && include.pattern || '**/*')
        const exc = exclude ? globToRegex(typeof exclude === 'string' ? exclude : exclude.pattern) : /(^|\/)(node_modules|\.git)(\/|$)/
        const out = []
        const walk = (dir) => {
          for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            if (out.length >= (maxResults || 5000)) return
            const full = path.join(dir, d.name)
            const rel = path.relative(root, full).replace(/\\/g, '/')
            if (exc.test(rel)) continue
            if (d.isDirectory()) walk(full)
            else if (inc.test(rel)) out.push(Uri.file(full))
          }
        }
        try { walk(root) } catch { /* unreadable folder */ }
        return out
      },
      fs: {
        readFile: async (uri) => isRemote(uri.fsPath) ? new Uint8Array(Buffer.from(await rfs('readFile', uri.fsPath), 'base64')) : new Uint8Array(fs.readFileSync(uri.fsPath)),
        writeFile: async (uri, bytes) => {
          if (isRemote(uri.fsPath)) { await rfs('writeFile', uri.fsPath, { data: Buffer.from(bytes).toString('base64') }); return }
          fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true }); fs.writeFileSync(uri.fsPath, Buffer.from(bytes))
        },
        stat: async (uri) => {
          if (isRemote(uri.fsPath)) { const s = await rfs('stat', uri.fsPath); return { type: s.isDir ? 2 : 1, ctime: s.ctime, mtime: s.mtime, size: s.size } }
          const s = fs.statSync(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }
        },
        readDirectory: async (uri) => isRemote(uri.fsPath) ? (await rfs('readDirectory', uri.fsPath)).map((d) => [d.name, d.isDir ? 2 : 1]) : fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1]),
        createDirectory: async (uri) => { if (isRemote(uri.fsPath)) await rfs('createDirectory', uri.fsPath); else fs.mkdirSync(uri.fsPath, { recursive: true }) },
        delete: async (uri, o) => { if (isRemote(uri.fsPath)) await rfs('delete', uri.fsPath); else fs.rmSync(uri.fsPath, { recursive: !!(o && o.recursive), force: true }) },
        rename: async (from, to) => { if (isRemote(from.fsPath)) await rfs('rename', from.fsPath, { to: to.fsPath }); else fs.renameSync(from.fsPath, to.fsPath) }
      },
      onDidChangeTextDocument: (cb, t, d) => { const f = t ? cb.bind(t) : cb; listeners.textChange.push(f); const x = new Disposable(() => { listeners.textChange = listeners.textChange.filter((y) => y !== f) }); if (d) d.push(x); return x },
      onDidOpenTextDocument: () => new Disposable(() => {}),
      onDidCloseTextDocument: () => new Disposable(() => {}),
      onDidSaveTextDocument: () => new Disposable(() => {}),
      onDidChangeConfiguration: () => new Disposable(() => {}),
      onDidChangeWorkspaceFolders: () => new Disposable(() => {}),
      onDidCreateFiles: () => new Disposable(() => {}),
      onDidDeleteFiles: () => new Disposable(() => {}),
      onDidRenameFiles: () => new Disposable(() => {}),
      createFileSystemWatcher: () => ({ onDidChange: () => new Disposable(() => {}), onDidCreate: () => new Disposable(() => {}), onDidDelete: () => new Disposable(() => {}), dispose() {} }),
      registerTextDocumentContentProvider: () => new Disposable(() => {}),
      isTrusted: true
    },
    languages: {
      registerCompletionItemProvider(selector, provider, ...triggerCharacters) { return registerProvider('completion', selector, provider, { triggerCharacters }) },
      registerHoverProvider(selector, provider) { return registerProvider('hover', selector, provider, {}) },
      createDiagnosticCollection(name) {
        const entries = new Map()
        const send = (file, list) => tell('setDiagnostics', { owner: ext.id + ':' + (name || 'default'), path: file, items: (list || []).map((d) => ({ message: d.message, severity: d.severity, source: d.source, code: typeof d.code === 'object' && d.code ? d.code.value : d.code, range: { start: { line: d.range.start.line, character: d.range.start.character }, end: { line: d.range.end.line, character: d.range.end.character } } })) })
        const coll = {
          name, set(a, b) { if (Array.isArray(a)) { for (const [u, d] of a) coll.set(u, d); return } entries.set(a.fsPath, b || []); send(a.fsPath, b || []) },
          delete(u) { entries.delete(u.fsPath); send(u.fsPath, []) },
          clear() { for (const k of entries.keys()) send(k, []); entries.clear() },
          forEach(cb) { for (const [k, v] of entries) cb(Uri.file(k), v, coll) },
          get: (u) => entries.get(u.fsPath), has: (u) => entries.has(u.fsPath),
          dispose() { coll.clear() }
        }
        diagnosticsCollections.push(coll)
        return coll
      },
      getLanguages: () => Promise.resolve(['plaintext', 'javascript', 'typescript', 'python', 'json', 'markdown', 'html', 'css']),
      setTextDocumentLanguage: unsupported('languages.setTextDocumentLanguage'),
      match: () => 0
    },
    env: {
      appName: 'My AI IDE', appRoot: path.dirname(process.execPath), language: 'en', machineId: 'my-ai-ide', sessionId: 'session', uriScheme: 'my-ai-ide', shell: process.env.ComSpec || process.env.SHELL || '', remoteName: undefined, isTelemetryEnabled: false,
      clipboard: { writeText: (t) => ask('clipboardWrite', { text: String(t) }).then(() => undefined), readText: () => Promise.resolve('') },
      openExternal: () => Promise.resolve(false)
    },
    extensions: {
      getExtension: (id) => (id === ext.id ? { id, extensionPath: ext.dir, extensionUri: Uri.file(ext.dir), isActive: true, packageJSON: ext.pkg || {}, exports: undefined } : undefined),
      all: [],
      onDidChange: () => new Disposable(() => {})
    },
    tasks: stub('tasks'), debug: stub('debug'), scm: stub('scm'), notebooks: stub('notebooks'), authentication: stub('authentication'), chat: stub('chat'), lm: stub('lm'), l10n: { t: (s) => String(s) }
  }

  vscodeApi = vscode
  function makeTreeView(viewId, provider, options) {
    const st = { provider, byKey: new Map(), keys: new Map(), nodes: new Map(), items: new Map(), byElement: new Map(), next: 1 }
    treeViews.set(viewId, st)
    const changed = new EventEmitter()
    let sub = null
    if (provider.onDidChangeTreeData) {
      sub = provider.onDidChangeTreeData((el) => {
        const h = el === undefined || el === null ? null : st.byElement.get(el)
        tell('treeChanged', { viewId, handle: h === undefined ? null : h })
      })
    }
    tell('treeView', { viewId, extId: ext.id })
    const disposable = new Disposable(() => {
      if (sub && sub.dispose) sub.dispose()
      treeViews.delete(viewId)
      tell('treeViewGone', { viewId })
    })
    const view = {
      onDidExpandElement: changed.event, onDidCollapseElement: changed.event, onDidChangeSelection: changed.event, onDidChangeVisibility: changed.event,
      visible: true, selection: [], title: options && options.title, description: undefined, message: undefined,
      reveal: () => Promise.resolve(), dispose: () => disposable.dispose()
    }
    return { view, disposable }
  }

  function makeWebviewPanel(viewType, title, options, viewId, state) {
    const id = ext.id + ':wv:' + webviewCounter++
    const messages = new EventEmitter()
    const disposedEvent = new EventEmitter()
    const stateEvent = new EventEmitter()
    let html = ''
    let currentTitle = String(title)
    let isDisposed = false
    const roots = [ext.dir, ...((options.localResourceRoots || []).map((u) => u.fsPath || String(u)))]
    const panel = {
      viewType, options, viewColumn: 1, active: true, visible: true,
      get title() { return currentTitle },
      set title(v) { currentTitle = String(v); tell('webviewTitle', { id, title: currentTitle }) },
      webview: {
        get html() { return html },
        set html(v) { html = String(v); tell('webviewHtml', { id, html }) },
        options,
        cspSource: 'vscode-webview-resource:',
        onDidReceiveMessage: (cb, thisArg, disposables) => messages.event(cb, thisArg, disposables),
        postMessage: (message) => { tell('webviewPost', { id, message }); return Promise.resolve(true) },
        asWebviewUri: (uri) => Uri.parse('vscode-webview-resource://w/' + Buffer.from(uri.fsPath || String(uri.path)).toString('base64url') + '/' + path.basename(uri.fsPath || String(uri.path)))
      },
      onDidDispose: (cb, thisArg, disposables) => disposedEvent.event(cb, thisArg, disposables),
      onDidChangeViewState: (cb, thisArg, disposables) => stateEvent.event(cb, thisArg, disposables),
      reveal() { tell('webviewReveal', { id }) },
      dispose() {
        if (isDisposed) return
        isDisposed = true
        webviews.delete(id)
        if (!w.closed) tell('webviewDispose', { id })
        disposedEvent.fire()
      }
    }
    const w = { panel, messages, closed: false }
    webviews.set(id, w)
    tell('webviewCreate', { id, viewType, title: currentTitle, extId: ext.id, roots, view: !!viewId, state: state === undefined ? null : state })
    return { id, panel }
  }

  function showMessage(kind, message, rest) {
    const items = rest.filter((x) => typeof x === 'string' || (x && typeof x === 'object' && typeof x.title === 'string'))
    const labels = items.map((i) => (typeof i === 'string' ? i : i.title))
    return ask('message', { text: String(message), kind, items: labels }).then((choice) => (choice === null || choice === undefined ? undefined : items[labels.indexOf(choice)]))
  }

  function registerProvider(kind, selector, provider, extra) {
    const id = ext.id + ':' + kind + ':' + Math.random().toString(36).slice(2)
    providers.set(id, { kind, provider, extId: ext.id })
    tell('registerProvider', { id, kind, languages: selectorLanguages(selector), triggerCharacters: (extra.triggerCharacters || []).map(String) })
    return new Disposable(() => { providers.delete(id); tell('unregisterProvider', { id }) })
  }

  // `Disposable` holders in subscriptions are not tracked; extensions are stopped with the host.
  void subscriptionsOf
  return vscode
}

function globToRegex(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') { const end = glob.indexOf('}', i); if (end > 0) { re += '(' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end } else re += '\\{' }
    else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

function mapKind(k) { return typeof k === 'number' ? k : 0 }

async function provide(msg) {
  if (typeof msg.kind === 'string' && msg.kind.startsWith('webview')) return webviewProvide(msg)
  if (typeof msg.kind === 'string' && msg.kind.startsWith('tree')) return treeProvide(msg)
  const rec = providers.get(msg.providerId)
  if (!rec) return null
  const doc = makeDocument(msg.params.path, msg.params.language, msg.params.text)
  const pos = new Position(msg.params.position.line, msg.params.position.character)
  const token = new CancellationTokenSource().token
  if (rec.kind === 'completion') {
    const list = await rec.provider.provideCompletionItems(doc, pos, token, { triggerKind: 0, triggerCharacter: msg.params.triggerCharacter })
    const items = Array.isArray(list) ? list : list && list.items ? list.items : []
    return items.slice(0, 500).map((it) => {
      const label = typeof it.label === 'string' ? it.label : it.label && it.label.label
      const ins = it.insertText !== undefined ? it.insertText : label
      const r = it.range && it.range.inserting ? it.range.inserting : it.range
      return {
        label, kind: mapKind(it.kind), detail: it.detail, documentation: it.documentation && (it.documentation.value !== undefined ? it.documentation.value : String(it.documentation)),
        insertText: ins && ins.value !== undefined ? ins.value : String(ins), isSnippet: !!(ins && ins.value !== undefined),
        filterText: it.filterText, sortText: it.sortText,
        range: r ? { start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } } : undefined
      }
    })
  }
  if (rec.kind === 'hover') {
    const h = await rec.provider.provideHover(doc, pos, token)
    if (!h) return null
    return { contents: h.contents.map((c) => (typeof c === 'string' ? c : c.value !== undefined ? c.value : c.language ? '```' + c.language + '\n' + c.value + '\n```' : String(c))), range: h.range ? { start: { line: h.range.start.line, character: h.range.start.character }, end: { line: h.range.end.line, character: h.range.end.character } } : undefined }
  }
  return null
}

// ============================================================ loading extensions
const loaded = new Map()
let shim = null // the `vscode` module being handed to the extension that is loading

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode' && shim) return shim
  return originalLoad.apply(this, [request, parent, isMain])
}

function memento(file) {
  let data = {}
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { /* new */ }
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)) } catch { /* best effort */ } }
  return { get: (k, d) => (data[k] === undefined ? d : data[k]), update: (k, v) => { if (v === undefined) delete data[k]; else data[k] = v; save(); return Promise.resolve() }, keys: () => Object.keys(data), setKeysForSync() {} }
}

async function activateExtension(ext) {
  try {
    if (ext.kind === 'vscode') {
      for (const [k, v] of Object.entries(ext.config || {})) configDefaults[k] = v
      shim = makeVscode(ext)
      const mod = require(path.join(ext.dir, ext.main))
      shim = null
      const context = {
        subscriptions: [], extensionPath: ext.dir, extensionUri: Uri.file(ext.dir), extension: { id: ext.id, extensionPath: ext.dir, packageJSON: ext.pkg || {} },
        globalState: memento(path.join(ext.storage, 'global.json')), workspaceState: memento(path.join(ext.storage, 'workspace.json')),
        globalStorageUri: Uri.file(ext.storage), storageUri: Uri.file(ext.storage), storagePath: ext.storage, globalStoragePath: ext.storage, logUri: Uri.file(ext.storage), logPath: ext.storage,
        asAbsolutePath: (p) => path.join(ext.dir, p), extensionMode: 1, environmentVariableCollection: { replace() {}, append() {}, prepend() {}, clear() {} }, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} }
      }
      loaded.set(ext.id, { mod, context })
      if (mod && typeof mod.activate === 'function') await mod.activate(context)
    } else {
      const mod = require(path.join(ext.dir, ext.main))
      loaded.set(ext.id, { mod })
      if (mod && typeof mod.activate === 'function') await mod.activate(makeIdeApi(ext))
    }
  } catch (e) {
    shim = null
    log('Extension ' + ext.id + ' failed to start: ' + (e && e.stack || e))
  }
}

process.on('message', async (msg) => {
  try {
    if (msg.type === 'init') {
      root = msg.root || null
      pendingRestore = Array.isArray(msg.restore) ? msg.restore : []
      for (const ext of msg.exts) await activateExtension(ext)
      process.send({ type: 'ready' })
    } else if (msg.type === 'run') {
      const fn = handlers.get(msg.ext + ':' + msg.command) || commandRegistry.get(msg.command)
      if (!fn) return process.send({ type: 'done', runId: msg.runId, error: 'The extension did not register the command ' + msg.command + '.' })
      // a file given as { $uri: path } reaches the command as a vscode.Uri (what the editor's menus pass)
      const callArgs = (Array.isArray(msg.args) ? msg.args : []).map((a) => (a && typeof a === 'object' && typeof a.$uri === 'string' ? Uri.file(a.$uri) : a))
      try { await fn(...callArgs); process.send({ type: 'done', runId: msg.runId }) } catch (e) { process.send({ type: 'done', runId: msg.runId, error: String(e && e.message || e) }) }
    } else if (msg.type === 'response') {
      const w = waiting.get(msg.reqId)
      if (w) { waiting.delete(msg.reqId); msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result) }
    } else if (msg.type === 'editorState') {
      const before = editorState
      editorState = msg.state
      if (!before || !msg.state || before.path !== msg.state.path) for (const f of listeners.activeEditor) { try { f(msg.state ? makeEditor(msg.state) : undefined) } catch (e) { log(String(e && e.stack || e)) } }
      else {
        if (before.text !== msg.state.text) for (const f of listeners.textChange) { try { f({ document: makeDocument(msg.state.path, msg.state.language, msg.state.text), contentChanges: [] }) } catch (e) { log(String(e && e.stack || e)) } }
        for (const f of listeners.selection) { try { const ed = makeEditor(msg.state); f({ textEditor: ed, selections: ed.selections, kind: undefined }) } catch (e) { log(String(e && e.stack || e)) } }
      }
    } else if (msg.type === 'provide') {
      try { process.send({ type: 'provided', reqId: msg.reqId, result: await provide(msg) }) } catch (e) { process.send({ type: 'provided', reqId: msg.reqId, error: String(e && e.message || e) }) }
    }
  } catch (e) {
    log(String(e && e.stack || e))
  }
})
process.on('uncaughtException', (e) => { try { log('Uncaught error in an extension: ' + (e && e.stack || e)) } catch { /* ignore */ } })
process.on('unhandledRejection', (e) => { try { log('Unhandled rejection in an extension: ' + (e && e.stack || e)) } catch { /* ignore */ } })
