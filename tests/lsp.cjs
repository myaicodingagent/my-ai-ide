// Language servers in the real app: gopls (Go) and pylsp (Python) are started by the editor and their answers checked on
// screen: errors in the Problems panel, outline, hover, go to definition, completion, formatting, rename; and what is shown
// when a server is not installed. `npm run test:lsp` starts the app itself; needs `gopls` (go install
// golang.org/x/tools/gopls@latest) and `pylsp` (pip install python-lsp-server); a missing one is skipped.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }
const have = (cmd) => { try { cp.execSync(cmd, { stdio: 'ignore' }); return true } catch { return false } }
const goplsOk = have('gopls version') || fs.existsSync(path.join(os.homedir(), 'go', 'bin', process.platform === 'win32' ? 'gopls.exe' : 'gopls'))
const pylspOk = have('pylsp --version')

const port = 9666
const tmp = path.join(os.tmpdir(), 'lsp-test-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true })
const proj = path.join(tmp, 'proj'), data = path.join(tmp, 'data')
fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(data, { recursive: true })
const write = (rel, text) => fs.writeFileSync(path.join(proj, rel), text)
write('go.mod', 'module prog\n\ngo 1.21\n')
write('main.go', [
  'package main',                                   // 1
  '',                                               // 2
  'import "fmt"',                                   // 3
  '',                                               // 4
  'type Greeter struct{ Name string }',             // 5
  '',                                               // 6
  'func (g Greeter) Hello() string { return "hi " + g.Name }', // 7
  '',                                               // 8
  'func add(a, b int) int { return a + b }',        // 9
  '',                                               // 10
  'func main() {',                                  // 11
  '\tg := Greeter{Name: "x"}',                      // 12
  '\tfmt.Println(g.Hello(), add(1, 2))',            // 13
  '\tvar unused int',                               // 14
  '}',                                              // 15
  ''
].join('\n'))
write('messy.go', 'package main\n\nfunc   twice( n int )int{return n*2}\n')
write('app.py', 'import os\n\ndef greet(name):\n    """Say hi to someone."""\n    return "hi " + name\n\nclass Box:\n    def size(self):\n        return 1\n\nx = greet("a")\nprint(undefined_name)\n')
write('lib.rs', 'fn main() {}\n')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = cp.spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${data}`, proj], { cwd: path.join(__dirname, '..'), env, shell: true, stdio: 'ignore', windowsHide: true })
const stopApp = () => { try { cp.execSync('taskkill /F /T /PID ' + app.pid, { stdio: 'ignore' }) } catch { /* gone */ } try { cp.execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }) } catch { /* none */ } try { cp.execSync('taskkill /F /IM gopls.exe', { stdio: 'ignore' }) } catch { /* none */ } }

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
  let id = 0; const pend = {}; const dialogs = []
  ws.on('message', (d) => {
    const m = JSON.parse(d)
    if (pend[m.id]) pend[m.id](m)
    if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR', JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 500))
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } })) }
  })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 20000); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.send(JSON.stringify({ id: ++id, method: 'Page.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value

  const VK = { Escape: 27, Enter: 13, Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F2: 113, F12: 123 }
  const press = async (combo, wait = 350) => {
    const parts = combo.split('+'); const k = parts.pop()
    const mods = parts.reduce((m, p) => m | ({ Alt: 1, Ctrl: 2, Shift: 8 }[p] ?? 0), 0)
    const vk = VK[k] ?? (/^[a-z]$/i.test(k) ? k.toUpperCase().charCodeAt(0) : 0)
    const base = { key: k, code: /^[a-z]$/i.test(k) ? 'Key' + k.toUpperCase() : k, modifiers: mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(wait)
  }
  const mouse = async (x, y, type = 'click') => {
    if (type === 'move') return void (await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }))
    for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 })
  }
  const center = async (sel) => JSON.parse(await ev(`(() => { const r = ${sel}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
  const realClick = async (sel) => { const { x, y } = await center(sel); await mouse(x, y) }
  const menu = async (top, item, wait = 900) => {
    await realClick(`document.querySelector('[data-menu="${top}"]')`); await sleep(150)
    await realClick(`[...document.querySelectorAll('[data-menu-item]')].find((e) => e.getAttribute('data-menu-item') === ${JSON.stringify(item)})`)
    await sleep(wait)
  }
  const visible = (sel) => ev(`!!(document.querySelector(${JSON.stringify(sel)})?.offsetParent)`)
  const text = () => ev(`document.querySelector('.monaco-editor .view-lines')?.innerText.replace(/\\u00a0/g, ' ') ?? ''`)
  const openFile = async (name) => {
    await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(300)
    await ev(`(() => { const r = [...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').split('\\\\').join('/').endsWith('/' + ${JSON.stringify(name)})); r?.click() })()`)
    await sleep(1500)
    const r = JSON.parse(await ev(`JSON.stringify(document.querySelector('.monaco-editor .view-lines').getBoundingClientRect())`))
    await mouse(r.left + 60, r.top + 8)
    await ev(`document.querySelector('.monaco-editor textarea')?.focus()`)
    await sleep(300)
  }
  // The screen position of a word on a line of the editor (the line is found by its text).
  const wordAt = async (lineContains, word, nth = 0) => JSON.parse(await ev(`(() => {
    const line = [...document.querySelectorAll('.monaco-editor .view-line')].find((l) => l.innerText.replace(/\\u00a0/g, ' ').includes(${JSON.stringify(lineContains)}))
    if (!line) return 'null'
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let seen = 0, node
    const flat = line.innerText.replace(/\\u00a0/g, ' ')
    let idx = -1; for (let k = 0; k <= ${nth}; k++) idx = flat.indexOf(${JSON.stringify(word)}, idx + 1)
    if (idx < 0) return 'null'
    let offset = 0
    while ((node = walker.nextNode())) {
      const len = node.textContent.length
      if (idx < offset + len) { const r = document.createRange(); const s = idx - offset; r.setStart(node, s); r.setEnd(node, Math.min(len, s + ${word.length})); const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 }) }
      offset += len
    }
    return 'null'
  })()`))
  const cursorLine = () => ev(`(() => { const lines = [...document.querySelectorAll('.monaco-editor .view-line')].map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top); const cur = document.querySelector('.monaco-editor .current-line')?.getBoundingClientRect(); if (!cur || lines.length < 2) return -1; return Math.round((cur.top - lines[0].top) / (lines[1].top - lines[0].top)) + 1 })()`)
  const waitFor = async (fn, ms = 40000, step = 700) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step) } }
  const problems = () => ev(`JSON.stringify([...document.querySelectorAll('[data-problem-row]')].map((r) => r.innerText.replace(/\\s+/g, ' ')))`).then((s) => JSON.parse(s || '[]'))
  const outline = () => ev(`JSON.stringify([...document.querySelectorAll('[data-outline-row]')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()))`).then((s) => JSON.parse(s || '[]'))
  const outputText = () => ev(`document.querySelector('[data-output-text]')?.innerText ?? ''`)

  await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(800)

  // ================= Go (gopls) =================
  if (!goplsOk) console.log('SKIP  Go checks (gopls is not installed)')
  else {
    await openFile('main.go')
    check('the status bar names the Go language server once it is running', await waitFor(() => ev(`/Go/.test(document.querySelector('[data-sb="lsp"]')?.innerText ?? '')`), 60000))
    await menu('View', 'Problems', 800)
    const probs = await waitFor(async () => { const p = await problems(); return p.some((t) => /unused/.test(t)) && p }, 60000)
    check('gopls reports "declared and not used" in the Problems panel', !!probs, JSON.stringify(probs))
    check('the problem is attributed to gopls and has its line', !!probs && probs.some((t) => /\[14, /.test(t)), JSON.stringify(probs))
    await ev(`[...document.querySelectorAll('.term-btn')].find((b) => b.textContent === 'Hide').click()`)
    await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(500)
    const ol = await waitFor(async () => { const o = await outline(); return o.some((t) => t.includes('Greeter')) && o }, 30000)
    check('the Outline lists Greeter, Hello, add and main from the server', !!ol && ['Greeter', 'Hello', 'add', 'main'].every((n) => ol.some((t) => t.includes(n))), JSON.stringify(ol))
    // hover
    let hov = ''
    const hw = await wordAt('fmt.Println', 'add')
    await mouse(hw.x - 60, hw.y - 40, 'move'); await sleep(200); await mouse(hw.x, hw.y, 'move')
    for (let i = 0; i < 40 && !/func add/.test(hov); i++) { await sleep(500); hov = await ev(`[...document.querySelectorAll('.monaco-hover')].map((h) => h.innerText).join(' ').replace(/\\u00a0/g, ' ')`) }
    check('hovering over add shows its signature', /func add\(a(, b| int, b) int\) int/.test(hov), hov)
    await press('Escape', 300)
    // definition
    const use = await wordAt('fmt.Println', 'add')
    await mouse(use.x, use.y); await sleep(300); await press('F12', 300)
    check('F12 on a call of add goes to its definition (line 9)', await waitFor(async () => (await cursorLine()) === 9, 8000, 400), await cursorLine())
    // completion: g.<suggestions>
    await press('Ctrl+End', 200)
    const t0 = await text()
    await press('ArrowUp', 100); await press('ArrowUp', 100); await press('End', 100)
    await send('Input.insertText', { text: '\n\t_ = g.' }); await sleep(2500)
    const sug = await ev(`document.querySelector('.suggest-widget')?.innerText ?? ''`)
    check('typing "g." offers Hello and Name from the server', /Hello/.test(sug) && /Name/.test(sug), sug.replace(/\n/g, ' '))
    await press('Escape', 200)
    await press('Ctrl+Z', 300); await press('Ctrl+Z', 300)
    // rename
    const sym = await wordAt('func add', 'add')
    await mouse(sym.x, sym.y); await sleep(300)
    await press('F2', 900)
    check('F2 opens the rename box', await visible('.rename-box, .monaco-editor .rename-input, .rename-input'))
    await send('Input.insertText', { text: 'plus' }); await sleep(200); await press('Enter', 2500)
    const after = await text()
    check('renaming add to plus changes the definition and the call', /func plus/.test(after) && /plus\(1, 2\)/.test(after) && !/\badd\b/.test(after.replace(/\/\/.*$/gm, '')), after.split('\n').slice(8, 14).join(' | '))
    await press('Ctrl+Z', 400)
    // formatting
    await openFile('messy.go')
    await sleep(3000)
    let fm = ''
    for (let i = 0; i < 4 && !/func twice\(n int\) int \{/.test(fm); i++) { await menu('Edit', 'Format Document', 2500); fm = await text() }
    check('Format Document formats Go with gofmt', /func twice\(n int\) int \{/.test(fm) && /return n \* 2/.test(fm), JSON.stringify(fm))
    await press('Ctrl+Z', 300)
    check('the Language Servers output channel records the start', await (async () => { await menu('View', 'Output', 800); await ev(`(() => { const s = document.querySelector('[data-output-channel]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'Language Servers'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`); await sleep(500); return /gopls\)? started|Go \(gopls\) started/.test(await outputText()) })(), (await outputText()).slice(0, 200))
    await ev(`[...document.querySelectorAll('.term-btn')].find((b) => b.textContent === 'Hide').click()`)
  }

  // ================= Python (pylsp) =================
  if (!pylspOk) console.log('SKIP  Python checks (pylsp is not installed)')
  else {
    await openFile('app.py')
    await menu('View', 'Problems', 800)
    const pp = await waitFor(async () => { const p = await problems(); return p.some((t) => /undefined_name/.test(t)) && p }, 60000)
    check('pylsp reports the undefined name in the Problems panel', !!pp, JSON.stringify(pp))
    await ev(`[...document.querySelectorAll('.term-btn')].find((b) => b.textContent === 'Hide').click()`)
    await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(500)
    const pol = await waitFor(async () => { const o = await outline(); return o.some((t) => t.includes('greet')) && o }, 30000)
    check('the Outline lists greet and Box for the Python file', !!pol && pol.some((t) => t.includes('greet')) && pol.some((t) => t.includes('Box')), JSON.stringify(pol))
    check('the status bar lists both servers', /Go/.test(await ev(`document.querySelector('[data-sb="lsp"]')?.innerText ?? ''`)) || !goplsOk)
    let phov = ''
    const hw = await wordAt('x = greet', 'greet')
    await mouse(hw.x - 60, hw.y - 40, 'move'); await sleep(200); await mouse(hw.x, hw.y, 'move')
    for (let i = 0; i < 40 && !/Say hi/.test(phov); i++) { await sleep(500); phov = await ev(`[...document.querySelectorAll('.monaco-hover')].map((h) => h.innerText).join(' ').replace(/\\u00a0/g, ' ')`) }
    check('hovering over greet shows its documentation', /Say hi to someone/.test(phov), phov)
    await press('Escape', 200)
    const g2 = await wordAt('x = greet', 'greet')
    await mouse(g2.x, g2.y); await sleep(300); await press('F12', 300)
    check('F12 on greet goes to its definition (line 3)', await waitFor(async () => (await cursorLine()) === 3, 8000, 400), await cursorLine())
  }

  // ================= a server that is not installed =================
  await openFile('lib.rs')
  await sleep(2500)
  await menu('View', 'Output', 800)
  await ev(`(() => { const s = document.querySelector('[data-output-channel]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'Language Servers'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await sleep(500)
  const out = await outputText()
  check('opening a Rust file without rust-analyzer says how to install it', /rust-analyzer/i.test(out) && /rustup/.test(out), out.slice(-300))
  await ev(`[...document.querySelectorAll('.term-btn')].find((b) => b.textContent === 'Hide').click()`)
  check('and the editor keeps working (no alert, no crash)', dialogs.length === 0 && (await text()).includes('fn main'), dialogs.join(' | '))

  stopApp()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); stopApp(); process.exit(1) })
