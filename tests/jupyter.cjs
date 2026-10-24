// Jupyter kernels over ZeroMQ: the real notebook and jupyter modules start a real ipykernel and run cells in it, through
// the same IPC handlers the notebook view uses. `npm run test:jupyter`: needs a Python with ipykernel registered as a
// Jupyter kernel (for example Anaconda); skipped without one. Does not start the app.
const fs = require('fs'), os = require('os'), path = require('path')
const handlers = {}
const sent = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jupyter-test-'))
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f } },
  shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') }
}
const root = path.join(__dirname, '..')
const cache = path.join(root, 'node_modules', '.cache')
fs.mkdirSync(cache, { recursive: true })
const stub = path.join(cache, 'jupyter-stub.cjs'), bundle = path.join(cache, 'jupyter-bundle.cjs')
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/main/notebook.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['esbuild'], alias: { electron: stub }, outfile: bundle, logLevel: 'error' })
const nb = require(bundle)
nb.registerNotebookHandlers(() => ({ webContents: { send: (ch, ...a) => sent.push({ ch, a }) } }))
const call = (n, ...a) => handlers[n]({}, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }
const events = (session, cell) => sent.filter((s) => s.ch === 'nb:event' && s.a[0] === session && s.a[1] === cell).map((s) => s.a[2])

