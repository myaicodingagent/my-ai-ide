// What a screen reader says: the packaged app is driven with REAL key presses while NVDA (a portable copy, with the "no speech"
// synthesizer so nothing is spoken aloud) writes everything it would say into its log; the test reads that log. This is a machine
// check of the words NVDA gets from the app (names, roles, states, announcements); it is not an audit by a person, and it does not
// cover JAWS or Narrator.
// `npm run test:nvda`: skipped unless NVDA is found (NVDA_EXE, or C:\Projects\tools\nvda\portable\nvda.exe: make one by running
// the installer from nvaccess.org with --create-portable-silent --portable-path=<folder>), the packaged app exists (MY_AI_IDE_EXE or
// release\win-unpacked) and no other NVDA is running. It takes the keyboard for about a minute: the app comes to the front and
// receives the keys, so do not type meanwhile. NVDA's own log: <temp>\nvda-test\nvda.log.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + String(detail).slice(0, 700)}`) }
const NVDA = process.env.NVDA_EXE || 'C:\\Projects\\tools\\nvda\\portable\\nvda.exe'
const EXE = process.env.MY_AI_IDE_EXE || path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
if (process.platform !== 'win32') { console.log('SKIP  NVDA runs on Windows'); process.exit(0) }
if (!fs.existsSync(NVDA)) { console.log('SKIP  NVDA is not at ' + NVDA + ' (set NVDA_EXE)'); process.exit(0) }
if (!fs.existsSync(EXE)) { console.log('SKIP  no packaged app at ' + EXE); process.exit(0) }
const running = cp.spawnSync('tasklist', ['/FI', 'IMAGENAME eq nvda.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf-8' }).stdout
if (/nvda\.exe/i.test(running)) { console.log('SKIP  NVDA is already running; close it first (this test starts its own copy)'); process.exit(0) }

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nvda-test-')))
const cfg = path.join(tmp, 'config'), LOG = path.join(tmp, 'nvda.log')
fs.mkdirSync(cfg, { recursive: true })
fs.writeFileSync(path.join(cfg, 'nvda.ini'), ['[general]', '\tloggingLevel = IO', '\tshowWelcomeDialogAtStartup = False', '\taskToExit = False', '\tplayStartAndExitSounds = False', '[speech]', '\tsynth = silence', '[update]', '\tautoCheckForUpdates = False', '\tstartupNotification = False', ''].join('\r\n'))
const proj = path.join(tmp, 'proj')
fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
fs.writeFileSync(path.join(proj, 'a.txt'), 'hello world\nsecond line\n')
fs.writeFileSync(path.join(proj, 'src', 'b.ts'), 'export const b = 1\n')
for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first']]) cp.execFileSync('git', a, { cwd: proj, stdio: 'ignore' })
fs.writeFileSync(path.join(proj, 'a.txt'), 'hello world\nsecond line\nthird line\n') // a change git shows

