import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { delimiter, join } from 'path'

// netcoredbg is the open-source .NET debugger (Samsung/netcoredbg) that speaks the Debug Adapter Protocol. It is not
// shipped with the .NET SDK, so it is found on PATH, or downloaded once from the project's GitHub releases when the
// user asks for it (palette: "Debug: Install the C# Debugger").

export const NETCOREDBG_HELP = 'C# debugging needs netcoredbg. Run "Debug: Install the C# Debugger (netcoredbg)" from the command palette (Ctrl+Shift+P) to download it, or put netcoredbg on your PATH.'

const exeName = (): string => (process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg')
export const toolsDir = (): string => join(app.getPath('userData'), 'tools')
const installedPath = (): string => join(toolsDir(), 'netcoredbg', exeName())

/** NETCOREDBG_PATH, then PATH, then the copy this app downloaded. */
export function findNetcoredbg(): string | null {
  const forced = process.env.NETCOREDBG_PATH
  if (forced && existsSync(forced)) return forced
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, exeName()))) return join(dir, exeName())
  }
  return existsSync(installedPath()) ? installedPath() : null
}

function assetName(): string | null {
  if (process.platform === 'win32' && process.arch === 'x64') return 'netcoredbg-win64.zip'
  if (process.platform === 'linux' && process.arch === 'x64') return 'netcoredbg-linux-amd64.tar.gz'
  if (process.platform === 'linux' && process.arch === 'arm64') return 'netcoredbg-linux-arm64.tar.gz'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'netcoredbg-osx-arm64.zip'
  return null
}

const MAX_DOWNLOAD = 60 * 1024 * 1024

/** `tar` reads both .zip and .tar.gz; on Windows the one in System32 is used (Git's tar cannot read zip files). */
function extract(archive: string, into: string): Promise<void> {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  return new Promise((resolve, reject) => {
    const c = spawn(tar, ['-xf', archive, '-C', into], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    c.stderr.on('data', (b: Buffer) => (err += b.toString()))
    c.on('error', (e) => reject(new Error(`Could not unpack the download: ${e.message}`)))
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not unpack the download: ${err.trim() || 'tar exited with ' + code}`))))
  })
}

/** Downloads the latest netcoredbg release for this computer into the app's data folder (once). */
export async function installNetcoredbg(): Promise<{ ok: true; path: string; version: string } | { ok: false; error: string }> {
  try {
    const have = findNetcoredbg()
    if (have) return { ok: true, path: have, version: 'already installed' }
    const name = assetName()
    if (!name) return { ok: false, error: `There is no netcoredbg download for ${process.platform} ${process.arch}. Build it from github.com/Samsung/netcoredbg and put it on your PATH.` }
    const rel = await fetch('https://api.github.com/repos/Samsung/netcoredbg/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'my-ai-ide' }, signal: AbortSignal.timeout(20_000) })
    if (!rel.ok) return { ok: false, error: `GitHub did not answer (${rel.status}). Check your internet connection.` }
    const info = (await rel.json()) as { tag_name?: string; assets?: { name: string; size: number; browser_download_url: string }[] }
    const asset = info.assets?.find((a) => a.name === name)
    if (!asset || !/^https:\/\/github\.com\/Samsung\/netcoredbg\/releases\/download\//.test(asset.browser_download_url)) return { ok: false, error: `The latest release has no ${name}.` }
    if (asset.size > MAX_DOWNLOAD) return { ok: false, error: 'The download is larger than expected; not installing it.' }
    const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180_000) })
    if (!res.ok) return { ok: false, error: `The download failed (${res.status}).` }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > MAX_DOWNLOAD || bytes.length !== asset.size) return { ok: false, error: 'The download was incomplete. Try again.' }
    await fs.mkdir(toolsDir(), { recursive: true })
    const archive = join(toolsDir(), name)
    await fs.writeFile(archive, bytes)
    await fs.rm(join(toolsDir(), 'netcoredbg'), { recursive: true, force: true })
    try {
      await extract(archive, toolsDir())
    } finally {
      await fs.rm(archive, { force: true })
    }
    if (!existsSync(installedPath())) return { ok: false, error: 'The download did not contain netcoredbg.' }
    if (process.platform !== 'win32') await fs.chmod(installedPath(), 0o755)
    return { ok: true, path: installedPath(), version: info.tag_name ?? '' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
