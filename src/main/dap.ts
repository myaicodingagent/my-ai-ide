import { ChildProcess, spawn } from 'child_process'
import { existsSync, readdirSync, realpathSync } from 'fs'
import { createServer, connect as tcpConnect, Socket } from 'net'
import { Readable, Writable } from 'stream'
import { homedir } from 'os'
import { basename, delimiter, dirname, join } from 'path'
import type { DbgBreakpoint, DbgEvent, DbgFrame, DbgScope, DbgVar } from './debugger'
import { findPython, hasDebugpy } from './pythonenv'
import * as ssh from './sshfs'
import { NETCOREDBG_HELP, findNetcoredbg } from './netcoredbg'
import { CPP_HELP, compileCpp, findCppDebugger, isCppSource } from './cpptools'
import { JAVA_HELP, compileJava, ensureJavaAdapter, findJdk } from './javatools'

// A client for the Debug Adapter Protocol (the protocol VS Code uses to talk to debuggers), and the Python debugger
// built on it: `python -m debugpy.adapter` is started and driven over stdin/stdout.

type Json = Record<string, any>

class Dap {
  private seq = 1
  private buf = Buffer.alloc(0)
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, ((body: any) => void)[]>()
  closed = false

  // The adapter is reached over a pair of streams: its stdin/stdout, or a TCP socket.
  constructor(private readonly io: { input: Readable; output: Writable }, closeOn: { once(event: 'close', cb: () => void): unknown }) {
    io.input.on('data', (b: Buffer) => this.feed(b))
    closeOn.once('close', () => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new Error('The debugger stopped.'))
      this.pending.clear()
      this.emit('__closed', null)
    })
  }

  private feed(b: Buffer): void {
    this.buf = Buffer.concat([this.buf, b])
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = this.buf.slice(0, end).toString('ascii')
      const len = Number(/Content-Length:\s*(\d+)/i.exec(head)?.[1] ?? NaN)
      if (!Number.isFinite(len)) {
        this.buf = Buffer.alloc(0)
        return
      }
      if (this.buf.length < end + 4 + len) return
      const body = this.buf.slice(end + 4, end + 4 + len).toString('utf-8')
      this.buf = this.buf.slice(end + 4 + len)
      let msg: Json
      try {
        msg = JSON.parse(body)
      } catch {
        continue
      }
      if (msg.type === 'response') {
        const p = this.pending.get(msg.request_seq)
        this.pending.delete(msg.request_seq)
        if (p) msg.success ? p.resolve(msg.body ?? {}) : p.reject(new Error(msg.message || 'The request failed.'))
      } else if (msg.type === 'event') {
        this.emit(msg.event, msg.body ?? {})
      } else if (msg.type === 'request') {
        // Requests from the adapter (runInTerminal...): not supported; answer so it does not wait.
        this.write({ seq: this.seq++, type: 'response', request_seq: msg.seq, success: false, command: msg.command, message: 'Not supported' })
      }
    }
  }

  private write(obj: Json): void {
    const body = Buffer.from(JSON.stringify(obj), 'utf-8')
    this.io.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
  }

  request<T = any>(command: string, args: Json = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('The debugger stopped.'))
      const seq = this.seq++
      this.pending.set(seq, { resolve, reject })
      this.write({ seq, type: 'request', command, arguments: args })
    })
  }

  on(event: string, cb: (body: any) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb])
  }

  once(event: string): Promise<any> {
    return new Promise((resolve) => {
      const cb = (b: any): void => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((x) => x !== cb))
        resolve(b)
      }
      this.on(event, cb)
    })
  }

  private emit(event: string, body: any): void {
    for (const cb of this.listeners.get(event) ?? []) cb(body)
  }
}

