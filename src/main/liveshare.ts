import { BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { randomBytes, timingSafeEqual } from 'crypto'
import { hostname, networkInterfaces, userInfo } from 'os'

const who = (given: string): string => given.trim() || (() => { try { return userInfo().username } catch { return hostname() } })()
import { isAbsolute, join, relative, resolve, sep } from 'path'
import WebSocket, { WebSocketServer } from 'ws'
import * as ssh from './sshfs'

// Live Share: one person (the host) opens a session on a folder, others (guests) join it with a code, see the folder, open its files
// and edit them together with the host. This file is the transport and the file server; the shared text itself (a Yjs document per
// file, cursors) lives in the renderer (src/renderer/src/liveshare.ts).
//
//   remote   the shared folder may also be one in a WSL distribution (reached as a Windows network path, so the host reads it like any
//            folder) or one on another computer over SSH (the host's SFTP connection serves the guests; links that lead out of the
//            folder are refused by asking the server for the real path).
//   host     a WebSocket server that needs the session code (an address and a random token). It listens on this PC only, unless the
//            host chooses to allow other computers. Guests can read and write files below the shared folder and nothing else:
//            no terminal, no commands, no other folder.
//   guest    one WebSocket connection to the host. Paths of the host's files look like \\liveshare.<session>\src\a.ts here, so the
//            editor's file calls (read a folder, read or save a file, search) are answered by the host.
//   messages JSON. hello/welcome/deny open the session; fs / fs-res are file requests and answers; doc-open, doc-state, doc-update
//            and cursor are for the shared documents and are handed to the renderer (and passed on to the other guests).

const MAX_GUESTS = 8
const MAX_FILE = 5 * 1024 * 1024
const IGNORED = new Set(['.git', 'node_modules'])
const REQUEST_TIMEOUT = 30_000

interface Peer {
  id: string
  name: string
  ws: WebSocket
}
interface Host {
  wss: WebSocketServer
  token: string
  sid: string
  root: string
  realRoot: string
  remote: boolean // a folder on another computer over SSH: files are reached through the SSH connection
  readOnly: boolean
  peers: Map<string, Peer>
  name: string
  join: string // the code guests use
  terms: Map<number, boolean> // terminals the host shares (id -> may guests type in it)
}
interface Guest {
  ws: WebSocket
  sid: string
  id: string
  name: string
  hostName: string
  readOnly: boolean
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>
  nextId: number
  code: string // to come back with after a lost connection
  endedByHost: boolean // the host closed the session: nothing to reconnect to
}

let host: Host | null = null
let guest: Guest | null = null
let getWinRef: () => BrowserWindow | null = () => null
const toRenderer = (payload: unknown): void => getWinRef()?.webContents.send('ls:event', payload)

// ---- paths on the host, below the shared folder ----

const LS = /^\\\\liveshare\.([0-9a-f]{6})(\\.*)?$/i
export const isLiveSharePath = (p: unknown): boolean => typeof p === 'string' && LS.test(p)
/** `\\liveshare.<session>\a\b` -> `a/b` ('' for the folder itself). */
export function lsRel(p: string): string | null {
  const m = LS.exec(p)
  return m ? (m[2] ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : null
}
const lsUnc = (sid: string, rel: string): string => `\\\\liveshare.${sid}${rel ? '\\' + rel.replace(/\//g, '\\') : ''}`

const BS = String.fromCharCode(92)
const OUTSIDE = 'That path is outside the shared folder.'
/** A path below the shared folder on the SSH computer (`rel` is checked here), refused if a link on the way leads out of the folder. */
async function safeRemote(h: Host, rel: string, forWrite: boolean, checkLinks: boolean): Promise<string> {
  const parts = rel.split('/').filter(Boolean)
  if (parts.includes('..')) throw new Error(OUTSIDE)
  if (parts.some((s) => s === '.' || s.includes(BS) || s.includes(':'))) throw new Error('That path is not allowed.')
  if (forWrite) {
    if (h.readOnly) throw new Error('This session is read-only.')
    if (parts.some((s) => s.toLowerCase() === '.git')) throw new Error('Guests cannot change git data.')
  }
  const unc = parts.length ? h.root + BS + parts.join(BS) : h.root
  if (checkLinks && parts.length) {
    // The real place of the file (or of the nearest folder that exists, for a new file) has to be below the real place of the folder.
    const r = await ssh.exec(h.root, ['realpath', '-m', '--', parts.join('/')])
    const real = r.stdout.trim()
    if (r.code !== 0 || !real) throw new Error('This server cannot confirm that the path is inside the shared folder (realpath is needed).')
    if (real !== h.realRoot && !real.startsWith(h.realRoot.replace(/\/+$/, '') + '/')) throw new Error(OUTSIDE)
  }
  return unc
}

async function safe(h: Host, rel: string, forWrite = false, checkLinks = true): Promise<string> {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new Error('That path is not allowed.')
  if (h.remote) return safeRemote(h, rel, forWrite, checkLinks)
  const abs = resolve(h.root, ...rel.split('/').filter(Boolean))
  const back = relative(h.root, abs)
  if (back.startsWith('..') || isAbsolute(back)) throw new Error('That path is outside the shared folder.')
  // A link that leads out of the folder does not count as inside it.
  const real = await fs.realpath(abs).catch(() => null)
  if (real) {
    const r = relative(h.realRoot, real)
    if (r.startsWith('..') || isAbsolute(r)) throw new Error('That path is outside the shared folder.')
  }
  if (forWrite) {
    if (h.readOnly) throw new Error('This session is read-only.')
    if (back.split(sep).some((s) => s.toLowerCase() === '.git')) throw new Error('Guests cannot change git data.')
  }
  return abs
}

async function walk(h: Host, dirAbs: string, out: string[], max: number): Promise<void> {
  if (out.length >= max) return
  for (const d of await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => [])) {
    if (IGNORED.has(d.name)) continue
    const full = join(dirAbs, d.name)
    if (d.isDirectory()) await walk(h, full, out, max)
    else if (d.isFile()) out.push(relative(h.root, full).split(sep).join('/'))
    if (out.length >= max) return
  }
}

/** The host answers a guest's file request. */
/** The same answers as serveFs, for a folder on another computer. */
async function serveRemoteFs(h: Host, op: string, req: Record<string, unknown>): Promise<unknown> {
  const rel = String(req.rel ?? '')
  switch (op) {
    case 'isDir':
      return ssh.isDir(await safe(h, rel))
    case 'readDir':
      return (await ssh.readDir(await safe(h, rel))).map((d) => ({ name: d.name, isDir: d.isDir }))
    case 'readFile':
      return ssh.readFile(await safe(h, rel))
    case 'writeFile':
    case 'createFile': {
      const unc = await safe(h, rel, true)
      const content = String(req.content ?? '')
      if (content.length > MAX_FILE) throw new Error('That file is too large to save in a shared session.')
      await ssh.mkdirp(unc.slice(0, unc.lastIndexOf(BS)))
      await ssh.writeFile(unc, content, op === 'createFile')
      toRenderer({ type: 'file-written', rel })
      return null
    }
    case 'listFiles': {
      const root = await safe(h, rel, false, false)
      const base = h.root.length + 1
      return (await ssh.listFiles(root)).map((f) => f.slice(base).replace(/\\/g, '/'))
    }
    case 'search': {
      const r = await ssh.search(h.root, String(req.query ?? ''), { caseSensitive: req.caseSensitive === true, regex: req.regex === true })
      return { matches: r.matches.map((m) => ({ rel: m.rel, line: m.line, text: m.text })), truncated: r.truncated, error: r.error }
    }
    default:
      throw new Error('Guests cannot do that: ' + op)
  }
}

async function serveFs(h: Host, op: string, req: Record<string, unknown>): Promise<unknown> {
  if (h.remote) return serveRemoteFs(h, op, req)
  const rel = String(req.rel ?? '')
  switch (op) {
    case 'isDir': {
      const abs = await safe(h, rel)
      return (await fs.stat(abs).catch(() => null))?.isDirectory() ?? false
    }
    case 'readDir': {
      const abs = await safe(h, rel)
      const list = await fs.readdir(abs, { withFileTypes: true })
      return list
        .filter((d) => !IGNORED.has(d.name))
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    }
    case 'readFile': {
      const abs = await safe(h, rel)
      const st = await fs.stat(abs)
      if (st.size > MAX_FILE) throw new Error(`This file is ${(st.size / 1048576).toFixed(1)} MB; shared files can be up to 5 MB.`)
      return fs.readFile(abs, 'utf-8')
    }
    case 'writeFile':
    case 'createFile': {
      const abs = await safe(h, rel, true)
      const content = String(req.content ?? '')
      if (content.length > MAX_FILE) throw new Error('That file is too large to save in a shared session.')
      if (op === 'createFile' && (await fs.stat(abs).catch(() => null))) throw Object.assign(new Error('A file or folder with that name already exists.'), { code: 'EEXIST' })
      await fs.mkdir(join(abs, '..'), { recursive: true })
      await fs.writeFile(abs, content, 'utf-8')
      toRenderer({ type: 'file-written', rel })
      return null
    }
    case 'listFiles': {
      const out: string[] = []
      await walk(h, await safe(h, rel), out, 10000)
      return out
    }
    case 'search': {
      const query = String(req.query ?? '')
      if (!query) return { matches: [], truncated: false }
      let re: RegExp
      try {
        re = new RegExp(req.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), req.caseSensitive ? '' : 'i')
      } catch (e) {
        return { matches: [], truncated: false, error: e instanceof Error ? e.message : String(e) }
      }
      const files: string[] = []
      await walk(h, h.root, files, 10000)
      const matches: { rel: string; line: number; text: string }[] = []
      for (const f of files) {
        if (matches.length >= 500) break
        const st = await fs.stat(join(h.root, f)).catch(() => null)
        if (!st || st.size > 1_000_000) continue
        const text = await fs.readFile(join(h.root, f), 'utf-8').catch(() => '')
        if (text.slice(0, 2000).includes('\0')) continue
        text.split(/\r?\n/).forEach((line, i) => {
          if (matches.length < 500 && re.test(line)) matches.push({ rel: f, line: i + 1, text: line.slice(0, 300) })
        })
      }
      return { matches, truncated: matches.length >= 500 }
    }
    default:
      throw new Error('Guests cannot do that: ' + op)
  }
}

