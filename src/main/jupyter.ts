import { spawn, ChildProcess } from 'child_process'
import { createHmac, randomBytes, randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, promises as fs } from 'fs'
import { createServer } from 'net'
import { homedir } from 'os'
import { basename, delimiter, dirname, join } from 'path'
import { ZSocket } from './zmq'
import type { NbEvent } from './notebook'

// Jupyter kernels: any kernel installed on this computer (ipykernel for Python, IRkernel, IJulia, ...) is started the
// way Jupyter starts it (kernel.json, a connection file) and spoken to with the Jupyter messaging protocol over ZeroMQ.

export interface KernelSpec {
  name: string // the folder name: python3, ir, julia-1.10
  display_name: string
  language: string
  argv: string[]
  env: Record<string, string>
  dir: string
}

const DELIM = '<IDS|MSG>'

// ipykernel cannot be interrupted by message on Windows (it waits for a Win32 event that only the process that
// started it can hand over). So on Windows it is started through this small wrapper, which turns a line on its
// standard input into the same thing the event would do: a KeyboardInterrupt in the running cell.
const INTERRUPT_WRAPPER = [
  'import sys, threading, signal, runpy',
  'def _watch(f=sys.__stdin__):',
  '    while True:',
  '        line = f.readline()',
  '        if not line:',
  '            return',
  "        if line.strip() == 'interrupt':",
  '            signal.raise_signal(signal.SIGINT)  # _thread.interrupt_main() does not wake time.sleep() on Windows',
  'threading.Thread(target=_watch, daemon=True).start()',
  "sys.argv = ['ipykernel_launcher'] + sys.argv[1:]",
  "runpy.run_module('ipykernel_launcher', run_name='__main__', alter_sys=True)"
].join('\n')

// ---- finding kernels ----

function specDirs(): string[] {
  const dirs: string[] = []
  const add = (d: string | undefined): void => {
    if (d && !dirs.includes(d)) dirs.push(d)
  }
  for (const p of (process.env.JUPYTER_PATH ?? '').split(delimiter)) if (p) add(join(p, 'kernels'))
  if (process.platform === 'win32') {
    add(join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jupyter', 'kernels'))
    add(join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'jupyter', 'kernels'))
  } else if (process.platform === 'darwin') {
    add(join(homedir(), 'Library', 'Jupyter', 'kernels'))
    add('/usr/local/share/jupyter/kernels')
    add('/usr/share/jupyter/kernels')
  } else {
    add(join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'jupyter', 'kernels'))
    add('/usr/local/share/jupyter/kernels')
    add('/usr/share/jupyter/kernels')
  }
  // Python installations: the kernels that pip and conda put in <prefix>/share/jupyter/kernels.
  for (const d of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!d) continue
    add(join(d, 'share', 'jupyter', 'kernels'))
    if (/^(scripts|bin)$/i.test(basename(d))) add(join(dirname(d), 'share', 'jupyter', 'kernels'))
  }
  if (process.env.CONDA_PREFIX) add(join(process.env.CONDA_PREFIX, 'share', 'jupyter', 'kernels'))
  return dirs
}

/** Every kernel.json found in the usual places (the first one found wins when a name appears twice). */
export function listKernelSpecs(extraDirs: string[] = []): KernelSpec[] {
  const out: KernelSpec[] = []
  for (const root of [...extraDirs, ...specDirs()]) {
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names.sort()) {
      if (out.some((k) => k.name === name)) continue
      try {
        const dir = join(root, name)
        const j = JSON.parse(readFileSync(join(dir, 'kernel.json'), 'utf-8')) as Partial<KernelSpec>
        if (!Array.isArray(j.argv) || !j.argv.length || !j.argv.every((a) => typeof a === 'string')) continue
        out.push({ name, display_name: String(j.display_name ?? name), language: String(j.language ?? '').toLowerCase(), argv: j.argv, env: (j.env as Record<string, string>) ?? {}, dir })
      } catch {
        // not a kernel
      }
    }
  }
  return out
}

/** `python` in a kernel.json means "the Python this kernel was installed for", which is the prefix three folders up from share/jupyter/kernels/<name>. */
function resolveArgv(spec: KernelSpec, connectionFile: string): string[] {
  const argv = spec.argv.map((a) => a.replace('{connection_file}', connectionFile).replace('{resource_dir}', spec.dir))
  if (/^python3?(\.exe)?$/i.test(argv[0])) {
    const prefix = dirname(dirname(dirname(dirname(spec.dir))))
    const exe = process.platform === 'win32' ? join(prefix, 'python.exe') : join(prefix, 'bin', 'python')
    if (existsSync(exe)) argv[0] = exe
  }
  return argv
}

