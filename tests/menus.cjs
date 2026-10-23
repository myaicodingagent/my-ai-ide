// Drives the running app (started with --remote-debugging-port) and uses every menu-bar entry that can be checked
// from the page. Usage: node tests/menus.cjs <port>. Start the app on a throwaway folder first, see the README.
const WebSocket = require('ws')
const port = process.argv[2] || '9444'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 200) : ''}`) }

;(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  let id = 0; const pend = {}
  const dialogs = []
  ws.on('message', (d) => {
    const m = JSON.parse(d)
    if (pend[m.id]) pend[m.id](m)
    // alert() / confirm() block the page; note what they said and dismiss them.
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message)
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }))
    }
  })
  ws.send(JSON.stringify({ id: ++id, method: 'Page.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } })) // the page counts as focused even if another window is in front
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method + ' (the page is stuck)')), 15000); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value }
  const key = async (k, mods = 0, code) => {
    const base = { key: k, code: code ?? k, modifiers: mods, windowsVirtualKeyCode: { Escape: 27, Enter: 13, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[k] ?? 0 }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  const esc = async () => { await key('Escape'); await sleep(250) }
  // Real mouse clicks (not element.click()), so clipboard commands see a genuine user gesture.
  const center = async (sel) => JSON.parse(await ev(`(() => { const r = ${sel}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
  const realClick = async (sel) => {
    const { x, y } = await center(sel)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const menu = async (top, item, wait = 800) => {
    await realClick(`document.querySelector('[data-menu="${top}"]')`)
    await sleep(150)
    const sel = `[...document.querySelectorAll('[data-menu-item]')].find((e) => e.getAttribute('data-menu-item') === ${JSON.stringify(item)})`
    if (!(await ev(`!!(${sel})`))) return false
    await realClick(sel)
    await sleep(wait)
    return true
  }
  const text = () => ev(`document.querySelector('.monaco-editor .view-lines')?.innerText.replace(/\\u00a0/g, ' ') ?? ''`)
  const lines = async () => (await text()).split('\n').filter((l) => l.length >= 0).length
  const visible = (sel) => ev(`!!(document.querySelector(${JSON.stringify(sel)})?.offsetParent)`)
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(200)
  }

  await ev(`document.querySelector('[data-view="files"]').click()`)
  await sleep(500)
  check('the app opened the throwaway folder', (await ev(`document.body.innerText`)).includes('sample.js'))
  await ev(`[...document.querySelectorAll('.tree-row')].find((r) => r.innerText.includes('sample.js')).click()`)
  await sleep(3500) // the language service starts on the first file
  const rect = JSON.parse(await ev(`JSON.stringify(document.querySelector('.monaco-editor .view-lines').getBoundingClientRect())`))
  const pitch = JSON.parse(await ev(`(() => { const l = [...document.querySelectorAll('.monaco-editor .view-line')].map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top); return JSON.stringify({ top: l[0].top, h: l[1].top - l[0].top }) })()`))
  const lineY = (n) => Math.round(pitch.top + pitch.h / 2 + (n - 1) * pitch.h)
  await clickAt(rect.left + 200, lineY(1))
  const original = await text()
  check('the sample file is open in the editor', /function a\(\)/.test(original), original)

  // ---- every menu has the entries we expect
  const wanted = {
    File: ['New File…', 'Open Folder…', 'Open Recent…', 'Save', 'Save All', 'Close Editor', 'Settings', 'Exit'],
    Edit: ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Find', 'Replace', 'Find in Files', 'Toggle Line Comment', 'Format Document'],
    Selection: ['Select All', 'Expand Selection', 'Copy Line Down', 'Move Line Down', 'Add Cursor Below'],
    View: ['Command Palette…', 'Explorer', 'Search', 'Source Control', 'Run and Debug', 'Extensions', 'Agents', 'AI Chat', 'Terminal', 'Toggle Sidebar'],
    Go: ['Go to File…', 'Go to Symbol in File…', 'Go to Line…', 'Go to Definition'],
    Run: ['Start Debugging', 'Stop Debugging', 'Step Over', 'Toggle Breakpoint', 'Attach to Node.js Program…'],
    Terminal: ['New Terminal', 'Run Task…', 'Toggle Terminal'],
    Help: ['Show All Commands', 'Toggle Developer Tools', 'About My AI IDE']
  }
  for (const [top, names] of Object.entries(wanted)) {
    await ev(`document.querySelector('[data-menu="${top}"]').click()`)
    await sleep(100)
    const have = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-menu-item]')].map((e) => e.getAttribute('data-menu-item')))`))
    check(`the ${top} menu lists its entries`, names.every((n) => have.includes(n)), have.join(', '))
    await esc()
  }
  check('Escape closes an open menu', !(await visible('.menu-drop')))
  await ev(`document.activeElement.blur()`)

  // ---- Edit
  await clickAt(rect.left + 200, lineY(1))
  await menu('Selection', 'Select All')
  await menu('Edit', 'Cut')
  check('Edit > Cut removes the selected text', (await text()).trim() === '', JSON.stringify(await text()))
  await menu('Edit', 'Paste')
  check('Edit > Paste puts it back', (await text()) === original, JSON.stringify(await text()))
  await menu('Edit', 'Undo')
  check('Edit > Undo undoes the paste', (await text()).trim() === '', JSON.stringify(await text()))
  await menu('Edit', 'Redo')
  check('Edit > Redo does it again', (await text()) === original, JSON.stringify(await text()))
  await menu('Edit', 'Find', 700)
  check('Edit > Find opens the find box', await visible('.monaco-editor .find-widget.visible'))
  await esc()
  await menu('Edit', 'Replace', 700)
  check('Edit > Replace opens the find box with the replace field', await visible('.monaco-editor .find-widget .replace-input textarea, .monaco-editor .find-widget .replace-part'))
  await esc()
  await clickAt(rect.left + 200, lineY(4))
  await menu('Edit', 'Toggle Line Comment')
  check('Edit > Toggle Line Comment comments the line', /\/\/ ?const b = 2/.test(await text()), JSON.stringify(await text()))
  await menu('Edit', 'Toggle Line Comment')
  check('and a second time uncomments it', !/\/\//.test(await text()), JSON.stringify(await text()))

  // ---- Selection
  await menu('Selection', 'Copy Line Down')
  check('Selection > Copy Line Down duplicates the line', (await text()).split('\n').filter((l) => /const b = 2/.test(l)).length === 2, JSON.stringify(await text()))
  await menu('Edit', 'Undo')
  await clickAt(rect.left + 200, lineY(1)); await key('Home', 2, 'Home'); for (let i = 0; i < 3; i++) await key('ArrowDown', 0, 'ArrowDown') // line 4
  const beforeMove = JSON.stringify(await text())
  await menu('Selection', 'Move Line Up')
  const moved = (await text()).split('\n')
  check('Selection > Move Line Up moves the selected line(s) up', moved.join('\n') !== beforeMove && moved.findIndex((l) => /const b = 2/.test(l)) < moved.findIndex((l) => /^}/.test(l)), beforeMove + ' => ' + JSON.stringify(moved))
  await menu('Edit', 'Undo')
  await menu('Selection', 'Add Cursor Below')
  check('Selection > Add Cursor Below gives two cursors', (await ev(`document.querySelectorAll('.monaco-editor .cursors-layer .cursor').length`)) >= 2)
  await clickAt(rect.left + 200, lineY(2))
  await menu('Selection', 'Expand Selection')
  check('Selection > Expand Selection selects something', (await ev(`document.querySelectorAll('.monaco-editor .selected-text').length`)) > 0)
  await clickAt(rect.left + 200, lineY(1))

  // ---- Go
  await menu('Go', 'Go to Line…', 700)
  check('Go > Go to Line opens its box', await visible('.quick-input-widget'))
  await esc()
  await menu('Go', 'Go to Symbol in File…', 700)
  check('Go > Go to Symbol opens its box', await visible('.quick-input-widget'))
  await esc()
  await menu('Go', 'Go to File…', 500)
  check('Go > Go to File opens the file picker', await visible('.qp'))
  await esc()

  // ---- View
  await menu('View', 'Command Palette…')
  check('View > Command Palette opens the palette', await visible('.qp'))
  await esc()
  for (const [item, view] of [['Search', 'search'], ['Source Control', 'git'], ['Run and Debug', 'debug'], ['Extensions', 'ext'], ['Agents', 'agents'], ['Explorer', 'files']]) {
    await menu('View', item, 600)
    check(`View > ${item} shows that side bar view`, (await ev(`document.querySelector('[data-view="${view}"]').getAttribute('aria-selected')`)) === 'true')
  }
  await menu('View', 'Toggle Sidebar')
  check('View > Toggle Sidebar hides it', (await ev(`document.querySelector('.sidebar').classList.contains('hidden')`)) === true)
  await menu('View', 'Toggle Sidebar')
  check('and shows it again', (await ev(`document.querySelector('.sidebar').classList.contains('hidden')`)) === false)
  const chatBefore = await visible('aside.chat')
  await menu('View', 'AI Chat')
  check('View > AI Chat toggles the chat panel', (await visible('aside.chat')) !== chatBefore)
  await menu('View', 'AI Chat')
  const groupsBefore = await ev(`document.querySelectorAll('.monaco-editor').length`)
  await menu('View', 'Split Editor Right', 800)
  check('View > Split Editor Right opens a second editor', (await ev(`document.querySelectorAll('.monaco-editor').length`)) > groupsBefore)
  await menu('View', 'Close Split Editor', 600)
  check('View > Close Split Editor closes it', (await ev(`document.querySelectorAll('.monaco-editor').length`)) === groupsBefore)
  const zoom0 = await ev('window.innerWidth')
  await menu('View', 'Zoom In')
  const zoom1 = await ev('window.innerWidth')
  check('View > Zoom In makes the page larger (fewer CSS pixels fit)', zoom1 < zoom0, `${zoom0} -> ${zoom1}`)
  await menu('View', 'Reset Zoom')

  // ---- Terminal
  await menu('Terminal', 'New Terminal', 1500)
  check('Terminal > New Terminal opens the terminal panel', await visible('.terminal-panel'))
  await menu('Terminal', 'Toggle Terminal')
  check('Terminal > Toggle Terminal hides it', !(await visible('.terminal-panel')))
  await menu('Terminal', 'Run Task…', 700)
  check('Terminal > Run Task opens the task list', await visible('.qp'))
  await esc()

  // ---- Run
  await menu('Run', 'Attach to Node.js Program…', 600)
  check('Run > Attach opens its dialog', await visible('.input-dialog'))
  await esc()
  await clickAt(rect.left + 200, lineY(2))
  await menu('Run', 'Toggle Breakpoint', 600)
  check('Run > Toggle Breakpoint puts a breakpoint on the line', (await ev(`document.querySelectorAll('[class*="breakpoint"], [class*="dbg-bp"]').length`)) > 0)
  await menu('Run', 'Remove All Breakpoints', 400)
  await menu('Run', 'Start Debugging', 3000)
  check('Run > Start Debugging switches to Run and Debug and runs the file', (await ev(`document.querySelector('[data-view="debug"]').getAttribute('aria-selected')`)) === 'true' && /Paused|ended|exited|result/i.test(await ev(`document.querySelector('.sidebar').innerText`)), (await ev(`document.querySelector('.sidebar').innerText`)).slice(0, 120))
  await menu('Run', 'Stop Debugging', 400)

  // ---- File and Help
  await menu('File', 'New File…', 600)
  check('File > New File asks for a name', await visible('.input-dialog'))
  await esc()
  await menu('File', 'Open Recent…', 600)
  check('File > Open Recent opens a list', await visible('.qp'))
  await esc()
  await menu('File', 'Settings', 700)
  check('File > Settings opens the settings dialog', (await ev(`document.body.innerText`)).includes('Reset to defaults'))
  await esc()
  await menu('File', 'Color Theme', 600)
  check('File > Color Theme opens the theme list', await visible('.qp'))
  await esc()
  await menu('File', 'Open Folder over SSH…', 600)
  check('File > Open Folder over SSH asks for the computer', await visible('.input-dialog'))
  await esc()
  await menu('Help', 'Show All Commands', 500)
  check('Help > Show All Commands opens the palette', await visible('.qp'))
  await esc()
  await menu('Help', 'Account…', 700)
  check('Help > Account opens the account dialog', await visible('[data-account-dialog]'))
  await esc()

  // ---- keyboard use of the menu bar
  await ev(`document.querySelector('[data-menu="File"]').click()`)
  await sleep(150)
  await key('ArrowRight'); await sleep(150)
  check('ArrowRight moves from File to Edit', (await ev(`document.querySelector('[data-menu="Edit"]').getAttribute('aria-expanded')`)) === 'true')
  await key('ArrowDown'); await key('ArrowDown'); await sleep(150)
  check('ArrowDown highlights an entry', await visible('.menu-item.hi'))
  await esc()

  check('no unexpected alert() or confirm() dialogs appeared', dialogs.length === 0, dialogs.join(' | '))
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