// ---- the host ----

const sendTo = (ws: WebSocket, msg: unknown): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}
const peerList = (h: Host): { id: string; name: string }[] => [{ id: 'host', name: h.name }, ...[...h.peers.values()].map((p) => ({ id: p.id, name: p.name }))]
function broadcast(h: Host, msg: unknown, except?: string): void {
  for (const p of h.peers.values()) if (p.id !== except) sendTo(p.ws, msg)
}
const announcePeers = (h: Host): void => {
  broadcast(h, { t: 'peers', peers: peerList(h) })
  toRenderer({ type: 'peers', peers: peerList(h) })
}

function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return '127.0.0.1'
}

async function startHost(opts: { root: string; name: string; readOnly: boolean; network: boolean }): Promise<{ ok: true; join: string; sid: string } | { ok: false; error: string }> {
  if (host) return { ok: false, error: 'A session is already open. End it first.' }
  if (guest) return { ok: false, error: 'You are in somebody else’s session. Leave it first.' }
  if (isLiveSharePath(opts.root)) return { ok: false, error: 'That folder belongs to somebody else’s session.' }
  const remote = ssh.isRemotePath(opts.root)
  if (remote ? !(await ssh.isDir(opts.root)) : !(await fs.stat(opts.root).catch(() => null))?.isDirectory()) return { ok: false, error: 'Open a folder to share it.' }
  let realRoot = resolve(opts.root)
  if (remote) {
    const r = await ssh.exec(opts.root, ['pwd', '-P'])
    realRoot = r.code === 0 ? r.stdout.trim() : ''
    if (!realRoot) return { ok: false, error: 'Could not look at that folder on the server: ' + (r.stderr.trim() || 'no answer') }
  } else realRoot = await fs.realpath(opts.root).catch(() => realRoot)
  const token = randomBytes(16).toString('hex')
  const sid = randomBytes(3).toString('hex')
  const bind = opts.network ? '0.0.0.0' : '127.0.0.1'
  const wss = new WebSocketServer({ host: bind, port: 0, maxPayload: 16 * 1024 * 1024 })
  await new Promise<void>((res, rej) => {
    wss.once('listening', () => res())
    wss.once('error', rej)
  }).catch((e) => {
    throw e
  })
  const h: Host = { wss, token, sid, root: remote ? opts.root.replace(/\\+$/, '') : resolve(opts.root), realRoot, remote, readOnly: opts.readOnly, peers: new Map(), name: who(opts.name), join: '', terms: new Map() }
  host = h
  const port = (wss.address() as { port: number }).port
  wss.on('connection', (ws) => {
    let peer: Peer | null = null
    const hello = setTimeout(() => ws.close(), 10_000) // someone who never says who they are
    ws.on('message', async (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!peer) {
        clearTimeout(hello)
        const given = Buffer.from(String(msg.token ?? ''))
        const want = Buffer.from(token)
        if (msg.t !== 'hello' || given.length !== want.length || !timingSafeEqual(given, want)) {
          sendTo(ws, { t: 'deny', reason: 'The code is not right.' })
          return void ws.close()
        }
        if (h.peers.size >= MAX_GUESTS) {
          sendTo(ws, { t: 'deny', reason: 'The session is full.' })
          return void ws.close()
        }
        peer = { id: randomBytes(4).toString('hex'), name: String(msg.name ?? 'Guest').slice(0, 40) || 'Guest', ws }
        h.peers.set(peer.id, peer)
        sendTo(ws, { t: 'welcome', sid, id: peer.id, hostName: h.name, rootName: h.root.split(/[\\/]/).pop(), readOnly: h.readOnly, peers: peerList(h) })
        announcePeers(h)
        return
      }
      const me = peer
      if (msg.t === 'fs') {
        try {
          sendTo(ws, { t: 'fs-res', id: msg.id, ok: true, result: await serveFs(h, String(msg.op), msg) })
        } catch (e) {
          sendTo(ws, { t: 'fs-res', id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code })
        }
      } else if (msg.t === 'doc-update' || msg.t === 'cursor') {
        if (msg.t === 'doc-update' && h.readOnly) return // a read-only guest's edits are not taken
        const out = { ...msg, from: me.id }
        broadcast(h, out, me.id)
        toRenderer({ type: 'msg', from: me.id, name: me.name, msg: out })
      } else if (msg.t === 'doc-open') {
        toRenderer({ type: 'msg', from: me.id, name: me.name, msg: { ...msg, from: me.id } })
      } else if (msg.t === 'term-open') {
        // Only terminals the host chose to share can be watched.
        if (h.terms.has(Number(msg.tid))) toRenderer({ type: 'msg', from: me.id, name: me.name, msg: { t: 'term-open', tid: Number(msg.tid), from: me.id } })
      } else if (msg.t === 'term-input') {
        // Typing in a shared terminal runs commands on the host's PC: only where the host allowed it, never in a read-only session.
        const data = msg.data
        if (h.readOnly || h.terms.get(Number(msg.tid)) !== true || typeof data !== 'string' || data.length > 4096) return
        toRenderer({ type: 'msg', from: me.id, name: me.name, msg: { t: 'term-input', tid: Number(msg.tid), data, from: me.id } })
      }
    })
    ws.on('close', () => {
      clearTimeout(hello)
      if (peer && h.peers.delete(peer.id)) {
        broadcast(h, { t: 'gone', id: peer.id })
        toRenderer({ type: 'gone', id: peer.id })
        announcePeers(h)
      }
    })
    ws.on('error', () => ws.close())
  })
  const addr = opts.network ? lanAddress() : '127.0.0.1'
  h.join = `${addr}:${port}#${token}`
  return { ok: true, join: h.join, sid }
}