// ---- the messaging protocol ----

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

interface Header {
  msg_id: string
  msg_type: string
  session: string
  username: string
  date: string
  version: string
}

export interface JMsg {
  header: Header
  parent_header: Partial<Header>
  metadata: Record<string, unknown>
  content: Record<string, any>
  buffers: Buffer[]
}

/** A mime bundle from the protocol as the notebook view takes it (every value a string). */
export function mimeBundle(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data ?? {})) {
    out[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join('') : JSON.stringify(v)
  }
  return out
}

interface Run {
  cell: string
  msgId: string
  idle: boolean
  replied: boolean
  ok: boolean
}

export interface KernelHooks {
  event(cell: string | null, ev: NbEvent): void
  // Widgets talk through comms. 'idle' says the kernel finished handling a message the notebook sent (parent = its id).
  comm?(msg: { type: 'comm_open' | 'comm_msg' | 'comm_close' | 'idle' | 'capture'; content: Record<string, any>; buffers: Buffer[]; metadata?: Record<string, unknown>; parent?: string }): void
  exit(code: number | null, stderr: string): void
}

export class JupyterKernel {
  private child: ChildProcess | null = null
  private key = ''
  private session = randomUUID()
  private shell!: ZSocket
  private iopub!: ZSocket
  private stdin!: ZSocket
  private control!: ZSocket
  private runs = new Map<string, Run>()
  private waiting = new Map<string, (m: JMsg) => void>() // replies and status messages that something is waiting for
  private inputRequest: JMsg | null = null
  private commSent = new Set<string>() // comm messages sent and not yet reported idle
  private claims = new Map<string, string>() // Output widget (comm id) -> the message id whose output it shows
  private connFile = ''
  private stderr = ''
  alive = false
  private pipeInterrupt = false // started through INTERRUPT_WRAPPER

  constructor(
    readonly spec: KernelSpec,
    private readonly cwd: string,
    private readonly dataDir: string,
    private readonly hooks: KernelHooks
  ) {}

  get pid(): number {
    return this.child?.pid ?? 0
  }

  async start(): Promise<void> {
    const ports = { shell: await freePort(), iopub: await freePort(), stdin: await freePort(), control: await freePort(), hb: await freePort() }
    this.key = randomBytes(16).toString('hex')
    await fs.mkdir(this.dataDir, { recursive: true })
    this.connFile = join(this.dataDir, `kernel-${randomUUID().slice(0, 8)}.json`)
    await fs.writeFile(
      this.connFile,
      JSON.stringify({ shell_port: ports.shell, iopub_port: ports.iopub, stdin_port: ports.stdin, control_port: ports.control, hb_port: ports.hb, ip: '127.0.0.1', key: this.key, transport: 'tcp', signature_scheme: 'hmac-sha256', kernel_name: this.spec.name }),
      'utf-8'
    )
    let argv = resolveArgv(this.spec, this.connFile)
    const at = argv.indexOf('ipykernel_launcher')
    if (process.platform === 'win32' && at > 1 && argv[at - 1] === '-m') {
      argv = [argv[0], '-c', INTERRUPT_WRAPPER, ...argv.slice(at + 1)]
      this.pipeInterrupt = true
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.spec.env, PYTHONIOENCODING: 'utf-8', PYDEVD_DISABLE_FILE_VALIDATION: '1' }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(argv[0], argv.slice(1), { cwd: this.cwd, env, stdio: [this.pipeInterrupt ? 'pipe' : 'ignore', 'ignore', 'pipe'], windowsHide: true })
    this.child = child
    this.alive = true
    child.stderr?.on('data', (b: Buffer) => (this.stderr = (this.stderr + b.toString('utf-8')).slice(-4000)))
    const died = new Promise<never>((_resolve, reject) => {
      child.once('error', (e) => reject(new Error(`Could not start the kernel "${this.spec.display_name}": ${e.message}`)))
      child.once('exit', (code) => reject(new Error(`The kernel "${this.spec.display_name}" stopped while starting (code ${code}).${this.stderr ? '\n' + this.stderr.trim().slice(-800) : ''}`)))
    })
    died.catch(() => undefined)
    child.on('exit', (code) => {
      this.alive = false
      for (const s of [this.shell, this.iopub, this.stdin, this.control]) s?.close()
      void fs.rm(this.connFile, { force: true })
      this.hooks.exit(code, this.stderr)
    })
    const identity = Buffer.from(this.session)
    this.shell = new ZSocket('DEALER', '127.0.0.1', ports.shell, identity)
    this.iopub = new ZSocket('SUB', '127.0.0.1', ports.iopub)
    this.stdin = new ZSocket('DEALER', '127.0.0.1', ports.stdin, identity)
    this.control = new ZSocket('DEALER', '127.0.0.1', ports.control)
    this.shell.on('message', (p: Buffer[]) => this.onShell(p))
    this.iopub.on('message', (p: Buffer[]) => this.onIopub(p))
    this.stdin.on('message', (p: Buffer[]) => this.onStdin(p))
    this.control.on('message', (p: Buffer[]) => this.onShell(p))
    await Promise.race([Promise.all([this.shell.connect(), this.iopub.connect(), this.stdin.connect(), this.control.connect()]), died])
    // The kernel is ready when it answers; its "idle" on the iopub socket shows the subscription is in place too.
    for (let i = 0; i < 40; i++) {
      const id = this.send(this.shell, 'kernel_info_request', {})
      const reply = await Promise.race([this.expect(id), new Promise<null>((r) => setTimeout(() => r(null), 1500)), died])
      if (reply) {
        await Promise.race([this.expect(id, 'status'), new Promise((r) => setTimeout(r, 1500)), died])
        return
      }
    }
    throw new Error('The kernel did not answer.')
  }

