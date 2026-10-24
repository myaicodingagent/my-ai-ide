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
    commands: [{ command: 'demo.refresh', title: 'Demo: Refresh' }, { command: 'demo.rename', title: 'Rename' }, { command: 'demo.eat', title: 'Eat' }, { command: 'demo.openfolder', title: 'Open Folder' }, { command: 'demo.wave', title: 'Wave' }, { command: 'demo.hidden', title: 'Never Shown' }],
    menus: { 'view/item/context': [
      { command: 'demo.eat', when: 'view == demo.tree && viewItem =~ /^(fruit|veg)$/', group: '2_eat@2' },
      { command: 'demo.rename', when: 'view == demo.tree && viewItem == fruit', group: '1_modify@1' },
      { command: 'demo.openfolder', when: "view == demo.tree && viewItem == 'group'", group: 'navigation' },
      { command: 'demo.wave', when: 'view == demo.tree && viewItem == fruit', group: 'inline' },
      { command: 'demo.hidden', when: 'view == some.other.tree', group: '9_x' },
      { command: 'demo.hidden', when: 'view == demo.tree && !(viewItem == fruit || viewItem == veg || viewItem == group)', group: '9_x' }
    ] },
    viewsContainers: { activitybar: [{ id: 'demo-bar', title: 'Demo Bar', icon: 'icon.svg' }] },
    views: { explorer: [{ id: 'demo.tree', name: 'Demo Tree' }], 'demo-bar': [{ id: 'demo.bar', name: 'Bar Items' }] }
  }
}))
fs.writeFileSync(path.join(extDir, 'leaf.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#33aa33"/></svg>')
fs.writeFileSync(path.join(extDir, 'veg-light.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="12" height="12" fill="#ff8800"/></svg>')
fs.writeFileSync(path.join(extDir, 'veg-dark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="12" height="12" fill="#00ccff"/></svg>')
fs.writeFileSync(path.join(extDir, 'extension.js'), `
const vscode = require('vscode')
const path = require('path')
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
      if (el.kind === 'group') { const i = new vscode.TreeItem(el.name, vscode.TreeItemCollapsibleState.Collapsed); i.description = groups[el.name].length + ' items'; i.iconPath = new vscode.ThemeIcon('folder'); i.contextValue = 'group'; return i }
      if (el.kind === 'tick') return new vscode.TreeItem('refreshed ' + tick + ' times')
      const i = new vscode.TreeItem(el.name)
      i.contextValue = el.name === 'carrot' ? 'veg' : 'fruit'
      i.iconPath = el.name === 'carrot' ? { light: vscode.Uri.file(path.join(__dirname, 'veg-light.svg')), dark: vscode.Uri.file(path.join(__dirname, 'veg-dark.svg')) } : vscode.Uri.file(path.join(__dirname, 'leaf.svg'))
      i.command = { command: 'demo.picked', title: 'Pick', arguments: [el.name] }
      return i
    }
  }
  context.subscriptions.push(vscode.window.createTreeView('demo.tree', { treeDataProvider: provider }))
  vscode.window.registerTreeDataProvider('demo.bar', { getChildren: () => ['one', 'two', 'three'], getTreeItem: (n) => new vscode.TreeItem(n) })
  for (const [cmd, word] of [['demo.rename', 'renamed'], ['demo.eat', 'ate'], ['demo.openfolder', 'opened'], ['demo.wave', 'waved']]) context.subscriptions.push(vscode.commands.registerCommand(cmd, (el, all) => vscode.window.showInformationMessage(word + ' ' + el.name + ' of ' + all.length)))
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
  // ---- icons from files
  const iconOf = (label) => ev(`(() => { const r = ${rowSel('demo.tree', label)}; const i = r?.querySelector('.xt-icon'); return JSON.stringify({ tag: i?.tagName, src: i?.getAttribute('src')?.slice(0, 30), cls: i?.className }) })()`).then((x) => JSON.parse(x || '{}'))
  const apple = await iconOf('apple')
  check('an icon given as a file is shown as an image', apple.tag === 'IMG' && /^data:image\/svg\+xml;base64,/.test(apple.src || ''), JSON.stringify(apple))
  await realClick(rowSel('demo.tree', 'Vegetables')); await sleep(1000)
  const decode = (label) => ev(`(() => { const i = ${rowSel('demo.tree', label)}?.querySelector('img.xt-icon'); return i ? atob(i.getAttribute('src').split(',')[1]) : '' })()`)
  check('{ light, dark } icons: the dark theme gets the dark file', /00ccff/.test(await decode('carrot')) && !/ff8800/.test(await decode('carrot')), await decode('carrot'))
  const folder = await iconOf('Fruits')
  check('a ThemeIcon is a codicon, drawn by the icon font', /codicon-folder/.test(folder.cls || '') && (await ev(`getComputedStyle(${rowSel('demo.tree', 'Fruits')}.querySelector('.codicon'), '::before').content`)).length > 2, JSON.stringify(folder))
  // ---- context menus (contributes.menus["view/item/context"])
  const rightClick = async (sel) => { const { x, y } = JSON.parse(await ev(`(() => { const r = ${sel}.getBoundingClientRect(); return JSON.stringify({ x: r.left + 40, y: r.top + r.height / 2 }) })()`)); for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button: t === 'mouseMoved' ? 'none' : 'right', buttons: t === 'mousePressed' ? 2 : 0, clickCount: 1 }) }
  const menuLabels = () => ev(`JSON.stringify([...document.querySelectorAll('[data-context-menu] [role="menuitem"]')].map((e) => e.textContent))`).then((x) => JSON.parse(x || '[]'))
  const esc = async () => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300) }
  await rightClick(rowSel('demo.tree', 'apple')); await sleep(600)
  let labels = await menuLabels()
  check('right-clicking a node shows the entries whose when clause matches, in group order', JSON.stringify(labels) === JSON.stringify(['Rename', 'Eat']), JSON.stringify(labels))
  check('entries of other views, and ones that do not match, are not shown', !labels.includes('Never Shown') && !labels.includes('Open Folder'))
  check('a divider is drawn between groups', (await ev(`document.querySelectorAll('[data-context-menu] .ctx-sep').length`)) === 1)
  await ev(`[...document.querySelectorAll('[data-context-menu] [role="menuitem"]')].find((e) => e.textContent === 'Rename').click()`)
  check('choosing an entry runs its command with the node the extension gave', await waitFor(() => ev(`document.body.innerText.includes('renamed apple of 1')`)))
  await rightClick(rowSel('demo.tree', 'carrot')); await sleep(600)
  labels = await menuLabels()
  check('a node with another context value gets another menu', JSON.stringify(labels) === JSON.stringify(['Eat']), JSON.stringify(labels))
  await esc()
  check('Escape closes the menu', (await menuLabels()).length === 0)
  await rightClick(rowSel('demo.tree', 'Fruits')); await sleep(600)
  labels = await menuLabels()
  check('a group node has its own entry (the clause uses a quoted value)', JSON.stringify(labels) === JSON.stringify(['Open Folder']), JSON.stringify(labels))
  await esc()
  // keyboard: the Menu key on a focused row
  await ev(`${rowSel('demo.tree', 'banana')}.focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ContextMenu', code: 'ContextMenu', windowsVirtualKeyCode: 93 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ContextMenu', code: 'ContextMenu', windowsVirtualKeyCode: 93 }); await sleep(600)
  check('the Menu key opens the menu of the focused node', JSON.stringify(await menuLabels()) === JSON.stringify(['Rename', 'Eat']), JSON.stringify(await menuLabels()))
  await esc()
  // inline entries are buttons on the row
  check('inline entries are buttons on the row', await ev(`!!${rowSel('demo.tree', 'apple')}.querySelector('[data-xt-inline="demo.wave"]')`) && !(await ev(`!!${rowSel('demo.tree', 'carrot')}.querySelector('[data-xt-inline]')`)))
  await ev(`${rowSel('demo.tree', 'apple')}.focus()`); await sleep(300)
  await realClick(`${rowSel('demo.tree', 'apple')}.querySelector('[data-xt-inline="demo.wave"]')`)
  check('clicking an inline button runs its command for that node', await waitFor(() => ev(`document.body.innerText.includes('waved apple of 1')`)))
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