function stopHost(): void {
  if (!host) return
  const h = host
  host = null
  for (const p of h.peers.values()) {
    sendTo(p.ws, { t: 'closed', reason: 'The host ended the session.' })
    p.ws.close()
  }
  h.wss.close()
  toRenderer({ type: 'closed', reason: '' })
}

// ---- the guest ----

type JoinResult = { ok: true; sid: string; root: string; hostName: string; readOnly: boolean; id: string; peers: { id: string; name: string }[] } | { ok: false; error: string }
type Dialed = { ok: true; ws: WebSocket; welcome: Record<string, unknown> } | { ok: false; error: string; refused: boolean }

/** Connects to a session and says hello; resolves with the open connection and the host's welcome, or why not (`refused`: the host said no, so trying again is pointless). */
function dial(code: string, name: string): Promise<Dialed> {
  const m = /^(?:ls:\/\/)?([A-Za-z0-9.\-[\]:]+?):(\d{1,5})#([0-9a-f]{32})$/.exec(code.trim())
  if (!m) return Promise.resolve({ ok: false, error: 'That is not a Live Share code. It looks like 192.168.1.5:50123#abc…', refused: true })
  const ws = new WebSocket(`ws://${m[1].includes(':') && !m[1].startsWith('[') ? '[' + m[1] + ']' : m[1]}:${m[2]}`, { handshakeTimeout: 8000, maxPayload: 16 * 1024 * 1024 })
  return new Promise((resolveDial) => {
    let settled = false
    const done = (r: Dialed): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!r.ok) ws.close()
      resolveDial(r)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'The host did not answer.', refused: false }), 12_000)
    ws.once('open', () => sendTo(ws, { t: 'hello', token: m[3], name: name.slice(0, 40) || 'Guest', v: 1 }))
    const first = (raw: WebSocket.RawData): void => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.t === 'deny') return done({ ok: false, error: String(msg.reason ?? 'The host did not let you in.'), refused: true })
      if (msg.t !== 'welcome') return
      ws.off('message', first)
      done({ ok: true, ws, welcome: msg })
    }
    ws.on('message', first)
    ws.once('error', (e) => done({ ok: false, error: `Could not connect: ${e.message}`, refused: false }))
    ws.once('close', () => done({ ok: false, error: 'The host closed the connection.', refused: false }))
  })
}