  private expect(parentId: string, type?: string): Promise<JMsg> {
    return new Promise((resolve) => this.waiting.set(parentId + ':' + (type ?? 'reply'), resolve))
  }

  private sign(parts: Buffer[]): string {
    if (!this.key) return ''
    const h = createHmac('sha256', this.key)
    for (const p of parts) h.update(p)
    return h.digest('hex')
  }

  /** Sends a message; returns its id. `parent` makes it a reply (input_reply). */
  private send(sock: ZSocket, type: string, content: Record<string, unknown>, parent?: Partial<Header>, buffers: Buffer[] = []): string {
    const header: Header = { msg_id: randomUUID(), msg_type: type, session: this.session, username: 'user', date: new Date().toISOString(), version: '5.3' }
    const body = [header, parent ?? {}, {}, content].map((o) => Buffer.from(JSON.stringify(o), 'utf-8'))
    sock.send([Buffer.from(DELIM), Buffer.from(this.sign(body)), ...body, ...buffers])
    return header.msg_id
  }

  private decode(parts: Buffer[]): JMsg | null {
    const i = parts.findIndex((p) => p.toString('latin1') === DELIM)
    if (i < 0 || parts.length < i + 6) return null
    const [sig, h, p, m, c] = parts.slice(i + 1, i + 6)
    if (this.key && sig.toString('ascii') !== this.sign([h, p, m, c])) return null
    try {
      return { header: JSON.parse(h.toString('utf-8')), parent_header: JSON.parse(p.toString('utf-8')), metadata: JSON.parse(m.toString('utf-8')), content: JSON.parse(c.toString('utf-8')), buffers: parts.slice(i + 6) }
    } catch {
      return null
    }
  }

  private onShell(parts: Buffer[]): void {
    const m = this.decode(parts)
    if (!m) return
    const parent = m.parent_header.msg_id ?? ''
    const w = this.waiting.get(parent + ':reply')
    if (w) {
      this.waiting.delete(parent + ':reply')
      w(m)
    }
    const run = this.runs.get(parent)
    if (run && m.header.msg_type === 'execute_reply') {
      run.replied = true
      run.ok = m.content.status === 'ok'
      this.finish(run)
    }
  }

  private finish(run: Run): void {
    if (!run.idle || !run.replied) return
    this.runs.delete(run.msgId)
    if (this.inputRequest?.parent_header.msg_id === run.msgId) this.inputRequest = null
    this.hooks.event(run.cell, { type: 'done', ok: run.ok })
  }

