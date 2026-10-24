import { BrowserWindow, ipcMain } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { existsSync, promises as fsp } from 'fs'
import { tmpdir } from 'os'
import { delimiter, dirname, join, resolve as resolvePath } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import WebSocket from 'ws'
import { SourceMapIndex, parseSourceMap } from './sourcemap'
import { installNetcoredbg } from './netcoredbg'
import { DapSession, adapterFor, goAdapter, killTree, pythonAdapter, startDapAttach, startDapDebug } from './dap'
import * as ssh from './sshfs'
import { isRemotePath } from './sshfs'

// A JavaScript debugger: the program runs under `node --inspect-brk` and this talks to Node's built-in inspector
// (the Chrome DevTools protocol) over a WebSocket. One session at a time.
//   renderer -> main   dbg:start / dbg:stop / dbg:continue / dbg:stepOver / dbg:stepInto / dbg:stepOut / dbg:pause
//                      dbg:setBreakpoints / dbg:scopes / dbg:props / dbg:eval
//   main -> renderer   'dbg:event': started, paused, resumed, output, exited, error

export interface DbgBreakpoint {
  line: number // 1-based
  condition?: string
}

export interface DbgFrame {
  index: number
  name: string
  file: string | null // absolute path, or null for Node's own code
  url: string
  line: number // 1-based
  column: number // 1-based
}

export interface DbgVar {
  name: string
  value: string
  type: string
  objectId?: string // present when it can be expanded
}

export interface DbgScope {
  name: string
  vars: DbgVar[]
}

export type DbgEvent =
  | { type: 'started'; pid: number }
  | { type: 'paused'; reason: string; frames: DbgFrame[]; exception?: string }
  | { type: 'resumed' }
  | { type: 'output'; stream: 'stdout' | 'stderr' | 'info'; text: string }
  | { type: 'exited'; code: number | null }
  | { type: 'error'; message: string }

interface Remote {
  type: string
  subtype?: string
  value?: unknown
  description?: string
  objectId?: string
  className?: string
}

interface Session {
  child: ChildProcess | null // null when attached to a program that was already running
  ws: WebSocket | null
  nextId: number
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
  frames: { callFrameId: string; scopeChain: { type: string; name?: string; object: Remote }[] }[]
  breakpointIds: Map<string, string[]> // file -> CDP breakpoint ids
  scripts: Map<string, string> // script id -> url (call frames only carry the id)
  stopOnEntry: boolean
  firstPause: boolean
  remote?: string // the name of the computer the program runs on (over SSH); file paths are translated
  tunnel?: { close(): void }
  exited: boolean
  // TypeScript: the program runs from a JavaScript bundle made from it; this maps between the two.
  ts?: { jsFile: string; index: SourceMapIndex; dir: string }
}

let session: Session | null = null
let getWinRef: () => BrowserWindow | null = () => null

const emit = (e: DbgEvent): void => getWinRef()?.webContents.send('dbg:event', e)

// ---- helpers ----

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A regex source matching the file:// URL Node reports for a file (drive letter case may differ on Windows). */
export function urlRegexFor(file: string): string {
  return regexForHref(pathToFileURL(file).href)
}

/** The file URL Node reports for a path on a remote computer (a POSIX path, or C:/... on a Windows server), as a regex. */
export function urlRegexForNative(native: string): string {
  const path = (native.startsWith('/') ? native : '/' + native).split('/').map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/')
  return regexForHref('file://' + path)
}

function regexForHref(href: string): string {
  const body = escapeRegex(href)
    .replace(/^(file:\/\/\/)([a-zA-Z])(:|%3A)/i, (_m, pre: string, d: string, colon: string) => `${pre}[${d.toLowerCase()}${d.toUpperCase()}]${colon}`)
    // Node leaves ~ ! ' ( ) * unescaped in the script URLs it reports (as in C:/Users/NAME~1/), the URL class escapes some of them.
    .replace(/%(7E|21|27|28|29|2A)/gi, (m, hex: string) => `(?:${m}|${escapeRegex(String.fromCharCode(parseInt(hex, 16)))})`)
  return '^' + body + '$'
}