/** Listens to the host on this connection (the first one, or one made again after the connection was lost). */
function listen(g: Guest, ws: WebSocket): void {
  ws.on('message', (raw) => {
    if (guest !== g || g.ws !== ws) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.t === 'fs-res') {
      const p = g.pending.get(Number(msg.id))
      if (!p) return
      g.pending.delete(Number(msg.id))
      clearTimeout(p.timer)
      msg.ok ? p.resolve(msg.result) : p.reject(Object.assign(new Error(String(msg.error ?? 'The host could not do that.')), { code: msg.code }))
    } else if (msg.t === 'peers') toRenderer({ type: 'peers', peers: msg.peers })
    else if (msg.t === 'gone') toRenderer({ type: 'gone', id: msg.id })
    else if (msg.t === 'closed') {
      g.endedByHost = true // not a lost connection: there is nothing to come back to
      toRenderer({ type: 'closed', reason: String(msg.reason ?? '') })
    } else if (msg.t === 'doc-state' || msg.t === 'doc-update' || msg.t === 'cursor' || msg.t === 'terms' || msg.t === 'term-data' || msg.t === 'debug') toRenderer({ type: 'msg', from: String(msg.from ?? 'host'), msg })
  })
  ws.on('error', () => ws.close())
  ws.on('close', () => {
    if (guest !== g || g.ws !== ws) return
    for (const p of g.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('The connection to the host was lost.'))
    }
    g.pending.clear()
    if (g.endedByHost) {
      guest = null
      return
    }
    void reconnect(g)
  })
}

