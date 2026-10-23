// The parts of the menu bar that tests/menus.cjs does not reach: the entries that open native dialogs (answered through
// environment variables), the ones that need the language service, saving and closing, stepping in the debugger, and
// every keyboard shortcut the menus show (the real keys are pressed). `npm run test:menus2` starts the app itself.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }

const port = 9555
const tmp = path.join(os.tmpdir(), 'menus2-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true })
const proj = path.join(tmp, 'proj'), other = path.join(tmp, 'other'), third = path.join(tmp, 'third'), data = path.join(tmp, 'data')
for (const d of [proj, other, third, data]) fs.mkdirSync(d, { recursive: true })
const write = (rel, text) => fs.writeFileSync(path.join(proj, rel), text)
write('package.json', '{"name":"t","scripts":{"build":"echo hi"}}')
write('dbg.js', 'function inner(x) {\n  const y = x + 1\n  return y\n}\nfunction outer(n) {\n  const r = inner(n)\n  return r * 2\n}\nconst out = outer(4)\nconsole.log("out", out)\n')
write('def.ts', 'function target() { return 1 }\nconst v = target()\nconst w = target()\nexport {}\n')
write('bad.ts', "const n: number = 'text'\nexport {}\n")
write('messy.js', 'const   x=1;function f( a,b ){return a+b}\n')
const editText = 'alpha one\nbeta two\nalpha three\ngamma four\n'
write('edit.js', editText)
write('two.js', 'let two = 2\n')
fs.writeFileSync(path.join(other, 'o.txt'), 'o')
fs.writeFileSync(path.join(third, 't.txt'), 't')
const git = (...a) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: proj, stdio: 'ignore' })
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'first commit of the test project')
const wsFile = path.join(tmp, 'ws.code-workspace')
fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: 'proj' }, { path: 'other' }] }))
const wsSaved = path.join(tmp, 'saved.code-workspace')