;(async () => {
  const kernels = await call('nb:kernels')
  const py = kernels.find((k) => k.id.startsWith('jupyter:') && k.kernelspec && k.kernelspec.language === 'python')
  if (!py) { console.log('SKIP  no Jupyter Python kernel installed'); process.exit(0) }
  check('installed Jupyter kernels are listed next to the built-in ones', kernels.some((k) => k.id === 'python') && kernels.some((k) => k.id === 'javascript') && /^Jupyter: /.test(py.label), JSON.stringify(py))
  let r = await call('nb:start', 'jupyter:does-not-exist', tmp)
  check('an unknown kernel gives a clear error', r.ok === false && /not installed/.test(r.error), JSON.stringify(r))
  r = await call('nb:start', 'jupyter:../evil', tmp)
  check('a kernel name with path characters is refused', r.ok === false)
  const t0 = Date.now()
  r = await call('nb:start', py.id, tmp)
  check('a kernel starts and answers the messaging protocol', r.ok === true, JSON.stringify(r) + ' in ' + (Date.now() - t0) + ' ms')
  const s = r.session
  const run = async (cell, code, ms = 20000) => {
    await call('nb:execute', s, cell, code)
    const t = Date.now()
    while (!events(s, cell).some((e) => e.type === 'done')) {
      if (Date.now() - t > ms) throw new Error('timed out running ' + cell + ': ' + JSON.stringify(events(s, cell)))
      await sleep(40)
    }
    return events(s, cell)
  }
  let ev = await run('c1', 'x = 41\nprint("hello", x)\nx + 1')
  check('output of print() arrives as a stream', ev.some((e) => e.type === 'stream' && e.name === 'stdout' && /hello 41/.test(e.text)), JSON.stringify(ev))
  check('the value of the last expression arrives as a result', ev.some((e) => e.type === 'result' && e.data['text/plain'] === '42'), JSON.stringify(ev))
  check('and the cell is done, ok', ev[ev.length - 1].type === 'done' && ev[ev.length - 1].ok === true)
  ev = await run('c2', 'x * 2')
  check('variables stay between cells', ev.some((e) => e.type === 'result' && e.data['text/plain'] === '82'), JSON.stringify(ev))
  ev = await run('c3', '1 / 0')
  const er = ev.find((e) => e.type === 'error')
  check('an exception arrives with its name, message and traceback', !!er && er.ename === 'ZeroDivisionError' && /division/.test(er.evalue) && er.traceback.length > 0 && ev[ev.length - 1].ok === false, JSON.stringify(er))
  ev = await run('c4', 'from IPython.display import display, HTML\ndisplay(HTML("<b>bold</b>"))')
  check('display() arrives with its HTML', ev.some((e) => e.type === 'display' && /<b>bold<\/b>/.test(e.data['text/html'] || '')), JSON.stringify(ev))
  ev = await run('c5', 'import matplotlib\nmatplotlib.use("module://matplotlib_inline.backend_inline")\nimport matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()', 40000)
  check('a plot arrives as a PNG image', ev.some((e) => e.type === 'display' && /^iVBOR/.test(e.data['image/png'] || '')), JSON.stringify(ev).slice(0, 200))
  // display(..., display_id=...) with an update, and clear_output
  ev = await run('c5b', ['from IPython.display import display, HTML, clear_output', 'h = display(HTML("<b>one</b>"), display_id="box1")', 'h.update(HTML("<b>two</b>"))', 'print("before")', 'clear_output(wait=True)', 'print("after")'].join(String.fromCharCode(10)))
  const dd = ev.find((e) => e.type === 'display')
  const up = ev.find((e) => e.type === 'update')
  check('a display with a display_id carries it, and update_display_data names the same one', !!dd && dd.id === 'box1' && /one/.test(dd.data['text/html']) && !!up && up.id === 'box1' && /two/.test(up.data['text/html']), JSON.stringify(ev).slice(0, 300))
  const ci = ev.findIndex((e) => e.type === 'clear')
  check('clear_output(wait=True) arrives as a clear that waits, between the two prints', ci > 0 && ev[ci].wait === true && ev[ci - 1].type === 'stream' && /before/.test(ev[ci - 1].text) && ev[ci + 1].type === 'stream' && /after/.test(ev[ci + 1].text), JSON.stringify(ev.map((e) => e.type)))
  // input()
  await call('nb:execute', s, 'c6', 'name = input("name? ")\nprint("hi " + name)')
  const t1 = Date.now()
  while (!events(s, 'c6').some((e) => e.type === 'input_request') && Date.now() - t1 < 15000) await sleep(40)
  const ir = events(s, 'c6').find((e) => e.type === 'input_request')
  check('input() asks the notebook for a line, with its prompt', !!ir && ir.prompt === 'name? ', JSON.stringify(events(s, 'c6')))
  await call('nb:input', s, 'Bob')
  while (!events(s, 'c6').some((e) => e.type === 'done') && Date.now() - t1 < 30000) await sleep(40)
  check('and the answer reaches the program', events(s, 'c6').some((e) => e.type === 'stream' && /hi Bob/.test(e.text)), JSON.stringify(events(s, 'c6')))
  // interrupt
  await call('nb:execute', s, 'c7', 'import time\ntime.sleep(60)')
  await sleep(1500)
  const t2 = Date.now()
  await call('nb:interrupt', s)
  while (!events(s, 'c7').some((e) => e.type === 'done') && Date.now() - t2 < 15000) await sleep(40)
  const ie = events(s, 'c7').find((e) => e.type === 'error')
  check('Interrupt stops a running cell with KeyboardInterrupt, within seconds', !!ie && ie.ename === 'KeyboardInterrupt' && Date.now() - t2 < 10000, JSON.stringify(ie) + ' ' + (Date.now() - t2) + ' ms')
  ev = await run('c8', 'x')
  check('and the kernel keeps its variables after an interrupt', ev.some((e) => e.type === 'result' && e.data['text/plain'] === '41'), JSON.stringify(ev))
  // the next cell after an error still runs; stop_on_error does not apply across separate executes
  ev = await run('c9', 'print("still alive")')
  check('a cell runs after an earlier one failed', ev.some((e) => e.type === 'stream' && /still alive/.test(e.text)))
  // stop
  await call('nb:stop', s)
  const t3 = Date.now()
  while (!sent.some((m) => m.ch === 'nb:exited' && m.a[0] === s) && Date.now() - t3 < 10000) await sleep(100)
  check('Stop ends the kernel process and the notebook is told', sent.some((m) => m.ch === 'nb:exited' && m.a[0] === s))
  r = await call('nb:execute', s, 'c10', '1')
  check('running a cell on a stopped kernel is refused', r.ok === false)
  try { nb.stopAllKernels() } catch { /* none */ }
  await sleep(500)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* temp */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); try { nb.stopAllKernels() } catch { /* */ } process.exit(1) })