export interface DapSession {
  step(kind: 'continue' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause'): Promise<void>
  setBreakpoints(file: string, bps: DbgBreakpoint[]): Promise<void>
  scopes(frameIndex: number): Promise<DbgScope[]>
  props(ref: string): Promise<DbgVar[]>
  evaluate(expression: string, frameIndex: number | null): Promise<{ ok: true; value: DbgVar } | { ok: false; error: string }>
  stop(): void
  /** Ends the program at once, without asking the debugger (the editor is closing). */
  kill(): void
  readonly active: boolean
}

const toVar = (v: Json): DbgVar => ({
  name: String(v.name),
  value: String(v.value ?? ''),
  type: String(v.type ?? ''),
  objectId: v.variablesReference > 0 ? 'dap:' + v.variablesReference : undefined
})

export const DEBUGPY_HELP = 'Python debugging needs the "debugpy" package. Install it by running:  py -3 -m pip install debugpy  (or: python -m pip install debugpy)'

export interface DebugOptions {
  file: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  stopOnEntry?: boolean
  breakpoints: Record<string, DbgBreakpoint[]>
}

// A debug adapter for one language: how to start it, and what to send in the launch request.
interface Adapter {
  id: string
  label: string
  files: RegExp // the files whose breakpoints belong to this adapter
  exceptionFilters?: string[] // what to ask the adapter to stop on (default: uncaught exceptions)
  frameName?(name: string): string // a readable name for a call stack entry
  evalContext?: string // the `context` of evaluate requests (default repl); lldb answers repl with `(int) $1 = 5`, watch with `5`
  adapterPath?(file: string): string // how the adapter must be told a file's path (the spelling its symbols use)
  start(opts: DebugOptions, emit: (e: DbgEvent) => void): Promise<Started>
  attach?(target: AttachTarget, emit: (e: DbgEvent) => void): Promise<Started>
}

export interface AttachTarget {
  host?: string
  port?: number
  pid?: number
  roots?: string[] // the open folders (where the source files are looked for)
}

interface Started {
  child: ChildProcess | null // the adapter process we own; null when we only connected to one that is already running
  io: { input: Readable; output: Writable }
  launch: Json // the arguments of the launch or attach request (its `request` field says which)
  stderr: () => string
  closeOn?: { once(event: 'close', cb: () => void): unknown } // what ends the connection when there is no child
  pid?: number
  remote?: string // the computer the program runs on (over SSH): file paths are translated both ways
  dispose?: () => void // closes what was opened for the connection (an SSH tunnel)
}

/**
 * Ends a process and everything it started (the adapter's program). On Windows the tree is ended by taskkill, and it must
 * happen BEFORE the adapter itself is killed: once the parent is gone its children cannot be found any more and live on.
 */
export function killTree(child: ChildProcess, remote?: string): void {
  if (process.platform === 'win32' && child.pid && !remote) {
    const t = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    t.on('error', () => child.kill())
    t.on('close', () => {
      try {
        child.kill()
      } catch {
        // gone
      }
    })
    return
  }
  try {
    child.kill()
  } catch {
    // gone
  }
}

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

export const pythonAdapter: Adapter = {
  id: 'python',
  label: 'Python',
  files: /\.pyw?$/i,
  async start(opts) {
    if (ssh.isRemotePath(opts.file)) return startRemotePython(opts)
    const py = await findPython()
    if (!py) throw new Error('Python 3 was not found. Install it from python.org (tick "Add to PATH").')
    if (!(await hasDebugpy(py))) throw new Error(DEBUGPY_HELP)
    const env = { ...cleanEnv(), PYTHONIOENCODING: 'utf-8' }
    const child = spawn(py.file, [...py.args, '-m', 'debugpy.adapter'], { cwd: opts.cwd || dirname(opts.file), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf-8')).slice(-2000)))
    return {
      child,
      io: { input: child.stdout!, output: child.stdin! },
      stderr: () => stderr,
      launch: {
        name: 'Python',
        type: 'python',
        request: 'launch',
        program: opts.file,
        args: opts.args ?? [],
        cwd: opts.cwd || dirname(opts.file),
        env: opts.env ?? {},
        python: py.executable,
        console: 'internalConsole',
        redirectOutput: true,
        justMyCode: true,
        stopOnEntry: opts.stopOnEntry === true
      }
    }
  }
}

const randomPort = (): number => 30000 + Math.floor(Math.random() * 20000)

/** Opens a tunnel to a port on the remote computer and connects once something is listening there. */
async function connectRemote(unc: string, port: number, proc: ssh.RemoteProcess, what: string): Promise<{ socket: Socket; tunnel: { close(): void } }> {
  const tunnel = await ssh.forwardPort(unc, port)
  try {
    for (let i = 0; i < 80; i++) {
      if (proc.exitCode !== null) break
      // The tunnel accepts at once; whether something listens on the other end shows when the connection is closed again.
      const socket = tcpConnect(tunnel.port, '127.0.0.1')
      const state = await new Promise<'up' | 'down'>((resolve) => {
        const t = setTimeout(() => resolve('up'), 400)
        socket.once('close', () => (clearTimeout(t), resolve('down')))
        socket.once('error', () => undefined)
      })
      if (state === 'up') return { socket, tunnel }
      await new Promise((r) => setTimeout(r, 250))
    }
  } catch {
    // fall through to the error
  }
  tunnel.close()
  throw new Error(`The ${what} debugger on the other computer did not start.`)
}

// The remote shell: Python 3 under debugpy, listening on a port that is reached through the SSH connection.
const REMOTE_PYTHON = 'port=$1; shift; for p in python3 python; do if $p -c "import sys" >/dev/null 2>&1; then exec $p -m debugpy --listen 127.0.0.1:$port --wait-for-client "$@"; fi; done; echo "Python was not found on this computer." >&2; exit 127'

async function startRemotePython(opts: DebugOptions): Promise<Started> {
  const name = ssh.parseRemote(opts.file)?.name as string
  const cwdUnc = opts.cwd || dirname(opts.file)
  const port = randomPort()
  const proc = ssh.spawnRemote(cwdUnc, ['sh', '-c', REMOTE_PYTHON, 'sh', String(port), ssh.nativePath(opts.file) as string, ...(opts.args ?? [])], { env: { PYTHONIOENCODING: 'utf-8', ...(opts.env ?? {}) } })
  let stderr = ''
  proc.stderr.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf-8')).slice(-2000)))
  proc.stdout.resume()
  proc.once('error', (e: Error) => (stderr += e.message))
  let conn: Awaited<ReturnType<typeof connectRemote>>
  try {
    conn = await connectRemote(cwdUnc, port, proc, 'Python')
  } catch (e) {
    proc.kill()
    throw new Error(/No module named debugpy/i.test(stderr) ? DEBUGPY_HELP.replace('Install it by running:', 'Install it on that computer by running:') : (e as Error).message + (stderr ? '\n' + stderr.trim() : ''))
  }
  return {
    child: proc as unknown as ChildProcess,
    io: { input: conn.socket, output: conn.socket },
    stderr: () => stderr,
    remote: name,
    dispose: conn.tunnel.close,
    // debugpy started the program itself (the command line above); the editor attaches to it.
    launch: { name: 'Python (remote)', type: 'python', request: 'attach', justMyCode: true, redirectOutput: true }
  }
}

pythonAdapter.attach = async (target) => {
  if (!target.port) throw new Error('Give the port the program listens on (started with: python -m debugpy --listen 5678 script.py).')
  const host = target.host || '127.0.0.1'
  // debugpy in the program speaks the Debug Adapter Protocol itself, so there is no adapter process: connect to it.
  const socket = await connectTo(host, target.port, 'Python')
  return {
    child: null,
    io: { input: socket, output: socket },
    closeOn: socket,
    stderr: () => '',
    launch: { name: 'Python attach', type: 'python', request: 'attach', justMyCode: true, redirectOutput: true }
  }
}

function connectTo(host: string, port: number, what: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(port, host)
    socket.once('connect', () => resolve(socket))
    socket.once('error', (e) => reject(new Error(`Nothing is listening for a ${what} debugger at ${host}:${port} (${e.message}).`)))
  })
}

export const DELVE_HELP = 'Go debugging needs Delve. Install it by running:  go install github.com/go-delve/delve/cmd/dlv@latest'

function findDelve(): string | null {
  const exe = process.platform === 'win32' ? 'dlv.exe' : 'dlv'
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter)
  dirs.push(join(process.env.GOPATH || join(homedir(), 'go'), 'bin'))
  for (const d of dirs) if (d && existsSync(join(d, exe))) return join(d, exe)
  return null
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

// Delve speaks the Debug Adapter Protocol over TCP: `dlv dap --listen=...`, then connect to that port.
async function spawnDelve(cwd: string, emit: (e: DbgEvent) => void): Promise<{ child: ChildProcess; socket: Socket; stderr: () => string; dispose?: () => void }> {
  const remote = ssh.isRemotePath(cwd)
  let dlv = ''
  if (!remote) {
    const found = findDelve()
    if (!found) throw new Error(DELVE_HELP)
    dlv = found
  }
  const port = remote ? randomPort() : await freePort()
  const child = remote
    ? (ssh.spawnRemote(cwd, ['sh', '-c', 'PATH="$PATH:$HOME/go/bin:/usr/local/go/bin:/usr/local/bin"; exec dlv dap --listen=127.0.0.1:' + port]) as unknown as ChildProcess)
    : spawn(dlv, ['dap', `--listen=127.0.0.1:${port}`], { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  let said = ''
  let ready = false
  child.stderr?.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString('utf-8')).slice(-2000)
    if (ready) emit({ type: 'output', stream: 'stderr', text: b.toString('utf-8') }) // the program's own error output
  })
  // Before the handshake this is Delve talking; afterwards it is the program, which shares Delve's output.
  child.stdout?.on('data', (b: Buffer) => {
    if (!ready) said += b.toString('utf-8')
    else emit({ type: 'output', stream: 'stdout', text: b.toString('utf-8') })
  })
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now()
    const tick = (): void => {
      if (/listening/i.test(said)) return resolve()
      if (child.exitCode !== null) return reject(new Error(`${/not found/i.test(stderr) ? DELVE_HELP.replace('Install it by', 'Install it on that computer by') : 'Delve stopped right away.'}${stderr ? '\n' + stderr : ''}`))
      if (Date.now() - t0 > 15_000) return reject(new Error('Delve did not start in time.'))
      setTimeout(tick, 50)
    }
    child.once('error', (e) => reject(new Error(`Could not start Delve: ${e.message}`)))
    tick()
  }).catch((e) => {
    child.kill()
    throw e
  })
  let tunnel: { port: number; close(): void } | undefined
  if (remote) {
    tunnel = await ssh.forwardPort(cwd, port).catch((e) => {
      child.kill()
      throw new Error(`Could not reach Delve on the other computer: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
  const socket = tcpConnect(tunnel ? tunnel.port : port, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', (e) => reject(new Error(`Could not connect to Delve: ${e.message}`)))
  }).catch((e) => {
    child.kill()
    tunnel?.close()
    throw e
  })
  ready = true
  child.once('close', () => socket.destroy())
  return { child, socket, stderr: () => stderr, dispose: tunnel?.close }
}

export const goAdapter: Adapter = {
  id: 'go',
  label: 'Go',
  files: /\.go$/i,
  async start(opts, emit) {
    const cwd = opts.cwd || dirname(opts.file)
    const remote = ssh.isRemotePath(opts.file)
    const { child, socket, stderr, dispose } = await spawnDelve(cwd, emit)
    const native = (p: string): string => (remote ? (ssh.nativePath(p) as string) : p)
    return {
      child,
      io: { input: socket, output: socket },
      stderr,
      dispose,
      remote: remote ? ssh.parseRemote(opts.file)?.name : undefined,
      launch: {
        name: 'Go',
        type: 'go',
        request: 'launch',
        mode: 'debug',
        // The package that holds the file, built as `go run .` would.
        program: native(dirname(opts.file)),
        args: opts.args ?? [],
        cwd: native(cwd),
        env: opts.env ?? {},
        stopOnEntry: opts.stopOnEntry === true
      }
    }
  },
  // A running Go program, by process id; or one started under `dlv --headless`, by port (that server speaks DAP too).
  async attach(target, emit) {
    if (target.pid) {
      try {
        process.kill(target.pid, 0)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') throw new Error(`There is no process with id ${target.pid}.`)
      }
      const { child, socket, stderr } = await spawnDelve(process.cwd(), emit)
      return { child, io: { input: socket, output: socket }, stderr, pid: target.pid, launch: { name: 'Go attach', type: 'go', request: 'attach', mode: 'local', processId: target.pid } }
    }
    if (!target.port) throw new Error('Give a process id ("pid 1234") or the port of a Delve server (dlv attach --headless --listen=:2345).')
    const socket = await connectTo(target.host || '127.0.0.1', target.port, 'Go')
    return { child: null, io: { input: socket, output: socket }, closeOn: socket, stderr: () => '', launch: { name: 'Go attach', type: 'go', request: 'attach', mode: 'remote' } }
  }
}


// C#: netcoredbg (a debug adapter for .NET) debugs the program that `dotnet build` makes from the nearest project.
function findProject(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    try {
      const found = readdirSync(d).filter((f) => /\.csproj$/i.test(f)).sort()
      if (found.length) return join(d, found[0])
    } catch {
      // unreadable: keep looking upwards
    }
    if (dirname(d) === d) return null
  }
}

function runDotnet(args: string[], cwd: string, onData?: (t: string) => void): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn('dotnet', args, { cwd, env: { ...cleanEnv(), DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', MSBUILDDISABLENODEREUSE: '1' }, windowsHide: true })
    let out = ''
    const take = (b: Buffer): void => {
      const t = b.toString('utf-8')
      out = (out + t).slice(-20000)
      onData?.(t)
    }
    c.stdout.on('data', take)
    c.stderr.on('data', take)
    c.on('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'ENOENT' ? 'The .NET SDK was not found. Install it from dot.net (the "dotnet" command must work in a terminal).' : e.message)))
    c.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

export const csharpAdapter: Adapter = {
  id: 'coreclr',
  label: 'C#',
  // The compiler's names for top-level statements and local functions: Program.<<Main>$>g__Add|0_0() is the local function Add.
  frameName: (n) => n.replace(/^(?:[A-Za-z0-9_.]+)?<<([^>]+)>[$]>g__([A-Za-z0-9_]+)\|\d+_\d+\(.*\)$/, '$2').replace(/^([A-Za-z0-9_]+)\.<Main>[$]\(.*\)$/, '$1.Main (top-level statements)'),
  files: /\.cs$/i,
  exceptionFilters: ['user-unhandled'],
  adapterPath: (file) => {
    try {
      return realpathSync.native(file)
    } catch {
      return file
    }
  },
  async start(opts, emit) {
    if (ssh.isRemotePath(opts.file)) throw new Error('C# programs on another computer cannot be debugged yet.')
    const dbg = findNetcoredbg()
    if (!dbg) throw new Error(NETCOREDBG_HELP)
    const proj = findProject(dirname(opts.file))
    if (!proj) throw new Error('No .csproj file was found next to this file or above it. Create a project with: dotnet new console')
    emit({ type: 'output', stream: 'info', text: `Building ${basename(proj)}...\n` })
    const build = await runDotnet(['build', proj, '-c', 'Debug', '--nologo', '-v', 'q', '-clp:NoSummary'], dirname(proj))
    if (build.code !== 0) {
      const errors = build.out.split(/\r?\n/).filter((l) => /\berror\b/i.test(l))
      throw new Error('The project did not build:\n' + (errors.length ? [...new Set(errors)].slice(0, 8).join('\n') : build.out.trim().slice(-800)))
    }
    const target = await runDotnet(['msbuild', proj, '-getProperty:TargetPath', '-p:Configuration=Debug'], dirname(proj))
    const dll = target.out.trim().split(/\r?\n/).pop()?.trim() ?? ''
    if (target.code !== 0 || !dll || !existsSync(dll)) throw new Error('The project built, but its program file could not be found.')
    const cwd = opts.cwd || dirname(proj)
    const child = spawn(dbg, ['--interpreter=vscode'], { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf-8')).slice(-2000)))
    return {
      child,
      io: { input: child.stdout!, output: child.stdin! },
      stderr: () => stderr,
      launch: { name: 'C#', type: 'coreclr', request: 'launch', program: dll, args: opts.args ?? [], cwd, env: opts.env ?? {}, stopAtEntry: opts.stopOnEntry === true }
    }
  }
}

// C and C++: lldb-dap runs the program that the compiler makes from the open source file.
export const cppAdapter: Adapter = {
  id: 'cppdbg',
  evalContext: 'watch',
  label: 'C/C++',
  files: /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx)$/i,
  exceptionFilters: [],
  adapterPath: (file) => {
    try {
      return realpathSync.native(file)
    } catch {
      return file
    }
  },
  async start(opts, emit) {
    if (ssh.isRemotePath(opts.file)) throw new Error('C and C++ programs on another computer cannot be debugged yet.')
    if (!isCppSource(opts.file)) throw new Error('Open a .c or .cpp file to debug it (a header cannot be run).')
    const dbg = findCppDebugger()
    if (!dbg) throw new Error(CPP_HELP)
    emit({ type: 'output', stream: 'info', text: `Compiling ${basename(opts.file)}...
` })
    const program = await compileCpp(opts.file, dirname(dbg))
    const cwd = opts.cwd || dirname(opts.file)
    const child = spawn(dbg, [], { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf-8')).slice(-2000)))
    const env = opts.env ?? {}
    return {
      child,
      io: { input: child.stdout!, output: child.stdin! },
      stderr: () => stderr,
      launch: { name: 'C/C++', request: 'launch', program, args: opts.args ?? [], cwd, env: Object.entries(env).map(([k, v]) => `${k}=${v}`), stopOnEntry: opts.stopOnEntry === true }
    }
  }
}

// Java: the editor's own adapter (JavaDap.java) compiled with the user's JDK; it starts the program with a debug agent.
export const javaAdapter: Adapter = {
  id: 'java',
  label: 'Java',
  files: /\.java$/i,
  async start(opts, emit) {
    if (ssh.isRemotePath(opts.file)) throw new Error('Java programs on another computer cannot be debugged yet.')
    const jdk = findJdk()
    if (!jdk) throw new Error(JAVA_HELP)
    emit({ type: 'output', stream: 'info', text: `Compiling ${basename(opts.file)}...\n` })
    const prog = await compileJava(opts.file, jdk.javac)
    const adapterDir = await ensureJavaAdapter(jdk.javac)
    const cwd = opts.cwd || dirname(opts.file)
    const child = spawn(jdk.java, ['-cp', adapterDir, 'JavaDap'], { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf-8')).slice(-2000)))
    return {
      child,
      io: { input: child.stdout!, output: child.stdin! },
      stderr: () => stderr,
      launch: { name: 'Java', request: 'launch', javaExe: jdk.java, mainClass: prog.mainClass, classpath: [prog.classes], sourceRoots: [prog.sourceRoot], args: opts.args ?? [], cwd, env: opts.env ?? {}, stopOnEntry: opts.stopOnEntry === true }
    }
  }
}

javaAdapter.attach = async (target) => {
  if (!target.port) throw new Error('Give the port the program listens on for a debugger (start it with: java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005 ...).')
  const jdk = findJdk()
  if (!jdk) throw new Error(JAVA_HELP)
  const adapterDir = await ensureJavaAdapter(jdk.javac)
  const child = spawn(jdk.java, ['-cp', adapterDir, 'JavaDap'], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf-8')).slice(-2000)))
  return {
    child,
    io: { input: child.stdout!, output: child.stdin! },
    stderr: () => stderr,
    launch: { name: 'Java attach', request: 'attach', host: target.host || '127.0.0.1', port: target.port, sourceRoots: target.roots ?? [] }
  }
}

// C and C++: lldb-dap attaches to a process by its id. netcoredbg (below) does the same for .NET programs.
cppAdapter.attach = async (target) => {
  if (!target.pid) throw new Error('Give the id of the process: "pid 1234".')
  const dbg = findCppDebugger()
  if (!dbg) throw new Error(CPP_HELP)
  const child = spawn(dbg, [], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf-8')).slice(-2000)))
  return { child, io: { input: child.stdout!, output: child.stdin! }, stderr: () => stderr, launch: { name: 'C/C++ attach', request: 'attach', pid: target.pid } }
}

csharpAdapter.attach = async (target) => {
  if (!target.pid) throw new Error('Give the id of the .NET process: "pid 1234".')
  const dbg = findNetcoredbg()
  if (!dbg) throw new Error(NETCOREDBG_HELP)
  const child = spawn(dbg, ['--interpreter=vscode'], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf-8')).slice(-2000)))
  return { child, io: { input: child.stdout!, output: child.stdin! }, stderr: () => stderr, launch: { name: 'C# attach', type: 'coreclr', request: 'attach', processId: target.pid } }
}

export const adapterFor = (file: string): Adapter | null => [pythonAdapter, goAdapter, csharpAdapter, cppAdapter, javaAdapter].find((a) => a.files.test(file)) ?? null

export function startPythonDebug(opts: DebugOptions, emit: (e: DbgEvent) => void): Promise<DapSession> {
  return startDapDebug(pythonAdapter, opts, emit)
}

/** Starts a program under a debug adapter. Resolves when it is running (breakpoints set), rejects with a readable message. */
export async function startDapDebug(adapter: Adapter, opts: DebugOptions, emit: (e: DbgEvent) => void): Promise<DapSession> {
  if (ssh.isRemotePath(opts.file)) await ssh.requireFile(opts.file)
  else if (!existsSync(opts.file)) throw new Error(`The file does not exist: ${opts.file}`)
  return runDap(adapter, await adapter.start(opts, emit), opts.breakpoints, [opts.file], false, emit)
}

/** Connects to a program that is already running (Python: started with debugpy --listen; Go: a process id or a Delve server). */
export async function startDapAttach(adapter: Adapter, target: AttachTarget, breakpoints: Record<string, DbgBreakpoint[]>, emit: (e: DbgEvent) => void): Promise<DapSession> {
  if (!adapter.attach) throw new Error(`Attaching is not supported for ${adapter.label}.`)
  return runDap(adapter, await adapter.attach(target, emit), breakpoints, [], true, emit)
}

async function runDap(adapter: Adapter, started: Started, breakpointsByFile: Record<string, DbgBreakpoint[]>, files: string[], attached: boolean, emit: (e: DbgEvent) => void): Promise<DapSession> {
  const { child } = started
  const dap = new Dap(started.io, (child ?? started.closeOn)!)
  const stderrOf = (): string => started.stderr()
  // The adapter reports long, real paths; the editor knows the files by the spelling it was given (short Windows names...).
  const spelling = new Map<string, string>()
  const key = (p: string): string => {
    if (started.remote) return p.replace(/\\/g, '/').toLowerCase()
    try {
      return realpathSync.native(p).replace(/\\/g, '/').toLowerCase()
    } catch {
      return p.replace(/\\/g, '/').toLowerCase()
    }
  }
  for (const f of [...files, ...Object.keys(breakpointsByFile)]) spelling.set(key(f), f)
  const spellAs = (p: string): string => spelling.get(key(p)) ?? p
  // Over SSH the adapter works with the other computer's paths: only files there can have breakpoints, and what it
  // reports is turned back into the editor's address.
  const remote = started.remote
  const toAdapter = (file: string): string | null => {
    if (!remote) return ssh.isRemotePath(file) ? null : (adapter.adapterPath?.(file) ?? file)
    return ssh.parseRemote(file)?.name === remote ? ssh.nativePath(file) : null
  }
  const breakpointArgs = (bps: DbgBreakpoint[]): Json[] => bps.map((b) => ({ line: b.line, ...(b.condition?.trim() ? { condition: b.condition } : {}) }))
  let frames: { id: number }[] = []
  let thread = 1
  let ended = false
  let exitCode: number | null = null

  let announced = false
  const announce = (): void => {
    if (announced) return
    announced = true
    emit({ type: 'exited', code: exitCode })
    setTimeout(() => {
      if (child) killTree(child, remote)
      if (!child) started.io.output.end()
      started.dispose?.()
    }, 300)
  }
  const finish = (): void => {
    if (ended) return
    ended = true
    // Over SSH debugpy does not report the exit code; the remote command's own status is the answer.
    if (exitCode === null && remote && child && child.exitCode === null) {
      child.once('close', (code: number | null) => {
        exitCode = code
        announce()
      })
      setTimeout(announce, 1500)
    } else announce()
  }

  dap.on('output', (b) => {
    const cat = String(b.category ?? 'console')
    if (cat === 'telemetry') return
    emit({ type: 'output', stream: cat === 'stderr' ? 'stderr' : cat === 'stdout' ? 'stdout' : 'info', text: String(b.output ?? '') })
  })
  dap.on('continued', () => {
    frames = []
    emit({ type: 'resumed' })
  })
  dap.on('exited', (b) => {
    exitCode = typeof b.exitCode === 'number' ? b.exitCode : null
  })
  dap.on('terminated', () => {
    void dap.request('disconnect', { terminateDebuggee: false }).catch(() => undefined)
    finish()
  })
  dap.on('__closed', finish)
  dap.on('stopped', async (b) => {
    try {
      thread = typeof b.threadId === 'number' ? b.threadId : thread
      const st = await dap.request<{ stackFrames: Json[] }>('stackTrace', { threadId: thread, startFrame: 0, levels: 40 })
      frames = st.stackFrames.map((f) => ({ id: f.id as number }))
      const list: DbgFrame[] = st.stackFrames.map((f, i) => ({
        index: i,
        name: adapter.frameName ? adapter.frameName(String(f.name)) : String(f.name),
        file: f.source?.path ? (remote ? ssh.fromNativePath(remote, String(f.source.path)) : existsSync(String(f.source.path)) ? spellAs(String(f.source.path)) : null) : null,
        url: String(f.source?.path ?? ''),
        line: Number(f.line) || 1,
        column: Number(f.column) || 1
      }))
      let exception: string | undefined
      const reason = b.reason === 'breakpoint' ? 'breakpoint' : b.reason === 'exception' ? 'exception' : b.reason === 'entry' ? 'Break on start' : b.reason === 'pause' ? 'pause' : 'step'
      if (reason === 'exception') {
        const info = await dap.request<Json>('exceptionInfo', { threadId: thread }).catch(() => null)
        exception = info ? `${info.exceptionId ?? ''}${info.description ? ': ' + String(info.description).split('\n')[0] : ''}`.trim() || undefined : String(b.text ?? '')
      }
      emit({ type: 'paused', reason, frames: list, exception })
    } catch (e) {
      emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  })

  const initialized = dap.once('initialized')
  const caps = await dap.request('initialize', {
    clientID: 'my-ai-ide',
    clientName: 'My AI IDE',
    adapterID: adapter.id,
    pathFormat: 'path',
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsRunInTerminalRequest: false
  }).catch((e) => {
    throw new Error(`Could not start the ${adapter.label} debugger: ${e.message}${stderrOf() ? '\n' + stderrOf() : ''}`)
  })
  void caps
  // launch's answer comes after configurationDone, so it is not awaited here.
  const launched = dap.request(started.launch.request === 'attach' ? 'attach' : 'launch', started.launch)
  launched.catch(() => undefined)
  await Promise.race([initialized, launched.then(() => initialized), new Promise((_r, rej) => setTimeout(() => rej(new Error(`The ${adapter.label} debugger did not start in time.` + (stderrOf() ? '\n' + stderrOf() : ''))), 30_000))])
  for (const [file, bps] of Object.entries(breakpointsByFile)) {
    const path = toAdapter(file)
    if (!adapter.files.test(file) || !path) continue
    await dap.request('setBreakpoints', { source: { path }, breakpoints: breakpointArgs(bps) }).catch(() => undefined)
  }
  await dap.request('setExceptionBreakpoints', { filters: adapter.exceptionFilters ?? ['uncaught'] }).catch(() => undefined)
  await dap.request('configurationDone').catch(() => undefined)
  await launched.catch((e) => {
    throw new Error(`The program could not be started: ${e.message}${stderrOf() ? '\n' + stderrOf() : ''}`)
  })
  emit({ type: 'started', pid: remote ? 0 : (started.pid ?? child?.pid ?? 0) })
  if (attached) emit({ type: 'output', stream: 'info', text: 'Attached (the program keeps running; Stop only disconnects).\n' })

  return {
    get active() {
      return !ended && !dap.closed
    },
    async step(kind) {
      const cmd = { continue: 'continue', stepOver: 'next', stepInto: 'stepIn', stepOut: 'stepOut', pause: 'pause' }[kind]
      await dap.request(cmd, { threadId: thread })
      if (kind === 'continue') {
        frames = []
        emit({ type: 'resumed' })
      }
    },
    async setBreakpoints(file, bps) {
      const path = toAdapter(file)
      if (!adapter.files.test(file) || !path) return
      await dap.request('setBreakpoints', { source: { path }, breakpoints: breakpointArgs(bps) })
    },
    async scopes(frameIndex) {
      const f = frames[frameIndex]
      if (!f) return []
      const sc = await dap.request<{ scopes: Json[] }>('scopes', { frameId: f.id })
      const out: DbgScope[] = []
      for (const s of sc.scopes) {
        if (/^(globals|registers?)$/i.test(String(s.name))) continue
        const vars = await dap.request<{ variables: Json[] }>('variables', { variablesReference: s.variablesReference }).catch(() => ({ variables: [] }))
        out.push({ name: /^locals$/i.test(String(s.name)) ? 'Local' : String(s.name), vars: vars.variables.filter((v) => !/ variables$/.test(String(v.name))).slice(0, 300).map(toVar) })
      }
      return out
    },
    async props(ref) {
      const n = Number(ref.replace(/^dap:/, ''))
      if (!Number.isInteger(n)) return []
      const vars = await dap.request<{ variables: Json[] }>('variables', { variablesReference: n }).catch(() => ({ variables: [] }))
      return vars.variables.filter((v) => !/ variables$/.test(String(v.name))).slice(0, 300).map(toVar)
    },
    async evaluate(expression, frameIndex) {
      try {
        const f = frameIndex === null ? undefined : frames[frameIndex]
        const r = await dap.request<Json>('evaluate', { expression, context: adapter.evalContext ?? 'repl', ...(f ? { frameId: f.id } : {}) })
        return { ok: true, value: { name: expression, value: String(r.result ?? ''), type: String(r.type ?? ''), objectId: r.variablesReference > 0 ? 'dap:' + r.variablesReference : undefined } }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    kill() {
      if (child) {
        if (attached) child.kill() // the program that was attached to keeps running
        else killTree(child, remote)
      }
      started.dispose?.()
    },
    stop() {
      // An attached program is let go, not ended. Wait for the answer so the adapter has detached before it is killed.
      const done = dap.request('disconnect', { terminateDebuggee: !attached }).catch(() => undefined)
      void Promise.race([done, new Promise((r) => setTimeout(r, 2000))]).then(() => {
        if (child) killTree(child, remote)
        if (!child) started.io.output.end()
        started.dispose?.()
      })
    }
  }
}