function fileFromUrl(url: string, remote?: string): string | null {
  if (!url.startsWith('file:')) return null
  try {
    if (remote) return ssh.fromNativePath(remote, decodeURIComponent(new URL(url).pathname).replace(/^\/(?=[A-Za-z]:)/, ''))
    return fileURLToPath(url)
  } catch {
    return null
  }
}

function describe(r: Remote): string {
  if (r.type === 'undefined') return 'undefined'
  if (r.subtype === 'null') return 'null'
  if (r.type === 'string') return JSON.stringify(r.value)
  if (r.type === 'number' || r.type === 'boolean' || r.type === 'bigint') return String(r.description ?? r.value)
  if (r.type === 'function') return (r.description ?? 'function').split('\n')[0].slice(0, 80)
  if (r.type === 'symbol') return r.description ?? 'Symbol()'
  return r.description ?? r.className ?? r.type
}

const toVar = (name: string, r: Remote): DbgVar => ({
  name,
  value: describe(r),
  type: r.subtype ?? r.type,
  objectId: r.type === 'object' ? r.objectId : undefined
})

function send<T = any>(s: Session, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return reject(new Error('The debugger is not connected.'))
    const id = s.nextId++
    s.pending.set(id, { resolve, reject })
    s.ws.send(JSON.stringify({ id, method, params }))
  })
}

const samePath = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

async function applyBreakpoints(s: Session, file: string, bps: DbgBreakpoint[]): Promise<void> {
  for (const id of s.breakpointIds.get(file) ?? []) await send(s, 'Debugger.removeBreakpoint', { breakpointId: id }).catch(() => undefined)
  const ids: string[] = []
  // A TypeScript file: the breakpoint goes where its line ended up in the generated JavaScript.
  const srcIdx = s.ts ? s.ts.index.sources.findIndex((x) => samePath(x, file)) : -1
  for (const bp of bps) {
    try {
      let lineNumber = bp.line - 1
      let urlRegex: string
      if (s.remote) {
        // Only files on the computer the program runs on can have breakpoints in it.
        const native = ssh.parseRemote(file)?.name === s.remote ? ssh.nativePath(file) : null
        if (!native) continue
        urlRegex = urlRegexForNative(native)
      } else if (isRemotePath(file)) continue
      else urlRegex = urlRegexFor(file)
      let columnNumber: number | undefined
      if (s.ts && srcIdx >= 0) {
        const g = s.ts.index.generatedFor(srcIdx, bp.line - 1)
        if (!g) continue // nothing on or after that line becomes code
        lineNumber = g.line
        columnNumber = g.column
        urlRegex = urlRegexFor(s.ts.jsFile)
      }
      const r = await send<{ breakpointId: string }>(s, 'Debugger.setBreakpointByUrl', {
        lineNumber,
        ...(columnNumber !== undefined ? { columnNumber } : {}),
        urlRegex,
        ...(bp.condition?.trim() ? { condition: bp.condition } : {})
      })
      ids.push(r.breakpointId)
    } catch {
      // A line that cannot hold a breakpoint is skipped.
    }
  }
  s.breakpointIds.set(file, ids)
}