const RECONNECT_WAITS = [1000, 2000, 4000, 8000, 8000, 8000]
/** The connection to the host dropped: try again for about half a minute, as a new guest with the same code; the editor then brings the shared files up to date. */
async function reconnect(g: Guest): Promise<void> {
  toRenderer({ type: 'reconnecting' })
  for (const wait of RECONNECT_WAITS) {
    await new Promise((r) => setTimeout(r, wait))
    if (guest !== g) return // left in the meantime
    const r = await dial(g.code, g.name)
    if (guest !== g) {
      if (r.ok) r.ws.close()
      return
    }
    if (!r.ok) {
      if (r.refused) break
      continue
    }
    g.ws = r.ws
    g.id = String(r.welcome.id)
    listen(g, r.ws)
    toRenderer({ type: 'reconnected', id: g.id, peers: r.welcome.peers })
    return
  }
  if (guest === g) {
    guest = null
    toRenderer({ type: 'closed', reason: 'The connection to the host was lost and could not be restored.' })
  }
}

async function joinSession(code: string, name: string): Promise<JoinResult> {
  if (guest || host) return { ok: false, error: 'End the current session first.' }
  name = who(name)
  const r = await dial(code, name)
  if (!r.ok) return r
  if (guest || host) {
    r.ws.close()
    return { ok: false, error: 'End the current session first.' }
  }
  const msg = r.welcome
  const g: Guest = { ws: r.ws, sid: String(msg.sid), id: String(msg.id), name, hostName: String(msg.hostName), readOnly: msg.readOnly === true, pending: new Map(), nextId: 1, code, endedByHost: false }
  guest = g
  listen(g, r.ws)
  return { ok: true, sid: g.sid, root: lsUnc(g.sid, ''), hostName: g.hostName, readOnly: g.readOnly, id: g.id, peers: msg.peers as { id: string; name: string }[] }
}

function leave(): void {
  if (!guest) return
  const g = guest
  guest = null
  g.ws.close()
  toRenderer({ type: 'closed', reason: '' })
}

/** A file request to the host, from the editor's file calls for \\liveshare paths. */
function ask(op: string, rel: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const g = guest
  if (!g) return Promise.reject(new Error('You are not in a Live Share session.'))
  return new Promise((resolveAsk, reject) => {
    const id = g.nextId++
    const timer = setTimeout(() => {
      g.pending.delete(id)
      reject(new Error('The host did not answer in time.'))
    }, REQUEST_TIMEOUT)
    g.pending.set(id, { resolve: resolveAsk, reject, timer })
    sendTo(g.ws, { t: 'fs', id, op, rel, ...extra })
  })
}

