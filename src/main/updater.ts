import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import { autoUpdater } from 'electron-updater'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available' // a newer version exists; nothing downloaded yet
  | 'none' // already up to date
  | 'downloading'
  | 'ready' // downloaded; installs when the app restarts
  | 'error'
  | 'unconfigured' // this build has no update feed set up
  | 'dev' // running from source, where updating makes no sense

export interface UpdateState {
  status: UpdateStatus
  current: string
  version?: string // the newer version, once known
  percent?: number
  error?: string
}

// electron-builder writes the feed (from the `publish` section of electron-builder.yml) into
// resources/app-update.yml. A placeholder owner there means nobody has filled it in yet.
function feedConfigured(): boolean {
  try {
    const yml = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf-8')
    return !yml.includes('YOUR_GITHUB_USER')
  } catch {
    return false
  }
}

let state: UpdateState = { status: 'idle', current: app.getVersion() }

export function registerUpdater(getWin: () => BrowserWindow | null): void {
  const set = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch }
    getWin()?.webContents.send('update:state', state)
  }

  // MY_AI_IDE_UPDATE_URL points the updater at any folder serving latest.yml (self-hosting, or tests).
  const override = process.env.MY_AI_IDE_UPDATE_URL
  if (override) autoUpdater.setFeedURL({ provider: 'generic', url: override })
  const configured = !!override || (app.isPackaged && feedConfigured())

  // The user decides when to download; once downloaded it installs when the app next quits.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version, percent: undefined }))
  autoUpdater.on('update-not-available', () => set({ status: 'none', version: undefined }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', (err) => set({ status: 'error', error: err?.message ?? String(err) }))

  ipcMain.handle('update:state', () => state)

  ipcMain.handle('update:check', async () => {
    if (!configured) {
      set({ status: app.isPackaged ? 'unconfigured' : 'dev' })
      return state
    }
    // Do not interrupt a download or an update that is waiting for a restart.
    if (state.status === 'downloading' || state.status === 'ready' || state.status === 'checking') return state
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
    return state
  })

  ipcMain.handle('update:download', async () => {
    if (state.status !== 'available') return state
    set({ status: 'downloading', percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
    return state
  })

  // Silent install, then the new version starts by itself.
  ipcMain.on('update:install', () => {
    if (state.status === 'ready') autoUpdater.quitAndInstall(true, true)
  })
}
