// Extensions in a folder opened over SSH, in the real app: the extension runs on this PC, but the project folder is on another
// computer (the test SSH server in this process). `workspace.workspaceFolders`, `workspace.fs`, `findFiles` and `openTextDocument`
// reach the other computer, and the menus hand the extension's commands the remote file. `npm run test:ext-ssh` starts the app itself.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }

const port = 9778
const tmp = path.join(os.tmpdir(), 'ext-ssh-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true })
const proj = path.join(tmp, 'proj'), data = path.join(tmp, 'data'), extDir = path.join(tmp, 'demo-remote'), sshRoot = path.join(tmp, 'server')
const remoteProj = path.join(sshRoot, 'home', 'tester', 'proj')
for (const d of [proj, path.join(data, 'extensions'), extDir, path.join(remoteProj, 'sub')]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(proj, 'local.txt'), 'local\n')
fs.writeFileSync(path.join(remoteProj, 'notes.txt'), 'first line of the notes\nsecond\n')
fs.writeFileSync(path.join(remoteProj, 'sub', 'deep.txt'), 'deep\n')
fs.writeFileSync(path.join(remoteProj, 'code.js'), 'let a = 1\n')
fs.mkdirSync(path.join(remoteProj, 'node_modules', 'dep'), { recursive: true }); fs.writeFileSync(path.join(remoteProj, 'node_modules', 'dep', 'skip.txt'), 'x\n')
fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({
  name: 'demo-remote', publisher: 'local', version: '1.0.0', main: './extension.js', activationEvents: ['*'], engines: { vscode: '^1.85.0' },
  contributes: {
    commands: [
      { command: 'remote.read', title: 'Remote Read File' }, { command: 'remote.workspace', title: 'Remote Workspace Report' }, { command: 'remote.write', title: 'Remote Write File' },
      { command: 'remote.titlebtn', title: 'Remote Title Button' }
    ],
    menus: { 'explorer/context': [{ command: 'remote.read', when: 'resourceExtname == .txt' }], 'editor/title': [{ command: 'remote.titlebtn', when: 'resourceExtname == .txt', group: 'navigation' }] }
  }
}))
fs.writeFileSync(path.join(extDir, 'extension.js'), `
const vscode = require('vscode')
const path = require('path')
const say = (t) => vscode.window.showInformationMessage(t)
exports.activate = (context) => {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...a) => { try { await fn(...a) } catch (e) { say(id + ' failed: ' + e.message) } }))
  reg('remote.read', async (uri) => {
    const bytes = await vscode.workspace.fs.readFile(uri)
    const doc = await vscode.workspace.openTextDocument(uri)
    say('read ' + path.basename(uri.fsPath) + ' ' + bytes.length + ' bytes, first line: ' + doc.lineAt(0).text + ', lines ' + doc.lineCount)
  })
  reg('remote.titlebtn', async (uri) => say('title button for ' + path.basename(uri.fsPath)))
  reg('remote.workspace', async () => {
    const folder = vscode.workspace.workspaceFolders[0]
    const entries = (await vscode.workspace.fs.readDirectory(folder.uri)).map(([n, t]) => n + ':' + t).sort().join(',')
    const found = (await vscode.workspace.findFiles('**/*.txt')).map((u) => vscode.workspace.asRelativePath(u)).sort().join(',')
    const st = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'notes.txt'))
    say('folder ' + folder.name + ' | ' + entries + ' | found ' + found + ' | size ' + st.size + ' type ' + st.type)
  })
  reg('remote.write', async () => {
    const folder = vscode.workspace.workspaceFolders[0]
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, 'made', 'inner'))
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, 'made', 'inner', 'out.bin'), new Uint8Array([0, 1, 2, 255, 254]))
    await vscode.workspace.fs.rename(vscode.Uri.joinPath(folder.uri, 'code.js'), vscode.Uri.joinPath(folder.uri, 'renamed.js'))
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, 'sub', 'deep.txt'))
    say('written')
  })
}
`)
fs.writeFileSync(path.join(data, 'extensions', 'state.json'), JSON.stringify([{ id: 'local.demo-remote', dir: extDir, enabled: true, source: 'folder' }]))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = cp.spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${data}`, proj], { cwd: path.join(__dirname, '..'), env, shell: true, stdio: 'ignore', windowsHide: true })
const stopApp = () => { try { cp.execSync('taskkill /F /T /PID ' + app.pid, { stdio: 'ignore' }) } catch { /* gone */ } try { cp.execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }) } catch { /* none */ } }
const sshServer = require('./sshserver.cjs')(sshRoot)

;(async () => {
  await new Promise((r) => sshServer.listen(0, '127.0.0.1', r))
  const sshPort = sshServer.address().port
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
  ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m); if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR', JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 300)) })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 20000); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
  const mouse = async (x, y, button = 'left') => { for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button, clickCount: 1 }) }
  const realClick = async (sel) => { const { x, y } = JSON.parse(await ev(`(() => { const r = ${sel}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`)); await mouse(x, y) }
  const rightClick = async (sel) => { const { x, y } = JSON.parse(await ev(`(() => { const r = ${sel}.getBoundingClientRect(); return JSON.stringify({ x: r.left + 40, y: r.top + r.height / 2 }) })()`)); await mouse(x, y, 'right') }
  const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(400) } }
  const typeInput = (sel, text) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  const ctrlShiftP = () => ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))`)
  const palette = async (text) => {
    await ctrlShiftP(); await sleep(400)
    await ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await sleep(500)
  }
  const runCommand = async (title) => {
    await palette(title)
    await waitFor(() => ev(`[...document.querySelectorAll('.qp-item')].some((i) => i.textContent.includes(${JSON.stringify(title)}))`))
    await ev(`[...document.querySelectorAll('.qp-item')].find((i) => i.textContent.includes(${JSON.stringify(title)})).click()`)
  }
  const menuLabels = () => ev(`JSON.stringify([...document.querySelectorAll('[data-context-menu] [role="menuitem"]')].map((e) => e.textContent))`).then((x) => JSON.parse(x || '[]'))
  const treeRow = (name) => `[...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').endsWith(${JSON.stringify(name)}))`
  const esc = async () => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300) }
  const said = (text) => waitFor(() => ev(`document.body.innerText.includes(${JSON.stringify(text)})`), 20000)

  // ---- open the folder on the other computer
  await palette('folder over ssh')
  await waitFor(() => ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Open Folder over SSH'))`))
  await ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Open Folder over SSH')).click()`)
  await waitFor(() => ev(`!!document.querySelector('[data-input-dialog]')`))
  await typeInput('[data-input-dialog]', 'tester@127.0.0.1:' + sshPort)
  await waitFor(() => ev(`/SHA256:/.test(document.querySelector('[data-choice-dialog]')?.textContent || '')`))
  await ev(`document.querySelector('[data-choice="Trust and connect"]').click()`)
  await waitFor(() => ev(`document.querySelector('[data-input-dialog]')?.type === 'password'`))
  await typeInput('[data-input-dialog]', 'secret')
  await waitFor(() => ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.trim().startsWith('proj'))`))
  await ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.trim().startsWith('proj')).click()`)
  await waitFor(() => ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Open this folder') && i.textContent.includes('/home/tester/proj'))`))
  await ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Open this folder')).click()`)
  check('the folder on the other computer is the project', await waitFor(() => ev(`!!document.querySelector('[data-sb="ssh"]') && !!document.querySelector('.tree-row[data-tree-path$="notes.txt"]')`)))
  await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(1000)

  // ---- the extension's view of the workspace
  await runCommand('Remote Workspace Report')
  const rep = await waitFor(() => ev(`(document.body.innerText.match(/folder proj \\|[^\\n]*/) || [''])[0]`), 30000)
  check('workspaceFolders names the folder on the other computer and readDirectory lists it with file types', /folder proj \| [^|]*code\.js:1[^|]*node_modules:2[^|]*notes\.txt:1[^|]*sub:2/.test(rep), rep)
  check('findFiles searches it (skipping node_modules) and asRelativePath gives paths inside the folder', /found notes\.txt,sub\/deep\.txt \|/.test(rep), rep)
  check('stat gives size and type', /size 31 type 1/.test(rep), rep)

  // ---- menus hand the command the remote file
  await rightClick(treeRow('notes.txt')); await sleep(600)
  const labels = await menuLabels()
  check('the explorer menu of a remote .txt file has the extension\'s entry', labels.includes('Remote Read File'), JSON.stringify(labels))
  await ev(`[...document.querySelectorAll('[data-context-menu] [role="menuitem"]')].find((e) => e.textContent === 'Remote Read File').click()`)
  check('the command reads the file through workspace.fs and openTextDocument', await said('read notes.txt 31 bytes, first line: first line of the notes, lines 3'), await ev(`document.body.innerText.slice(-300)`))
  await ev(`${treeRow('notes.txt')}.click()`)
  check('with the remote file open, the tab bar has the extension\'s button', await waitFor(() => ev(`!!document.querySelector('[data-ext-editor-title="remote.titlebtn"]')`)))
  await realClick(`document.querySelector('[data-ext-editor-title="remote.titlebtn"]')`)
  check('and it runs the command with the remote file', await said('title button for notes.txt'))

  // ---- writing
  await runCommand('Remote Write File')
  check('the extension can create folders, write bytes, rename and delete on the other computer', await said('written') && fs.existsSync(path.join(remoteProj, 'renamed.js')) && !fs.existsSync(path.join(remoteProj, 'code.js')) && !fs.existsSync(path.join(remoteProj, 'sub', 'deep.txt')) && fs.readFileSync(path.join(remoteProj, 'made', 'inner', 'out.bin')).equals(Buffer.from([0, 1, 2, 255, 254])),
    JSON.stringify({ renamed: fs.existsSync(path.join(remoteProj, 'renamed.js')), made: fs.existsSync(path.join(remoteProj, 'made', 'inner', 'out.bin')) }))
  stopApp()
  sshServer.close()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); stopApp(); process.exit(1) })
