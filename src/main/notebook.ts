import { app, BrowserWindow, ipcMain } from 'electron'
import { ChildProcess, spawn } from 'child_process'
import { findPython } from './pythonenv'
import { JupyterKernel, listKernelSpecs } from './jupyter'
import { promises as fs } from 'fs'
import { join } from 'path'

// Notebook kernels: a long-running process per notebook that runs one cell after another and keeps its variables.
//   Python      a small driver around exec() (needs Python 3 on the PATH)
//   JavaScript  Node, using the vm module (works with the Node inside this app, no install needed)
//   Jupyter     any installed Jupyter kernel (ipykernel, IRkernel, IJulia...), started from its kernel.json and driven with
//               the Jupyter messaging protocol over ZeroMQ (see jupyter.ts); this is the way to get widgets
// Cells, outputs and the notebook file itself follow nbformat 4 as usual.

export interface KernelInfo {
  id: string // python, javascript, or jupyter:<kernelspec name>
  label: string
  kernelspec?: { name: string; display_name: string; language: string } // what a notebook records about it in its metadata
}

export type NbEvent =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'result'; data: Record<string, string> }
  | { type: 'display'; data: Record<string, string>; id?: string } // id: display(..., display_id=...), which update_display_data refers to
  | { type: 'update'; id: string; data: Record<string, string> }
  | { type: 'clear'; wait: boolean } // clear_output(); with wait, the output goes when the next output arrives
  | { type: 'error'; ename: string; evalue: string; traceback: string[] }
  | { type: 'input_request'; prompt: string }
  | { type: 'done'; ok: boolean }

const PY_DRIVER = `import sys, os, json, ast, io, traceback, base64

_proto = os.fdopen(os.dup(1), 'w', buffering=1, encoding='utf-8')
os.dup2(2, 1)  # anything a child process writes to stdout goes to the error pipe, not into the protocol
_cur = [None]

def _send(obj):
    _proto.write(json.dumps(obj) + '\\n')
    _proto.flush()

class _Out(io.TextIOBase):
    def __init__(self, name):
        self.name = name
    def writable(self):
        return True
    def write(self, s):
        if s and _cur[0] is not None:
            _send({'id': _cur[0], 'type': 'stream', 'name': self.name, 'text': s})
        return len(s)
    def flush(self):
        pass

sys.stdout = _Out('stdout')
sys.stderr = _Out('stderr')

def _input(prompt=''):
    _send({'id': _cur[0], 'type': 'input_request', 'prompt': str(prompt)})
    line = sys.stdin.readline()
    if not line:
        raise EOFError('The kernel was closed while waiting for input')
    reply = json.loads(line)
    if reply.get('cancel'):
        raise KeyboardInterrupt('input cancelled')
    return reply.get('value', '')
import builtins
builtins.input = _input

def _bundle(obj):
    data = {}
    try:
        if hasattr(obj, '_repr_png_'):
            png = obj._repr_png_()
            if png:
                data['image/png'] = base64.b64encode(png).decode('ascii') if isinstance(png, bytes) else png
        if hasattr(obj, '_repr_svg_'):
            svg = obj._repr_svg_()
            if svg:
                data['image/svg+xml'] = svg
        if hasattr(obj, '_repr_html_'):
            html = obj._repr_html_()
            if html:
                data['text/html'] = html
        if hasattr(obj, '_repr_markdown_'):
            md = obj._repr_markdown_()
            if md:
                data['text/markdown'] = md
    except Exception:
        pass
    data['text/plain'] = repr(obj)
    return data

def display(*objs):
    for o in objs:
        _send({'id': _cur[0], 'type': 'display', 'data': _bundle(o)})
builtins.display = display

def _figures():
    mpl = sys.modules.get('matplotlib.pyplot')
    if not mpl:
        return
    try:
        for num in mpl.get_fignums():
            fig = mpl.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format='png', bbox_inches='tight')
            _send({'id': _cur[0], 'type': 'display', 'data': {'image/png': base64.b64encode(buf.getvalue()).decode('ascii'), 'text/plain': '<Figure>'}})
        mpl.close('all')
    except Exception:
        pass

os.environ.setdefault('MPLBACKEND', 'Agg')
_ns = {'__name__': '__main__', '__builtins__': builtins}

def _run(code):
    tree = ast.parse(code, '<cell>', 'exec')
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    exec(compile(tree, '<cell>', 'exec'), _ns)
    if last is not None:
        value = eval(compile(last, '<cell>', 'eval'), _ns)
        if value is not None:
            _ns['_'] = value
            _send({'id': _cur[0], 'type': 'result', 'data': _bundle(value)})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    _cur[0] = msg['id']
    ok = True
    try:
        _run(msg['code'])
    except SystemExit:
        pass
    except BaseException as e:
        ok = False
        t = e.__traceback__
        while t is not None and t.tb_frame.f_code.co_filename == __file__:  # leave out the frames of this driver
            t = t.tb_next
        keep = traceback.format_exception(type(e), e, t)
        _send({'id': _cur[0], 'type': 'error', 'ename': type(e).__name__, 'evalue': str(e), 'traceback': ''.join(keep).rstrip().split('\\n')})
    _figures()
    _send({'id': _cur[0], 'type': 'done', 'ok': ok})
    _cur[0] = None
`

