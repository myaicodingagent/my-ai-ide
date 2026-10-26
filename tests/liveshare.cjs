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

const env = { ...process.env, MY_AI_IDE_TEST_HOOKS: '1' }
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

    // ---- what a screen reader gets
    check('a screen reader is told when somebody joins', /Reader|.+ joined the Live Share session/.test(await host.ev(`document.querySelector('[data-live-polite]')?.textContent || ''`)), await host.ev(`document.querySelector('[data-live-polite]')?.textContent`))
    const sbName = (side) => side.ev(`document.querySelector('[data-sb="liveshare"]')?.getAttribute('aria-label') || ''`)
    check('the status item has a name that says the role, the people and what pressing does (host)', /^Live Share: hosting, 2 people: .+Press to copy the session code$/.test(await sbName(host)), await sbName(host))
    check('and for a guest, without the press hint', /^Live Share: joined, 2 people: /.test(await sbName(guest)) && !/Press/.test(await sbName(guest)), await sbName(guest))
    check('its symbol is hidden from screen readers', await host.ev(`document.querySelector('[data-sb="liveshare"] [aria-hidden="true"]')?.textContent.includes('⇆')`))

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

    // ---- a shared terminal
    const termText = (side) => side.ev(`(() => { const v = [...document.querySelectorAll('.term-view')].find((v) => v.style.display !== 'none'); return v ? (v.querySelector('.xterm-rows')?.textContent || '').replace(/\u00a0/g, ' ') : '' })()`)
    const typeInTerm = async (side, text) => { await side.ev(`[...document.querySelectorAll('.term-view')].find((v) => v.style.display !== 'none')?.querySelector('.xterm-helper-textarea')?.focus()`); await side.send('Input.insertText', { text }); await side.key('Enter', 'Enter', 13) }
    await host.key('`', 'Backquote', 192, 2) // Ctrl+` opens the panel with a terminal
    check('the host has a terminal', await host.waitFor(async () => /PS .*>/.test(await termText(host)), 30000))
    check('a guest has no terminal tab before the host shares one', await guest.ev(`document.querySelectorAll('.term-tab').length === 0`))
    await host.palette('live share', 'Live Share: Share the Terminal')
    await host.choose('Let guests watch')
    await host.ev(`Promise.resolve(0)`)
    await typeInTerm(host, 'echo BEFORE-' + 'JOIN')
    check('the guest gets a tab for the shared terminal', await guest.waitFor(() => guest.ev(`[...document.querySelectorAll('.term-tab-name')].some((t) => /\(shared\)/.test(t.textContent))`), 15000))
    check('it shows what the host\'s terminal showed, and what the host types after', await guest.waitFor(async () => /BEFORE-JOIN/.test(await termText(guest)), 15000), await termText(guest))
    check('a terminal that a guest may only watch says so to a screen reader', /read only/.test(await guest.ev(`[...document.querySelectorAll('.term-view')].find((v) => v.style.display !== 'none')?.querySelector('.xterm-helper-textarea')?.getAttribute('aria-label') || ''`)))
    await typeInTerm(host, 'echo AFTER-' + 'SHARE')
    check('new output reaches the guest', await guest.waitFor(async () => /AFTER-SHARE/.test(await termText(guest)), 15000))
    await typeInTerm(guest, 'echo GUEST-' + 'TYPED')
    await sleep(1500)
    check('a guest cannot type in a terminal shared for watching', !/GUEST-TYPED/.test(await termText(host)) && !/GUEST-TYPED/.test(await termText(guest)))
    // the main process also refuses a guest's input that the host did not allow
    for (let n = 1; n <= 6; n++) await guest.ev(`window.api.lsSend({ t: 'term-input', tid: ${n}, data: 'echo FORGED-' + 'INPUT\\r' })`)
    await sleep(1000)
    check('and input sent around the page is refused as well', !/FORGED-INPUT/.test(await termText(host)))
    await host.palette('live share', 'Live Share: Stop Sharing the Terminal')
    check('the guest\'s tab goes when sharing stops', await guest.waitFor(() => guest.ev(`![...document.querySelectorAll('.term-tab-name')].some((t) => /\(shared\)/.test(t.textContent))`), 10000))
    await host.palette('live share', 'Live Share: Share the Terminal')
    await host.choose('Let guests type too')
    check('a terminal shared with typing lets a guest run a command', await guest.waitFor(() => guest.ev(`[...document.querySelectorAll('.term-tab-name')].some((t) => /\(shared\)/.test(t.textContent))`), 15000))
    await typeInTerm(guest, 'echo GUEST-' + 'RAN')
    check('and it runs in the host\'s shell', await host.waitFor(async () => (await termText(host)).split('GUEST-RAN').length > 2, 15000), (await termText(host)).slice(-110) + " || GUEST: " + (await termText(guest)).slice(-110))

    // ---- the connection is lost and comes back
    await guest.ev(`document.querySelector('[data-sb="liveshare"]') && window.api.lsTestDrop()`)
    await guest.focusEditor()
    await guest.send('Input.insertText', { text: 'OFFLINE-' }) // typed while the connection is down (the guest waits a second before trying again)
    check('a guest whose connection is lost says it is reconnecting', await guest.waitFor(() => guest.ev(`/reconnecting/.test(document.querySelector('[data-sb="liveshare"]')?.textContent || '')`), 5000))
    check('and is back in the session by itself', await guest.waitFor(() => guest.ev(`/joined · 2/.test(document.querySelector('[data-sb="liveshare"]')?.textContent || '')`), 30000) && await host.waitFor(() => host.ev(`/hosting · 2/.test(document.querySelector('[data-sb="liveshare"]')?.textContent || '')`), 30000))
    check('what was typed while away reaches the host, and both have the same text', await host.waitFor(async () => { const a = await merged(host), b = await merged(guest); return a === b && /OFFLINE-/.test(a) }, 20000), (await merged(host)) + ' | ' + (await merged(guest)))
    await host.focusEditor(); await host.send('Input.insertText', { text: 'HOST-AFTER ' })
    check('edits go both ways again', await guest.waitFor(async () => /HOST-AFTER/.test(await guest.text()), 15000))
    await typeInTerm(host, 'echo AFTER-' + 'RECONNECT')
    check('the shared terminal shows new output again', await guest.waitFor(async () => /AFTER-RECONNECT/.test(await termText(guest)), 20000), (await termText(guest)).slice(-200))

    // ---- following somebody
    const activeTab = (side) => side.ev(`document.querySelector('.tab.active .tab-name')?.textContent`)
    check('before following, the guest is in b.js', (await activeTab(guest)) === 'b.js', await activeTab(guest))
    await guest.palette('live share', 'Live Share: Follow a Participant')
    await guest.waitFor(() => guest.ev(`!!document.querySelector('[data-choice]')`))
    await guest.ev(`document.querySelector('[data-choice]').click()`)
    check('the status item says whom the guest follows', await guest.waitFor(() => guest.ev(`/following/.test(document.querySelector('[data-sb="liveshare"]')?.textContent || '')`), 8000))
    await host.openFromTree('a.txt')
    await host.focusEditor()
    check('when the host goes to another file the guest\'s editor goes there too', await guest.waitFor(async () => (await activeTab(guest)) === 'a.txt', 15000), await activeTab(guest))
    await guest.palette('live share', 'Live Share: Stop Following')
    check('stopping removes it from the status item', await guest.waitFor(() => guest.ev(`!/following/.test(document.querySelector('[data-sb="liveshare"]')?.textContent || '')`), 8000))
    await host.openFromTree('b.js')
    await host.focusEditor()
    await sleep(2000)
    check('and the guest stays where it is', (await activeTab(guest)) === 'a.txt', await activeTab(guest))

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