async function onPaused(s: Session, p: any): Promise<void> {
  s.frames = p.callFrames
  // Node pauses once at the first line of the program; unless the user asked to stop there, carry on.
  if (s.firstPause) {
    s.firstPause = false
    if (!s.stopOnEntry && (/Break on start/i.test(String(p.reason)) || p.reason === 'other') && (p.hitBreakpoints ?? []).length === 0) {
      await send(s, 'Debugger.resume').catch(() => undefined)
      return
    }
  }
  const frames: DbgFrame[] = p.callFrames.map((f: any, i: number): DbgFrame => {
    const url: string = s.scripts.get(f.location.scriptId) ?? f.url ?? ''
    let file = fileFromUrl(url, s.remote)
    let line = f.location.lineNumber + 1
    let column = (f.location.columnNumber ?? 0) + 1
    // Code from the TypeScript bundle is shown at its place in the original file.
    if (s.ts && file && samePath(file, s.ts.jsFile)) {
      const o = s.ts.index.originalFor(f.location.lineNumber, f.location.columnNumber ?? 0)
      if (o) {
        file = o.source
        line = o.line + 1
        column = o.column + 1
      }
    }
    return {
      index: i,
      name: f.functionName || (i === p.callFrames.length - 1 ? '(program)' : '(anonymous)'),
      file,
      url,
      line,
      column
    }
  })
  const reason =
    (p.hitBreakpoints ?? []).length > 0 ? 'breakpoint' : p.reason === 'exception' || p.reason === 'promiseRejection' ? 'exception' : p.reason === 'other' ? 'step' : String(p.reason)
  emit({ type: 'paused', reason, frames, exception: p.data?.description ? String(p.data.description).split('\n')[0] : undefined })
}

function handleMessage(s: Session, raw: string): void {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof msg.id === 'number') {
    const p = s.pending.get(msg.id)
    s.pending.delete(msg.id)
    if (p) msg.error ? p.reject(new Error(msg.error.message ?? 'Debugger error')) : p.resolve(msg.result)
    return
  }
  if (msg.method === 'Debugger.scriptParsed') s.scripts.set(msg.params.scriptId, msg.params.url)
  else if (msg.method === 'Debugger.paused') void onPaused(s, msg.params)
  else if (msg.method === 'Debugger.resumed') {
    s.frames = []
    emit({ type: 'resumed' })
  }
}

// ---- starting ----

function nodeCommand(): { file: string; env: NodeJS.ProcessEnv } {
  // The user's own node if there is one (their project is written for it); otherwise the Node inside this app.
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  const sep = process.platform === 'win32' ? ';' : ':'
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (env.PATH ?? env.Path ?? '').split(sep)) {
    if (dir && existsSync(`${dir}${process.platform === 'win32' ? '\\' : '/'}${exe}`)) {
      delete env.ELECTRON_RUN_AS_NODE
      return { file: exe, env }
    }
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  return { file: process.execPath, env }
}

const NOISE = [/^Debugger listening on /, /^For help, see: /, /^Debugger attached\./, /^Waiting for the debugger to disconnect/]

const TS_FILE = /\.(ts|tsx|mts|cts)$/i

// esbuild is a program (not JavaScript): in the installed app it lives outside the app.asar archive.
function esbuildBinary(): string | undefined {
  try {
    const exe = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'
    const pkg = `@esbuild/${process.platform}-${process.arch}`
    return require.resolve(`${pkg}/${process.platform === 'win32' ? '' : 'bin/'}${exe}`).replace('app.asar' + (process.platform === 'win32' ? '\\' : '/'), 'app.asar.unpacked' + (process.platform === 'win32' ? '\\' : '/'))
  } catch {
    return undefined
  }
}

/** Turns a TypeScript program into one JavaScript file with a source map (packages stay as imports, found at run time). */
async function bundleTs(entry: string, cwd: string): Promise<{ jsFile: string; index: SourceMapIndex; dir: string }> {
  const bin = esbuildBinary()
  if (bin && !process.env.ESBUILD_BINARY_PATH) process.env.ESBUILD_BINARY_PATH = bin
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const esbuild = require('esbuild') as typeof import('esbuild')
  const dir = await fsp.mkdtemp(join(tmpdir(), 'ai-ide-debug-'))
  const jsFile = join(dir, 'program.js')
  await esbuild.build({
    entryPoints: [entry],
    outfile: jsFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: 'linked',
    sourcesContent: false,
    packages: 'external',
    absWorkingDir: cwd,
    logLevel: 'silent'
  })
  const index = parseSourceMap(await fsp.readFile(jsFile + '.map', 'utf-8'), jsFile + '.map')
  return { jsFile, index, dir }
}