const JS_DRIVER = `'use strict'
const vm = require('vm')
const readline = require('readline')
const path = require('path')
const util = require('util')
const proto = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
let cur = null
const emit = (name) => (...args) => { if (cur) proto({ id: cur, type: 'stream', name, text: util.format(...args) + '\\n' }) }
const consoleShim = { log: emit('stdout'), info: emit('stdout'), debug: emit('stdout'), warn: emit('stderr'), error: emit('stderr'), table: emit('stdout'), dir: (o) => emit('stdout')(util.inspect(o, { depth: 4 })) }
const req = require('module').createRequire(path.join(process.cwd(), 'notebook.js'))
const sandbox = { console: consoleShim, require: req, process, Buffer, setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, URL, TextEncoder, TextDecoder, fetch: globalThis.fetch, structuredClone, queueMicrotask }
sandbox.global = sandbox
sandbox.display = (o) => { if (cur) proto({ id: cur, type: 'display', data: { 'text/plain': util.inspect(o, { depth: 4 }) } }) }
const ctx = vm.createContext(sandbox)
const rl = readline.createInterface({ input: process.stdin })
let chain = Promise.resolve()
rl.on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  chain = chain.then(async () => {
    cur = msg.id
    let ok = true
    try {
      let value = vm.runInContext(msg.code, ctx, { filename: 'cell' })
      if (value && typeof value.then === 'function') value = await value
      if (value !== undefined) { ctx._ = value; proto({ id: cur, type: 'result', data: { 'text/plain': util.inspect(value, { depth: 4 }) } }) }
    } catch (e) {
      ok = false
      const err = e && e.stack ? e : new Error(String(e))
      proto({ id: cur, type: 'error', ename: err.name || 'Error', evalue: String(err.message || e), traceback: String(err.stack || err).split('\\n').filter((l) => !/node:internal|driver/.test(l)) })
    }
    proto({ id: cur, type: 'done', ok })
    cur = null
  })
})
process.on('uncaughtException', (e) => { if (cur) proto({ id: cur, type: 'stream', name: 'stderr', text: String(e && e.stack || e) + '\\n' }) })
process.on('unhandledRejection', (e) => { if (cur) proto({ id: cur, type: 'stream', name: 'stderr', text: 'Unhandled rejection: ' + String(e && e.stack || e) + '\\n' }) })
`

interface Session {
  id: number
  kernel: KernelInfo['id']
  child: ChildProcess | null // null for a Jupyter kernel
  jupyter?: JupyterKernel
  buffer: string
  cwd: string
  alive: boolean
}

const sessions = new Map<number, Session>()
let nextSession = 1
let getWinRef: () => BrowserWindow | null = () => null
const dataDir = (): string => join(app.getPath('userData'), 'notebook')

export async function availableKernels(): Promise<KernelInfo[]> {
  const out: KernelInfo[] = []
  const py = await findPython()
  if (py) out.push({ id: 'python', label: `Python ${py.version}` })
  out.push({ id: 'javascript', label: `JavaScript (Node ${process.versions.node})` })
  for (const k of listKernelSpecs()) out.push({ id: 'jupyter:' + k.name, label: `Jupyter: ${k.display_name}`, kernelspec: { name: k.name, display_name: k.display_name, language: k.language } })
  return out
}

