import { app, ipcMain } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import { Client, ConnectConfig, SFTPWrapper, Stats } from 'ssh2'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { createServer as createTcpServer } from 'net'

// Folders on another computer over SSH. A remote folder is addressed like a network share, so the rest of the editor
// (which passes paths around as text) needs no changes:
//     \\ssh.<name>\home\me\project     is     /home/me/project     on the computer called <name>
// This module owns the connections (SFTP over SSH, using ssh2) and the file operations; main-process handlers for files
// call it when a path starts with \\ssh. Git, the agent and the code index do not work on remote folders yet.

export interface SshHost {
  name: string // what appears in paths: letters, digits and dashes
  host: string
  port: number
  username: string
  identityFile?: string
}

interface Live {
  host: SshHost
  client: Client
  sftp: SFTPWrapper
}

export type ConnectResult =
  | { ok: true; name: string; home: string }
  | { ok: false; need: 'password' | 'passphrase' | 'trust'; fingerprint?: string; error?: string }
  | { ok: false; error: string; need?: undefined }

const live = new Map<string, Live>()
const saved = new Map<string, SshHost>()
const MAX_FILE = 5 * 1024 * 1024
const MAX_FILES = 10000

const dataDir = (): string => join(app.getPath('userData'), 'ssh')
const hostsFile = (): string => join(dataDir(), 'connections.json')
const knownFile = (): string => join(dataDir(), 'known-hosts.json')

// ---- paths ----

const REMOTE = /^\\\\ssh\.([A-Za-z0-9-]{1,40})(\\.*)?$/i

export const isRemotePath = (p: unknown): boolean => typeof p === 'string' && REMOTE.test(p)

export function parseRemote(p: string): { name: string; path: string } | null {
  const m = REMOTE.exec(p)
  if (!m) return null
  const rest = (m[2] ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  return { name: m[1].toLowerCase(), path: rest === '' ? '/' : rest }
}

export const remoteUnc = (name: string, remote: string): string => `\\\\ssh.${name}${remote === '/' ? '' : remote.replace(/\//g, '\\')}`
const childUnc = (dirUnc: string, child: string): string => dirUnc.replace(/\\+$/, '') + '\\' + child
const posixJoin = (a: string, b: string): string => (a === '/' ? '' : a.replace(/\/$/, '')) + '/' + b

/** The part of the address after the computer's name, as a remote path. */
function target(p: string): { conn: Live; path: string } {
  const r = parseRemote(p)
  if (!r) throw new Error('Not a remote path.')
  const conn = live.get(r.name)
  if (!conn) throw new Error(`Not connected to "${r.name}". Open the folder again to reconnect.`)
  return { conn, path: r.path }
}

// ---- connections: remembered, and verified the first time like ssh does ----

async function loadSaved(): Promise<void> {
  if (saved.size) return
  try {
    for (const h of JSON.parse(await fs.readFile(hostsFile(), 'utf-8')) as SshHost[]) saved.set(h.name, h)
  } catch {
    // none yet
  }
}
async function persist(): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  await fs.writeFile(hostsFile(), JSON.stringify([...saved.values()]), 'utf-8')
}

async function readKnown(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(knownFile(), 'utf-8'))
  } catch {
    return {}
  }
}

/** Reads the parts of ~/.ssh/config this editor uses (Host, HostName, User, Port, IdentityFile). */
export async function readSshConfig(alias: string, file = join(homedir(), '.ssh', 'config')): Promise<Partial<SshHost> & { found: boolean }> {
  let text = ''
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch {
    return { found: false }
  }
  let applies = false
  const out: Partial<SshHost> & { found: boolean } = { found: false }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^(\w+)\s*[=\s]\s*(.+)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      applies = value.split(/\s+/).some((pat) => pat === alias)
      if (applies) out.found = true
    } else if (applies) {
      if (key === 'hostname' && !out.host) out.host = value
      else if (key === 'user' && !out.username) out.username = value
      else if (key === 'port' && !out.port) out.port = Number(value) || 22
      else if (key === 'identityfile' && !out.identityFile) out.identityFile = value.replace(/^~/, homedir())
    }
  }
  return out
}