const procs = []
const stopAll = () => { for (const p of procs) { try { cp.execSync('taskkill /F /T /PID ' + p.pid, { stdio: 'ignore' }) } catch { /* gone */ } } }
const norm = (s) => s.replace(/LangChangeCommand \('[a-z-]+'\), /g, '').replace(/, CancellableSpeech \(still valid\)/g, '').replace(/CallbackCommand\(name=[^)]*\)/g, '')
/** Everything NVDA said since a point in its log: one string per utterance, its parts joined with " | ". */
const spoken = (offset) => [...fs.readFileSync(LOG, 'utf-8').slice(offset).matchAll(/Speaking \[(.*)\]\s*$/gm)].map((m) => [...norm(m[1]).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((x) => (x[1] ?? x[2]).replace(/\\n/g, ' ').replace(/\\\\/g, '\\')).join(' | '))

;(async () => {
  try {
    procs.push(cp.spawn(NVDA, ['-c', cfg, `--log-file=${LOG}`, '--log-level=12', '--minimal', '--disable-addons'], { stdio: 'ignore', windowsHide: true }))
    for (let i = 0; i < 60 && !(fs.existsSync(LOG) && /NVDA initialized/.test(fs.readFileSync(LOG, 'utf-8'))); i++) await sleep(500)
    check('NVDA starts with the silent synthesizer and writes what it would say to a log', /Loaded synthDriver silence/.test(fs.readFileSync(LOG, 'utf-8')) && /NVDA initialized/.test(fs.readFileSync(LOG, 'utf-8')))
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const app = cp.spawn(EXE, ['--remote-debugging-port=9815', `--user-data-dir=${path.join(tmp, 'data')}`, proj], { env, stdio: 'ignore' })
    procs.push(app)
    let list
    for (let i = 0; i < 60; i++) { list = await fetch('http://127.0.0.1:9815/json/list').then((r) => r.json()).catch(() => null); if (list && list.some((t) => t.type === 'page')) break; await sleep(1000) }
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((r) => ws.on('open', r))
    let id = 0; const pend = {}
    ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m) })
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method, params })) })
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
    for (let i = 0; i < 60 && !(await ev(`!!document.querySelector('.tree-row[data-tree-path$="a.txt"]')`)); i++) await sleep(500)
    await sleep(2500)
    // The window has to be the one in front, or the keys go elsewhere (something else may take the front in between: it is done again before every step).
    const activate = async () => {
      await send('Page.bringToFront')
      cp.spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate(${app.pid})`])
      await sleep(400)
    }
    await activate()
    await sleep(1000)
    const keys = (k) => cp.spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${k}')`])
    let where = ''
    const said = async (action, wait = 1600) => {
      await activate()
      const off = fs.statSync(LOG).size
      await action()
      await sleep(wait)
      where = await ev(`(() => { const a = document.activeElement; return a ? a.tagName + '.' + String(a.className).slice(0, 40) + '[' + (a.getAttribute('role') || '') + '|' + (a.getAttribute('aria-label') || '').slice(0, 30) + '] menu:' + !!document.querySelector('[data-menu-item]') + ' dlg:' + !!document.querySelector('[role=dialog],[role=alertdialog]') : 'none' })()`)
      return spoken(off)
    }
    const has = (heard, ...words) => words.every((w) => heard.some((u) => u.toLowerCase().includes(w.toLowerCase())))

    check('Chromium reports that a screen reader is running, so the editor and terminal switch to their screen reader mode', await ev(`window.api.screenReaderActive()`) === true)

    // ---- the explorer
    let h = await said(() => ev(`document.querySelector('.tree-row').focus()`))
    check('the explorer is announced as a tree, and its first row is a folder with its level and state', has(h, 'tree view', 'src', 'collapsed', 'level 1'), JSON.stringify(h) + ' @ ' + where)
    check('a row is not followed by its full path', !h.some((u) => /[A-Za-z]:\\|nvda-test/.test(u)), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('{DOWN}'))
    check('the next row says its name, its place in the list and the change git sees', has(h, 'a.txt', '2 of 2', 'modified'), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('{ENTER}'))
    check('opening a file says so', has(h, 'Opened a.txt'), JSON.stringify(h) + ' @ ' + where)

    // ---- the editor
    h = await said(() => ev(`document.querySelector('.monaco-editor textarea').focus()`))
    check('the editor is announced with the file it shows and its first line', has(h, 'editor', 'a.txt', 'hello world'), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('{DOWN}'))
    check('the arrow keys read the line the caret moves to', has(h, 'second line'), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('qz'))
    check('typing is echoed', has(h, 'q') && has(h, 'z'), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('^s'))
    check('saving says "Saved"', has(h, 'Saved a.txt'), JSON.stringify(h) + ' @ ' + where)

    // ---- the command palette
    h = await said(() => keys('^+p'))
    check('the command palette is a dialog with a name, and its list says how many entries there are', has(h, 'Type a command', 'dialog') && has(h, 'of'), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('{DOWN}'))
    check('moving in the list reads the entry and its place', h.some((u) => /\d+ of \d+/.test(u)), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('{ESC}'))
    check('Escape leads back to the editor', has(h, 'Editor'), JSON.stringify(h) + ' @ ' + where)

    // ---- the activity bar
    h = await said(() => ev(`document.querySelector('.activity-btn').focus()`))
    check('the activity bar is a set of tabs, with the selected one and its position', has(h, 'Side bar views', 'tab', 'selected', 'of 6'), JSON.stringify(h) + ' @ ' + where)

    // ---- the menu bar: Alt+F opens File
    await ev(`document.querySelector('.monaco-editor textarea').focus()`); await sleep(500)
    h = await said(() => keys('%f'))
    check('Alt+F opens the File menu and its first entry is read', has(h, 'File') && h.some((u) => /menu/i.test(u)) , JSON.stringify(h) + ' @ ' + where)
    await said(() => keys('{ESC}'), 600)

    // ---- settings
    await ev(`document.querySelector('.monaco-editor textarea').focus()`); await sleep(500)
    h = await said(() => keys('^,'))
    check('Settings is a dialog with a name', has(h, 'Settings', 'dialog'), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('{TAB}'))
    check('Tab goes through the controls, saying what each one is', h.length > 0 && h.some((u) => /combo box|check box|button|edit|slider|spin/i.test(u)), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('{ESC}'))
    check('Escape closes it and returns to the editor', has(h, 'Editor'), JSON.stringify(h) + ' @ ' + where)

    // ---- search results are announced
    h = await said(() => keys('^+f'), 1200)
    check('Find in files focuses its box and names it', has(h, 'Search', 'edit'), JSON.stringify(h) + ' @ ' + where)
    h = await said(() => keys('hello{ENTER}'), 2500)
    check('the number of results is announced', h.some((u) => /\d+ results? in \d+ files?/.test(u)), JSON.stringify(h) + ' @ ' + where)

    // ---- source control
    h = await said(() => keys('^+g'), 1800)
    check('Source Control (Ctrl+Shift+G) puts the focus in its commit message box and names it', has(h, 'Side bar') && has(h, 'Message', 'edit'), JSON.stringify(h).slice(0, 500) + ' @ ' + where)
  } catch (e) {
    check('test run completed without exception', false, e.message)
  } finally {
    stopAll()
    await sleep(1500)
    try { cp.execSync('taskkill /F /IM nvda.exe', { stdio: 'ignore' }) } catch { /* not running */ } // (only the copy this test started can be running: it refused to start otherwise)
    if (process.env.NVDA_KEEP_LOG) console.log('NVDA log kept at ' + LOG)
    else try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})()