async function startJupyter(name: string, cwd: string): Promise<{ ok: true; session: number } | { ok: false; error: string }> {
  const spec = listKernelSpecs().find((k) => k.name === name)
  if (!spec) return { ok: false, error: `The Jupyter kernel "${name}" is not installed on this computer.` }
  const id = nextSession++
  const send = (cell: string | null, ev: NbEvent): void => getWinRef()?.webContents.send('nb:event', id, cell, ev)
  const k = new JupyterKernel(spec, cwd, join(dataDir(), 'jupyter'), {
    event: send,
    comm: (m) => getWinRef()?.webContents.send('nb:comm', id, m.type, m.content, m.buffers.map((b) => new Uint8Array(b)), m.parent, m.metadata),
    exit: (code, err) => {
      sessions.delete(id)
      getWinRef()?.webContents.send('nb:exited', id, code, err)
    }
  })
  try {
    await k.start()
  } catch (e) {
    k.kill()
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  sessions.set(id, { id, kernel: 'jupyter:' + name, child: null, jupyter: k, buffer: '', cwd, alive: true })
  return { ok: true, session: id }
}

async function startKernel(kernel: KernelInfo['id'], cwd: string): Promise<{ ok: true; session: number } | { ok: false; error: string }> {
  if (kernel.startsWith('jupyter:')) return startJupyter(kernel.slice(8), cwd)
  await fs.mkdir(dataDir(), { recursive: true })
  let file: string
  let args: string[]
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  if (kernel === 'python') {
    const py = await findPython()
    if (!py) return { ok: false, error: 'Python 3 was not found. Install it from python.org (tick "Add to PATH") and reopen the notebook.' }
    const driver = join(dataDir(), 'py-driver.py')
    await fs.writeFile(driver, PY_DRIVER, 'utf-8')
    file = py.file
    args = [...py.args, '-u', driver]
    delete env.ELECTRON_RUN_AS_NODE
  } else {
    const driver = join(dataDir(), 'js-driver.cjs')
    await fs.writeFile(driver, JS_DRIVER, 'utf-8')
    file = process.execPath
    args = [driver]
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const s: Session = { id: nextSession++, kernel: kernel as 'python' | 'javascript', child, buffer: '', cwd, alive: true }
  sessions.set(s.id, s)
  const send = (cell: string | null, ev: NbEvent): void => getWinRef()?.webContents.send('nb:event', s.id, cell, ev)
  child.stdout?.on('data', (b: Buffer) => {
    s.buffer += b.toString('utf-8')
    let i: number
    while ((i = s.buffer.indexOf('\n')) >= 0) {
      const line = s.buffer.slice(0, i)
      s.buffer = s.buffer.slice(i + 1)
      try {
        const m = JSON.parse(line) as { id: string } & NbEvent
        send(m.id, m)
      } catch {
        send(null, { type: 'stream', name: 'stdout', text: line + '\n' })
      }
    }
  })
  // Whatever the kernel writes to its error stream outside a cell (start-up problems).
  let startupErr = ''
  child.stderr?.on('data', (b: Buffer) => {
    const text = b.toString('utf-8')
    startupErr = (startupErr + text).slice(-4000)
    send(null, { type: 'stream', name: 'stderr', text })
  })
  child.on('error', (e) => send(null, { type: 'error', ename: 'KernelError', evalue: e.message, traceback: [] }))
  child.on('exit', (code) => {
    s.alive = false
    sessions.delete(s.id)
    getWinRef()?.webContents.send('nb:exited', s.id, code, startupErr)
  })
  return { ok: true, session: s.id }
}

function kill(s: Session): void {
  if (s.jupyter) return void s.jupyter.kill()
  if (!s.child) return
  try {
    s.child.kill()
  } catch {
    // already gone
  }
  if (process.platform === 'win32' && s.child.pid) spawn('taskkill', ['/pid', String(s.child.pid), '/T', '/F'], { windowsHide: true })
}

export function registerNotebookHandlers(getWin: () => BrowserWindow | null): void {
  getWinRef = getWin
  ipcMain.handle('nb:kernels', () => availableKernels())
  ipcMain.handle('nb:start', (_e, kernel: string, cwd: string) => {
    if (kernel !== 'python' && kernel !== 'javascript' && !/^jupyter:[A-Za-z0-9._-]{1,80}$/.test(String(kernel))) return { ok: false as const, error: 'Unknown kernel.' }
    return startKernel(kernel, cwd || process.cwd())
  })
  ipcMain.handle('nb:execute', (_e, session: number, cellId: string, code: string) => {
    const s = sessions.get(session)
    if (!s || !s.alive) return { ok: false as const, error: 'The kernel is not running.' }
    if (s.jupyter) {
      s.jupyter.execute(String(cellId), String(code))
      return { ok: true as const }
    }
    s.child?.stdin?.write(JSON.stringify({ id: String(cellId), code: String(code) }) + '\n')
    return { ok: true as const }
  })
  // The answer to an input() the Python kernel is waiting on (value null = the user cancelled).
  ipcMain.handle('nb:input', (_e, session: number, value: string | null) => {
    const s = sessions.get(session)
    if (!s || !s.alive) return
    if (s.jupyter) return s.jupyter.inputReply(value === null ? null : String(value))
    s.child?.stdin?.write(JSON.stringify(value === null ? { cancel: true } : { value: String(value) }) + '\n')
  })
  // There is no way to send Ctrl+C to a process on Windows, so an interrupt stops the kernel (variables are lost).
  // A widget in the notebook talking to its model in the kernel.
  ipcMain.handle('nb:comm', (_e, session: number, type: string, content: Record<string, unknown>, buffers: Uint8Array[]) => {
    const s = sessions.get(session)
    if (!s?.jupyter || !['comm_open', 'comm_msg', 'comm_close'].includes(type)) return null
    return s.jupyter.comm(type as 'comm_open', content ?? {}, (buffers ?? []).map((b) => Buffer.from(b)))
  })
  // A Jupyter kernel can be interrupted without losing its variables; the others are stopped.
  ipcMain.handle('nb:interrupt', (_e, session: number) => {
    const s = sessions.get(session)
    if (!s) return
    if (s.jupyter) {
      if (!s.jupyter.interrupt()) kill(s) // a kernel that cannot be interrupted is stopped
    } else kill(s)
  })
  ipcMain.handle('nb:stop', (_e, session: number) => {
    const s = sessions.get(session)
    if (s) kill(s)
  })
}

export function stopAllKernels(): void {
  for (const s of sessions.values()) kill(s)
}