/** `user@host`, `user@host:port`, or a name from ~/.ssh/config. */
export async function parseAddress(address: string): Promise<{ ok: true; host: SshHost } | { ok: false; error: string }> {
  const a = address.trim()
  if (!/^[A-Za-z0-9._@:\-[\]]{1,200}$/.test(a) || a.startsWith('-')) return { ok: false, error: 'That is not a valid SSH address. Use user@host, user@host:port, or a name from your ssh config.' }
  let user: string | undefined
  let rest = a
  if (a.includes('@')) {
    user = a.slice(0, a.indexOf('@'))
    rest = a.slice(a.indexOf('@') + 1)
  }
  let port: number | undefined
  const pm = /^(.*):(\d{1,5})$/.exec(rest)
  if (pm && !pm[1].includes(':')) {
    rest = pm[1]
    port = Number(pm[2])
  }
  const cfg = await readSshConfig(rest)
  const host = cfg.host ?? rest
  const username = user ?? cfg.username ?? process.env.USERNAME ?? process.env.USER ?? ''
  if (!username) return { ok: false, error: 'Add the user name: user@host.' }
  const name = (cfg.found ? rest : host).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'host'
  return { ok: true, host: { name, host, port: port ?? cfg.port ?? 22, username, identityFile: cfg.identityFile } }
}

const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa']

async function connectClient(
  h: SshHost,
  secrets: { password?: string; passphrase?: string; trust?: string }
): Promise<{ ok: true; client: Client } | { ok: false; need?: 'password' | 'passphrase' | 'trust'; fingerprint?: string; error: string }> {
  const known = await readKnown()
  const hostKey = `${h.host}:${h.port}`
  let unknownFingerprint: string | undefined
  let mismatch = false
  const base: ConnectConfig = {
    host: h.host,
    port: h.port,
    username: h.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    hostVerifier: (key: Buffer) => {
      const fp = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
      if (known[hostKey] === fp) return true
      if (known[hostKey]) {
        mismatch = true
        return false
      }
      if (secrets.trust === fp) {
        known[hostKey] = fp
        void fs.mkdir(dataDir(), { recursive: true }).then(() => fs.writeFile(knownFile(), JSON.stringify(known), 'utf-8'))
        return true
      }
      unknownFingerprint = fp
      return false
    }
  }
  // Ways to log in, in order: the agent, the key file, then a password if one was given.
  const attempts: { label: string; cfg: Partial<ConnectConfig> }[] = []
  if (secrets.password) attempts.push({ label: 'password', cfg: { password: secrets.password } })
  else {
    const agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK
    if (agent) attempts.push({ label: 'agent', cfg: { agent } })
    const keys = h.identityFile ? [h.identityFile] : DEFAULT_KEYS.map((k) => join(homedir(), '.ssh', k)).filter((p) => existsSync(p))
    for (const k of keys) {
      try {
        attempts.push({ label: 'key ' + k, cfg: { privateKey: await fs.readFile(k), passphrase: secrets.passphrase } })
      } catch {
        // unreadable key: skip
      }
    }
  }
  if (attempts.length === 0) return { ok: false, need: 'password', error: 'No key or agent was found. Enter the password.' }

  let needPassphrase = false
  let lastError = ''
  for (const att of attempts) {
    const client = new Client()
    const outcome = await new Promise<'ok' | 'fail'>((resolve) => {
      client.on('ready', () => resolve('ok'))
      client.on('error', (e: Error & { level?: string }) => {
        lastError = e.message
        if (/passphrase/i.test(e.message)) needPassphrase = true
        resolve('fail')
      })
      try {
        client.connect({ ...base, ...att.cfg })
      } catch (e) {
        lastError = (e as Error).message
        if (/passphrase/i.test(lastError)) needPassphrase = true
        resolve('fail')
      }
    })
    if (outcome === 'ok') return { ok: true, client }
    client.end()
    if (unknownFingerprint) return { ok: false, need: 'trust', fingerprint: unknownFingerprint, error: `The identity of ${h.host} is not known yet.` }
    if (mismatch) return { ok: false, error: `The identity of ${h.host} has CHANGED since you last connected. Someone may be intercepting the connection. Remove its line from ${knownFile()} only if you know the server was reinstalled.` }
  }
  if (needPassphrase) return { ok: false, need: 'passphrase', error: 'The key is protected by a passphrase.' }
  if (secrets.password) return { ok: false, need: 'password', error: 'The password was not accepted.' }
  return { ok: false, need: 'password', error: lastError && !/authentication methods failed/i.test(lastError) ? lastError : 'Logging in with your key or agent did not work. Enter the password.' }
}

function sftpOf(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s))))
}

