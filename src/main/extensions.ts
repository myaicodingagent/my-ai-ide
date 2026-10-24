import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import { ChildProcess, fork } from 'child_process'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import AdmZip from 'adm-zip'
import * as llm from './llm'
import { parseJsonc } from './jsonc'
import { isRemotePath } from './sshfs'
import HOST_SOURCE from './exthost.js?raw'

export { parseJsonc }

// Extensions. This is not the VS Code extension host (that API is huge and tied to VS Code), but it can use a good part
// of what is published for VS Code:
//   themes      from a VS Code theme extension (.vsix): converted into this editor's themes
//   snippets    VS Code snippet files: offered as completions for their language
//   commands    "native" extensions (package.json: "engines": { "my-ai-ide": "*" }) run a small JavaScript file in a
//               separate process; it can add commands to the palette and use a small API (see exthost.js)
// Other parts of VS Code extensions (language servers, grammars, debuggers, webviews, anything that needs the `vscode`
// module) are not supported; the Extensions view says so for each extension it cannot fully use.
// Extension code runs with your user's permissions. Install only extensions you trust.

export interface ExtRecord {
  id: string // publisher.name
  name: string
  publisher: string
  version: string
  displayName: string
  description: string
  dir: string
  enabled: boolean
  native: boolean // written for this editor: runs code in the extension host with the `ide` object
  vscode: boolean // written for VS Code: its code runs in the extension host against a partial `vscode` module
  themes: number
  snippets: number
  commands: { id: string; title: string }[]
  // Tree views the extension adds (their container is "explorer", another built-in one, or one of `containers`).
  views: { container: string; id: string; name: string; webview?: boolean }[]
  containers: { id: string; title: string }[] // extra activity bar entries
  // Menu entries for tree items (contributes.menus["view/item/context"]): what to offer in a node's right-click menu.
  treeMenus: { command: string; title: string; when: string; group: string }[]
  unsupported: string[] // contributions that are ignored (grammars, languages, debuggers...)
  codeIgnored: boolean // a VS Code extension with code (main) that cannot run here
  source: 'vsix' | 'registry' | 'folder'
}

export interface RegistryResult {
  id: string
  namespace: string
  name: string
  displayName: string
  description: string
  version: string
  downloads: number
  download: string
}

const MAX_VSIX_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 20_000
const MAX_UNPACKED = 300 * 1024 * 1024

const extDir = (): string => join(app.getPath('userData'), 'extensions')
const stateFile = (): string => join(extDir(), 'state.json')
const registryBase = (): string => (process.env.MY_AI_IDE_REGISTRY_URL || 'https://open-vsx.org').replace(/\/+$/, '')

let records: ExtRecord[] = []
let loaded = false
let getWinRef: () => BrowserWindow | null = () => null

// ---- Reading an extension folder ----

interface Pkg {
  name?: string
  publisher?: string
  version?: string
  displayName?: string
  description?: string
  main?: string
  engines?: Record<string, string>
  contributes?: Record<string, unknown>
}

const SUPPORTED = new Set(['themes', 'snippets', 'commands', 'configuration', 'colors', 'iconThemes', 'productIconThemes', 'views', 'viewsContainers'])

