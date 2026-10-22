import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { join, relative, resolve, sep } from 'path'
import { promises as fs, statSync } from 'fs'
import * as pty from '@lydell/node-pty'
import { registerAiHandlers } from './ai'
import { registerAgentHandlers } from './agent'
import { registerUpdater } from './updater'
import { registerGitHandlers } from './git'
import { registerFsOps } from './fsops'
import { registerRulesHandlers } from './rules'

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

// Keeps the title bar, dialogs and native scrollbars in step with the chosen theme.
ipcMain.handle('app:setNativeTheme', (_e, type: 'light' | 'dark') => {
  nativeTheme.themeSource = type === 'light' ? 'light' : 'dark'
})

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return res.canceled ? null : res.filePaths[0]
})

ipcMain.handle('fs:readDir', async (_e, dir: string): Promise<DirEntry[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
    .map((d) => ({ name: d.name, path: join(dir, d.name), isDir: d.isDirectory() }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
})

ipcMain.handle('fs:readFile', (_e, file: string) => fs.readFile(file, 'utf-8'))

ipcMain.handle('fs:writeFile', (_e, file: string, content: string) =>
  fs.writeFile(file, content, 'utf-8')
)

ipcMain.handle('fs:listFiles', async (_e, root: string): Promise<string[]> => {
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
    if (await exists('C:\\Windows\\System32\\wsl.exe')) shells.push({ id: 'wsl', label: 'WSL', file: 'wsl.exe', args: [] })
  } else {
    shells.push({ id: 'default', label: 'Shell', file: process.env.SHELL || '/bin/bash', args: [] })
  }
  shellsCache = shells
  return shells
}

ipcMain.handle('term:shells', async () => (await detectShells()).map(({ id, label }) => ({ id, label })))

ipcMain.handle('term:create', async (_e, shellId: string, cwd: string | null, cols: number, rows: number) => {
  const shells = await detectShells()
  const shell = shells.find((s) => s.id === shellId) ?? shells[0] // unknown id: the first (PowerShell)
  const id = nextTermId++
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE // would make `node` in the terminal behave like Electron
  const term = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd ?? process.env.USERPROFILE ?? process.cwd(),
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

app.whenReady().then(() => {
  // No default menu: its accelerators (Ctrl+W closes the window, Ctrl+R reloads) would fight the editor's own shortcuts.
  Menu.setApplicationMenu(null)
  registerAiHandlers(() => mainWin)
  registerAgentHandlers(() => mainWin)
  registerUpdater(() => mainWin)
  registerGitHandlers()
  registerFsOps(() => mainWin)
  registerRulesHandlers()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
