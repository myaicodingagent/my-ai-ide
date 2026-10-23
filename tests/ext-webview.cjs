// Extension web pages (webviews) in the real app: a small extension opens a page with createWebviewPanel; the page runs a
// script under a nonce-only Content-Security-Policy, loads another script through asWebviewUri, talks to the extension and
// back, the extension renames the tab, and closing the tab tells the extension. A request for a file outside the allowed
// folders must be refused. `npm run test:ext-webview` starts the app itself.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }

const port = 9888
const tmp = path.join(os.tmpdir(), 'ext-webview-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true })
const proj = path.join(tmp, 'proj'), data = path.join(tmp, 'data'), extDir = path.join(tmp, 'demo-page')
for (const d of [proj, path.join(data, 'extensions'), path.join(extDir, 'media')]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(proj, 'readme.txt'), 'hello\n')
const secret = path.join(tmp, 'secret.txt'); fs.writeFileSync(secret, 'do not serve me')
fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({
  name: 'demo-page', publisher: 'local', version: '1.0.0', main: './extension.js', activationEvents: ['*'], engines: { vscode: '^1.85.0' },
  contributes: { commands: [{ command: 'demo.page', title: 'Demo: Open Page' }], views: { explorer: [{ id: 'demo.sidebar', name: 'Demo Sidebar', type: 'webview' }] } }
}))
fs.writeFileSync(path.join(extDir, 'media', 'main.js'), `;(() => {
  const api = acquireVsCodeApi()
  api.postMessage({ resource: 'loaded' })
  fetch(document.body.dataset.secret).then((r) => api.postMessage({ secretStatus: r.status }), (e) => api.postMessage({ secretStatus: 'blocked: ' + e.message }))
})()
`)
fs.writeFileSync(path.join(extDir, 'extension.js'), `
const vscode = require('vscode')
const path = require('path')
exports.activate = (context) => {
  const out = vscode.window.createOutputChannel('demo-page')
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('demo.sidebar', {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true }
      view.webview.onDidReceiveMessage((m) => out.appendLine('VIEWMSG ' + JSON.stringify(m)))
      view.webview.html = '<body style="margin:0">sidebar page<script>acquireVsCodeApi().postMessage({ side: true })</script></body>'
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('demo.page', () => {
    const panel = vscode.window.createWebviewPanel('demo', 'Demo Page', vscode.ViewColumn.One, { enableScripts: true })
    const script = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'main.js')))
    const secret = panel.webview.asWebviewUri(vscode.Uri.file(${JSON.stringify(secret)}))
    const nonce = 'n0nce123'
    panel.webview.html = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; script-src \\'nonce-' + nonce + '\\' ' + panel.webview.cspSource + '; connect-src ' + panel.webview.cspSource + ';"></head><body data-secret="' + secret + '"><h1>Hello page</h1><script nonce="' + nonce + '">const api = acquireVsCodeApi(); api.postMessage({ hello: "inline" }); window.addEventListener("message", (e) => api.postMessage({ echo: e.data }))</script><script src="' + script + '"></script></body></html>'
    panel.webview.onDidReceiveMessage((m) => { out.appendLine('MSG ' + JSON.stringify(m)); if (m.hello) panel.webview.postMessage({ ping: 42 }) })
    panel.onDidDispose(() => out.appendLine('DISPOSED'))
    setTimeout(() => { panel.title = 'Renamed Page' }, 1500)
  }))
}
`)
fs.writeFileSync(path.join(data, 'extensions', 'state.json'), JSON.stringify([{ id: 'local.demo-page', dir: extDir, enabled: true, source: 'folder' }]))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = cp.spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${data}`, proj], { cwd: path.join(__dirname, '..'), env, shell: true, stdio: process.env.WV_LOG ? ['ignore', fs.openSync(process.env.WV_LOG, 'w'), fs.openSync(process.env.WV_LOG, 'a')] : 'ignore', windowsHide: true })
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
  ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m); if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR', JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 400)) })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 20000); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
  const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(400) } }
  const log = async () => (await ev(`window.api.extLog()`)).join('\n')

  await sleep(2000)
  check('a web page in a side bar view (registerWebviewViewProvider) is shown in the Explorer and runs', await waitFor(() => ev(`!!document.querySelector('[data-ext-webview-view="demo.sidebar"] iframe')`)) && await waitFor(async () => (await log()).includes('VIEWMSG {"side":true}')), (await log()).slice(-200))
  check('and it is not made into a tab', !(await ev(`!!document.querySelector('[data-webview-tab]')`)))
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))`); await sleep(500)
  await ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Demo: Open Page'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(500)
  await ev(`[...document.querySelectorAll('.qp-item')].find((i) => i.textContent.includes('Demo: Open Page'))?.click()`)

  check('the page opens as a tab with the title the extension gave it', await waitFor(() => ev(`document.querySelector('[data-webview-tab]')?.innerText.includes('Demo Page')`)))
  check('and it shows in a frame', await ev(`!!document.querySelector('[data-webview-frame]') && document.querySelector('[data-webview-frame]').getAttribute('sandbox') === 'allow-scripts allow-forms'`))
  check('the page\'s inline script (allowed only by its nonce) runs and can use acquireVsCodeApi', await waitFor(async () => (await log()).includes('MSG {"hello":"inline"}')), (await log()).slice(-300))
  check('a script loaded through asWebviewUri runs too', await waitFor(async () => (await log()).includes('MSG {"resource":"loaded"}')), (await log()).slice(-300))
  check('a message from the extension reaches the page, which answers it', await waitFor(async () => (await log()).includes('MSG {"echo":{"ping":42}}')), (await log()).slice(-300))
  check('a file outside the extension and project folders is refused (403)', await waitFor(async () => (await log()).includes('MSG {"secretStatus":403}')), (await log()).slice(-300))
  check('the extension can rename the tab', await waitFor(() => ev(`document.querySelector('[data-webview-tab]')?.innerText.includes('Renamed Page')`)))
  check('the page is shown over the editor area while its tab is active', await ev(`document.querySelector('.webview-host.on') !== null && getComputedStyle(document.querySelector('[data-webview-frame]')).display !== 'none'`))
  await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(300)
  await ev(`[...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').endsWith('readme.txt'))?.click()`); await sleep(1500)
  check('opening a file brings the editor back in front of the page', await ev(`!document.querySelector('.webview-host.on')`))
  await ev(`document.querySelector('[data-webview-tab]').click()`); await sleep(500)
  check('clicking the page tab brings it back (it kept running)', await ev(`!!document.querySelector('.webview-host.on')`))
  await ev(`document.querySelector('[data-webview-tab] .close').click()`); await sleep(1500)
  check('closing the tab removes it', await ev(`!document.querySelector('[data-webview-tab]') && !document.querySelector('.webview-host [data-webview-frame]')`))
  check('and tells the extension the page was disposed', (await log()).includes('DISPOSED'), (await log()).slice(-200))

  stopApp()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); stopApp(); process.exit(1) })
