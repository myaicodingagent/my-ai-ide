import { BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { randomBytes, timingSafeEqual } from 'crypto'
import { hostname, networkInterfaces, userInfo } from 'os'

const who = (given: string): string => given.trim() || (() => { try { return userInfo().username } catch { return hostname() } })()
import { isAbsolute, join, relative, resolve, sep } from 'path'
import WebSocket, { WebSocketServer } from 'ws'

// Live Share: one person (the host) opens a session on a folder, others (guests) join it with a code, see the folder, open its files
// and edit them together with the host. This file is the transport and the file server; the shared text itself (a Yjs document per
// file, cursors) lives in the renderer (src/renderer/src/liveshare.ts).
//
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

async function safe(h: Host, rel: string, forWrite = false): Promise<string> {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new Error('That path is not allowed.')
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
async function serveFs(h: Host, op: string, req: Record<string, unknown>): Promise<unknown> {
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
  const st = await fs.stat(opts.root).catch(() => null)
  if (!st?.isDirectory()) return { ok: false, error: 'Open a folder on this PC to share it.' }
  const token = randomBytes(16).toString('hex')
  const sid = randomBytes(3).toString('hex')
  const realRoot = await fs.realpath(opts.root).catch(() => opts.root)
  const bind = opts.network ? '0.0.0.0' : '127.0.0.1'
  const wss = new WebSocketServer({ host: bind, port: 0, maxPayload: 16 * 1024 * 1024 })
  await new Promise<void>((res, rej) => {
    wss.once('listening', () => res())
    wss.once('error', rej)
  }).catch((e) => {
    throw e
  })
  const h: Host = { wss, token, sid, root: resolve(opts.root), realRoot, readOnly: opts.readOnly, peers: new Map(), name: who(opts.name), join: '', terms: new Map() }
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

async function joinSession(code: string, name: string): Promise<{ ok: true; sid: string; root: string; hostName: string; readOnly: boolean; id: string; peers: { id: string; name: string }[] } | { ok: false; error: string }> {
  if (guest || host) return { ok: false, error: 'End the current session first.' }
  name = who(name)
  const m = /^(?:ls:\/\/)?([A-Za-z0-9.\-[\]:]+?):(\d{1,5})#([0-9a-f]{32})$/.exec(code.trim())
  if (!m) return { ok: false, error: 'That is not a Live Share code. It looks like 192.168.1.5:50123#abc…' }
  const ws = new WebSocket(`ws://${m[1].includes(':') && !m[1].startsWith('[') ? '[' + m[1] + ']' : m[1]}:${m[2]}`, { handshakeTimeout: 8000, maxPayload: 16 * 1024 * 1024 })
  return new Promise((resolveJoin) => {
    let settled = false
    const done = (r: Awaited<ReturnType<typeof joinSession>>): void => {
      if (settled) return
      settled = true
      if (!r.ok) ws.close()
      resolveJoin(r)
    }
    ws.once('open', () => sendTo(ws, { t: 'hello', token: m[3], name: name.slice(0, 40) || 'Guest', v: 1 }))
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!settled) {
        if (msg.t === 'deny') return done({ ok: false, error: String(msg.reason ?? 'The host did not let you in.') })
        if (msg.t !== 'welcome') return
        const g: Guest = { ws, sid: String(msg.sid), id: String(msg.id), name, hostName: String(msg.hostName), readOnly: msg.readOnly === true, pending: new Map(), nextId: 1 }
        guest = g
        return done({ ok: true, sid: g.sid, root: lsUnc(g.sid, ''), hostName: g.hostName, readOnly: g.readOnly, id: g.id, peers: msg.peers as { id: string; name: string }[] })
      }
      const g = guest
      if (!g) return
      if (msg.t === 'fs-res') {
        const p = g.pending.get(Number(msg.id))
        if (!p) return
        g.pending.delete(Number(msg.id))
        clearTimeout(p.timer)
        msg.ok ? p.resolve(msg.result) : p.reject(Object.assign(new Error(String(msg.error ?? 'The host could not do that.')), { code: msg.code }))
      } else if (msg.t === 'peers') toRenderer({ type: 'peers', peers: msg.peers })
      else if (msg.t === 'gone') toRenderer({ type: 'gone', id: msg.id })
      else if (msg.t === 'closed') toRenderer({ type: 'closed', reason: String(msg.reason ?? '') })
      else if (msg.t === 'doc-state' || msg.t === 'doc-update' || msg.t === 'cursor' || msg.t === 'terms' || msg.t === 'term-data') toRenderer({ type: 'msg', from: String(msg.from ?? 'host'), msg })
    })
    ws.on('error', (e) => done({ ok: false, error: `Could not connect: ${e.message}` }))
    ws.on('close', () => {
      if (!settled) return done({ ok: false, error: 'The host closed the connection.' })
      if (guest?.ws === ws) {
        const g = guest
        guest = null
        for (const p of g.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error('The session ended.'))
        }
        toRenderer({ type: 'closed', reason: 'The connection to the host was lost.' })
      }
    })
    setTimeout(() => done({ ok: false, error: 'The host did not answer.' }), 12_000)
  })
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