export async function connect(address: string, secrets: { password?: string; passphrase?: string; trust?: string } = {}): Promise<ConnectResult> {
  await loadSaved()
  const parsed = await parseAddress(address)
  if (!parsed.ok) return parsed
  const h = parsed.host
  const existing = live.get(h.name)
  if (existing) {
    // Already connected; the same name for another computer would be confusing.
    if (existing.host.host !== h.host || existing.host.username !== h.username || existing.host.port !== h.port) {
      return { ok: false, error: `The name "${h.name}" is already used by ${existing.host.username}@${existing.host.host}. Disconnect it first.` }
    }
    return { ok: true, name: h.name, home: await realpath(existing.sftp, '.') }
  }
  const r = await connectClient(h, secrets)
  if (!r.ok) return r
  let sftp: SFTPWrapper
  try {
    sftp = await sftpOf(r.client)
  } catch (e) {
    r.client.end()
    return { ok: false, error: 'The server does not offer SFTP, which this editor needs: ' + (e as Error).message }
  }
  const entry: Live = { host: h, client: r.client, sftp }
  live.set(h.name, entry)
  r.client.on('close', () => {
    if (live.get(h.name) === entry) live.delete(h.name)
  })
  r.client.on('error', () => undefined)
  saved.set(h.name, h)
  await persist().catch(() => undefined)
  return { ok: true, name: h.name, home: await realpath(sftp, '.') }
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Runs a command on the remote computer, in the folder `unc` names, and collects its output (used for git). */
export function exec(
  unc: string,
  command: string[],
  opts: { input?: string; timeout?: number; env?: Record<string, string>; onData?: (text: string) => void; signal?: AbortSignal } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let t: { conn: Live; path: string }
    try {
      t = target(unc)
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: (e as Error).message })
    }
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${shq(v)}`)
    const line = `cd ${shq(t.path)} && ${[...env, ...command.map(shq)].join(' ')}`
    t.conn.client.exec(line, (err, stream) => {
      if (err) return resolve({ code: -1, stdout: '', stderr: err.message })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => stream.close(), opts.timeout ?? 30_000)
      const abort = (): void => stream.close()
      opts.signal?.addEventListener('abort', abort)
      stream.on('data', (d: Buffer) => {
        opts.onData?.(d.toString('utf-8'))
        if (stdout.length < 8_000_000) stdout += d.toString('utf-8')
      })
      stream.stderr.on('data', (d: Buffer) => {
        opts.onData?.(d.toString('utf-8'))
        if (stderr.length < 8_000_000) stderr += d.toString('utf-8')
      })
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', abort)
        resolve({ code: code ?? -1, stdout, stderr })
      })
      stream.end(opts.input ?? '')
    })
  })
}

/** A program running on the other computer, shaped like a child process (stdout, stderr, kill, 'close'). */
export interface RemoteProcess extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  exitCode: number | null
  kill(): boolean
}

/**
 * Starts a program on the remote computer, in the folder `unc` names, and keeps it running until it ends or is killed.
 * The remote shell reports its process id first, so kill() can end the program (closing an SSH channel does not).
 */
export function spawnRemote(unc: string, command: string[], opts: { env?: Record<string, string> } = {}): RemoteProcess {
  const proc = new EventEmitter() as RemoteProcess
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.pid = 0
  proc.exitCode = null
  let conn: Live
  let line: string
  try {
    const t = target(unc)
    conn = t.conn
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `export ${k}=${shq(v)}`)
    line = `cd ${shq(t.path)} && echo __MYIDE_PID__$$ && ${[...env, ''].join(' && ')}exec ${command.map(shq).join(' ')}`
  } catch (e) {
    setImmediate(() => proc.emit('error', e))
    return proc
  }
  let closeStream: (() => void) | null = null
  let ended = false
  proc.kill = (): boolean => {
    if (ended) return false
    if (proc.pid) conn.client.exec(`cd '/' && kill ${proc.pid} 2>/dev/null || kill -9 ${proc.pid} 2>/dev/null; true`, (err, s) => (err ? undefined : s.resume()))
    setTimeout(() => closeStream?.(), 1500)
    return true
  }
  conn.client.exec(line, (err, stream) => {
    if (err) return proc.emit('error', err)
    closeStream = () => stream.close()
    let head = ''
    let gotPid = false
    stream.on('data', (d: Buffer) => {
      if (gotPid) return void proc.stdout.write(d)
      head += d.toString('utf-8')
      const nl = head.indexOf('\n')
      if (nl < 0) return
      const m = /__MYIDE_PID__(\d+)/.exec(head.slice(0, nl))
      gotPid = true
      if (m) proc.pid = Number(m[1])
      const rest = head.slice(nl + 1)
      if (rest) proc.stdout.write(rest)
    })
    stream.stderr.on('data', (d: Buffer) => proc.stderr.write(d))
    stream.on('close', (code: number | null) => {
      ended = true
      proc.exitCode = code ?? -1
      proc.stdout.end()
      proc.stderr.end()
      proc.emit('close', code)
    })
    stream.end()
  })
  return proc
}

/** Makes a port on the remote computer reachable on this one (127.0.0.1:<port returned>), through the SSH connection. */
export function forwardPort(unc: string, remotePort: number): Promise<{ port: number; close(): void }> {
  const { conn } = target(unc)
  const sockets = new Set<import('net').Socket>()
  const server = createTcpServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => sock.destroy())
    conn.client.forwardOut('127.0.0.1', sock.remotePort ?? 0, '127.0.0.1', remotePort, (err, stream) => {
      if (err) return sock.destroy()
      stream.on('error', () => sock.destroy())
      stream.on('close', () => sock.destroy())
      sock.pipe(stream)
      stream.pipe(sock)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        close: () => {
          for (const x of sockets) x.destroy()
          server.close()
        }
      })
    })
  })
}

/** The path of a place on the remote computer as the programs there write it (Windows servers: /C:/x is C:/x). */
export function nativePath(unc: string): string | null {
  const r = parseRemote(unc)
  if (!r) return null
  return /^\/[A-Za-z]:(\/|$)/.test(r.path) ? r.path.slice(1) : r.path
}

/** The editor's address for a path a program on the remote computer reported. */
export function fromNativePath(name: string, p: string): string {
  const q = p.replace(/\\/g, '/')
  return remoteUnc(name, /^[A-Za-z]:(\/|$)/.test(q) ? '/' + q : q)
}

export function disconnect(name: string): void {
  const c = live.get(name)
  live.delete(name)
  c?.client.end()
}

/** Reconnects a remembered computer (agent or key only), for a folder that was open before the app was closed. */
export async function ensure(unc: string, secrets: { password?: string; passphrase?: string; trust?: string } = {}): Promise<ConnectResult> {
  const r = parseRemote(unc)
  if (!r) return { ok: false, error: 'Not a remote path.' }
  const l = live.get(r.name)
  if (l) return { ok: true, name: r.name, home: r.path }
  await loadSaved()
  const h = saved.get(r.name)
  if (!h) return { ok: false, error: `The connection "${r.name}" is not known on this PC. Use "Open Folder over SSH" to set it up.` }
  return connect(`${h.username}@${h.host}:${h.port}`, secrets)
}

export const connected = (): { name: string; label: string }[] => [...live.values()].map((l) => ({ name: l.host.name, label: `${l.host.username}@${l.host.host}` }))
export const remembered = async (): Promise<SshHost[]> => (await loadSaved(), [...saved.values()])
export const hostOf = (name: string): SshHost | undefined => live.get(name)?.host ?? saved.get(name)

// ---- file operations ----

function realpath(sftp: SFTPWrapper, p: string): Promise<string> {
  return new Promise((resolve, reject) => sftp.realpath(p, (e, r) => (e ? reject(e) : resolve(r))))
}
const stat = (sftp: SFTPWrapper, p: string): Promise<Stats> => new Promise((resolve, reject) => sftp.stat(p, (e, s) => (e ? reject(e) : resolve(s))))

const errno = (e: unknown): Error => {
  const err = e as { code?: number | string; message?: string }
  if (err.code === 2 || err.code === 'ENOENT') return Object.assign(new Error('The location no longer exists.'), { code: 'ENOENT' })
  if (err.code === 3 || err.code === 'EACCES') return Object.assign(new Error('Permission denied on the server.'), { code: 'EACCES' })
  return e instanceof Error ? e : new Error(String(e))
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
}

export async function readDir(unc: string): Promise<RemoteEntry[]> {
  const { conn, path } = target(unc)
  const list = await new Promise<{ filename: string; attrs: Stats }[]>((resolve, reject) => conn.sftp.readdir(path, (e, l) => (e ? reject(errno(e)) : resolve(l as never))))
  const out: RemoteEntry[] = []
  for (const f of list) {
    if (f.filename === '.git' || f.filename === 'node_modules') continue
    let isDir = f.attrs.isDirectory()
    // A link to a folder is shown as a folder.
    if (!isDir && f.attrs.isSymbolicLink?.()) isDir = await stat(conn.sftp, posixJoin(path, f.filename)).then((s) => s.isDirectory(), () => false)
    out.push({ name: f.filename, path: childUnc(unc, f.filename), isDir })
  }
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
}

export async function isDir(unc: string): Promise<boolean> {
  try {
    const { conn, path } = target(unc)
    return (await stat(conn.sftp, path)).isDirectory()
  } catch {
    return false
  }
}

export async function statSize(unc: string): Promise<number> {
  const { conn, path } = target(unc)
  return (await stat(conn.sftp, path).catch((e) => Promise.reject(errno(e)))).size
}

/** Throws a readable error unless the file exists (and the computer is reachable). */
export async function requireFile(unc: string): Promise<void> {
  try {
    await statSize(unc)
  } catch (e) {
    throw (e as { code?: string }).code === 'ENOENT' ? new Error(`The file does not exist: ${unc}`) : e
  }
}

export async function readFile(unc: string): Promise<string> {
  const { conn, path } = target(unc)
  const size = (await stat(conn.sftp, path).catch((e) => Promise.reject(errno(e)))).size
  if (size > MAX_FILE) throw new Error(`This file is ${(size / 1048576).toFixed(1)} MB; the editor opens files up to 5 MB over SSH.`)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const s = conn.sftp.createReadStream(path)
    s.on('data', (c: Buffer) => chunks.push(c))
    s.on('error', (e: Error) => reject(errno(e)))
    s.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
}

export async function writeFile(unc: string, text: string, exclusive = false): Promise<void> {
  const { conn, path } = target(unc)
  if (exclusive && (await stat(conn.sftp, path).then(() => true, () => false))) throw Object.assign(new Error('A file or folder with that name already exists.'), { code: 'EEXIST' })
  await new Promise<void>((resolve, reject) => {
    const s = conn.sftp.createWriteStream(path)
    s.on('error', (e: Error) => reject(errno(e)))
    s.on('close', () => resolve())
    s.end(Buffer.from(text, 'utf-8'))
  })
}

/** Creates a folder and any missing parents; fine if it exists already. */
export async function mkdirp(unc: string): Promise<void> {
  const { conn, path } = target(unc)
  let cur = ''
  for (const part of path.split('/').filter(Boolean)) {
    cur += '/' + part
    const have = await stat(conn.sftp, cur).then((s) => s.isDirectory(), () => false)
    if (!have) await new Promise<void>((resolve, reject) => conn.sftp.mkdir(cur, (e) => (e ? reject(errno(e)) : resolve())))
  }
}

export async function mkdir(unc: string): Promise<void> {
  const { conn, path } = target(unc)
  if (await stat(conn.sftp, path).then(() => true, () => false)) throw Object.assign(new Error('A file or folder with that name already exists.'), { code: 'EEXIST' })
  await new Promise<void>((resolve, reject) => conn.sftp.mkdir(path, (e) => (e ? reject(errno(e)) : resolve())))
}

export async function rename(fromUnc: string, toUnc: string): Promise<void> {
  const a = target(fromUnc)
  const b = target(toUnc)
  if (a.conn !== b.conn) throw new Error('Files cannot be moved between computers.')
  if (a.path.toLowerCase() !== b.path.toLowerCase() && (await stat(b.conn.sftp, b.path).then(() => true, () => false))) throw Object.assign(new Error('A file or folder with that name already exists.'), { code: 'EEXIST' })
  await new Promise<void>((resolve, reject) => a.conn.sftp.rename(a.path, b.path, (e) => (e ? reject(errno(e)) : resolve())))
}

/** Deletes a file or a folder with everything in it. There is no Recycle Bin on a server. */
export async function remove(unc: string): Promise<void> {
  const { conn, path } = target(unc)
  const rm = async (p: string): Promise<void> => {
    const s = await stat(conn.sftp, p).catch(() => null)
    if (!s) return
    if (s.isDirectory()) {
      const list = await new Promise<{ filename: string }[]>((resolve, reject) => conn.sftp.readdir(p, (e, l) => (e ? reject(errno(e)) : resolve(l as never))))
      for (const f of list) await rm(posixJoin(p, f.filename))
      await new Promise<void>((resolve, reject) => conn.sftp.rmdir(p, (e) => (e ? reject(errno(e)) : resolve())))
    } else await new Promise<void>((resolve, reject) => conn.sftp.unlink(p, (e) => (e ? reject(errno(e)) : resolve())))
  }
  if (path === '/') throw new Error('Refusing to delete the root of the server.')
  await rm(path)
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist'])

/** Every file below a folder (up to a limit), as paths in the editor's form. */
export async function listFiles(rootUnc: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dirUnc: string): Promise<void> => {
    if (out.length >= MAX_FILES) return
    const { conn, path } = target(dirUnc)
    const list = await new Promise<{ filename: string; attrs: Stats }[]>((resolve) => conn.sftp.readdir(path, (e, l) => resolve(e ? [] : (l as never))))
    for (const f of list) {
      if (out.length >= MAX_FILES) return
      if (f.attrs.isDirectory()) {
        if (!SKIP_DIRS.has(f.filename)) await walk(childUnc(dirUnc, f.filename))
      } else if (f.attrs.isFile()) out.push(childUnc(dirUnc, f.filename))
    }
  }
  await walk(rootUnc)
  return out
}

export interface RemoteMatch {
  path: string
  rel: string
  line: number
  text: string
}

export async function search(rootUnc: string, query: string, opts: { caseSensitive: boolean; regex: boolean }): Promise<{ matches: RemoteMatch[]; truncated: boolean; error?: string }> {
  if (!query) return { matches: [], truncated: false }
  let re: RegExp
  try {
    re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? '' : 'i')
  } catch (e) {
    return { matches: [], truncated: false, error: (e as Error).message }
  }
  const matches: RemoteMatch[] = []
  let truncated = false
  const rootLen = rootUnc.replace(/\\+$/, '').length + 1
  for (const file of await listFiles(rootUnc)) {
    if (matches.length >= 500) {
      truncated = true
      break
    }
    let text: string
    try {
      if ((await statSize(file)) > 1_000_000) continue
      text = await readFile(file)
    } catch {
      continue
    }
    if (text.slice(0, 1000).includes('\u0000')) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && matches.length < 500; i++) {
      if (re.test(lines[i])) matches.push({ path: file, rel: file.slice(rootLen).replace(/\\/g, '/'), line: i + 1, text: lines[i].replace(/\r$/, '').slice(0, 300) })
    }
  }
  return { matches, truncated }
}

/** Folders only, for choosing a folder to open. */
export async function browse(name: string, remotePath: string): Promise<{ path: string; parent: string | null; dirs: string[] }> {
  const conn = live.get(name)
  if (!conn) throw new Error('Not connected.')
  const real = await realpath(conn.sftp, remotePath || '.')
  const list = await new Promise<{ filename: string; attrs: Stats }[]>((resolve, reject) => conn.sftp.readdir(real, (e, l) => (e ? reject(errno(e)) : resolve(l as never))))
  const dirs: string[] = []
  for (const f of list) {
    if (f.filename.startsWith('.')) continue
    if (f.attrs.isDirectory() || (f.attrs.isSymbolicLink?.() && (await stat(conn.sftp, posixJoin(real, f.filename)).then((s) => s.isDirectory(), () => false)))) dirs.push(f.filename)
  }
  dirs.sort((a, b) => a.localeCompare(b))
  return { path: real, parent: real === '/' ? null : real.replace(/\/[^/]*$/, '') || '/', dirs }
}

// ---- IPC ----

export function registerSshHandlers(): void {
  ipcMain.handle('ssh:connect', (_e, address: string, secrets?: { password?: string; passphrase?: string; trust?: string }) => connect(String(address ?? ''), secrets ?? {}))
  ipcMain.handle('ssh:ensure', (_e, unc: string, secrets?: { password?: string; passphrase?: string; trust?: string }) => ensure(String(unc ?? ''), secrets ?? {}))
  ipcMain.handle('ssh:disconnect', (_e, name: string) => disconnect(String(name)))
  ipcMain.handle('ssh:connections', async () => ({ live: connected(), remembered: await remembered() }))
  ipcMain.handle('ssh:browse', async (_e, name: string, p: string) => {
    try {
      return { ok: true as const, ...(await browse(String(name), String(p))) }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ssh:toUnc', (_e, name: string, p: string) => remoteUnc(String(name), String(p)))
}

export function disconnectAll(): void {
  for (const n of [...live.keys()]) disconnect(n)
}
