// Live Share with the host's folder on ANOTHER computer: the host opens a folder on the Linux SSH server (Docker, see tests/ssh-linux.cjs),
// shares it, and a second instance of the packaged app joins and edits a file of that folder together with the host; saving from the
// guest writes the file on the server. `npm run test:liveshare-remote-ui` (skipped without the server on 127.0.0.1:2222).
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), net = require('net')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }
const EXE = process.env.MY_AI_IDE_EXE || path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
if (!fs.existsSync(EXE)) { console.log('SKIP  no packaged app at ' + EXE); process.exit(0) }
const docker = (line) => cp.spawnSync('docker', ['exec', '-u', 'tester', 'sshtest', 'sh', '-c', 'cd /home/tester && ' + line], { encoding: 'utf-8' })

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-remote-ui-')))
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
  const up = await new Promise((res) => { const s = net.connect(2222, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
  if (!up) { console.log('SKIP  no SSH server on 127.0.0.1:2222'); process.exit(0) }
  try {
    const made = docker('rm -rf lsui && mkdir -p lsui/sub && printf "alpha\\nbeta\\ngamma\\n" > lsui/a.txt && echo "const b = 1" > lsui/sub/b.js')
    check('the folder was made on the server', made.status === 0, made.stderr)
    launch('host', 9811, [])
    launch('guest', 9812, [])
    const host = await connect(9811)
    const guest = await connect(9812)
    await sleep(4000)

    // ---- the host opens the folder over SSH, from the palette
    await host.palette('folder over ssh', 'Open Folder over SSH')
    await host.waitFor(() => host.ev(`!!document.querySelector('[data-input-dialog]')`))
    await host.typeInto('[data-input-dialog]', 'tester@127.0.0.1:2222')
    await host.waitFor(() => host.ev(`/SHA256:/.test(document.querySelector('[data-choice-dialog]')?.textContent || '')`))
    await host.ev(`document.querySelector('[data-choice="Trust and connect"]').click()`)
    await host.waitFor(() => host.ev(`document.querySelector('[data-input-dialog]')?.type === 'password'`))
    await host.typeInto('[data-input-dialog]', 'secret')
    await host.waitFor(() => host.ev(`[...document.querySelectorAll('.qp-item')].some((i) => i.textContent.trim().startsWith('lsui'))`), 30000)
    await host.ev(`[...document.querySelectorAll('.qp-item')].find((i) => i.textContent.trim().startsWith('lsui')).click()`)
    await host.waitFor(() => host.ev(`[...document.querySelectorAll('.qp-item')].some((i) => i.textContent.includes('Open this folder') && i.textContent.includes('/home/tester/lsui'))`), 20000)
    await host.ev(`[...document.querySelectorAll('.qp-item')].find((i) => i.textContent.includes('Open this folder')).click()`)
    check('the host has the server folder open', await host.waitFor(() => host.ev(`!!document.querySelector('[data-sb="ssh"]') && !!document.querySelector('.tree-row[data-tree-path$="a.txt"]')`), 30000))

    // ---- and starts a session on it
    await host.palette('live share', 'Live Share: Start a Session')
    await host.waitFor(() => host.ev(`/Who can join/.test(document.querySelector('[data-choice-dialog]')?.textContent || '')`))
    await host.choose('This PC only')
    await host.waitFor(() => host.ev(`/What can guests do/.test(document.querySelector('[data-choice-dialog]')?.textContent || '')`))
    await host.choose('Edit files')
    check('a session can be started on a folder of another computer', await host.waitFor(() => host.ev(`/hosting · 1/.test(document.querySelector('[data-sb="liveshare"]')?.textContent || '')`), 20000))
    const code = JSON.parse(await host.ev(`window.api.lsStatus().then((s) => JSON.stringify(s))`)).join

    // ---- a guest joins
    await guest.palette('live share', 'Live Share: Join a Session')
    await guest.waitFor(() => guest.ev(`!!document.querySelector('[data-input-dialog]')`))
    await guest.typeInto('[data-input-dialog]', code)
    check('the guest sees the server folder in its explorer', await guest.waitFor(() => guest.ev(`!!document.querySelector('.tree-row[data-tree-path$="a.txt"]') && !!document.querySelector('.tree-row[data-tree-path$="sub"]')`), 30000))

    // ---- both edit the same file
    await host.openFromTree('a.txt')
    await guest.openFromTree('a.txt')
    check('the guest sees the text of the file on the server', await guest.waitFor(async () => /alpha\s+beta\s+gamma/.test(await guest.text()), 15000))
    await host.focusEditor(); await guest.focusEditor()
    await host.key('Home', 'Home', 36, 2); await guest.key('End', 'End', 35, 2)
    await Promise.all([host.send('Input.insertText', { text: 'HOST-' }), guest.send('Input.insertText', { text: '-GUEST' })])
    const merged = async (side) => (await side.text()).replace(/\s+/g, ' ').trim()
    check('typing at the same time ends with the same text on both sides', await host.waitFor(async () => { const a = await merged(host), b = await merged(guest); return a === b && /HOST-alpha/.test(a) && /gamma\s?-GUEST/.test(a) }, 15000), (await merged(host)) + ' | ' + (await merged(guest)))

    // ---- saving from the guest writes the file on the server
    await guest.key('s', 'KeyS', 83, 2)
    const onServer = () => docker('cat lsui/a.txt').stdout.replace(/\s+/g, ' ').trim()
    check('the guest\'s save lands in the file on the server, with the shared text', await host.waitFor(async () => onServer() === (await merged(host)), 15000), onServer())
    await guest.ev(`document.querySelector('.tree-row[data-tree-path$="sub"]').click()`)
    await guest.openFromTree('b.js')
    check('a file the host has not opened is read from the server', await guest.waitFor(async () => /const b = 1/.test(await guest.text()), 15000))
    await guest.focusEditor()
    await guest.send('Input.insertText', { text: '// from the guest\n' })
    await guest.key('s', 'KeyS', 83, 2)
    check('and saving it writes it there', await host.waitFor(() => /from the guest/.test(docker('cat lsui/sub/b.js').stdout), 15000), docker('cat lsui/sub/b.js').stdout)
    check('no uncaught errors in either window', host.errors.length === 0 && guest.errors.length === 0, [...host.errors, ...guest.errors].join(' | '))
  } catch (e) {
    check('test run completed without exception', false, e.message)
  } finally {
    stopAll()
    docker('rm -rf lsui')
    await sleep(800)
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})()
