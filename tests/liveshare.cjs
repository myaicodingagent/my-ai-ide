// Live Share between two REAL instances of the app (two processes with their own user-data folders): one hosts a folder, the other
// joins with the session code, browses the folder, and both edit the same file at the same time. `npm run test:liveshare` starts both
// (the packaged app: MY_AI_IDE_EXE, or release\win-unpacked) and drives them through the debugging port.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }
const EXE = process.env.MY_AI_IDE_EXE || path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
if (!fs.existsSync(EXE)) { console.log('SKIP  no packaged app at ' + EXE); process.exit(0) }

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'liveshare-')))
const proj = path.join(tmp, 'shared proj')
fs.mkdirSync(path.join(proj, 'sub'), { recursive: true })
fs.mkdirSync(path.join(proj, 'node_modules', 'dep'), { recursive: true })
fs.mkdirSync(path.join(proj, '.git'), { recursive: true })
fs.writeFileSync(path.join(proj, 'a.txt'), 'alpha\nbeta\ngamma\n')
fs.writeFileSync(path.join(proj, 'sub', 'b.js'), 'const b = 1\n')
fs.writeFileSync(path.join(proj, 'node_modules', 'dep', 'x.js'), 'x\n')
fs.writeFileSync(path.join(proj, '.git', 'config'), '[core]\n')
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside the shared folder\n')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const apps = []
function launch(name, port, args) {
  const data = path.join(tmp, 'data-' + name)
  const p = cp.spawn(EXE, [`--remote-debugging-port=${port}`, `--user-data-dir=${data}`, ...args], { env, stdio: 'ignore', windowsHide: true })
  apps.push(p)
  return p
}
const stopAll = () => { for (const p of apps) { try { cp.execSync('taskkill /F /T /PID ' + p.pid, { stdio: 'ignore' }) } catch { /* gone */ } } }