async function readExtension(dir: string, source: ExtRecord['source']): Promise<ExtRecord> {
  const pkg = parseJsonc(await fs.readFile(join(dir, 'package.json'), 'utf-8')) as Pkg
  if (!pkg.name || typeof pkg.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(pkg.name)) throw new Error('package.json has no valid "name".')
  const publisher = typeof pkg.publisher === 'string' && /^[A-Za-z0-9._-]+$/.test(pkg.publisher) ? pkg.publisher : 'local'
  if (!pkg.version || typeof pkg.version !== 'string') throw new Error('package.json has no "version".')
  const c = (pkg.contributes ?? {}) as Record<string, unknown>
  const list = (k: string): unknown[] => (Array.isArray(c[k]) ? (c[k] as unknown[]) : [])
  const native = !!pkg.engines && Object.prototype.hasOwnProperty.call(pkg.engines, 'my-ai-ide')
  const vscode = !native && typeof pkg.main === 'string'
  const label = (t: unknown, fallback: string): string => (typeof t === 'string' && t && !t.startsWith('%') ? t : fallback)
  const commands =
    native || vscode
      ? list('commands')
          .filter((x): x is { command: string; title?: string; category?: string } => !!x && typeof (x as { command?: unknown }).command === 'string')
          .map((x) => {
            const title = label(x.title, x.command)
            const category = label(x.category, '')
            return { id: x.command, title: category && !title.startsWith(category) ? `${category}: ${title}` : title }
          })
      : []
  const unsupported = Object.keys(c).filter((k) => !SUPPORTED.has(k) && k !== 'menus')
  const menus = (c.menus && typeof c.menus === 'object' ? c.menus : {}) as Record<string, unknown>
  const otherMenus = Object.keys(menus).filter((k) => k !== 'view/item/context')
  if (otherMenus.length) unsupported.push('menus (' + otherMenus.join(', ') + ')')
  const titleOf = new Map(commands.map((x) => [x.id, x.title]))
  const treeMenus: ExtRecord['treeMenus'] = vscode && Array.isArray(menus['view/item/context'])
    ? (menus['view/item/context'] as { command?: unknown; when?: unknown; group?: unknown }[])
        .filter((x) => x && typeof x.command === 'string')
        .map((x) => ({ command: x.command as string, title: titleOf.get(x.command as string) ?? (x.command as string), when: typeof x.when === 'string' ? x.when : '', group: typeof x.group === 'string' ? x.group : '' }))
    : []
  const views: ExtRecord['views'] = []
  if (vscode && c.views && typeof c.views === 'object') {
    for (const [container, arr] of Object.entries(c.views as Record<string, unknown>)) {
      if (!Array.isArray(arr)) continue
      for (const v of arr as { id?: unknown; name?: unknown; type?: unknown }[]) {
        if (v && typeof v.id === 'string') views.push({ container, id: v.id, name: label(v.name, v.id), ...(v.type === 'webview' ? { webview: true } : {}) })
      }
    }
  }
  const bar = (c.viewsContainers as { activitybar?: unknown } | undefined)?.activitybar
  const containers: ExtRecord['containers'] = vscode && Array.isArray(bar)
    ? (bar as { id?: unknown; title?: unknown }[]).filter((x) => x && typeof x.id === 'string').map((x) => ({ id: x.id as string, title: label(x.title, x.id as string) }))
    : []
  return {
    id: `${publisher}.${pkg.name}`,
    name: pkg.name,
    publisher,
    version: pkg.version,
    displayName: typeof pkg.displayName === 'string' && !pkg.displayName.startsWith('%') ? pkg.displayName : pkg.name,
    description: typeof pkg.description === 'string' && !pkg.description.startsWith('%') ? pkg.description : '',
    dir,
    enabled: true,
    native,
    vscode,
    themes: list('themes').length,
    snippets: list('snippets').length,
    commands,
    views,
    containers,
    treeMenus,
    unsupported,
    codeIgnored: false,
    source
  }
}

async function loadState(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const saved = JSON.parse(await fs.readFile(stateFile(), 'utf-8')) as { id: string; dir: string; enabled: boolean; source: ExtRecord['source'] }[]
    for (const s of Array.isArray(saved) ? saved : []) {
      try {
        const r = await readExtension(s.dir, s.source)
        r.enabled = s.enabled !== false
        records.push(r)
      } catch {
        // The folder is gone or broken: it simply drops off the list.
      }
    }
  } catch {
    // No extensions installed yet.
  }
}

