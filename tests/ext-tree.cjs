// Extension tree views in the real app: a small VS Code style extension (written to a temporary folder and registered as an
// installed extension before the app starts) adds a tree to the Explorer and another in a view container of its own, in the
// activity bar. Checks that the nodes appear, expand, run their command when clicked, and refresh when the extension says
// the data changed. `npm run test:ext-tree` starts the app itself.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }

const port = 9777
const tmp = path.join(os.tmpdir(), 'ext-tree-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true })
const proj = path.join(tmp, 'proj'), data = path.join(tmp, 'data'), extDir = path.join(tmp, 'demo-tree')
for (const d of [proj, path.join(data, 'extensions'), extDir]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(proj, 'readme.txt'), 'hello\n')
fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({
  name: 'demo-tree', publisher: 'local', version: '1.0.0', main: './extension.js', activationEvents: ['*'], engines: { vscode: '^1.85.0' },
  contributes: {
    commands: [{ command: 'demo.refresh', title: 'Demo: Refresh' }],
    viewsContainers: { activitybar: [{ id: 'demo-bar', title: 'Demo Bar', icon: 'icon.svg' }] },
    views: { explorer: [{ id: 'demo.tree', name: 'Demo Tree' }], 'demo-bar': [{ id: 'demo.bar', name: 'Bar Items' }] }
  }
}))
fs.writeFileSync(path.join(extDir, 'extension.js'), `
const vscode = require('vscode')
exports.activate = (context) => {
  const emitter = new vscode.EventEmitter()
  let tick = 0
  const groups = { Fruits: ['apple', 'banana'], Vegetables: ['carrot'] }
  const provider = {
    onDidChangeTreeData: emitter.event,
    getChildren(el) {
      if (!el) return [...Object.keys(groups).map((g) => ({ kind: 'group', name: g })), { kind: 'tick' }]
      if (el.kind === 'group') return groups[el.name].map((n) => ({ kind: 'leaf', name: n }))
      return []
    },
    getTreeItem(el) {
      if (el.kind === 'group') { const i = new vscode.TreeItem(el.name, vscode.TreeItemCollapsibleState.Collapsed); i.description = groups[el.name].length + ' items'; i.iconPath = new vscode.ThemeIcon('folder'); return i }
      if (el.kind === 'tick') return new vscode.TreeItem('refreshed ' + tick + ' times')
      const i = new vscode.TreeItem(el.name)
      i.command = { command: 'demo.picked', title: 'Pick', arguments: [el.name] }
      return i
    }
  }
  context.subscriptions.push(vscode.window.createTreeView('demo.tree', { treeDataProvider: provider }))
  vscode.window.registerTreeDataProvider('demo.bar', { getChildren: () => ['one', 'two', 'three'], getTreeItem: (n) => new vscode.TreeItem(n) })
  context.subscriptions.push(vscode.commands.registerCommand('demo.picked', (name) => vscode.window.showInformationMessage('picked ' + name)))
  context.subscriptions.push(vscode.commands.registerCommand('demo.refresh', () => { tick++; groups.Fruits.push('cherry'); emitter.fire(undefined) }))
}
`)
fs.writeFileSync(path.join(data, 'extensions', 'state.json'), JSON.stringify([{ id: 'local.demo-tree', dir: extDir, enabled: true, source: 'folder' }]))

const env = { ...process.env }
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
  ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m); if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR', JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 400)) })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 20000); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
  const mouse = async (x, y) => { for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 }) }
  const realClick = async (sel) => { const { x, y } = JSON.parse(await ev(`(() => { const r = ${sel}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`)); await mouse(x, y) }
  const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(400) } }
  const rows = (view) => ev(`JSON.stringify([...document.querySelectorAll('[data-xt-view="${view}"]')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()))`).then((s) => JSON.parse(s || '[]'))
  const rowSel = (view, label) => `[...document.querySelectorAll('[data-xt-view="${view}"]')].find((r) => r.getAttribute('data-xt-label') === ${JSON.stringify(label)})`

  await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(1500)
  check('the extension\'s tree appears in the Explorer with its nodes', await waitFor(async () => { const r = await rows('demo.tree'); return r.some((t) => t.includes('Fruits')) && r.some((t) => t.includes('Vegetables')) }), JSON.stringify(await rows('demo.tree')))
  check('a node shows its description', (await rows('demo.tree')).some((t) => t.includes('2 items')), JSON.stringify(await rows('demo.tree')))
  await realClick(rowSel('demo.tree', 'Fruits')); await sleep(1200)
  check('clicking a node with children expands it', await waitFor(async () => { const r = await rows('demo.tree'); return r.some((t) => t.includes('apple')) && r.some((t) => t.includes('banana')) }), JSON.stringify(await rows('demo.tree')))
  await realClick(rowSel('demo.tree', 'apple')); await sleep(1500)
  check('clicking a leaf runs its command in the extension', await waitFor(() => ev(`document.body.innerText.includes('picked apple')`)))
  // refresh: run the extension's command from the palette
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))`); await sleep(500)
  await ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Demo: Refresh'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(500)
  await ev(`[...document.querySelectorAll('.qp-item')].find((i) => i.textContent.includes('Demo: Refresh'))?.click()`)
  check('when the extension fires its change event the tree reloads (a new child, a changed label)', await waitFor(async () => { const r = await rows('demo.tree'); return r.some((t) => t.includes('cherry')) && r.some((t) => t.includes('refreshed 1 times')) }), JSON.stringify(await rows('demo.tree')))
  check('and the expanded node stays expanded', (await rows('demo.tree')).some((t) => t.includes('apple')))
  // the view container of its own
  check('the extension\'s own container has a button in the activity bar', await waitFor(() => ev(`!!document.querySelector('[data-view="xc:demo-bar"]')`)))
  await realClick(`document.querySelector('[data-view="xc:demo-bar"]')`); await sleep(1200)
  check('opening it shows its title and its tree', ((await ev(`document.querySelector('.sidebar-title')?.innerText`)) ?? '').toLowerCase() === 'demo bar' && (await waitFor(async () => { const r = await rows('demo.bar'); return r.length === 3 && r.some((t) => t.includes('two')) }, 15000)), JSON.stringify(await rows('demo.bar')))
  check('the Explorer\'s tree is not shown there', !(await ev(`!!document.querySelector('[data-view="xc:demo-bar"][aria-selected="false"]') && document.querySelector('.explorer').style.display !== 'none'`)))
  // disabling the extension removes the views (through the main process API the Extensions panel uses)
  await ev(`window.api.extSetEnabled('local.demo-tree', false)`); await sleep(2000)
  check('disabling the extension removes its tree and its activity bar button', await waitFor(async () => !(await ev(`!!document.querySelector('[data-xt-view]')`)) && !(await ev(`!!document.querySelector('[data-view="xc:demo-bar"]')`))))
  stopApp()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); stopApp(); process.exit(1) })