const relOrThrow = (p: string): string => {
  const rel = lsRel(p)
  if (rel === null) throw new Error('Not a shared path.')
  if (guest && !p.toLowerCase().startsWith(`\\\\liveshare.${guest.sid}`)) throw new Error('That session has ended.')
  return rel
}

export const lsIsDir = async (p: string): Promise<boolean> => !!(await ask('isDir', relOrThrow(p)).catch(() => false))
export async function lsReadDir(p: string): Promise<{ name: string; path: string; isDir: boolean }[]> {
  const rel = relOrThrow(p)
  const list = (await ask('readDir', rel)) as { name: string; isDir: boolean }[]
  return list.map((d) => ({ name: d.name, isDir: d.isDir, path: lsUnc(guest?.sid ?? '', rel ? `${rel}/${d.name}` : d.name) }))
}
export const lsReadFile = async (p: string): Promise<string> => (await ask('readFile', relOrThrow(p))) as string
export const lsWriteFile = async (p: string, content: string, exclusive = false): Promise<void> => void (await ask(exclusive ? 'createFile' : 'writeFile', relOrThrow(p), { content }))
export async function lsListFiles(p: string): Promise<string[]> {
  const list = (await ask('listFiles', relOrThrow(p))) as string[]
  return list.map((r) => lsUnc(guest?.sid ?? '', r))
}
export async function lsSearch(p: string, query: string, opts: { caseSensitive: boolean; regex: boolean }): Promise<{ matches: { path: string; rel: string; line: number; text: string }[]; truncated: boolean; error?: string }> {
  relOrThrow(p)
  const r = (await ask('search', '', { query, caseSensitive: opts.caseSensitive, regex: opts.regex })) as { matches: { rel: string; line: number; text: string }[]; truncated: boolean; error?: string }
  return { ...r, matches: r.matches.map((m) => ({ ...m, path: lsUnc(guest?.sid ?? '', m.rel) })) }
}

export function registerLiveShareHandlers(getWin: () => BrowserWindow | null): void {
  getWinRef = getWin
  ipcMain.handle('ls:host', async (_e, opts: { root: string; name?: string; readOnly?: boolean; network?: boolean }) => {
    try {
      return await startHost({ root: String(opts?.root ?? ''), name: String(opts?.name ?? ''), readOnly: opts?.readOnly === true, network: opts?.network === true })
    } catch (e) {
      host = null
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ls:stop', () => {
    stopHost()
    leave()
  })
  ipcMain.handle('ls:join', (_e, code: string, name: string) => joinSession(String(code ?? ''), String(name ?? '')))
  ipcMain.handle('ls:status', () =>
    host
      ? { role: 'host' as const, sid: host.sid, readOnly: host.readOnly, peers: peerList(host), join: host.join }
      : guest
        ? { role: 'guest' as const, sid: guest.sid, readOnly: guest.readOnly, peers: [] }
        : { role: 'none' as const }
  )
  // For tests only: cut the connections as if the network had failed (the session stays open; a guest comes back by itself).
  if (process.env.MY_AI_IDE_TEST_HOOKS === '1') {
    ipcMain.handle('ls:test-drop', () => {
      for (const p of host?.peers.values() ?? []) p.ws.terminate()
      guest?.ws.terminate()
    })
  }
  // The terminals the host shares, and whether guests may type in each: the host's renderer says, this side enforces it.
  ipcMain.handle('ls:terms', (_e, list: { id: number; write: boolean }[]) => {
    if (!host || !Array.isArray(list)) return
    host.terms = new Map(list.filter((t) => Number.isInteger(t?.id)).map((t) => [t.id, t.write === true]))
  })
  // The renderer's messages about shared documents: a host sends to one guest (`to`) or to all, a guest to the host.
  ipcMain.handle('ls:send', (_e, msg: Record<string, unknown>) => {
    if (!msg || typeof msg.t !== 'string') return
    if (host) {
      const out = { ...msg, from: 'host' }
      if (typeof msg.to === 'string') {
        const p = host.peers.get(msg.to)
        if (p) sendTo(p.ws, out)
      } else broadcast(host, out)
    } else if (guest) sendTo(guest.ws, { ...msg, from: guest.id })
  })
}

export function stopLiveShare(): void {
  stopHost()
  leave()
}