  private onIopub(parts: Buffer[]): void {
    const m = this.decode(parts)
    if (!m) return
    const t = m.header.msg_type
    const parent = m.parent_header.msg_id ?? ''
    if (t === 'comm_open' || t === 'comm_msg' || t === 'comm_close') {
      // An Output widget says which message's output it wants (msg_id); that output goes to the widget, not to the cell.
      const state = m.content.data?.state ?? (m.content.data?.method === 'update' || m.content.data?.method === 'echo_update' ? m.content.data.state : undefined)
      if (t === 'comm_close') this.claims.delete(String(m.content.comm_id))
      else if (state && typeof state.msg_id === 'string') {
        if (state.msg_id) this.claims.set(String(m.content.comm_id), state.msg_id)
        else this.claims.delete(String(m.content.comm_id))
      }
    }
    if (['stream', 'display_data', 'execute_result', 'error', 'clear_output'].includes(t) && parent) {
      const widgets = [...this.claims].filter(([, msg]) => msg === parent).map(([comm]) => comm)
      if (widgets.length) return void this.hooks.comm?.({ type: 'capture', content: { ...m.content, msg_type: t, widgets }, buffers: [], parent })
    }
    if (t === 'comm_open' || t === 'comm_msg' || t === 'comm_close') return void this.hooks.comm?.({ type: t, content: m.content, buffers: m.buffers, metadata: m.metadata })
    if (t === 'status' && m.content.execution_state === 'idle' && this.commSent.delete(parent)) this.hooks.comm?.({ type: 'idle', content: {}, buffers: [], parent })
    if (t === 'status' && m.content.execution_state === 'idle') {
      const w = this.waiting.get(parent + ':status')
      if (w) {
        this.waiting.delete(parent + ':status')
        w(m)
      }
    }
    const run = this.runs.get(parent)
    if (!run) return
    const c = m.content
    switch (t) {
      case 'stream':
        this.hooks.event(run.cell, { type: 'stream', name: c.name === 'stderr' ? 'stderr' : 'stdout', text: String(c.text ?? '') })
        break
      case 'display_data':
        this.hooks.event(run.cell, { type: 'display', data: mimeBundle(c.data), ...(typeof c.transient?.display_id === 'string' ? { id: c.transient.display_id } : {}) })
        break
      case 'update_display_data':
        if (typeof c.transient?.display_id === 'string') this.hooks.event(run.cell, { type: 'update', id: c.transient.display_id, data: mimeBundle(c.data) })
        break
      case 'clear_output':
        this.hooks.event(run.cell, { type: 'clear', wait: c.wait === true })
        break
      case 'execute_result':
        this.hooks.event(run.cell, { type: 'result', data: mimeBundle(c.data) })
        break
      case 'error':
        this.hooks.event(run.cell, { type: 'error', ename: String(c.ename ?? 'Error'), evalue: String(c.evalue ?? ''), traceback: Array.isArray(c.traceback) ? c.traceback.map(String) : [] })
        break
      case 'status':
        if (c.execution_state === 'idle') {
          run.idle = true
          this.finish(run)
        }
        break
    }
  }

  private onStdin(parts: Buffer[]): void {
    const m = this.decode(parts)
    if (!m || m.header.msg_type !== 'input_request') return
    const run = this.runs.get(m.parent_header.msg_id ?? '')
    if (!run) return
    this.inputRequest = m
    this.hooks.event(run.cell, { type: 'input_request', prompt: String(m.content.prompt ?? '') })
  }

  execute(cell: string, code: string): void {
    const id = this.send(this.shell, 'execute_request', { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: true, stop_on_error: true })
    this.runs.set(id, { cell, msgId: id, idle: false, replied: false, ok: true })
  }

  /** The answer to an input() the kernel is waiting on (null = cancelled). */
  inputReply(value: string | null): void {
    const req = this.inputRequest
    if (!req) return
    this.inputRequest = null
    this.send(this.stdin, 'input_reply', { value: value ?? '', status: 'ok' }, req.header)
    if (value === null) this.interrupt()
  }

  /** Stops the running cell and keeps the kernel's variables. False when this kernel cannot be interrupted here. */
  interrupt(): boolean {
    if (!this.alive) return false
    if (this.pipeInterrupt) return this.child?.stdin?.write('interrupt' + String.fromCharCode(10)) ?? false
    if (process.platform === 'win32') return false // other kernels have no way to be interrupted on Windows
    this.send(this.control, 'interrupt_request', {})
    return true
  }

  /** A message from a widget in the notebook to its counterpart in the kernel. */
  comm(type: 'comm_open' | 'comm_msg' | 'comm_close', content: Record<string, unknown>, buffers: Buffer[] = []): string | null {
    if (!this.alive) return null
    const id = this.send(this.shell, type, content, undefined, buffers)
    this.commSent.add(id)
    return id
  }

  kill(): void {
    try {
      if (this.alive && this.control) this.send(this.control, 'shutdown_request', { restart: false })
    } catch {
      // not connected yet
    }
    const child = this.child
    if (!child) return
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // gone
      }
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    }, 400)
  }
}