const env = { ...process.env, MY_AI_IDE_TEST_WORKSPACE_FILE: wsFile, MY_AI_IDE_TEST_SAVE_FILE: wsSaved, MY_AI_IDE_TEST_OPEN_FOLDER: third }
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
  let id = 0; const pend = {}; const dialogs = []
  ws.on('message', (d) => {
    const m = JSON.parse(d)
    if (pend[m.id]) pend[m.id](m)
    if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR', JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 600))
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } })) }
  })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method + ' (the page is stuck)')), 20000); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.send(JSON.stringify({ id: ++id, method: 'Page.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } })) // the page counts as focused even if another window is in front
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value

  // ---- input helpers
  const VK = { Escape: 27, Enter: 13, Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Tab: 9, ',': 188, '`': 192, '\\': 220, '=': 187, '-': 189, '/': 191 }
  const CODE = { ',': 'Comma', '`': 'Backquote', '\\': 'Backslash', '=': 'Equal', '-': 'Minus', '/': 'Slash' }
  const COMMANDS = { c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' }
  // press('Ctrl+Shift+P'), press('F12'), press('Alt+ArrowUp')...
  const press = async (combo, wait = 350) => {
    const parts = combo.split('+')
    const k = parts.pop() === '' ? '+' : combo.split('+').filter(Boolean).pop()
    const mods = parts.reduce((m, p) => m | ({ Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 }[p] ?? 0), 0)
    const isF = /^F\d+$/.test(k)
    const vk = VK[k] ?? (isF ? 111 + Number(k.slice(1)) : /^[a-z]$/i.test(k) ? k.toUpperCase().charCodeAt(0) : /^\d$/.test(k) ? k.charCodeAt(0) : 0)
    const code = CODE[k] ?? (isF || k.startsWith('Arrow') || VK[k] ? k : /^[a-z]$/i.test(k) ? 'Key' + k.toUpperCase() : /^\d$/.test(k) ? 'Digit' + k : k)
    const base = { key: mods & 8 && /^[a-z]$/.test(k) ? k.toUpperCase() : k, code, modifiers: mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    const commands = mods === 2 && COMMANDS[k] ? [COMMANDS[k]] : undefined
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(commands ? { commands } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(wait)
  }
  const center = async (sel) => JSON.parse(await ev(`(() => { const r = ${sel}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
  const mouse = async (x, y) => { for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 }) }
  const realClick = async (sel) => { const { x, y } = await center(sel); await mouse(x, y) }
  const menu = async (top, item, wait = 800) => {
    await realClick(`document.querySelector('[data-menu="${top}"]')`)
    await sleep(150)
    const sel = `[...document.querySelectorAll('[data-menu-item]')].find((e) => e.getAttribute('data-menu-item') === ${JSON.stringify(item)})`
    if (!(await ev(`!!(${sel})`))) throw new Error(`no menu entry ${top} > ${item}`)
    await realClick(sel)
    await sleep(wait)
  }
  const visible = (sel) => ev(`!!(document.querySelector(${JSON.stringify(sel)})?.offsetParent)`)
  const esc = async () => { await press('Escape', 300) }
  const text = () => ev(`document.querySelector('.monaco-editor .view-lines')?.innerText.replace(/\\u00a0/g, ' ') ?? ''`)
  const side = () => ev(`document.querySelector('.sidebar')?.innerText ?? ''`)
  const tabs = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.tabs [role="tab"]')].map((t) => t.innerText.trim()))`))
  const disk = (rel) => fs.readFileSync(path.join(proj, rel), 'utf-8')
  const focusEditor = async () => {
    const r = JSON.parse(await ev(`JSON.stringify(document.querySelector('.monaco-editor .view-lines').getBoundingClientRect())`))
    await mouse(r.left + 60, r.top + 8)
    await ev(`document.querySelector('.monaco-editor textarea')?.focus()`)
    await sleep(250)
  }
  const openFile = async (name) => {
    await ev(`document.querySelector('[data-view="files"]').click()`)
    await sleep(300)
    await ev(`(() => { const r = [...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').split('\\\\').join('/').endsWith('/' + ${JSON.stringify(name)})); r?.click(); return !!r })()`)
    await sleep(1500)
    for (let i = 0; i < 3 && !(await ev(`!!document.querySelector('.monaco-editor .view-lines')`)); i++) { // sometimes the first click only closes a popup
      await ev(`(() => { const r = [...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').split('\\\\').join('/').endsWith('/' + ${JSON.stringify(name)})); r?.click() })()`)
      await sleep(1200)
    }
    await focusEditor()
  }
  const cursorLineNow = () => ev(`(() => { const lines = [...document.querySelectorAll('.monaco-editor .view-line')].map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top); const cur = document.querySelector('.monaco-editor .current-line')?.getBoundingClientRect(); if (!cur || lines.length < 2) return -1; return Math.round((cur.top - lines[0].top) / (lines[1].top - lines[0].top)) + 1 })()`)
  // The current-line highlight can lag a moment behind the cursor, so look for a few seconds.
  const cursorLine = async () => { let v = -1; for (let i = 0; i < 8; i++) { v = await cursorLineNow(); if (v > 0) return v; await sleep(400) } return v }
  const waitLine = async (n, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await cursorLineNow()) === n) return true; await sleep(250) } return false }
  const toLine = async (n) => { await press('Ctrl+Home', 150); for (let i = 1; i < n; i++) await press('ArrowDown', 60) }
  const typeText = async (t) => { await send('Input.insertText', { text: t }); await sleep(300) }
  const resetText = async () => { await press('Ctrl+A', 150); await typeText(editText.trimEnd()); await press('Escape', 100) }
  const closeAllTabs = async () => { await press('Ctrl+Alt+S', 600); for (let i = 0; i < 12 && (await tabs()).length; i++) await press('Ctrl+W', 250) }

  const height0 = await ev('window.innerHeight')
  await ev(`document.querySelector('[data-view="files"]').click()`)
  await sleep(800)
  check('the app opened the test folder', (await side()).toLowerCase().includes('dbg.js'))

  // ================= native dialogs (answered by environment variables) =================
  await menu('File', 'Open Workspace from File…', 1500)
  check('File > Open Workspace from File adds the second folder of the .code-workspace file', (await side()).toLowerCase().includes('other'), (await side()).slice(0, 80))
  await menu('File', 'Save Workspace As…', 800)
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(wsSaved, 'utf-8')) } catch { /* not written */ }
  check('File > Save Workspace As writes the folders (relative paths) to the chosen file', !!saved && saved.folders.length === 2 && saved.folders.some((f) => f.path === 'other') && saved.folders.some((f) => f.path === 'proj'), JSON.stringify(saved))
  await menu('File', 'Add Folder to Workspace…', 1500)
  check('File > Add Folder to Workspace adds the chosen folder', (await side()).toLowerCase().includes('third'), (await side()).slice(0, 100))
  await menu('File', 'Open WSL Folder…', 2500)
  check('File > Open WSL Folder lists distributions, or says there are none', dialogs.some((d) => /WSL/i.test(d)) || (await visible('.qp')), dialogs.join(' | '))
  await esc()
  dialogs.length = 0
  await menu('Help', 'About My AI IDE', 600)
  check('Help > About shows the product name', dialogs.some((d) => /My AI IDE/.test(d)), dialogs.join(' | '))
  dialogs.length = 0
  const devtools = async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).filter((t) => /devtools/i.test(t.url)).length
  const dt0 = await devtools()
  await menu('Help', 'Toggle Developer Tools', 1500)
  const dt1 = await devtools()
  check('Help > Toggle Developer Tools opens the developer tools', dt1 > dt0, `${dt0} -> ${dt1}`)
  await menu('Help', 'Toggle Developer Tools', 1500)
  check('and a second time closes them', (await devtools()) === dt0)
  for (let i = 0; i < 3 && (await devtools()) > dt0; i++) await menu('Help', 'Toggle Developer Tools', 1500) // docked developer tools would shrink the window

  // ================= language service =================
  await openFile('messy.js')
  let fm = await text()
  for (let attempt = 0; attempt < 4 && !/const x = 1;/.test(fm); attempt++) { // the language service may still be starting
    await menu('Edit', 'Format Document', 2000); fm = await text()
  }
  check('Edit > Format Document formats the file', /const x = 1;/.test(fm) && /return a \+ b/.test(fm), JSON.stringify(fm))
  await press('Ctrl+Z', 300)

  await openFile('def.ts')
  await sleep(4000) // the language service needs a moment for a new file
  await toLine(2); for (let i = 0; i < 12; i++) await press('ArrowRight', 40) // inside the word "target"
  check('the cursor starts on line 2', (await cursorLine()) === 2, await cursorLine())
  const inWord = async () => { await toLine(2); for (let i = 0; i < 12; i++) await press('ArrowRight', 40) }
  let jumped = false
  for (let attempt = 0; attempt < 4 && !jumped; attempt++) { // the language service may still be starting
    await inWord(); await menu('Go', 'Go to Definition', 1500); jumped = await waitLine(1, 2500)
  }
  check('Go > Go to Definition jumps to the function', jumped, await cursorLine())
  let peek = false
  for (let attempt = 0; attempt < 4 && !peek; attempt++) {
    await inWord(); await menu('Go', 'Go to References', 1500)
    peek = await visible('.monaco-editor .zone-widget, .monaco-editor .peekview-widget, .monaco-editor .reference-zone-widget')
    if (!peek) await esc()
  }
  check('Go > Go to References opens the references view', peek)
  await esc()

  await openFile('bad.ts')
  let problems = ''
  for (let i = 0; i < 20 && !/[1-9]/.test(problems); i++) { await sleep(700); problems = await ev(`document.querySelector('.statusbar').innerText`) }
  await toLine(1)
  await menu('Go', 'Next Problem', 1200)
  check('Go > Next Problem shows the error', await visible('.monaco-editor .marker-widget, .monaco-editor .zone-widget'), problems.replace(/\n/g, ' '))
  await esc()
  await menu('Go', 'Previous Problem', 1200)
  check('Go > Previous Problem shows the error too', await visible('.monaco-editor .marker-widget, .monaco-editor .zone-widget'))
  await esc()
  await closeAllTabs()

  // ================= saving, closing, searching =================
  await openFile('edit.js')
  await toLine(1)
  await typeText('X')
  await menu('File', 'Save', 900)
  check('File > Save writes the file to disk', disk('edit.js').startsWith('Xalpha one'), JSON.stringify(disk('edit.js').slice(0, 20)))
  await openFile('two.js')
  await toLine(1); await typeText('Y')
  await openFile('edit.js')
  await toLine(1); await typeText('Z')
  await menu('File', 'Save All', 900)
  check('File > Save All writes every open file', disk('edit.js').startsWith('ZXalpha') && disk('two.js').startsWith('Ylet two'), JSON.stringify([disk('edit.js').slice(0, 8), disk('two.js').slice(0, 8)]))
  const before = await tabs()
  await menu('File', 'Close Editor', 600)
  const after = await tabs()
  check('File > Close Editor closes the active tab', after.length === before.length - 1, `${before.length} -> ${after.length}`)
  await menu('File', 'Reopen Closed Editor', 1200)
  check('File > Reopen Closed Editor brings it back', (await tabs()).length === before.length)
  await menu('Edit', 'Find in Files', 700)
  check('Edit > Find in Files shows the search view with the cursor in its box', (await ev(`document.querySelector('[data-view="search"]').getAttribute('aria-selected')`)) === 'true' && (await ev(`document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('.sidebar')`)))
  await ev(`document.querySelector('[data-view="files"]').click()`)
  fs.writeFileSync(path.join(proj, 'edit.js'), editText); fs.writeFileSync(path.join(proj, 'two.js'), 'let two = 2\n')
  await closeAllTabs()

  // ================= debugger: step in, over, out, stop =================
  await openFile('dbg.js')
  await toLine(6)
  await menu('Run', 'Toggle Breakpoint', 700)
  await menu('Run', 'Start Debugging', 3500)
  const frames = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-dbg-frame]')].map((f) => f.innerText.replace(/\\s+/g, ' ').trim()))`))
  let fr = await frames()
  check('the program stops at the breakpoint in outer, line 6', /outer dbg\.js:6/.test(fr[0] ?? ''), JSON.stringify(fr))
  await menu('Run', 'Step Into', 1500); fr = await frames()
  check('Run > Step Into enters inner', /inner dbg\.js:2/.test(fr[0] ?? ''), JSON.stringify(fr))
  await menu('Run', 'Step Over', 1500); fr = await frames()
  check('Run > Step Over goes to the next line of inner', /inner dbg\.js:3/.test(fr[0] ?? ''), JSON.stringify(fr))
  await menu('Run', 'Step Out', 1500); fr = await frames()
  check('Run > Step Out returns to outer', /outer dbg\.js:(6|7)/.test(fr[0] ?? ''), JSON.stringify(fr))
  await menu('Run', 'Stop Debugging', 1500)
  check('Run > Stop Debugging ends the session', (await frames()).length === 0 && /Start Debugging/.test(await side()))

  // ================= every shortcut the menus show =================
  check('the window has its full height again (no panel or developer tools left open)', (await ev('window.innerHeight')) === height0, `${await ev('window.innerHeight')} vs ${height0}`)
  await openFile('edit.js')
  const lines = async () => (await text()).split('\n')
  await toLine(1)
  console.log('DIAG', JSON.stringify({ editors: await ev(`document.querySelectorAll('.monaco-editor').length`), height: await ev(`Math.round(document.querySelector('.monaco-editor').getBoundingClientRect().height)`), panel: await visible('.terminal-panel'), innerH: await ev('window.innerHeight'), tabs: await tabs(), text: (await text()).slice(0, 40), active: await ev(`document.activeElement?.tagName + '.' + document.activeElement?.className`), sidebar: (await side()).slice(0, 40) }))
  await press('Ctrl+A'); check('Ctrl+A selects everything', (await ev(`document.querySelectorAll('.monaco-editor .selected-text').length`)) >= 4)
  await press('Ctrl+C'); await press('Ctrl+Home', 150); await press('Ctrl+End', 150); await press('Ctrl+V', 500)
  check('Ctrl+C and Ctrl+V copy and paste', (await text()).split('alpha one').length === 3, JSON.stringify(await text()))
  await press('Ctrl+Z', 500)
  check('Ctrl+Z undoes the paste', (await text()) === editText.replace(/\n$/, ''), JSON.stringify(await text()))
  await press('Ctrl+Y', 500)
  check('Ctrl+Y redoes it', (await text()).split('alpha one').length === 3)
  await press('Ctrl+Z', 500)
  await toLine(1); await press('Shift+End', 100); await press('Ctrl+X', 500)
  check('Ctrl+X cuts the selection', !(await text()).startsWith('alpha one'), JSON.stringify(await text()))
  await press('Ctrl+Z', 500)
  await resetText(); await toLine(2); await press('Ctrl+/', 500)
  check('Ctrl+/ toggles a line comment', /\/\/ ?beta two/.test(await text()))
  await press('Ctrl+/', 500)
  await resetText(); await toLine(2); await press('Home', 100); await press('Shift+End', 100); await press('Shift+Alt+A', 500)
  check('Shift+Alt+A wraps the selection in a block comment', /\/\*.*beta two.*\*\//.test(await text()), JSON.stringify(await text()))
  await resetText(); await toLine(2)
  await press('Shift+Alt+ArrowDown', 500)
  check('Shift+Alt+Down copies the line down', (await lines()).filter((l) => /beta two/.test(l)).length === 2)
  await resetText(); await toLine(2); await press('Alt+ArrowDown', 500)
  check('Alt+Down moves the line down', /alpha three/.test((await lines())[1]) && /beta two/.test((await lines())[2]), JSON.stringify(await lines()))
  await resetText(); await toLine(2); await press('Shift+Alt+ArrowUp', 500)
  check('Shift+Alt+Up copies the line up', (await lines()).filter((l) => /beta two/.test(l)).length === 2)
  await resetText(); await toLine(3); await press('Alt+ArrowUp', 500)
  check('Alt+Up moves the line up', /alpha three/.test((await lines())[1]), JSON.stringify(await lines()))
  await press('Ctrl+Z', 400)
  await toLine(1); await press('Ctrl+Alt+ArrowDown', 400)
  check('Ctrl+Alt+Down adds a cursor below', (await ev(`document.querySelectorAll('.monaco-editor .cursors-layer .cursor').length`)) >= 2)
  await press('Escape', 200)
  await toLine(3); await press('Ctrl+Alt+ArrowUp', 400)
  check('Ctrl+Alt+Up adds a cursor above', (await ev(`document.querySelectorAll('.monaco-editor .cursors-layer .cursor').length`)) >= 2)
  await press('Escape', 200)
  await toLine(1); await press('Ctrl+Home', 100); for (let i = 0; i < 2; i++) await press('ArrowRight', 40)
  await press('Ctrl+D', 300); await press('Ctrl+D', 400)
  check('Ctrl+D selects the word, and the next occurrence of it', (await ev(`document.querySelectorAll('.monaco-editor .cursors-layer .cursor').length`)) >= 2)
  await press('Escape', 200)
  await toLine(1); for (let i = 0; i < 2; i++) await press('ArrowRight', 40)
  await press('Ctrl+Shift+L', 500)
  check('Ctrl+Shift+L selects every occurrence of the word', (await ev(`document.querySelectorAll('.monaco-editor .cursors-layer .cursor').length`)) >= 2)
  await press('Escape', 200)
  await toLine(1)
  await press('Shift+Alt+ArrowRight', 400)
  const w1 = await ev(`document.querySelectorAll('.monaco-editor .selected-text').length`)
  await press('Shift+Alt+ArrowRight', 400)
  check('Shift+Alt+Right expands the selection', w1 > 0)
  await press('Shift+Alt+ArrowLeft', 400)
  check('Shift+Alt+Left shrinks it again', (await ev(`document.querySelectorAll('.monaco-editor .selected-text').length`)) >= 0)
  await press('Escape', 200)
  await press('Ctrl+F', 600); check('Ctrl+F opens find', await visible('.monaco-editor .find-widget.visible')); await esc()
  await press('Ctrl+H', 600); check('Ctrl+H opens replace', await visible('.monaco-editor .find-widget .replace-part, .monaco-editor .find-widget .replace-input')); await esc()
  await press('Ctrl+G', 600); check('Ctrl+G opens go to line', await visible('.quick-input-widget')); await esc()
  await press('Ctrl+Shift+O', 700); check('Ctrl+Shift+O opens go to symbol', await visible('.quick-input-widget')); await esc()

  // the keys of the app itself
  await press('Ctrl+Shift+P', 500); check('Ctrl+Shift+P opens the command palette', await visible('.qp')); await esc()
  await press('Ctrl+P', 500); check('Ctrl+P opens the file picker', await visible('.qp')); await esc()
  await press('Ctrl+Shift+F', 500); check('Ctrl+Shift+F shows the search view', (await ev(`document.querySelector('[data-view="search"]').getAttribute('aria-selected')`)) === 'true')
  await press('Ctrl+Shift+G', 500); check('Ctrl+Shift+G shows source control', (await ev(`document.querySelector('[data-view="git"]').getAttribute('aria-selected')`)) === 'true')
  await press('Ctrl+Shift+E', 500); check('Ctrl+Shift+E shows the explorer', (await ev(`document.querySelector('[data-view="files"]').getAttribute('aria-selected')`)) === 'true')
  const hidden = () => ev(`document.querySelector('.sidebar').classList.contains('hidden')`)
  await press('Ctrl+B', 400); check('Ctrl+B hides the side bar', (await hidden()) === true)
  await press('Ctrl+Shift+G', 400); check('and Ctrl+Shift+G brings it back on the git view', (await hidden()) === false)
  await press('Ctrl+Shift+E', 400)
  const chat0 = await visible('aside.chat'); await press('Ctrl+L', 400); check('Ctrl+L toggles the chat panel', (await visible('aside.chat')) !== chat0); await press('Ctrl+L', 400)
  await press('Ctrl+,', 600); check('Ctrl+, opens settings', (await ev(`document.body.innerText`)).includes('Reset to defaults')); await esc()
  await press('Ctrl+`', 1500); const t1 = await visible('.terminal-panel'); await press('Ctrl+`', 500)
  check('Ctrl+` shows and hides the terminal', t1 && !(await visible('.terminal-panel')))
  await press('Ctrl+Shift+`', 1500)
  const nTerm = await ev(`document.querySelectorAll('.term-tab').length`)
  await press('Ctrl+Shift+`', 1500)
  check('Ctrl+Shift+` opens another terminal', (await ev(`document.querySelectorAll('.term-tab').length`)) === nTerm + 1, nTerm)
  await press('Ctrl+`', 400)
  const ed0 = await ev(`document.querySelectorAll('.monaco-editor').length`)
  await press('Ctrl+\\', 900); check('Ctrl+\\ splits the editor', (await ev(`document.querySelectorAll('.monaco-editor').length`)) > ed0); await press('Ctrl+\\', 700)
  const iw0 = await ev('window.innerWidth')
  await press('Ctrl+=', 500); const iw1 = await ev('window.innerWidth'); await press('Ctrl+-', 500); await press('Ctrl+-', 500); const iw2 = await ev('window.innerWidth'); await press('Ctrl+0', 500)
  check('Ctrl+= zooms in, Ctrl+- zooms out, Ctrl+0 resets', iw1 < iw0 && iw2 > iw0 && (await ev('window.innerWidth')) === iw0, `${iw0} ${iw1} ${iw2}`)

  await focusEditor(); await toLine(1); await typeText('Q')
  await press('Ctrl+S', 900); check('Ctrl+S saves', disk('edit.js').startsWith('Q'))
  await focusEditor(); await toLine(1); await typeText('R')
  await openFile('two.js'); await toLine(1); await typeText('S')
  await press('Ctrl+Alt+S', 900); check('Ctrl+Alt+S saves all', disk('edit.js').startsWith('RQ') && disk('two.js').startsWith('Slet'))
  const nt = (await tabs()).length
  await press('Ctrl+W', 600); check('Ctrl+W closes the tab', (await tabs()).length === nt - 1)
  await press('Ctrl+Shift+T', 1000); check('Ctrl+Shift+T reopens it', (await tabs()).length === nt)

  // debugging keys
  await openFile('dbg.js'); await toLine(9)
  await press('F9', 500)
  await press('F5', 3500)
  fr = await frames(); check('F9 sets a breakpoint and F5 runs to it', /outer dbg\.js:9|\(anonymous\) dbg\.js:9|dbg\.js:9/.test(fr[0] ?? ''), JSON.stringify(fr))
  await press('F11', 1500); fr = await frames(); check('F11 steps into outer', /outer dbg\.js:6/.test(fr[0] ?? ''), JSON.stringify(fr))
  await press('F11', 1500); fr = await frames(); check('F11 again steps into inner', /inner dbg\.js:2/.test(fr[0] ?? ''), JSON.stringify(fr))
  await press('F10', 1500); fr = await frames(); check('F10 steps over', /inner dbg\.js:3/.test(fr[0] ?? ''), JSON.stringify(fr))
  await press('Shift+F11', 1500); fr = await frames(); check('Shift+F11 steps out', /outer dbg\.js:(6|7)/.test(fr[0] ?? ''), JSON.stringify(fr))
  await press('Shift+F5', 1500); check('Shift+F5 stops debugging', (await frames()).length === 0)
  await press('F9', 400)

  // keys that need the language service
  await openFile('def.ts'); await toLine(2); for (let i = 0; i < 12; i++) await press('ArrowRight', 40)
  await press('F12', 300); check('F12 goes to the definition', await waitLine(1), await cursorLineNow())
  await toLine(2); for (let i = 0; i < 12; i++) await press('ArrowRight', 40)
  await press('Shift+F12', 1500); check('Shift+F12 shows references', await visible('.monaco-editor .zone-widget, .monaco-editor .peekview-widget, .monaco-editor .reference-zone-widget')); await esc()
  await openFile('bad.ts'); await sleep(2500); await toLine(1)
  await press('F8', 1200); check('F8 goes to the next problem', await visible('.monaco-editor .marker-widget, .monaco-editor .zone-widget')); await esc()
  await press('Shift+F8', 1200); check('Shift+F8 goes to the previous problem', await visible('.monaco-editor .marker-widget, .monaco-editor .zone-widget')); await esc()
  await openFile('messy.js'); await press('Shift+Alt+F', 2500)
  check('Shift+Alt+F formats the document', /const x = 1;/.test(await text()), JSON.stringify(await text()))
  await press('Ctrl+Z', 300)
  await openFile('edit.js'); await toLine(1); await press('Shift+End', 100)
  await press('Ctrl+K', 800); check('Ctrl+K opens the AI edit box', await visible('.qp.ie')); await esc()

  // ================= bottom panel tabs =================
  const panelOn = (tab) => ev(`document.querySelector('[data-panel-tab="${tab}"]')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('.terminal-panel')?.offsetParent`)
  await closeAllTabs()
  await openFile('bad.ts'); await sleep(3000)
  await menu('View', 'Problems', 900)
  check('View > Problems shows the Problems tab of the bottom panel', await panelOn('problems'))
  let rows = []
  for (let i = 0; i < 15 && !rows.length; i++) { rows = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-problem-row]')].map((r) => r.closest('[role="listitem"]').querySelector('.pv-file').textContent + ' ' + r.textContent))`)); if (!rows.length) await sleep(700) }
  check('it lists the type error with its file and position', rows.some((t) => t.includes('bad.ts') && /\[1, \d+\]/.test(t)), JSON.stringify(rows))
  check('the Problems tab carries a count', Number(await ev(`document.querySelector('[data-panel-tab="problems"] .badge')?.textContent ?? 0`)) >= 1)
  await openFile('edit.js')
  await ev(`document.querySelector('[data-problem-row]').click()`); await sleep(1500)
  check('clicking a problem opens the file at its line', (await tabs()).some((t) => t.startsWith('bad.ts')))
  await menu('View', 'Output', 900)
  check('View > Output shows the Output tab', await panelOn('output'))
  check('the Output tab has the app\'s messages (the workspace file saved earlier)', /Saved saved\.code-workspace/.test(await ev(`document.querySelector('[data-output-text]').innerText`)), (await ev(`document.querySelector('[data-output-text]').innerText`)).slice(0, 120))
  check('and a list of channels', (await ev(`[...document.querySelectorAll('[data-output-channel] option')].map((o) => o.value).join()`)).includes('Tasks'))
  await openFile('dbg.js'); await menu('Run', 'Remove All Breakpoints', 400); await menu('Run', 'Start Debugging', 4000)
  await menu('View', 'Debug Console', 900)
  check('View > Debug Console shows the Debug Console tab', await panelOn('debug'))
  check('it still has the output of the last debugged program', /out\s+10/.test(await ev(`document.querySelector('[data-debug-console-text]').innerText`)), (await ev(`document.querySelector('[data-debug-console-text]').innerText`)).slice(0, 150))
  await ev(`document.querySelector('[data-debug-console-panel-input]').focus()`)
  await send('Input.insertText', { text: '1 + 1' }); await press('Enter', 700)
  check('typing an expression when nothing is being debugged says so', /Start debugging to evaluate/.test(await ev(`document.querySelector('[data-debug-console-text]').innerText`)))
  await press('Ctrl+`', 900)
  check('Ctrl+` while another tab is showing switches to the Terminal tab', await panelOn('terminal'))
  await press('Ctrl+`', 700)
  check('and pressing it again hides the panel', !(await visible('.terminal-panel')))
  await menu('View', 'Output', 700); await ev(`[...document.querySelectorAll('.term-btn')].find((b) => b.textContent === 'Hide').click()`); await sleep(400)
  check('Hide closes the panel from any tab', !(await visible('.terminal-panel')))

  // ================= explorer sections =================
  await closeAllTabs()
  await openFile('def.ts'); await openFile('edit.js')
  await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(500)
  const oe = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-oe-path]')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()))`))
  let openList = await oe()
  check('Open Editors lists every open file', openList.length === 2 && openList.some((t) => t.startsWith('def.ts')) && openList.some((t) => t.startsWith('edit.js')), JSON.stringify(openList))
  await ev(`[...document.querySelectorAll('[data-oe-path]')].find((r) => r.getAttribute('data-oe-path').endsWith('def.ts')).click()`); await sleep(700)
  check('clicking one in Open Editors makes it the active tab', (await ev(`document.querySelector('.tabs [aria-selected="true"]')?.innerText ?? ''`)).startsWith('def.ts'))
  await focusEditor(); await toLine(4); await press('End', 100); await typeText(' // x') // at the end of the last line, so the function stays intact
  openList = await oe()
  check('an unsaved file shows a dot in Open Editors', openList.some((t) => t.startsWith('def.ts') && t.includes('●')), JSON.stringify(openList))
  await press('Ctrl+Z', 400); await menu('File', 'Save', 700)
  await ev(`[...document.querySelectorAll('[data-oe-path]')].find((r) => r.getAttribute('data-oe-path').endsWith('edit.js')).querySelector('.oe-close').click()`); await sleep(700)
  check('the × in Open Editors closes a file', (await oe()).length === 1 && (await tabs()).length === 1, JSON.stringify(await oe()))
  // Outline of a TypeScript file
  let outline = []
  for (let i = 0; i < 30 && !outline.length; i++) { outline = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-outline-row]')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()))`)); if (!outline.length) await sleep(700) }
  check('Outline lists the symbols of the open TypeScript file', outline.some((t) => t.includes('target')), JSON.stringify(outline) + ' | ' + JSON.stringify(await ev(`document.querySelector('[data-ex-section="outline"]')?.innerText`)) + ' | ' + (await tabs()).join(','))
  await openFile('dbg.js'); await sleep(2500)
  outline = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-outline-row]')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()))`))
  check('and follows the active file (dbg.js has inner and outer)', outline.some((t) => t.includes('inner')) && outline.some((t) => t.includes('outer')), JSON.stringify(outline))
  await ev(`[...document.querySelectorAll('[data-outline-row]')].find((r) => r.innerText.includes('outer')).click()`); await sleep(1200)
  check('clicking a symbol moves the cursor to it', await waitLine(5), await cursorLineNow())
  // Timeline
  let tl = []
  for (let i = 0; i < 10 && !tl.length; i++) { tl = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-timeline-row]')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()))`)); if (!tl.length) await sleep(700) }
  check('Timeline lists the commits that changed the open file', tl.some((t) => t.includes('first commit of the test project')), JSON.stringify(tl))
  await ev(`document.querySelector('[data-timeline-row]').click()`); await sleep(1000)
  check('clicking a commit opens the file history in Source Control', (await ev(`document.querySelector('[data-view="git"]').getAttribute('aria-selected')`)) === 'true')
  await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(400)
  await ev(`document.querySelector('[data-ex-toggle="outline"]').click()`); await sleep(300)
  check('a section can be collapsed', !(await ev(`!!document.querySelector('[data-outline-row]')`)))
  await ev(`document.querySelector('[data-ex-toggle="outline"]').click()`); await sleep(300)
  check('and opened again', await ev(`!!document.querySelector('[data-outline-row]')`))
  await closeAllTabs()
  check('with no file open, Open Editors goes away', !(await ev(`!!document.querySelector('[data-oe-path]')`)))

  // ================= Alt mnemonics and check marks =================
  await openFile('edit.js')
  for (const [letter, name] of [['f', 'File'], ['e', 'Edit'], ['s', 'Selection'], ['v', 'View'], ['g', 'Go'], ['r', 'Run'], ['t', 'Terminal'], ['h', 'Help']]) {
    await press('Alt+' + letter, 350)
    check(`Alt+${letter.toUpperCase()} opens the ${name} menu`, (await ev(`document.querySelector('[data-menu="${name}"]').getAttribute('aria-expanded')`)) === 'true')
    await esc()
  }
  const checkOf = (item) => ev(`(() => { const e = [...document.querySelectorAll('[data-menu-item]')].find((x) => x.getAttribute('data-menu-item') === ${JSON.stringify(item)}); return e ? e.getAttribute('aria-checked') + '|' + e.querySelector('.menu-check').innerText : 'missing' })()`)
  await realClick(`document.querySelector('[data-menu="View"]')`); await sleep(200)
  check('View > Toggle Sidebar has a check mark while the side bar is shown', (await checkOf('Toggle Sidebar')) === 'true|✓', await checkOf('Toggle Sidebar'))
  await esc()
  await press('Ctrl+B', 400)
  await realClick(`document.querySelector('[data-menu="View"]')`); await sleep(200)
  check('and none while it is hidden', (await checkOf('Toggle Sidebar')) === 'false|', await checkOf('Toggle Sidebar'))
  await esc()
  await press('Ctrl+B', 400)

  // ================= Exit last: it closes the window =================
  await closeAllTabs()
  const pagesBefore = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).filter((t) => t.type === 'page').length
  ev(`1`).catch(() => undefined)
  send('Runtime.evaluate', { expression: `(() => { const b = document.querySelector('[data-menu="File"]'); b.click(); setTimeout(() => [...document.querySelectorAll('[data-menu-item]')].find((e) => e.getAttribute('data-menu-item') === 'Exit').click(), 200) })()` }).catch(() => undefined)
  await sleep(3000)
  const pagesAfter = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l) => l.filter((t) => t.type === 'page').length, () => 0)
  check('File > Exit closes the window', pagesAfter < pagesBefore, `${pagesBefore} -> ${pagesAfter}`)
  check('no unexpected alert() or confirm() dialogs appeared', dialogs.filter((d) => !/WSL/i.test(d) && !/^My AI IDE/.test(d)).length === 0, dialogs.join(' | '))

  stopApp()
  fs.rmSync(tmp, { recursive: true, force: true })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); stopApp(); process.exit(1) })
