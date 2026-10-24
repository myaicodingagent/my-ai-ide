// Webview panel serializers in the real app: an extension opens a page that keeps state with setState(); the app is closed
// (killed, so nothing is saved at the end) and started again; the extension's serializer is asked to bring the panel back
// with that state, and the page gets the state from getState(). A panel the user closed does not come back.
// `npm run test:ext-restore` starts the app itself (three times).
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }

const port = 9889
const tmp = path.join(os.tmpdir(), 'ext-restore-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true })
const proj = path.join(tmp, 'proj'), data = path.join(tmp, 'data'), extDir = path.join(tmp, 'demo-serial'), logFile = path.join(tmp, 'events.log')
for (const d of [proj, path.join(data, 'extensions'), extDir]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(proj, 'readme.txt'), 'hello\n')
fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({
  name: 'demo-serial', publisher: 'local', version: '1.0.0', main: './extension.js', activationEvents: ['*'], engines: { vscode: '^1.85.0' },
  contributes: { commands: [{ command: 'demo.counter', title: 'Demo: Open Counter' }] }
}))
fs.writeFileSync(path.join(extDir, 'extension.js'), `
const vscode = require('vscode')
const fs = require('fs')
const note = (t) => fs.appendFileSync(${JSON.stringify(logFile)}, t + '\\n')
const html = '<!DOCTYPE html><html><body>counter<script>' +
  'const api = acquireVsCodeApi();' +
  'api.postMessage({ kind: "load", state: api.getState() === undefined ? "none" : api.getState() });' +
  'window.addEventListener("message", (e) => { if (e.data.set) { api.setState(e.data.set); api.postMessage({ kind: "saved", state: api.getState() }) } });' +
  '</script></body></html>'
function wire(panel) {
  panel.webview.html = html
  panel.webview.onDidReceiveMessage((m) => {
    note('MSG ' + JSON.stringify(m))
    if (m.kind === 'load' && m.state === 'none') panel.webview.postMessage({ set: { n: 7, name: 'seven <b>&</b> "q"' } })
  })
  panel.onDidDispose(() => note('DISPOSED'))
}
exports.activate = (context) => {
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('counter', {
    async deserializeWebviewPanel(panel, state) {
      note('RESTORED ' + JSON.stringify(state) + ' title=' + panel.title)
      panel.title = 'Counter (restored)'
      wire(panel)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('demo.counter', () => {
    const panel = vscode.window.createWebviewPanel('counter', 'Counter', vscode.ViewColumn.One, { enableScripts: true })
    note('CREATED')
    wire(panel)
  }))
}
`)
fs.writeFileSync(path.join(data, 'extensions', 'state.json'), JSON.stringify([{ id: 'local.demo-serial', dir: extDir, enabled: true, source: 'folder' }]))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let app = null
const stopApp = () => { try { cp.execSync('taskkill /F /T /PID ' + app.pid, { stdio: 'ignore' }) } catch { /* gone */ } try { cp.execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }) } catch { /* none */ } }
const events = () => { try { return fs.readFileSync(logFile, 'utf-8').split(/\r?\n/).filter(Boolean) } catch { return [] } }

async function launch() {
  app = cp.spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${data}`, proj], { cwd: path.join(__dirname, '..'), env, shell: true, stdio: 'ignore', windowsHide: true })
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
  ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m) })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 20000); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
  return { ev, send }
}
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(400) } }

;(async () => {
  // ---- first run: open the page, which saves its state
  let page = await launch()
  await page.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))`); await sleep(600)
  await page.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Demo: Open Counter'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(500)
  await page.ev(`[...document.querySelectorAll('.qp-item')].find((i) => i.textContent.includes('Demo: Open Counter'))?.click()`)
  check('the panel opens as a tab', await waitFor(() => page.ev(`document.querySelector('[data-webview-tab]')?.innerText.includes('Counter')`)))
  check('the page starts without state (getState() is undefined)', await waitFor(() => events().some((l) => l === 'MSG {"kind":"load","state":"none"}')), events().join(' | '))
  check('setState() in the page works and the page can read it back', await waitFor(() => events().some((l) => /^MSG \{"kind":"saved","state":\{"n":7/.test(l))), events().join(' | '))
  const savedFile = path.join(data, 'extensions', 'webview-panels.json')
  check('the editor keeps the panel and its state on disk', await waitFor(() => { try { const j = JSON.parse(fs.readFileSync(savedFile, 'utf-8')); return j.length === 1 && j[0].viewType === 'counter' && j[0].state && j[0].state.n === 7 } catch { return false } }, 8000), (() => { try { return fs.readFileSync(savedFile, 'utf-8') } catch { return 'no file' } })())
  stopApp(); await sleep(2500)
  fs.writeFileSync(logFile, '')

  // ---- second run: nothing is opened by hand; the serializer brings the panel back
  page = await launch()
  check('the extension\'s serializer is asked to restore the panel, with its state and title', await waitFor(() => events().some((l) => l === 'RESTORED {"n":7,"name":"seven <b>&</b> \\"q\\""} title=Counter'), 30000), events().join(' | '))
  check('the panel is a tab again, with the title the serializer gave it', await waitFor(() => page.ev(`document.querySelector('[data-webview-tab]')?.innerText.includes('Counter (restored)')`)))
  check('the page gets its saved state from getState()', await waitFor(() => events().some((l) => /^MSG \{"kind":"load","state":\{"n":7,"name":"seven <b>&<\/b> \\"q\\""\}\}$/.test(l))), events().join(' | '))
  check('only one panel came back', (await page.ev(`document.querySelectorAll('[data-webview-tab]').length`)) === 1)
  await page.ev(`document.querySelector('[data-webview-tab] .close').click()`); await sleep(1500)
  check('closing the tab tells the extension', await waitFor(() => events().includes('DISPOSED')))
  await sleep(800)
  stopApp(); await sleep(2500)
  fs.writeFileSync(logFile, '')

  // ---- third run: the panel was closed by the user, so it does not come back
  page = await launch()
  await sleep(4000)
  check('a panel the user closed is not restored', !events().some((l) => l.startsWith('RESTORED')) && !(await page.ev(`!!document.querySelector('[data-webview-tab]')`)), events().join(' | '))
  stopApp()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); stopApp(); process.exit(1) })