async function start(opts: {
  file: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  stopOnEntry?: boolean
  breakpoints: Record<string, DbgBreakpoint[]>
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (session && !session.exited) return { ok: false, error: 'A debug session is already running. Stop it first.' }
  const remote = isRemotePath(opts.file) ? ssh.parseRemote(opts.file)?.name : undefined
  if (remote) {
    if (TS_FILE.test(opts.file)) return { ok: false, error: 'TypeScript programs on another computer cannot be debugged yet. Compile it there and debug the JavaScript file.' }
    try {
      await ssh.requireFile(opts.file)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  } else if (!existsSync(opts.file)) return { ok: false, error: `The file does not exist: ${opts.file}` }
  const { file, env } = nodeCommand()
  const cwd = opts.cwd || dirname(opts.file)
  let ts: Session['ts']
  let program = opts.file
  if (TS_FILE.test(opts.file)) {
    try {
      ts = await bundleTs(opts.file, cwd)
      program = ts.jsFile
    } catch (e) {
      const errs = (e as { errors?: { text: string; location?: { file: string; line: number } }[] }).errors
      return { ok: false, error: 'Could not compile the TypeScript program:\n' + (errs?.length ? errs.slice(0, 5).map((x) => (x.location ? `${x.location.file}:${x.location.line} ` : '') + x.text).join('\n') : e instanceof Error ? e.message : String(e)) }
    }
  }
  // Packages the program imports are looked for next to the program, not next to the bundle in the temp folder.
  const nodePath: string[] = []
  for (let d = cwd; ; d = dirname(d)) {
    nodePath.push(join(d, 'node_modules'))
    if (dirname(d) === d) break
  }
  let child: ChildProcess
  try {
    if (remote) {
      // On the other computer: its own node, started over SSH; the debugger port is reached through the same connection.
      child = ssh.spawnRemote(cwd, ['node', '--inspect-brk=127.0.0.1:0', ssh.nativePath(opts.file) as string, ...(opts.args ?? [])], { env: opts.env }) as unknown as ChildProcess
    } else
    child = spawn(file, ['--inspect-brk=127.0.0.1:0', program, ...(opts.args ?? [])], {
      cwd,
      env: {
        ...env,
        ...(ts ? { NODE_PATH: [...nodePath, env.NODE_PATH ?? ''].filter(Boolean).join(delimiter) } : {}),
        ...Object.fromEntries(Object.entries(opts.env ?? {}).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'))
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const s: Session = {
    child, ws: null, nextId: 1, pending: new Map(), frames: [], breakpointIds: new Map(), scripts: new Map(),
    stopOnEntry: opts.stopOnEntry === true, firstPause: true, exited: false, ts, remote
  }
  session = s

  return new Promise((resolve) => {
    let connected = false
    let stderrBuf = ''
    let wsStarted = false
    const fail = (error: string): void => {
      if (connected) return
      connected = true
      try {
        child.kill()
      } catch {
        // already gone
      }
      resolve({ ok: false, error })
    }
    child.on('error', (e) => fail(`Could not start Node: ${e.message}`))
    child.stdout?.on('data', (b: Buffer) => emit({ type: 'output', stream: 'stdout', text: b.toString('utf-8') }))
    child.stderr?.on('data', (b: Buffer) => {
      const text = b.toString('utf-8')
      stderrBuf += text
      const m = /ws:\/\/(127\.0\.0\.1|localhost):(\d+)\/[0-9a-f-]+/.exec(stderrBuf)
      if (m && !s.ws && !connected && !wsStarted) {
        wsStarted = true
        const open = (url: string): void => {
          const ws = new WebSocket(url)
          s.ws = ws
          ws.on('open', async () => {
            try {
              await send(s, 'Runtime.enable')
              await send(s, 'Debugger.enable')
              await send(s, 'Debugger.setPauseOnExceptions', { state: 'uncaught' })
              for (const [f, bps] of Object.entries(opts.breakpoints)) await applyBreakpoints(s, f, bps)
              connected = true
              resolve({ ok: true })
              emit({ type: 'started', pid: remote ? 0 : (child.pid ?? 0) })
              await send(s, 'Runtime.runIfWaitingForDebugger')
            } catch (e) {
              fail(e instanceof Error ? e.message : String(e))
            }
          })
          ws.on('message', (d) => handleMessage(s, d.toString()))
          ws.on('error', (e) => fail(`Could not connect to the debugger: ${e.message}`))
        }
        if (remote) {
          ssh.forwardPort(cwd, Number(m[2])).then(
            (t) => {
              s.tunnel = t
              open(m[0].replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${t.port}`))
            },
            (e) => fail(`Could not reach the debugger on the other computer: ${e instanceof Error ? e.message : String(e)}`)
          )
        } else open(m[0])
      }
      // The program has finished; Node now waits for the debugger to let go before it exits.
      if (/Waiting for the debugger to disconnect/.test(text)) {
        try {
          s.ws?.close()
        } catch {
          // already closed
        }
      }
      const keep = text
        .split(/\r?\n/)
        .filter((l) => l && !NOISE.some((re) => re.test(l)))
        .join('\n')
      if (keep) emit({ type: 'output', stream: 'stderr', text: keep + '\n' })
    })
    child.on('close', (code) => {
      s.exited = true
      for (const p of s.pending.values()) p.reject(new Error('The program ended.'))
      s.pending.clear()
      try {
        s.ws?.close()
      } catch {
        // already closed
      }
      if (!connected) fail(`Node exited before the debugger could connect (code ${code}).\n${stderrBuf.trim()}`)
      if (session === s) session = null
      s.tunnel?.close()
      if (s.ts) void fsp.rm(s.ts.dir, { recursive: true, force: true }).catch(() => undefined)
      emit({ type: 'exited', code })
    })
    setTimeout(() => fail('Timed out waiting for Node to start the debugger.'), 20_000)
  })
}

// ---- attaching to a program that is already running (started with --inspect, or given a PID) ----

async function inspectorUrl(host: string, port: number): Promise<string> {
  const res = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
  if (!res || !res.ok) throw new Error(`Nothing is listening for a debugger at ${host}:${port}. Start the program with node --inspect, or attach by process id.`)
  const list = (await res.json()) as { webSocketDebuggerUrl?: string; type?: string }[]
  const target = list.find((t) => t.webSocketDebuggerUrl && (!t.type || t.type === 'node')) ?? list.find((t) => t.webSocketDebuggerUrl)
  if (!target?.webSocketDebuggerUrl) throw new Error('The program did not offer a debugger connection (another debugger may be attached).')
  return target.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${host}:${port}`)
}

// Asks a running Node process to open its inspector (what SIGUSR1 does); it listens on 9229 unless that is taken.
async function enableInspector(pid: number): Promise<number> {
  const { file, env } = nodeCommand()
  const code = `try { process._debugProcess(${Math.floor(pid)}) } catch (e) { console.error(e.message); process.exit(1) }`
  await new Promise<void>((resolve, reject) => {
    const c = spawn(file, ['-e', code], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    c.stderr?.on('data', (b: Buffer) => (err += b.toString()))
    c.on('error', reject)
    c.on('close', (n) => (n === 0 ? resolve() : reject(new Error(err.trim() || `Could not signal process ${pid}.`))))
  })
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250))
    for (const port of [9229, 9230, 9231]) {
      const ok = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false)
      if (ok) return port
    }
  }
  throw new Error(`Process ${pid} did not open a debugger. Is it a Node.js process that is still running?`)
}

async function attach(opts: { host?: string; port?: number; pid?: number; breakpoints: Record<string, DbgBreakpoint[]> }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (session && !session.exited) return { ok: false, error: 'A debug session is already running. Stop it first.' }
  const host = opts.host || '127.0.0.1'
  let url: string
  let pid = 0
  try {
    let port = opts.port
    if (!port && opts.pid) {
      pid = opts.pid
      port = await enableInspector(opts.pid)
    }
    if (!port || port < 1 || port > 65535) return { ok: false, error: 'Give a port (for example 9229) or a process id.' }
    url = await inspectorUrl(host, port)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const s: Session = {
    child: null, ws: null, nextId: 1, pending: new Map(), frames: [], breakpointIds: new Map(), scripts: new Map(),
    stopOnEntry: false, firstPause: false, exited: false
  }
  session = s
  return new Promise((resolve) => {
    let connected = false
    const ws = new WebSocket(url)
    s.ws = ws
    const fail = (error: string): void => {
      if (connected) return
      connected = true
      s.exited = true
      if (session === s) session = null
      try {
        ws.close()
      } catch {
        // already closed
      }
      resolve({ ok: false, error })
    }
    ws.on('open', async () => {
      try {
        await send(s, 'Runtime.enable')
        await send(s, 'Debugger.enable')
        await send(s, 'Debugger.setPauseOnExceptions', { state: 'uncaught' })
        for (const [f, bps] of Object.entries(opts.breakpoints)) await applyBreakpoints(s, f, bps)
        connected = true
        resolve({ ok: true })
        emit({ type: 'started', pid })
        emit({ type: 'output', stream: 'info', text: `Attached to ${host} (the program keeps running; Stop only disconnects).
` })
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e))
      }
    })
    ws.on('message', (d) => handleMessage(s, d.toString()))
    ws.on('error', (e) => fail(`Could not connect to the debugger: ${e.message}`))
    ws.on('close', () => {
      if (!connected) return fail('The debugger connection closed.')
      if (s.exited) return
      s.exited = true
      for (const p of s.pending.values()) p.reject(new Error('The debugger disconnected.'))
      s.pending.clear()
      if (session === s) session = null
      emit({ type: 'exited', code: null })
    })
    setTimeout(() => fail('Timed out connecting to the debugger.'), 15_000)
  })
}

// ---- inspecting ----

async function propsOf(s: Session, objectId: string): Promise<DbgVar[]> {
  const r = await send<{ result: { name: string; value?: Remote; get?: Remote; enumerable?: boolean; isOwn?: boolean }[] }>(s, 'Runtime.getProperties', {
    objectId, ownProperties: true, generatePreview: false
  })
  return r.result
    .filter((p) => p.value && (p.enumerable || p.isOwn) && p.name !== '__proto__')
    .slice(0, 200)
    .map((p) => toVar(p.name, p.value!))
}

let dapSession: DapSession | null = null

export function registerDebugHandlers(getWin: () => BrowserWindow | null): void {
  getWinRef = getWin
  const need = (): Session => {
    if (!session || session.exited) throw new Error('No debug session is running.')
    return session
  }
  const dapActive = (): DapSession | null => (dapSession && dapSession.active ? dapSession : null)

  ipcMain.handle('dbg:start', async (_e, opts) => {
    if ((session && !session.exited) || dapActive()) return { ok: false as const, error: 'A debug session is already running. Stop it first.' }
    // Python (debugpy) and Go (Delve) go through the Debug Adapter Protocol; JavaScript and TypeScript through Node's inspector.
    const adapter = adapterFor(String(opts?.file))
    if (adapter) {
      try {
        dapSession = await startDapDebug(adapter, opts, emit)
        return { ok: true as const }
      } catch (e) {
        dapSession = null
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    }
    return start(opts)
  })
  ipcMain.handle('dbg:attach', async (_e, opts) => {
    if ((session && !session.exited) || dapActive()) return { ok: false as const, error: 'A debug session is already running. Stop it first.' }
    const target = {
      host: typeof opts?.host === 'string' && /^[A-Za-z0-9.-]{1,255}$/.test(opts.host) ? opts.host : undefined,
      port: Number.isInteger(opts?.port) ? opts.port : undefined,
      pid: Number.isInteger(opts?.pid) ? opts.pid : undefined
    }
    const breakpoints = opts?.breakpoints ?? {}
    const language = opts?.language === 'python' || opts?.language === 'go' ? (opts.language as 'python' | 'go') : 'node'
    if (language === 'node') return attach({ ...target, breakpoints })
    try {
      dapSession = await startDapAttach(language === 'python' ? pythonAdapter : goAdapter, target, breakpoints, emit)
      return { ok: true as const }
    } catch (e) {
      dapSession = null
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('dbg:installCsharp', () => installNetcoredbg())
  ipcMain.handle('dbg:stop', () => {
    dapActive()?.stop()
    const s = session
    if (!s) return
    if (!s.child) return void s.ws?.close() // attached: let go, the program keeps running
    killTree(s.child, s.remote)
  })
  for (const [name, method] of [
    ['dbg:continue', 'Debugger.resume'],
    ['dbg:stepOver', 'Debugger.stepOver'],
    ['dbg:stepInto', 'Debugger.stepInto'],
    ['dbg:stepOut', 'Debugger.stepOut'],
    ['dbg:pause', 'Debugger.pause']
  ] as const) {
    ipcMain.handle(name, async () => {
      try {
        const d = dapActive()
        if (d) {
          await d.step(name.slice(4) as 'continue' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause')
          return { ok: true as const }
        }
        await send(need(), method)
        return { ok: true as const }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    })
  }
  ipcMain.handle('dbg:setBreakpoints', async (_e, file: string, bps: DbgBreakpoint[]) => {
    const d = dapActive()
    if (d) return void (await d.setBreakpoints(file, bps).catch(() => undefined))
    if (!session || session.exited || !session.ws) return
    await applyBreakpoints(session, file, bps)
  })
  // Variables of a call frame: its scopes (local, closures; the global scope is left out, it is huge).
  ipcMain.handle('dbg:scopes', async (_e, frameIndex: number): Promise<DbgScope[]> => {
    const d = dapActive()
    if (d) return d.scopes(frameIndex).catch(() => [])
    const s = need()
    const frame = s.frames[frameIndex]
    if (!frame) return []
    const out: DbgScope[] = []
    for (const sc of frame.scopeChain) {
      if (sc.type === 'global') continue
      if (!sc.object.objectId) continue
      const label = sc.type === 'local' ? 'Local' : sc.type === 'closure' ? 'Closure' + (sc.name ? ` (${sc.name})` : '') : sc.type === 'block' ? 'Block' : sc.type === 'catch' ? 'Catch' : sc.type === 'module' ? 'Module' : sc.type[0].toUpperCase() + sc.type.slice(1)
      out.push({ name: label, vars: await propsOf(s, sc.object.objectId).catch(() => []) })
    }
    // `this` is shown with the local scope.
    return out
  })
  ipcMain.handle('dbg:props', async (_e, objectId: string): Promise<DbgVar[]> => {
    const d = dapActive()
    if (d) return d.props(objectId).catch(() => [])
    return propsOf(need(), objectId).catch(() => [])
  })
  ipcMain.handle('dbg:eval', async (_e, expression: string, frameIndex: number | null) => {
    const d = dapActive()
    if (d) return d.evaluate(expression, frameIndex)
    const s = need()
    try {
      const frame = frameIndex === null ? undefined : s.frames[frameIndex]
      const r = frame
        ? await send<{ result: Remote; exceptionDetails?: { exception?: Remote; text: string } }>(s, 'Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, objectGroup: 'console', silent: true })
        : await send<{ result: Remote; exceptionDetails?: { exception?: Remote; text: string } }>(s, 'Runtime.evaluate', { expression, objectGroup: 'console', silent: true })
      if (r.exceptionDetails) return { ok: false as const, error: r.exceptionDetails.exception ? describe(r.exceptionDetails.exception) : r.exceptionDetails.text }
      return { ok: true as const, value: toVar(expression, r.result) }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

export function stopDebugging(): void {
  if (dapSession && dapSession.active) dapSession.kill()
  try {
    if (session?.child) killTree(session.child, session.remote)
    else session?.ws?.close()
  } catch {
    // already gone
  }
}