async function saveState(): Promise<void> {
  await fs.mkdir(extDir(), { recursive: true })
  await fs.writeFile(stateFile(), JSON.stringify(records.map((r) => ({ id: r.id, dir: r.dir, enabled: r.enabled, source: r.source }))), 'utf-8')
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_')

// ---- Installing ----

export async function installVsix(file: string, source: ExtRecord['source'] = 'vsix'): Promise<ExtRecord> {
  await loadState()
  const stat = await fs.stat(file)
  if (stat.size > MAX_VSIX_BYTES) throw new Error('That package is too large.')
  const zip = new AdmZip(file)
  const entries = zip.getEntries()
  if (entries.length > MAX_ENTRIES) throw new Error('That package has too many files.')
  const prefix = entries.some((e) => e.entryName === 'extension/package.json') ? 'extension/' : entries.some((e) => e.entryName === 'package.json') ? '' : null
  if (prefix === null) throw new Error('This is not an extension package (no extension/package.json inside).')
  let total = 0
  for (const e of entries) total += e.header.size
  if (total > MAX_UNPACKED) throw new Error('That package is too large when unpacked.')

  const tmp = join(extDir(), '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  await fs.mkdir(tmp, { recursive: true })
  try {
    for (const e of entries) {
      if (e.isDirectory || !e.entryName.startsWith(prefix)) continue
      const rel = e.entryName.slice(prefix.length)
      const dest = resolve(tmp, rel)
      const back = relative(tmp, dest)
      if (!rel || back.startsWith('..') || isAbsolute(back)) throw new Error(`The package contains an unsafe path: ${e.entryName}`)
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.writeFile(dest, e.getData())
    }
    const rec = await readExtension(tmp, source)
    const final = join(extDir(), `${safeName(rec.id)}-${safeName(rec.version)}`)
    await fs.rm(final, { recursive: true, force: true })
    await fs.rename(tmp, final)
    rec.dir = final
    // Replace an older install of the same extension, keeping whether it was enabled.
    const old = records.find((r) => r.id === rec.id)
    if (old) {
      rec.enabled = old.enabled
      if (old.dir !== final) await fs.rm(old.dir, { recursive: true, force: true })
      records = records.filter((r) => r.id !== rec.id)
    }
    records.push(rec)
    await saveState()
    return rec
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
}

async function installFolder(dir: string): Promise<ExtRecord> {
  await loadState()
  const rec = await readExtension(dir, 'folder')
  const final = join(extDir(), `${safeName(rec.id)}-${safeName(rec.version)}`)
  await fs.rm(final, { recursive: true, force: true })
  await fs.cp(dir, final, { recursive: true, filter: (src) => basename(src) !== 'node_modules' && basename(src) !== '.git' })
  rec.dir = final
  records = records.filter((r) => r.id !== rec.id)
  records.push(rec)
  await saveState()
  return rec
}

async function uninstall(id: string): Promise<void> {
  await loadState()
  const r = records.find((x) => x.id === id)
  if (!r) return
  records = records.filter((x) => x !== r)
  await fs.rm(r.dir, { recursive: true, force: true })
  await saveState()
}

// ---- Registry (Open VSX) ----

async function searchRegistry(query: string): Promise<RegistryResult[]> {
  const url = `${registryBase()}/api/-/search?query=${encodeURIComponent(query)}&size=20&sortBy=relevance&sortOrder=desc`
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`The extension registry answered ${res.status}.`)
  const data = (await res.json()) as { extensions?: any[] }
  return (data.extensions ?? []).slice(0, 20).map((x) => ({
    id: `${x.namespace}.${x.name}`,
    namespace: String(x.namespace),
    name: String(x.name),
    displayName: String(x.displayName || x.name),
    description: String(x.description || ''),
    version: String(x.version || ''),
    downloads: Number(x.downloadCount || 0),
    download: String(x.files?.download || '')
  }))
}

async function installFromRegistry(result: RegistryResult): Promise<ExtRecord> {
  if (!/^https?:\/\//.test(result.download)) throw new Error('This extension has no download link.')
  const res = await fetch(result.download, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`The download failed (${res.status}).`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_VSIX_BYTES) throw new Error('That package is too large.')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_VSIX_BYTES) throw new Error('That package is too large.')
  await fs.mkdir(extDir(), { recursive: true })
  const tmp = join(extDir(), `.dl-${Date.now()}.vsix`)
  await fs.writeFile(tmp, buf)
  try {
    return await installVsix(tmp, 'registry')
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

// ---- Themes: VS Code theme JSON -> this editor's theme format ----

type Json = Record<string, any>

async function readThemeFile(file: string, depth = 0): Promise<Json> {
  const t = parseJsonc(await fs.readFile(file, 'utf-8')) as Json
  if (typeof t.include === 'string' && depth < 4) {
    const parent = await readThemeFile(resolve(dirname(file), t.include), depth + 1).catch(() => ({}) as Json)
    return {
      ...parent,
      ...t,
      colors: { ...(parent.colors ?? {}), ...(t.colors ?? {}) },
      tokenColors: [...(parent.tokenColors ?? []), ...(t.tokenColors ?? [])]
    }
  }
  return t
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** #rgb / #rgba / #rrggbb / #rrggbbaa -> #rrggbb, blended over `over` when it has transparency. */
export function solid(v: unknown, over = '#000000'): string | null {
  if (typeof v !== 'string' || !HEX.test(v.trim())) return null
  let h = v.trim().slice(1).toLowerCase()
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
  if (a < 1) {
    const o = HEX.test(over) ? [1, 3, 5].map((i) => parseInt(over.slice(i, i + 2), 16)) : [0, 0, 0]
    return '#' + rgb.map((c, i) => Math.round(c * a + o[i] * (1 - a)).toString(16).padStart(2, '0')).join('')
  }
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('')
}

const tokenColor = (theme: Json, scopes: string[]): string | null => {
  // The most specific rule wins: the longest matching scope prefix, and later rules win ties.
  let best: { score: number; color: string } | null = null
  for (const rule of Array.isArray(theme.tokenColors) ? theme.tokenColors : []) {
    const fg = rule?.settings?.foreground
    if (typeof fg !== 'string') continue
    const rs: string[] = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === 'string' ? rule.scope.split(',').map((s: string) => s.trim()) : []
    for (const want of scopes) {
      for (const r of rs) {
        if (want === r || want.startsWith(r + '.')) {
          const score = r.length
          const c = solid(fg)
          if (c && (!best || score >= best.score)) best = { score, color: c }
        }
      }
    }
  }
  return best?.color ?? null
}

export function convertTheme(vs: Json, label: string, uiTheme: string): string {
  const colors: Json = vs.colors ?? {}
  const type = uiTheme === 'vs' ? 'light' : uiTheme === 'hc-black' || uiTheme === 'hc-light' ? 'hc' : 'dark'
  const bg = solid(colors['editor.background']) ?? (type === 'light' ? '#ffffff' : '#1e1e1e')
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const c = solid(colors[k], bg)
      if (c) return c
    }
    return undefined
  }
  const ui: Json = {
    bg,
    side: pick('sideBar.background', 'activityBar.background', 'editorGroupHeader.tabsBackground'),
    sunken: pick('input.background', 'editorWidget.background', 'dropdown.background'),
    hover: pick('list.hoverBackground', 'toolbar.hoverBackground'),
    active: pick('list.activeSelectionBackground', 'tab.activeBackground'),
    border: pick('sideBar.border', 'panel.border', 'editorGroup.border', 'contrastBorder'),
    fg: pick('editor.foreground', 'foreground'),
    muted: pick('descriptionForeground', 'editorLineNumber.foreground', 'tab.inactiveForeground'),
    accent: pick('button.background', 'focusBorder', 'textLink.foreground', 'activityBarBadge.background'),
    onAccent: pick('button.foreground', 'activityBarBadge.foreground'),
    danger: pick('errorForeground', 'editorError.foreground'),
    ok: pick('diffEditor.insertedTextBackground', 'editorGutter.addedBackground'),
    sel: pick('editor.selectionBackground', 'list.activeSelectionBackground')
  }
  for (const k of Object.keys(ui)) if (ui[k] === undefined) delete ui[k]
  const syn = (...scopes: string[]): string | undefined => tokenColor(vs, scopes) ?? undefined
  const syntax: Json = {
    comment: syn('comment'),
    keyword: syn('keyword', 'storage'),
    string: syn('string'),
    number: syn('constant.numeric'),
    type: syn('entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'storage.type'),
    func: syn('entity.name.function', 'support.function', 'meta.function-call'),
    variable: syn('variable', 'variable.other.readwrite'),
    constant: syn('constant.language', 'support.constant', 'variable.other.constant', 'constant'),
    tag: syn('entity.name.tag'),
    attr: syn('entity.other.attribute-name')
  }
  for (const k of Object.keys(syntax)) if (syntax[k] === undefined) delete syntax[k]
  return JSON.stringify({ name: label, type, base: type === 'light' ? 'light-modern' : type === 'hc' ? 'high-contrast' : 'dark-modern', ui, syntax }, null, 2)
}

/** The enabled extensions' themes, converted, in the shape `themes:list` returns for theme files. */
export async function extensionThemes(): Promise<{ file: string; text: string }[]> {
  await loadState()
  const out: { file: string; text: string }[] = []
  for (const r of records.filter((x) => x.enabled)) {
    try {
      const pkg = parseJsonc(await fs.readFile(join(r.dir, 'package.json'), 'utf-8')) as Pkg
      const themes = Array.isArray(pkg.contributes?.themes) ? (pkg.contributes!.themes as { label?: string; uiTheme?: string; path?: string }[]) : []
      for (const t of themes.slice(0, 20)) {
        if (!t.path || typeof t.path !== 'string') continue
        const file = resolve(r.dir, t.path)
        const back = relative(r.dir, file)
        if (back.startsWith('..') || isAbsolute(back)) continue
        try {
          const label = (t.label && !t.label.startsWith('%') ? t.label : basename(t.path, '.json')).slice(0, 40)
          out.push({ file: `ext-${safeName(r.id)}-${safeName(label)}.json`, text: convertTheme(await readThemeFile(file), label, t.uiTheme ?? 'vs-dark') })
        } catch {
          // A theme file that cannot be read or converted is skipped; the others still load.
        }
      }
    } catch {
      // Unreadable extension: skip it.
    }
  }
  return out
}

// ---- Snippets ----

export interface SnippetSet {
  language: string
  snippets: { prefix: string; body: string; description: string }[]
}

export async function extensionSnippets(): Promise<SnippetSet[]> {
  await loadState()
  const sets: SnippetSet[] = []
  for (const r of records.filter((x) => x.enabled)) {
    try {
      const pkg = parseJsonc(await fs.readFile(join(r.dir, 'package.json'), 'utf-8')) as Pkg
      const list = Array.isArray(pkg.contributes?.snippets) ? (pkg.contributes!.snippets as { language?: string; path?: string }[]) : []
      for (const s of list.slice(0, 50)) {
        if (!s.language || !s.path) continue
        const file = resolve(r.dir, s.path)
        const back = relative(r.dir, file)
        if (back.startsWith('..') || isAbsolute(back)) continue
        try {
          const data = parseJsonc(await fs.readFile(file, 'utf-8')) as Record<string, { prefix?: string | string[]; body?: string | string[]; description?: string }>
          const snippets: SnippetSet['snippets'] = []
          for (const [name, def] of Object.entries(data ?? {})) {
            if (!def || def.body === undefined) continue
            const body = Array.isArray(def.body) ? def.body.join('\n') : String(def.body)
            for (const prefix of Array.isArray(def.prefix) ? def.prefix : def.prefix ? [def.prefix] : [name]) {
              snippets.push({ prefix: String(prefix), body, description: String(def.description ?? name) })
            }
          }
          if (snippets.length) sets.push({ language: s.language, snippets: snippets.slice(0, 2000) })
        } catch {
          // Skip a snippet file that cannot be read.
        }
      }
    } catch {
      // Unreadable extension: skip it.
    }
  }
  return sets
}

// ---- Extension host: native extensions run in a separate process ----

interface Host {
  child: ChildProcess
  ready: Promise<void>
  runs: Map<number, { resolve: () => void; reject: (e: Error) => void }>
}

let host: Host | null = null
let hostLog: string[] = []
let currentRoot: string | null = null

// Folders a webview may read files from (through the vscode-webview-resource protocol): the extension's own folder, the
// folders it names in localResourceRoots, and the open project.
const webviewRoots = new Set<string>()
// The HTML each webview panel was given; the editor shows it in a frame that loads it from the vscode-webview-resource
// protocol (so it has an address and security rules of its own, not the editor's).
const webviewPages = new Map<string, string>()

// What the page needs to talk to its extension: acquireVsCodeApi(), as VS Code's own webviews have. The state a page keeps
// with setState() is sent to the editor, which remembers it (also across restarts, for panels with a serializer).
const webviewApi = (state: unknown): string => `const __state = { v: ${JSON.stringify(state === undefined ? null : state).replace(/</g, '\\u003c')} }
if (__state.v === null) __state.v = undefined
window.acquireVsCodeApi = () => ({
  postMessage: (message) => parent.postMessage({ __vscodeWebview: true, message }, '*'),
  getState: () => __state.v,
  setState: (s) => { __state.v = s; parent.postMessage({ __vscodeWebview: true, __vscodeState: true, state: s === undefined ? null : s }, '*'); return s }
})`

// The panels that are open (tabs, not side bar views): kept on disk so that an extension that registers a
// WebviewPanelSerializer for their type is asked to bring them back when the editor starts again.
interface PanelEntry {
  viewType: string
  title: string
  extId: string
  state: unknown
}
const panelStore = new Map<string, PanelEntry>()
let panelFileTimer: NodeJS.Timeout | null = null
const panelFile = (): string => join(extDir(), 'webview-panels.json')
function savePanels(): void {
  if (panelFileTimer) return
  panelFileTimer = setTimeout(() => {
    panelFileTimer = null
    void fs.mkdir(extDir(), { recursive: true }).then(() => fs.writeFile(panelFile(), JSON.stringify([...panelStore.values()]), 'utf-8')).catch(() => undefined)
  }, 300)
}
async function readSavedPanels(): Promise<PanelEntry[]> {
  try {
    const list = JSON.parse(await fs.readFile(panelFile(), 'utf-8')) as PanelEntry[]
    return Array.isArray(list) ? list.filter((x) => x && typeof x.viewType === 'string' && typeof x.extId === 'string').slice(0, 50) : []
  } catch {
    return []
  }
}

export function webviewPage(id: string): string | null {
  const html = webviewPages.get(id)
  if (html === undefined) return null
  // A page with a Content-Security-Policy that allows scripts only by nonce would block ours: give it the same nonce.
  const nonce = /nonce-([A-Za-z0-9+/=_-]+)/.exec(html)?.[1]
  const tag = `<script${nonce ? ` nonce="${nonce}"` : ''}>${webviewApi(panelStore.get(id)?.state)}</script>`
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html
}

export function webviewMayRead(file: string): boolean {
  const norm = (p: string): string => p.split('\\').join('/').toLowerCase().replace(/\/+$/, '')
  const f = norm(file)
  const roots = [...records.filter((r) => r.enabled).map((r) => r.dir), ...webviewRoots, ...(currentRoot ? [currentRoot] : [])]
  return !f.includes('/../') && roots.some((r) => f.startsWith(norm(r) + '/'))
}
let nextRun = 1
let nextReq = 1_000_000
const provideWaiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const rendererWaiting = new Map<number, (r: { result?: unknown; error?: string }) => void>()

const logLine = (t: string): void => {
  hostLog = [...hostLog, t].slice(-50)
  getWinRef()?.webContents.send('ext:log', hostLog)
}

// Extensions that add things to the editor (diagnostics, completions, status items) must be running from the start,
// so the host is started whenever there is at least one enabled extension with code.
function restartHost(): void {
  stopHost()
  void startHost().catch(() => undefined)
}

function stopHost(): void {
  hostGen++
  // What the old host added to the editor (completions, diagnostics, status items) goes with it.
  getWinRef()?.webContents.send('ext:request', { reqId: 0, method: 'reset', params: {} })
  if (!host) return
  try {
    host.child.kill()
  } catch {
    // already gone
  }
  host = null
}

async function aiAsk(prompt: string): Promise<string> {
  if (!(await llm.ready())) throw new Error(llm.notReady)
  return llm.text({ prompt: prompt.slice(0, 40_000), maxTokens: 1500 })
}

async function hostRequest(method: string, params: any): Promise<unknown> {
  const root = currentRoot
  switch (method) {
    case 'readFile':
    case 'writeFile': {
      if (!root) throw new Error('No folder is open.')
      const abs = resolve(root, String(params.rel))
      const back = relative(root, abs)
      if (back.startsWith('..') || isAbsolute(back)) throw new Error('That path is outside the project folder.')
      if (method === 'readFile') return fs.readFile(abs, 'utf-8')
      await fs.mkdir(dirname(abs), { recursive: true })
      await fs.writeFile(abs, String(params.text), 'utf-8')
      getWinRef()?.webContents.send('ext:request', { reqId: 0, method: 'fileChanged', params: { path: abs } })
      return null
    }
    case 'aiAsk':
      return aiAsk(String(params.prompt))
    case 'clipboardWrite':
      clipboard?.writeText?.(String(params.text ?? ''))
      return null
    default: {
      // Everything else is about the editor window.
      const win = getWinRef()
      if (!win) throw new Error('The editor window is not available.')
      const reqId = nextReq++
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          rendererWaiting.delete(reqId)
          rej(new Error('The editor did not answer in time.'))
        }, 120_000)
        rendererWaiting.set(reqId, (r) => {
          clearTimeout(timer)
          r.error ? rej(new Error(r.error)) : res(r.result)
        })
        win.webContents.send('ext:request', { reqId, method, params })
      })
    }
  }
}

