import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron'
import { pathToFileURL } from 'url'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { promises as fs, statSync } from 'fs'
import * as pty from '@lydell/node-pty'
import { registerAiHandlers } from './ai'
import { registerBackendHandlers } from './backend'
import { registerAgentHandlers } from './agent'
import { registerUpdater } from './updater'
import { registerGitHandlers } from './git'
import { registerFsOps } from './fsops'
import { registerRulesHandlers } from './rules'
import { registerCodeIndexHandlers } from './codeindex'
import { registerBackgroundHandlers, stopAllBackground } from './background'
import { registerDebugHandlers, stopDebugging } from './debugger'
import { extensionThemes, registerExtensionHandlers, stopExtensions } from './extensions'
import { registerTaskHandlers } from './tasks'
import { notebookPage, registerNotebookHandlers, stopAllKernels } from './notebook'
import { webviewMayRead, webviewPage } from './extensions'
import { registerLspHandlers, stopAllLanguageServers } from './lsp'
import * as ssh from './sshfs'
import { parseJsonc } from './jsonc'
import { execFile } from 'child_process'
import { parseWslList, sshArgs, validSshTarget, wslLocation, wslShellArgs } from './shellspec'

interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

let mainWin: BrowserWindow | null = null
const terminals = new Map<number, pty.IPty>()
let nextTermId = 1
const IGNORED = new Set(['.git', 'node_modules', 'out', 'dist'])

