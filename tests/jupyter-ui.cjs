// Jupyter kernels and widgets in the real app: a notebook is run with an installed Jupyter kernel (ipykernel), and an
// ipywidgets slider and button are drawn, moved with the keyboard and clicked, with the kernel seeing the changes.
// `npm run test:jupyter-ui` starts the app itself. Needs a Jupyter Python kernel with ipywidgets installed (e.g. Anaconda);
// set JUPYTER_TEST_PYTHON to the python.exe whose kernel it should use if the default is not there.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 1200) : ''}`) }

const py = process.env.JUPYTER_TEST_PYTHON || 'C:\\ProgramData\\Anaconda3\\python.exe'
const probe = fs.existsSync(py) ? cp.spawnSync(py, ['-c', 'import ipykernel, ipywidgets; print(ipywidgets.__version__)'], { encoding: 'utf-8', windowsHide: true }) : { status: 1 }
if (probe.status !== 0) { console.log('SKIP  no Python with ipykernel and ipywidgets (set JUPYTER_TEST_PYTHON)'); process.exit(0) }
const widgetsVersion = probe.stdout.trim()

const port = 9778
const tmp = path.join(os.tmpdir(), 'jupyter-ui-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true })
const proj = path.join(tmp, 'proj'), data = path.join(tmp, 'data'), kdir = path.join(tmp, 'jupyter', 'kernels', 'ide-test')
for (const d of [proj, data, kdir]) fs.mkdirSync(d, { recursive: true })
// The kernel is found through JUPYTER_PATH, like any other installed kernel.
fs.writeFileSync(path.join(kdir, 'kernel.json'), JSON.stringify({ argv: [py, '-m', 'ipykernel_launcher', '-f', '{connection_file}'], display_name: 'IDE Test Kernel', language: 'python' }))
const cell = (id, lines) => ({ cell_type: 'code', id, metadata: {}, execution_count: null, outputs: [], source: lines.join(String.fromCharCode(10)) })
fs.writeFileSync(path.join(proj, 'w.ipynb'), JSON.stringify({
  cells: [
    cell('c1', ['import ipywidgets as w', 'from IPython.display import display', 'slider = w.IntSlider(value=5, min=0, max=10, description="Level")', 'clicks = []', 'button = w.Button(description="Press me")', 'button.on_click(lambda b: clicks.append(1))', 'display(slider, button)']),
    cell('c2', ['print("level", slider.value, "clicks", len(clicks))']),
    cell('c3', ['slider.value = 8']),
    cell('c4', ['from ipywidgets import interact', '@interact(n=(0, 10))', 'def show(n=3):', '    print("n is", n)']),
    cell('c5', ['from IPython.display import display', 'h = display("first", display_id="box")', 'h.update("second")']),
    cell('c6', ['from IPython.display import clear_output', 'print("p1")', 'clear_output(wait=True)', 'print("p2")']),
    cell('c7', ['from IPython.display import HTML, display', 'display(HTML(\'<div id="x">start</div><script>var d=document.getElementById("x");for(var i=0;i<14;i++){var p=document.createElement("p");p.textContent="line "+i;d.appendChild(p)}</script>\'))'])
  ],
  metadata: { kernelspec: { display_name: 'IDE Test Kernel', language: 'python', name: 'ide-test' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5
}, null, 1))

const env = { ...process.env, JUPYTER_PATH: path.join(tmp, 'jupyter') }
delete env.ELECTRON_RUN_AS_NODE
const app = cp.spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${data}`, proj], { cwd: path.join(__dirname, '..'), env, shell: true, stdio: 'ignore', windowsHide: true })
const stopApp = () => { try { cp.execSync('taskkill /F /T /PID ' + app.pid, { stdio: 'ignore' }) } catch { /* gone */ } try { cp.execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }) } catch { /* none */ } }

;(async () => {
  let list
  for (let i = 0; i < 60; i++) {
    list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null)
    if (list && list.some((t) => t.type === 'page')) break
    await sleep(2000)
  }
  if (!list) throw new Error('the app did not start')
  await sleep(5000)
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  let id = 0; const pend = {}
  const errors = []
  ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m); if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type) && !/externalized/.test(JSON.stringify(m.params.args)) ) console.log('CONSOLE', m.params.type, JSON.stringify(m.params.args.map((a) => a.description || a.value)).slice(0, 700))
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text) })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 30000); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
  const mouse = async (x, y) => { for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 }) }
  const center = async (sel) => JSON.parse(await ev(`(() => { const e = ${sel}; if (!e) return 'null'; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
  const realClick = async (sel) => { const p = await center(sel); if (p) await mouse(p.x, p.y); return !!p }
  const key = async (k, code, vk) => { for (const t of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, key: k, code, windowsVirtualKeyCode: vk }) }
  const waitFor = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(400) } }
  const cellSel = (n) => `document.querySelectorAll('[data-nb-cell]')[${n}]`
  const out = (n) => ev(`${cellSel(n)}?.querySelector('[data-nb-outputs]')?.innerText ?? ''`)

  await waitFor(() => ev(`document.querySelectorAll('.tree-row').length > 0`), 120000)
  await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(1000)
  await ev(`[...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').endsWith('w.ipynb'))?.click()`)
  check('the notebook opens', await waitFor(() => ev(`!!document.querySelector('[data-notebook]') || document.querySelectorAll('[data-nb-cell]').length === 3`), 20000))
  const optionsNow = () => ev(`JSON.stringify([...document.querySelectorAll('[data-nb-kernel] option')].map((o) => [o.value, o.textContent]))`)
  await waitFor(async () => /jupyter:ide-test/.test(await optionsNow()), 20000)
  const kernels = JSON.parse(await optionsNow())
  check('the installed Jupyter kernel is in the kernel list', kernels.some((k) => k[0] === 'jupyter:ide-test' && /IDE Test Kernel/.test(k[1])), JSON.stringify(kernels))
  check('and the notebook, which names that kernel, has it selected', (await ev(`document.querySelector('[data-nb-kernel]').value`)) === 'jupyter:ide-test')

  await realClick(`${cellSel(0)}.querySelector('[data-nb-run]')`)
  check('running a cell starts the kernel and draws the slider and the button', await waitFor(() => ev(`!!document.querySelector('[data-nb-widget] .widget-hslider, [data-nb-widget] .widget-slider') && /Press me/.test(document.querySelector('[data-nb-widget] button')?.textContent ?? '')`), 60000), await ev(`JSON.stringify(document.querySelector('[data-nb-widget]')?.textContent.slice(0, 900)) + ' || ' + (document.querySelector('[data-nb-outputs]')?.innerHTML.slice(0, 200))`))
  check('the slider shows its label and starts at 5', /Level/.test(await ev(`document.querySelector('[data-nb-widget]')?.innerText ?? ''`)) && /5/.test(await ev(`document.querySelector('[data-nb-widget] .widget-readout')?.textContent ?? ''`)), await ev(`document.querySelector('[data-nb-widget] .widget-readout')?.textContent`))
  // move the slider with the keyboard
  const handle = `document.querySelector('[data-nb-widget] .noUi-handle, [data-nb-widget] [role="slider"]')`
  await realClick(handle)
  for (let i = 0; i < 2; i++) await key('ArrowRight', 'ArrowRight', 39)
  check('the keyboard moves the slider', await waitFor(() => ev(`/7/.test(document.querySelector('[data-nb-widget] .widget-readout')?.textContent ?? '')`), 10000), await ev(`document.querySelector('[data-nb-widget] .widget-readout')?.textContent`))
  await realClick(`${cellSel(1)}.querySelector('[data-nb-run]')`)
  check('and the kernel sees the new value', await waitFor(async () => /level 7 clicks 0/.test(await out(1)), 20000), await out(1))
  await realClick(`[...document.querySelectorAll('[data-nb-widget] button')].find((b) => /Press me/.test(b.textContent))`)
  await realClick(`${cellSel(1)}.querySelector('[data-nb-run]')`)
  check('clicking the button runs its handler in the kernel', await waitFor(async () => /level 7 clicks 1/.test(await out(1)), 20000), await out(1))
  // the kernel changes the widget
  await realClick(`${cellSel(2)}.querySelector('[data-nb-run]')`)
  check('a value set by the kernel moves the slider on screen', await waitFor(() => ev(`/8/.test(document.querySelector('[data-nb-widget] .widget-readout')?.textContent ?? '')`), 20000), await ev(`document.querySelector('[data-nb-widget] .widget-readout')?.textContent`))
  // interact(): a slider whose function's output is drawn by an Output widget
  await realClick(`${cellSel(3)}.querySelector('[data-nb-run]')`)
  check('interact() draws a slider and the printed output of its function in an Output widget', await waitFor(async () => /n is 3/.test(await ev(`${cellSel(3)}?.querySelector('.nb-widget-output')?.innerText ?? ''`)), 30000), await ev(`${cellSel(3)}?.querySelector('[data-nb-outputs]')?.innerHTML.slice(0, 900)`))
  await realClick(`${cellSel(3)}.querySelector('.noUi-handle, [role="slider"]')`)
  await key('ArrowRight', 'ArrowRight', 39)
  check('moving that slider re-runs the function in the kernel and the new output replaces the old', await waitFor(async () => { const t = await ev(`${cellSel(3)}?.querySelector('.nb-widget-output')?.innerText ?? ''`); return /n is 4/.test(t) && !/n is 3/.test(t) }, 20000), await ev(`${cellSel(3)}?.querySelector('.nb-widget-output')?.innerText`))
  // update_display_data replaces an output, clear_output(wait=True) replaces what was printed
  await realClick(`${cellSel(4)}.querySelector('[data-nb-run]')`)
  check('a display updated by its display_id shows the new text, not the old', await waitFor(async () => { const t = await out(4); return /second/.test(t) && !/first/.test(t) }, 30000), await out(4))
  await realClick(`${cellSel(5)}.querySelector('[data-nb-run]')`)
  check('clear_output(wait=True) leaves only what is printed after it', await waitFor(async () => { const t = await out(5); return /p2/.test(t) && !/p1/.test(t) }, 30000), await out(5))
  // HTML with scripts (plotly, bokeh...) runs in a frame of its own for a cell that was just run: the script made the page taller
  await realClick(`${cellSel(6)}.querySelector('[data-nb-run]')`)
  check('the script in the HTML output of a cell that was just run ran (the frame grew to hold what it added)', await waitFor(async () => (await ev(`${cellSel(6)}.querySelector('[data-nb-html-live]')?.getBoundingClientRect().height ?? 0`)) > 150, 30000), await ev(`${cellSel(6)}.querySelector('[data-nb-outputs]')?.innerHTML.slice(0, 300)`))
  check('and that frame is cut off from the editor (a sandbox without same-origin access)', (await ev(`${cellSel(6)}.querySelector('[data-nb-html-live]')?.getAttribute('sandbox')`)) === 'allow-scripts')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (process.env.JUPYTER_UI_SHOT) fs.writeFileSync(process.env.JUPYTER_UI_SHOT, Buffer.from(shot.result.data, 'base64'))
  // the notebook file keeps the widget's fallback text, not widget state
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 })
  await waitFor(() => /widget-view/.test(fs.readFileSync(path.join(proj, 'w.ipynb'), 'utf-8')), 8000)
  const saved = fs.readFileSync(path.join(proj, 'w.ipynb'), 'utf-8')
  check('the saved notebook has the widget as an output with a text fallback', /application\/vnd\.jupyter\.widget-view\+json/.test(saved) && /IntSlider/.test(saved))
  // stopping the kernel
  await ev(`document.querySelector('[data-nb-action="stop"]').click()`)
  check('Stop with nothing running stops the kernel', await waitFor(() => ev(`document.querySelector('[data-nb-status]')?.getAttribute('data-nb-status') === 'stopped'`), 15000))
  // the same notebook opened again: its saved HTML does not run scripts
  await ev(`document.querySelector('.tab .close, .tab [data-tab-close]')?.click()`); await sleep(800)
  await ev(`[...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').endsWith('w.ipynb'))?.click()`)
  await waitFor(() => ev(`document.querySelectorAll('[data-nb-cell]').length === 7`), 20000)
  check('after the notebook is opened again, saved HTML is shown without scripts (not in the script-running frame)', await waitFor(() => ev(`!!${cellSel(6)}.querySelector('iframe.nb-html') && !${cellSel(6)}.querySelector('[data-nb-html-live]') && ${cellSel(6)}.querySelector('iframe.nb-html').getAttribute('sandbox') === 'allow-same-origin'`), 20000))
  check('no uncaught errors in the page', errors.length === 0, errors.join(' | '))
  console.log('ipywidgets', widgetsVersion)
  stopApp()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); stopApp(); process.exit(1) })