async function connect(port) {
  let list
  for (let i = 0; i < 60; i++) { list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null); if (list && list.some((t) => t.type === 'page')) break; await sleep(1000) }
  if (!list) throw new Error('the app on port ' + port + ' did not start')
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  let id = 0; const pend = {}
  const errors = []
  ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text) })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 30000); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
  const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(250) } }
  const mouse = async (x, y) => { for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 }) }
  const key = async (k, code, vk, mods = 0) => { for (const t of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }) }
  const typeInto = (sel, text) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  const palette = async (text, item) => {
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))`); await sleep(400)
    await ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(400)
    await waitFor(() => ev(`[...document.querySelectorAll('.qp-item')].some((i) => i.textContent.includes(${JSON.stringify(item)}))`))
    await ev(`[...document.querySelectorAll('.qp-item')].find((i) => i.textContent.includes(${JSON.stringify(item)})).click()`)
  }
  const choose = (label) => ev(`document.querySelector('[data-choice=${JSON.stringify(label)}]').click()`)
  const openFromTree = async (name) => { await waitFor(() => ev(`!!document.querySelector('.tree-row[data-tree-path$="${name}"]')`)); await ev(`document.querySelector('.tree-row[data-tree-path$="${name}"]').click()`); await waitFor(() => ev(`document.querySelector('.tab.active .tab-name')?.textContent === ${JSON.stringify(name.split(/[\\/]/).pop())}`)) }
  const text = () => ev(`(() => { const ed = [...document.querySelectorAll('.group-main .monaco-editor .view-lines')][0]; return ed ? ed.innerText.replace(/\\u00a0/g, ' ') : '' })()`)
  const focusEditor = async () => { const r = JSON.parse(await ev(`JSON.stringify(document.querySelector('.group-main .monaco-editor .view-lines').getBoundingClientRect())`)); await mouse(r.left + 300, r.top + 8) }
  return { ev, send, waitFor, mouse, key, typeInto, palette, choose, openFromTree, text, focusEditor, errors, ws }
}

;(async () => {
  try {
    launch('host', 9801, [proj])
    launch('guest', 9802, [])
    const host = await connect(9801)
    const guest = await connect(9802)
    await sleep(4000)
    await host.waitFor(() => host.ev(`!!document.querySelector('.tree-row[data-tree-path$="a.txt"]')`), 30000)

    // ---- the host opens a session from the palette
    await host.palette('live share', 'Live Share: Start a Session')
    check('the host is asked who can join', await host.waitFor(() => host.ev(`/Who can join/.test(document.querySelector('[data-choice-dialog]')?.textContent || '')`)))
    await host.choose('This PC only')
    check('and what guests may do', await host.waitFor(() => host.ev(`/What can guests do/.test(document.querySelector('[data-choice-dialog]')?.textContent || '')`)))
    await host.choose('Edit files')
    check('the status bar shows the session, with one person in it', await host.waitFor(() => host.ev(`/hosting · 1/.test(document.querySelector('[data-sb="liveshare"]')?.textContent || '')`)))
    const status = JSON.parse(await host.ev(`window.api.lsStatus().then((s) => JSON.stringify(s))`))
    const code = status.join
    check('there is a session code with an address, a port and a long random token', /^127\.0\.0\.1:\d+#[0-9a-f]{32}$/.test(code), code)

    // ---- a wrong code, and a malformed one
    const bad = JSON.parse(await guest.ev(`window.api.lsJoin(${JSON.stringify(code.replace(/#.*/, '#' + '0'.repeat(32)))}, 'Mallory').then((r) => JSON.stringify(r))`))
    check('a wrong token is refused', bad.ok === false && /code is not right/.test(bad.error), JSON.stringify(bad))
    const junk = JSON.parse(await guest.ev(`window.api.lsJoin('hello', 'x').then((r) => JSON.stringify(r))`))
    check('so is something that is not a code', junk.ok === false && /not a Live Share code/.test(junk.error), JSON.stringify(junk))

    // ---- the guest joins from the palette
    await guest.palette('live share', 'Live Share: Join a Session')
    await guest.waitFor(() => guest.ev(`!!document.querySelector('[data-input-dialog]')`))
    await guest.typeInto('[data-input-dialog]', code)
    check('the guest sees the host\'s folder in the explorer', await guest.waitFor(() => guest.ev(`!!document.querySelector('.tree-row[data-tree-path$="a.txt"]') && !!document.querySelector('.tree-row[data-tree-path$="sub"]')`), 30000))
    check('without node_modules and .git', await guest.ev(`!document.querySelector('.tree-row[data-tree-path$="node_modules"]') && !document.querySelector('.tree-row[data-tree-path$=".git"]')`))
    check('both sides show two people', await guest.waitFor(() => guest.ev(`/joined · 2/.test(document.querySelector('[data-sb="liveshare"]')?.textContent || '')`)) && await host.waitFor(() => host.ev(`/hosting · 2/.test(document.querySelector('[data-sb="liveshare"]')?.textContent || '')`)))

    // ---- what a guest can reach
    const sid = JSON.parse(await guest.ev(`window.api.lsStatus().then((s) => JSON.stringify(s))`)).sid
    const unc = (rel) => String.fromCharCode(92, 92) + 'liveshare.' + sid + (rel ? String.fromCharCode(92) + rel : '')
    const outside = await guest.ev(`window.api.readFile(${JSON.stringify(unc('..' + String.fromCharCode(92) + 'secret.txt'))}).then(() => 'READ', (e) => String(e.message))`)
    check('a guest cannot read a file outside the shared folder', /outside the shared folder/.test(outside), outside)
    const gitWrite = await guest.ev(`window.api.writeFile(${JSON.stringify(unc('.git' + String.fromCharCode(92) + 'config'))}, 'x').then(() => 'WROTE', (e) => String(e.message))`)
    check('or change git data', /git data/.test(gitWrite) && fs.readFileSync(path.join(proj, '.git', 'config'), 'utf-8') === '[core]\n', gitWrite)

    // ---- both open a.txt and type at the same time
    await host.openFromTree('a.txt')
    await guest.openFromTree('a.txt')
    check('the guest sees the host\'s text', await guest.waitFor(async () => /alpha\s+beta\s+gamma/.test(await guest.text())))
    await host.focusEditor(); await guest.focusEditor()
    await host.key('Home', 'Home', 36, 2); await guest.key('End', 'End', 35, 2) // Ctrl+Home on the host, Ctrl+End on the guest
    await Promise.all([host.send('Input.insertText', { text: 'HOST-' }), guest.send('Input.insertText', { text: '-GUEST' })])
    const merged = async (side) => (await side.text()).replace(/\s+/g, ' ').trim()
    check('typing at the same time on both sides ends with the same text on both', await host.waitFor(async () => { const a = await merged(host), b = await merged(guest); return a === b && /HOST-alpha/.test(a) && /gamma\s?-GUEST/.test(a) }, 15000), (await merged(host)) + ' | ' + (await merged(guest)))
    // many small edits from both sides in turn
    for (let i = 0; i < 6; i++) {
      await Promise.all([host.send('Input.insertText', { text: 'h' + i }), guest.send('Input.insertText', { text: 'g' + i })])
      await sleep(60)
    }
    check('and stays the same after many edits from both', await host.waitFor(async () => { const a = await merged(host), b = await merged(guest); return a === b && /h0/.test(a) && /g5/.test(a) }, 15000), (await merged(host)) + ' | ' + (await merged(guest)))
    check('the host\'s editor is marked as modified by the guest\'s edits', await host.ev(`document.querySelectorAll('.tab.active .tab-dot').length === 1`))

    // ---- cursors
    check('each side sees the other\'s cursor with a name', await host.waitFor(() => host.ev(`!!document.querySelector('.group-main .monaco-editor [class*="ls-"][class*="-caret"]')`), 8000) && await guest.waitFor(() => guest.ev(`!!document.querySelector('.group-main .monaco-editor [class*="ls-"][class*="-caret"]')`), 8000))

    // ---- saving
    await guest.key('s', 'KeyS', 83, 2)
    const onDisk = () => fs.readFileSync(path.join(proj, 'a.txt'), 'utf-8').replace(/\s+/g, ' ').trim()
    check('the guest saves the file on the host\'s disk, with the shared text', await host.waitFor(async () => { return onDisk() === (await merged(host)) }, 10000), onDisk())

    // ---- the guest opens a file that is not open on the host
    await guest.ev(`document.querySelector('.tree-row[data-tree-path$="sub"]').click()`)
    await guest.openFromTree('b.js')
    check('a file the host has not opened is shared too', await guest.waitFor(async () => /const b = 1/.test(await guest.text())))
    await guest.focusEditor()
    await guest.send('Input.insertText', { text: '// guest line\n' })
    await guest.key('s', 'KeyS', 83, 2)
    check('and saving it writes it on the host', await host.waitFor(() => /guest line/.test(fs.readFileSync(path.join(proj, 'sub', 'b.js'), 'utf-8')), 10000), fs.readFileSync(path.join(proj, 'sub', 'b.js'), 'utf-8'))
    await host.ev(`document.querySelector('.tree-row[data-tree-path$="sub"]').click()`)
    await host.openFromTree('b.js')
    check('when the host opens it afterwards it has the guest\'s edit', await host.waitFor(async () => /guest line/.test(await host.text()), 8000))

    // ---- search in the guest's explorer goes to the host
    const found = await guest.ev(`window.api.searchText(${JSON.stringify(unc(''))}, 'gamma', { caseSensitive: false, regex: false }).then((r) => JSON.stringify(r.matches.map((m) => m.rel)))`)
    check('search from the guest looks in the host\'s folder', /a\.txt/.test(found) && !/node_modules/.test(found), found)

    // ---- the host ends the session
    await host.palette('live share', 'Live Share: End the Session')
    check('the host\'s status item goes away', await host.waitFor(() => host.ev(`!document.querySelector('[data-sb="liveshare"]')`), 8000))
    check('the guest is told, loses the folder and its status item', await guest.waitFor(() => guest.ev(`!document.querySelector('[data-sb="liveshare"]') && !document.querySelector('.tree-row[data-tree-path$="a.txt"]')`), 10000))
    check('the host keeps its own files and tabs', await host.ev(`!!document.querySelector('.tree-row[data-tree-path$="a.txt"]')`))
    const afterEnd = JSON.parse(await guest.ev(`window.api.lsJoin(${JSON.stringify(code)}, 'late').then((r) => JSON.stringify(r))`))
    check('the old code does not work any more', afterEnd.ok === false, JSON.stringify(afterEnd))

    // ---- a read-only session
    const ro = JSON.parse(await host.ev(`window.api.lsHost({ root: ${JSON.stringify(proj)}, readOnly: true, network: false }).then((r) => JSON.stringify(r))`))
    await host.ev(`void 0`)
    const j = JSON.parse(await guest.ev(`window.api.lsJoin(${JSON.stringify(ro.join)}, 'Reader').then((r) => JSON.stringify(r))`))
    check('a read-only session can be joined', ro.ok === true && j.ok === true && j.readOnly === true, JSON.stringify(j))
    const roWrite = await guest.ev(`window.api.writeFile(${JSON.stringify(String.fromCharCode(92, 92) + 'liveshare.' + j.sid + String.fromCharCode(92) + 'a.txt')}, 'overwritten').then(() => 'WROTE', (e) => String(e.message))`)
    check('a read-only guest cannot save a file', /read-only/.test(roWrite) && !/overwritten/.test(fs.readFileSync(path.join(proj, 'a.txt'), 'utf-8')), roWrite)
    await guest.ev(`window.api.lsStop()`)

    check('no uncaught errors in either window', host.errors.length === 0 && guest.errors.length === 0, [...host.errors, ...guest.errors].join(' | '))
  } catch (e) {
    check('test run completed without exception', false, e.message)
  } finally {
    stopAll()
    await sleep(800)
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})()