// The default of every setting an extension declares, so getConfiguration().get() has answers.
function configDefaults(pkg: Pkg): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const conf = pkg.contributes?.configuration
  for (const block of Array.isArray(conf) ? conf : conf ? [conf] : []) {
    const props = (block as { properties?: Record<string, { default?: unknown }> }).properties ?? {}
    for (const [k, v] of Object.entries(props)) if (v && 'default' in v) out[k] = v.default
  }
  return out
}

// Starting takes a moment, and a change (an install, a switch of folder) can ask for a restart meanwhile: only one start
// is ever in flight, and one that has been overtaken by a stop gives up.
let hostGen = 0
let starting: { gen: number; p: Promise<Host | null> } | null = null

async function startHost(): Promise<Host | null> {
  if (host) return host
  if (starting && starting.gen === hostGen) return starting.p
  const gen = hostGen
  const p: Promise<Host | null> = doStartHost(gen).finally(() => {
    if (starting?.p === p) starting = null
  })
  starting = { gen, p }
  return p
}

async function doStartHost(gen: number): Promise<Host | null> {
  if (host) return host
  await loadState()
  const exts: { id: string; dir: string; main: string; kind: 'native' | 'vscode'; storage: string; config: Record<string, unknown>; pkg: Record<string, unknown> }[] = []
  for (const r of records.filter((x) => x.enabled && (x.native || x.vscode))) {
    try {
      const pkg = parseJsonc(await fs.readFile(join(r.dir, 'package.json'), 'utf-8')) as Pkg
      if (typeof pkg.main !== 'string') continue
      const main = resolve(r.dir, pkg.main)
      const back = relative(r.dir, main)
      if (back.startsWith('..') || isAbsolute(back)) continue
      exts.push({
        id: r.id,
        dir: r.dir,
        main: pkg.main,
        kind: r.native ? 'native' : 'vscode',
        storage: join(extDir(), '.storage', safeName(r.id)),
        config: configDefaults(pkg),
        pkg: { name: pkg.name, publisher: r.publisher, version: pkg.version, displayName: r.displayName }
      })
    } catch {
      // skipped
    }
  }
  if (exts.length === 0 || gen !== hostGen) return null
  await fs.mkdir(extDir(), { recursive: true })
  if (gen !== hostGen) return null
  const hostFile = join(extDir(), '.host.cjs')
  await fs.writeFile(hostFile, HOST_SOURCE, 'utf-8')
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  const child = fork(hostFile, [], { env, execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' })
  const runs = new Map<number, { resolve: () => void; reject: (e: Error) => void }>()
  let readyResolve: () => void = () => undefined
  const ready = new Promise<void>((r) => (readyResolve = r))
  const h: Host = { child, ready, runs }
  host = h
  child.stdout?.on('data', (b: Buffer) => logLine(b.toString('utf-8').trimEnd()))
  child.stderr?.on('data', (b: Buffer) => logLine(b.toString('utf-8').trimEnd()))
  child.on('message', async (m: any) => {
    if (m.type === 'ready') readyResolve()
    else if (m.type === 'log') logLine(String(m.text))
    else if (m.type === 'done') {
      const r = runs.get(m.runId)
      runs.delete(m.runId)
      if (r) m.error ? r.reject(new Error(m.error)) : r.resolve()
    } else if (m.type === 'provided') {
      const p = provideWaiting.get(m.reqId)
      provideWaiting.delete(m.reqId)
      if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.result)
    } else if (m.type === 'request' && m.reqId === 0) {
      // Something that needs no answer (a status bar item, a diagnostic, registering a provider...).
      if (m.method === 'webviewHtml') webviewPages.set(String(m.params?.id), String(m.params?.html ?? ''))
      if (m.method === 'webviewDispose') {
        webviewPages.delete(String(m.params?.id))
        if (panelStore.delete(String(m.params?.id))) savePanels()
      }
      if (m.method === 'webviewTitle' && panelStore.has(String(m.params?.id))) {
        panelStore.get(String(m.params.id))!.title = String(m.params.title ?? '')
        savePanels()
      }
      if (m.method === 'webviewCreate' && m.params?.view !== true) {
        panelStore.set(String(m.params.id), { viewType: String(m.params.viewType), title: String(m.params.title ?? ''), extId: String(m.params.extId), state: m.params.state ?? null })
        savePanels()
      }
      if (m.method === 'webviewCreate') for (const r of Array.isArray(m.params?.roots) ? m.params.roots : []) webviewRoots.add(String(r))
      if (m.method === 'clipboardWrite') clipboard?.writeText?.(String(m.params?.text ?? ''))
      else getWinRef()?.webContents.send('ext:request', { reqId: 0, method: m.method, params: m.params })
    } else if (m.type === 'request') {
      try {
        child.send({ type: 'response', reqId: m.reqId, result: (await hostRequest(m.method, m.params)) ?? null })
      } catch (e) {
        child.send({ type: 'response', reqId: m.reqId, error: e instanceof Error ? e.message : String(e) })
      }
    }
  })
  child.on('exit', (code) => {
    if (host === h) host = null
    for (const r of runs.values()) r.reject(new Error('The extension host stopped.'))
    runs.clear()
    readyResolve()
    if (code) logLine(`The extension host stopped (exit code ${code}).`)
  })
  // Panels that were open when the editor was closed: an extension with a serializer for their type gets them back. What
  // nobody claims is forgotten, except panels of extensions that are not running (disabled, or not installed any more).
  const saved = panelStore.size ? [...panelStore.values()] : await readSavedPanels()
  const restore = saved.filter((p) => exts.some((x) => x.id === p.extId))
  panelStore.clear()
  saved.filter((p) => !exts.some((x) => x.id === p.extId)).forEach((p, i) => panelStore.set('kept:' + i, p))
  child.send({ type: 'init', exts, root: currentRoot, restore })
  return h
}

async function runCommand(extId: string, command: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const h = (await startHost()) ?? (await startHost()) // once more if a restart overtook the first
    if (!h) return { ok: false, error: 'No extension is running.' }
    await h.ready
    const runId = nextRun++
    await new Promise<void>((resolveRun, rejectRun) => {
      h.runs.set(runId, { resolve: resolveRun, reject: rejectRun })
      h.child.send({ type: 'run', runId, ext: extId, command })
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---- IPC ----

const changed = (): void => getWinRef()?.webContents.send('ext:changed')

export function registerExtensionHandlers(getWin: () => BrowserWindow | null): void {
  getWinRef = getWin
  ipcMain.handle('ext:list', async () => {
    await loadState()
    return records
  })
  ipcMain.handle('ext:setRoot', async (_e, root: string | null) => {
    if (isRemotePath(root)) root = null // extensions work on this PC's files
    if (currentRoot !== root) {
      currentRoot = root
      restartHost()
    }
  })
  ipcMain.handle('ext:installVsix', async (_e, file?: string) => {
    try {
      let path = file
      if (!path) {
        const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Extension package', extensions: ['vsix', 'zip'] }] })
        if (res.canceled || !res.filePaths[0]) return { ok: false as const, error: 'cancelled' }
        path = res.filePaths[0]
      }
      const rec = await installVsix(path)
      restartHost()
      changed()
      return { ok: true as const, ext: rec }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ext:installFolder', async () => {
    try {
      const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (res.canceled || !res.filePaths[0]) return { ok: false as const, error: 'cancelled' }
      const rec = await installFolder(res.filePaths[0])
      restartHost()
      changed()
      return { ok: true as const, ext: rec }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ext:search', async (_e, query: string) => {
    try {
      return { ok: true as const, results: await searchRegistry(String(query ?? '')) }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e), results: [] as RegistryResult[] }
    }
  })
  ipcMain.handle('ext:installRegistry', async (_e, result: RegistryResult) => {
    try {
      const rec = await installFromRegistry(result)
      restartHost()
      changed()
      return { ok: true as const, ext: rec }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ext:setEnabled', async (_e, id: string, enabled: boolean) => {
    await loadState()
    const r = records.find((x) => x.id === id)
    if (r) {
      r.enabled = enabled
      await saveState()
      restartHost()
      changed()
    }
  })
  ipcMain.handle('ext:uninstall', async (_e, id: string) => {
    await uninstall(id)
    stopHost()
    changed()
  })
  ipcMain.handle('ext:snippets', () => extensionSnippets())
  // What the editor shows (open file, selection): extensions read it through vscode.window.activeTextEditor.
  ipcMain.handle('ext:editorState', (_e, state: unknown) => {
    host?.child.send({ type: 'editorState', state })
  })
  // The editor asks an extension's provider (completions, hover) for an answer.
  // The state a page keeps with setState(): remembered for the panel (and for the page when it is loaded again).
  ipcMain.handle('ext:webviewState', (_e, id: string, state: unknown) => {
    const p = panelStore.get(String(id))
    if (!p) return
    if (JSON.stringify(state ?? null).length > 1_000_000) return
    p.state = state ?? null
    savePanels()
  })
  ipcMain.handle('ext:provide', async (_e, providerId: string, kind: string, params: unknown) => {
    if (kind === 'webviewClosed' && panelStore.delete(String(providerId))) savePanels()
    const h = host
    if (!h) return null
    const reqId = nextReq++
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        provideWaiting.delete(reqId)
        res(null)
      }, 10_000)
      provideWaiting.set(reqId, { resolve: (v) => (clearTimeout(timer), res(v)), reject: (e) => (clearTimeout(timer), rej(e)) })
      h.child.send({ type: 'provide', reqId, providerId, kind, params })
    })
  })
  ipcMain.handle('ext:run', (_e, extId: string, command: string) => runCommand(extId, command))
  ipcMain.handle('ext:log', () => hostLog)
  ipcMain.handle('ext:openFolder', async () => {
    await fs.mkdir(extDir(), { recursive: true })
    return (await shell.openPath(extDir())) || null
  })
  // The editor's answer to something an extension asked for.
  ipcMain.handle('ext:respond', (_e, reqId: number, r: { result?: unknown; error?: string }) => {
    rendererWaiting.get(reqId)?.(r)
    rendererWaiting.delete(reqId)
  })
}

export function stopExtensions(): void {
  stopHost()
}
