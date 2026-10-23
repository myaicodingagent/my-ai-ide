import { ChildProcess, spawn } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { createServer, connect as tcpConnect } from 'net'
import { Readable, Writable } from 'stream'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import type { DbgBreakpoint, DbgEvent, DbgFrame, DbgScope, DbgVar } from './debugger'
import { findPython, hasDebugpy } from './pythonenv'

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
  start(opts: DebugOptions, emit: (e: DbgEvent) => void): Promise<{ child: ChildProcess; io: { input: Readable; output: Writable }; launch: Json; stderr: () => string }>
}

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

const pythonAdapter: Adapter = {
  id: 'python',
  label: 'Python',
  files: /\.pyw?$/i,
  async start(opts) {
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
const goAdapter: Adapter = {
  id: 'go',
  label: 'Go',
  files: /\.go$/i,
  async start(opts, emit) {
    const dlv = findDelve()
    if (!dlv) throw new Error(DELVE_HELP)
    const port = await freePort()
    const cwd = opts.cwd || dirname(opts.file)
    const child = spawn(dlv, ['dap', `--listen=127.0.0.1:${port}`], { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
        if (child.exitCode !== null) return reject(new Error(`Delve stopped right away.${stderr ? '\n' + stderr : ''}`))
        if (Date.now() - t0 > 15_000) return reject(new Error('Delve did not start in time.'))
        setTimeout(tick, 50)
      }
      child.once('error', (e) => reject(new Error(`Could not start Delve: ${e.message}`)))
      tick()
    }).catch((e) => {
      child.kill()
      throw e
    })
    const socket = tcpConnect(port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', (e) => reject(new Error(`Could not connect to Delve: ${e.message}`)))
    }).catch((e) => {
      child.kill()
      throw e
    })
    ready = true
    child.once('close', () => socket.destroy())
    return {
      child,
      io: { input: socket, output: socket },
      stderr: () => stderr,
      launch: {
        name: 'Go',
        type: 'go',
        request: 'launch',
        mode: 'debug',
        // The package that holds the file, built as `go run .` would.
        program: dirname(opts.file),
        args: opts.args ?? [],
        cwd,
        env: opts.env ?? {},
        stopOnEntry: opts.stopOnEntry === true
      }
    }
  }
}

export const adapterFor = (file: string): Adapter | null => [pythonAdapter, goAdapter].find((a) => a.files.test(file)) ?? null

export function startPythonDebug(opts: DebugOptions, emit: (e: DbgEvent) => void): Promise<DapSession> {
  return startDapDebug(pythonAdapter, opts, emit)
}

/** Starts a program under a debug adapter. Resolves when it is running (breakpoints set), rejects with a readable message. */
export async function startDapDebug(adapter: Adapter, opts: DebugOptions, emit: (e: DbgEvent) => void): Promise<DapSession> {
  if (!existsSync(opts.file)) throw new Error(`The file does not exist: ${opts.file}`)
  const started = await adapter.start(opts, emit)
  const { child } = started
  const dap = new Dap(started.io, child)
  const stderrOf = (): string => started.stderr()
  // The adapter reports long, real paths; the editor knows the files by the spelling it was given (short Windows names...).
  const spelling = new Map<string, string>()
  const key = (p: string): string => {
    try {
      return realpathSync.native(p).replace(/\\/g, '/').toLowerCase()
    } catch {
      return p.replace(/\\/g, '/').toLowerCase()
    }
  }
  for (const f of [opts.file, ...Object.keys(opts.breakpoints)]) spelling.set(key(f), f)
  const spellAs = (p: string): string => spelling.get(key(p)) ?? p
  let frames: { id: number }[] = []
  let thread = 1
  let ended = false
  let exitCode: number | null = null

  const finish = (): void => {
    if (ended) return
    ended = true
    emit({ type: 'exited', code: exitCode })
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // gone
      }
    }, 300)
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
        name: String(f.name),
        file: f.source?.path && existsSync(String(f.source.path)) ? spellAs(String(f.source.path)) : null,
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
  const launched = dap.request('launch', started.launch)
  launched.catch(() => undefined)
  await Promise.race([initialized, new Promise((_r, rej) => setTimeout(() => rej(new Error(`The ${adapter.label} debugger did not start in time.` + (stderrOf() ? '\n' + stderrOf() : ''))), 30_000))])
  for (const [file, bps] of Object.entries(opts.breakpoints)) {
    if (!adapter.files.test(file)) continue
    await dap.request('setBreakpoints', { source: { path: file }, breakpoints: bps.map((b) => ({ line: b.line, ...(b.condition?.trim() ? { condition: b.condition } : {}) })) }).catch(() => undefined)
  }
  await dap.request('setExceptionBreakpoints', { filters: ['uncaught'] }).catch(() => undefined)
  await dap.request('configurationDone').catch(() => undefined)
  await launched.catch((e) => {
    throw new Error(`The program could not be started: ${e.message}${stderrOf() ? '\n' + stderrOf() : ''}`)
  })
  emit({ type: 'started', pid: child.pid ?? 0 })

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
      if (!adapter.files.test(file)) return
      await dap.request('setBreakpoints', { source: { path: file }, breakpoints: bps.map((b) => ({ line: b.line, ...(b.condition?.trim() ? { condition: b.condition } : {}) })) })
    },
    async scopes(frameIndex) {
      const f = frames[frameIndex]
      if (!f) return []
      const sc = await dap.request<{ scopes: Json[] }>('scopes', { frameId: f.id })
      const out: DbgScope[] = []
      for (const s of sc.scopes) {
        if (/^globals$/i.test(String(s.name))) continue
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
        const r = await dap.request<Json>('evaluate', { expression, context: 'repl', ...(f ? { frameId: f.id } : {}) })
        return { ok: true, value: { name: expression, value: String(r.result ?? ''), type: String(r.type ?? ''), objectId: r.variablesReference > 0 ? 'dap:' + r.variablesReference : undefined } }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    stop() {
      void dap.request('disconnect', { terminateDebuggee: true }).catch(() => undefined)
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          // gone
        }
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      }, 500)
    }
  }
}