// A folder passed on the command line (e.g. `"My AI IDE.exe" C:\code\project`) opens at startup.
function folderFromArgs(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  for (const a of args) {
    if (a.startsWith('-')) continue
    try {
      if (statSync(a).isDirectory()) return resolve(a)
    } catch {
      // Not a path that exists; ignore it.
    }
  }
  return null
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1e1e1e',
    title: 'My AI IDE',
    // The menu bar is drawn in the title bar (see MenuBar); the system draws only the window buttons, over its right end.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#252526', symbolColor: '#cccccc', height: 30 } }),
    // The packaged exe carries its own icon; this is for `npm run dev`.
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWin = win
  win.setMenuBarVisibility(false)

  // The app only ever shows its own UI: refuse pop-ups and navigation to anything else.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  // The renderer blocks unload while files have unsaved edits; ask before throwing them away.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'You have files with unsaved changes. Close anyway?'
    })
    if (choice === 1) e.preventDefault() // preventDefault here means "go ahead and unload"
  })
  win.on('closed', () => {
    terminals.forEach((t) => t.kill())
    terminals.clear()
    mainWin = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('app:initialFolder', () => folderFromArgs())

ipcMain.handle('fs:isDir', (_e, p: string) => {
  if (ssh.isRemotePath(p)) return ssh.isDir(p)
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
})

ipcMain.handle('app:toggleDevTools', () => mainWin?.webContents.toggleDevTools())

// ---- Custom themes: JSON files in <app data>/themes. The renderer validates them. ----
const themesDir = (): string => join(app.getPath('userData'), 'themes')
const MAX_THEME_FILES = 50
const MAX_THEME_BYTES = 100_000

const EXAMPLE_THEME = `{
  "name": "My Theme",
  "type": "dark",
  "base": "dark-modern",
  "ui": {
    "bg": "#1b1d2b",
    "side": "#161824",
    "accent": "#ff6ac1"
  },
  "syntax": {
    "keyword": "#ff6ac1",
    "string": "#5af78e",
    "comment": "#686868"
  }
}
`

// Picks a file name that does not exist yet (name.json, name-2.json, ...).
async function uniqueThemeFile(base: string): Promise<string> {
  const stem = base.toLowerCase().replace(/\\.json$/i, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}.json` : `${stem}-${n}.json`
    try {
      await fs.access(join(themesDir(), name))
    } catch {
      return name
    }
  }
}

ipcMain.handle('themes:list', async () => {
  await fs.mkdir(themesDir(), { recursive: true })
  const out: { file: string; text: string }[] = []
  // Files starting with "_" are ignored, so the example can sit in the folder.
  const files = (await fs.readdir(themesDir())).filter((f) => f.toLowerCase().endsWith('.json') && !f.startsWith('_'))
  for (const file of files.slice(0, MAX_THEME_FILES)) {
    const full = join(themesDir(), file)
    const stat = await fs.stat(full).catch(() => null)
    if (!stat || !stat.isFile()) continue
    if (stat.size > MAX_THEME_BYTES) out.push({ file, text: '' }) // reported as an error by the renderer
    else out.push({ file, text: await fs.readFile(full, 'utf-8') })
  }
  // Themes that installed extensions bring along.
  out.push(...(await extensionThemes().catch(() => [])))
  return out
})

ipcMain.handle('themes:openFolder', async () => {
  await fs.mkdir(themesDir(), { recursive: true })
  const example = join(themesDir(), '_example-theme.json')
  await fs.access(example).catch(() => fs.writeFile(example, EXAMPLE_THEME, 'utf-8'))
  const err = await shell.openPath(themesDir())
  return err || null
})

ipcMain.handle('themes:import', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Theme (JSON)', extensions: ['json'] }] })
  if (res.canceled || !res.filePaths[0]) return { ok: false as const, error: 'cancelled' }
  const src = res.filePaths[0]
  const stat = await fs.stat(src)
  if (stat.size > MAX_THEME_BYTES) return { ok: false as const, error: 'That file is too large to be a theme.' }
  const text = await fs.readFile(src, 'utf-8')
  try {
    JSON.parse(text)
  } catch {
    return { ok: false as const, error: 'That file is not valid JSON.' }
  }
  await fs.mkdir(themesDir(), { recursive: true })
  const file = await uniqueThemeFile(src.split(/[\\/]/).pop() ?? 'theme')
  await fs.writeFile(join(themesDir(), file), text, 'utf-8')
  return { ok: true as const, file }
})

ipcMain.handle('themes:save', async (_e, name: string, text: string) => {
  if (typeof text !== 'string' || text.length > MAX_THEME_BYTES) throw new Error('Invalid theme data.')
  await fs.mkdir(themesDir(), { recursive: true })
  const file = await uniqueThemeFile(String(name))
  await fs.writeFile(join(themesDir(), file), text, 'utf-8')
  return file
})

// The window buttons that the system draws over the custom title bar take the colors of the theme.
ipcMain.handle('app:setTitleBar', (_e, color: string, symbolColor: string) => {
  if (process.platform === 'darwin' || !mainWin || mainWin.isDestroyed()) return
  const ok = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)
  if (!ok(color) || !ok(symbolColor)) return
  try {
    mainWin.setTitleBarOverlay({ color, symbolColor, height: 30 })
  } catch {
    // no overlay on this system
  }
})

// Keeps the title bar, dialogs and native scrollbars in step with the chosen theme.
ipcMain.handle('app:setNativeTheme', (_e, type: 'light' | 'dark') => {
  nativeTheme.themeSource = type === 'light' ? 'light' : 'dark'
})

// Tests answer the native dialogs through environment variables instead of showing them (like MY_AI_IDE_NO_TRASH).
ipcMain.handle('dialog:openFolder', async () => {
  if (process.env.MY_AI_IDE_TEST_OPEN_FOLDER) return process.env.MY_AI_IDE_TEST_OPEN_FOLDER
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return res.canceled ? null : res.filePaths[0]
})

// .code-workspace files: a list of folders (relative to the file or absolute) plus settings, which are ignored.
ipcMain.handle('workspace:open', async (): Promise<{ file: string; folders: string[] } | { error: string } | null> => {
  const testFile = process.env.MY_AI_IDE_TEST_WORKSPACE_FILE
  const res = testFile ? { canceled: false, filePaths: [testFile] } : await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Workspace', extensions: ['code-workspace'] }] })
  if (res.canceled) return null
  const file = res.filePaths[0]
  try {
    const data = parseJsonc(await fs.readFile(file, 'utf-8')) as { folders?: { path?: unknown; uri?: unknown }[] }
    const base = dirname(file)
    const folders: string[] = []
    for (const f of Array.isArray(data?.folders) ? data.folders : []) {
      if (typeof f?.path !== 'string') continue
      const dir = isAbsolute(f.path) ? f.path : resolve(base, f.path)
      if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) folders.push(dir)
    }
    if (folders.length === 0) return { error: 'That workspace file has no folders that exist on this PC.' }
    return { file, folders }
  } catch (e) {
    return { error: `Could not read the workspace file: ${e instanceof Error ? e.message : String(e)}` }
  }
})

ipcMain.handle('workspace:save', async (_e, folders: string[]): Promise<string | null> => {
  const testFile = process.env.MY_AI_IDE_TEST_SAVE_FILE
  const res = testFile ? { canceled: false, filePath: testFile } : await dialog.showSaveDialog({ defaultPath: 'project.code-workspace', filters: [{ name: 'Workspace', extensions: ['code-workspace'] }] })
  if (res.canceled || !res.filePath) return null
  const base = dirname(res.filePath)
  const list = (Array.isArray(folders) ? folders : []).map((d) => ({ path: (relative(base, d) || '.').split(sep).join('/') }))
  await fs.writeFile(res.filePath, JSON.stringify({ folders: list, settings: {} }, null, 2) + '\n', 'utf-8')
  return res.filePath
})

ipcMain.handle('fs:readDir', async (_e, dir: string): Promise<DirEntry[]> => {
  if (ssh.isRemotePath(dir)) return ssh.readDir(dir)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
    .map((d) => ({ name: d.name, path: join(dir, d.name), isDir: d.isDirectory() }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
})

ipcMain.handle('fs:readFile', (_e, file: string) => (ssh.isRemotePath(file) ? ssh.readFile(file) : fs.readFile(file, 'utf-8')))

ipcMain.handle('fs:writeFile', (_e, file: string, content: string) =>
  ssh.isRemotePath(file) ? ssh.writeFile(file, content) : fs.writeFile(file, content, 'utf-8')
)

ipcMain.handle('fs:listFiles', async (_e, root: string): Promise<string[]> => {
  if (ssh.isRemotePath(root)) return ssh.listFiles(root)
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= 10000) return
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      if (IGNORED.has(d.name)) continue
      const full = join(dir, d.name)
      if (d.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(root)
  return out
})

interface SearchMatch {
  path: string // absolute
  rel: string // project-relative, forward slashes
  line: number
  text: string
}

const MAX_SEARCH_MATCHES = 500
const MAX_SEARCH_FILES = 10000
const MAX_SEARCH_FILE_BYTES = 1_000_000

ipcMain.handle(
  'fs:search',
  async (
    _e,
    root: string,
    query: string,
    opts: { caseSensitive: boolean; regex: boolean }
  ): Promise<{ matches: SearchMatch[]; truncated: boolean; error?: string }> => {
    if (!query) return { matches: [], truncated: false }
    if (ssh.isRemotePath(root)) return ssh.search(root, query, opts)
    let re: RegExp
    try {
      const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      re = new RegExp(source, opts.caseSensitive ? '' : 'i')
    } catch (e) {
      return { matches: [], truncated: false, error: (e as Error).message }
    }
    const matches: SearchMatch[] = []
    let scanned = 0
    let truncated = false

    const walk = async (dir: string): Promise<void> => {
      for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (truncated) return
        if (IGNORED.has(d.name)) continue
        const full = join(dir, d.name)
        if (d.isDirectory()) {
          await walk(full)
          continue
        }
        if (!d.isFile()) continue
        if (++scanned > MAX_SEARCH_FILES) {
          truncated = true
          return
        }
        const stat = await fs.stat(full).catch(() => null)
        if (!stat || stat.size > MAX_SEARCH_FILE_BYTES) continue
        const text = await fs.readFile(full, 'utf-8').catch(() => '')
        if (text.slice(0, 1000).includes('\u0000')) continue // binary
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue
          matches.push({
            path: full,
            rel: relative(root, full).split(sep).join('/'),
            line: i + 1,
            text: lines[i].trim().slice(0, 300)
          })
          if (matches.length >= MAX_SEARCH_MATCHES) {
            truncated = true
            return
          }
        }
      }
    }
    await walk(root)
    return { matches, truncated }
  }
)

// ---- Terminals: shells the user can pick from, found once and cached ----
interface ShellInfo {
  id: string
  label: string
  file: string
  args: string[]
}

let shellsCache: ShellInfo[] | null = null

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false)
}

// First match of an executable on PATH (Windows).
async function findOnPath(exe: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir && (await exists(join(dir, exe)))) return join(dir, exe)
  }
  return null
}

async function detectShells(): Promise<ShellInfo[]> {
  if (shellsCache) return shellsCache
  const shells: ShellInfo[] = []
  if (process.platform === 'win32') {
    shells.push({ id: 'powershell', label: 'PowerShell', file: 'powershell.exe', args: [] })
    const pwsh = (await findOnPath('pwsh.exe')) ?? ((await exists('C:\\Program Files\\PowerShell\\7\\pwsh.exe')) ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null)
    if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: [] })
    shells.push({ id: 'cmd', label: 'Command Prompt', file: 'cmd.exe', args: [] })
    for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
      if (await exists(p)) {
        shells.push({ id: 'gitbash', label: 'Git Bash', file: p, args: ['--login', '-i'] })
        break
      }
    }
    if (await exists('C:\\Windows\\System32\\wsl.exe')) {
      shells.push({ id: 'wsl', label: 'WSL', file: 'wsl.exe', args: [] })
      // One entry per installed distribution.
      const raw = await new Promise<Buffer | null>((resolveList) => {
        execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 8000, windowsHide: true }, (err, stdout) => resolveList(err ? null : stdout))
      })
      for (const distro of raw ? parseWslList(raw) : []) shells.push({ id: 'wsl:' + distro, label: 'WSL: ' + distro, file: 'wsl.exe', args: ['-d', distro] })
    }
  } else {
    shells.push({ id: 'default', label: 'Shell', file: process.env.SHELL || '/bin/bash', args: [] })
  }
  shellsCache = shells
  return shells
}

ipcMain.handle('term:shells', async () => (await detectShells()).map(({ id, label }) => ({ id, label })))

ipcMain.handle('term:create', async (_e, shellId: string, cwd: string | null, cols: number, rows: number) => {
  const shells = await detectShells()
  let shell = shells.find((s) => s.id === shellId) ?? shells[0] // unknown id: the first (PowerShell)
  let startIn = cwd ?? process.env.USERPROFILE ?? process.cwd()
  if (typeof shellId === 'string' && shellId.startsWith('ssh:')) {
    // An SSH session with the OpenSSH client that comes with Windows 10 and 11.
    const target = shellId.slice(4)
    if (!validSshTarget(target)) throw new Error('That is not a valid SSH address.')
    const candidates = ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', (await findOnPath('ssh.exe')) ?? '']
    let file = 'ssh'
    for (const c of candidates) if (c && (await exists(c))) { file = c; break }
    shell = { id: shellId, label: 'SSH: ' + target, file, args: sshArgs(target) }
    startIn = process.env.USERPROFILE ?? process.cwd()
  } else if (ssh.isRemotePath(cwd)) {
    // A folder on another computer: ssh logs in and starts a shell in that folder (the password prompt, if any, shows in the terminal).
    const r = ssh.parseRemote(cwd as string)
    const h = r ? ssh.hostOf(r.name) : undefined
    if (!r || !h) throw new Error('Not connected to that computer. Open the folder again to reconnect.')
    const candidates = ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', (await findOnPath('ssh.exe')) ?? '']
    let exe = 'ssh'
    for (const c of candidates) if (c && (await exists(c))) { exe = c; break }
    const quoted = "'" + r.path.replace(/'/g, "'\\''") + "'"
    shell = {
      id: 'ssh-folder',
      label: 'SSH: ' + h.host,
      file: exe,
      args: ['-t', '-p', String(h.port), ...(h.identityFile ? ['-i', h.identityFile] : []), '--', h.username + '@' + h.host, 'cd ' + quoted + ' && exec "$SHELL" -l']
    }
    startIn = process.env.USERPROFILE ?? process.cwd()
  } else {
    // A folder inside WSL: open the shell of that distribution in that folder (the Windows side cannot start in a \\wsl$ path).
    const loc = wslLocation(cwd)
    if (loc && process.platform === 'win32') {
      shell = { id: 'wsl:' + loc.distro, label: 'WSL: ' + loc.distro, file: 'wsl.exe', args: wslShellArgs(loc) }
      startIn = process.env.USERPROFILE ?? process.cwd()
    }
  }
  const id = nextTermId++
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE // would make `node` in the terminal behave like Electron
  const term = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: startIn,
    env
  })
  term.onData((data) => mainWin?.webContents.send('term:data', id, data))
  term.onExit(() => {
    terminals.delete(id)
    mainWin?.webContents.send('term:exit', id)
  })
  terminals.set(id, term)
  return id
})

ipcMain.on('term:write', (_e, id: number, data: string) => terminals.get(id)?.write(data))
ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) =>
  terminals.get(id)?.resize(cols, rows)
)
ipcMain.on('term:kill', (_e, id: number) => {
  terminals.get(id)?.kill()
  terminals.delete(id)
})

// Extensions' web pages (webviews) load their own files through this address, which only serves what they may read.
protocol.registerSchemesAsPrivileged([{ scheme: 'vscode-webview-resource', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

app.whenReady().then(() => {
  protocol.handle('vscode-webview-resource', async (req) => {
    try {
      const parts = new URL(req.url).pathname.split('/')
      const seg = parts[1] ?? ''
      if (seg === 'nbhtml') {
        const page = notebookPage(decodeURIComponent(parts[2] ?? ''))
        return page === null ? new Response('Not found', { status: 404 }) : new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (seg === 'page') {
        const html = webviewPage(decodeURIComponent(parts[2] ?? ''))
        return html === null ? new Response('Not found', { status: 404 }) : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      const file = Buffer.from(seg, 'base64url').toString('utf-8')
      if (!webviewMayRead(file)) return new Response('Not allowed', { status: 403 })
      const res = await net.fetch(pathToFileURL(file).href)
      const headers = new Headers(res.headers)
      headers.set('access-control-allow-origin', '*') // the page has no origin of its own to be matched against
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  // No default menu: its accelerators (Ctrl+W closes the window, Ctrl+R reloads) would fight the editor's own shortcuts.
  Menu.setApplicationMenu(null)
  registerAiHandlers(() => mainWin)
  registerBackendHandlers(() => mainWin, app.getVersion())
  registerAgentHandlers(() => mainWin)
  registerUpdater(() => mainWin)
  registerGitHandlers()
  registerFsOps(() => mainWin)
  registerRulesHandlers()
  registerCodeIndexHandlers()
  registerBackgroundHandlers(() => mainWin)
  registerDebugHandlers(() => mainWin)
  registerExtensionHandlers(() => mainWin)
  registerTaskHandlers()
  registerNotebookHandlers(() => mainWin)
  registerLspHandlers(() => mainWin)
  ssh.registerSshHandlers()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopAllBackground()
  stopDebugging()
  stopExtensions()
  stopAllKernels()
  stopAllLanguageServers()
  ssh.disconnectAll()
})
