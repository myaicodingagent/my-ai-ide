// A language server for a folder in a WSL distribution, in the real app: the server (pylsp) runs inside Ubuntu-24.04 (install python3-pylsp there) and the editor shows its errors, hover and go to
// definition for a file in the distribution, opened as \wsl.localhost<distro>... `npm run test:lsp-wsl`: skipped unless that distribution exists. Starts the app itself.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }
const run = (cmd, args, opts = {}) => cp.spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true, ...opts })

;(async () => {
  const distro = process.env.WSL_TEST_DISTRO || 'Ubuntu-24.04'
  const wx = (script) => run('wsl.exe', ['-d', distro, '--user', 'root', '--', 'bash', '-c', script])
  if (wx('command -v pylsp').status !== 0) { console.log('SKIP  needs the WSL distribution ' + distro + ' with pylsp (apt install python3-pylsp)'); process.exit(0) }

  const tmp = path.join(os.tmpdir(), 'lsp-wsl-' + process.pid)
  fs.rmSync(tmp, { recursive: true, force: true })
  const data = path.join(tmp, 'data')
  fs.mkdirSync(data, { recursive: true })
  wx('mkdir -p /root/lspwsl/uilsp && cat > /root/lspwsl/uilsp/app.py <<"EOF"\nimport os\n\ndef greet(name):\n    """Say hi to someone."""\n    return "hi " + name\n\nx = greet("a")\nprint(undefined_name)\nEOF\nchown -R tester:tester /root/lspwsl')
  let unc = ''

  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const port = 9794
  const app = cp.spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${data}`], { cwd: path.join(__dirname, '..'), env, shell: true, stdio: 'ignore', windowsHide: true })
  const stopApp = () => { try { cp.execSync('taskkill /F /T /PID ' + app.pid, { stdio: 'ignore' }) } catch { /* gone */ } try { cp.execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }) } catch { /* none */ } }
  try {
    let list
    for (let i = 0; i < 60; i++) { list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null); if (list && list.some((t) => t.type === 'page')) break; await sleep(2000) }
    if (!list) throw new Error('the app did not start')
    await sleep(5000)
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((r) => ws.on('open', r))
    let id = 0; const pend = {}
    ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m); if (m.method === 'Page.javascriptDialogOpening') { console.log('DIALOG', m.params.message); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } })) } })
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 30000); ws.send(JSON.stringify({ id: i, method, params })) })
    for (const m of ['Page.enable', 'Runtime.enable']) ws.send(JSON.stringify({ id: ++id, method: m }))
    ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
    const waitFor = async (fn, ms = 40000, step = 700) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step) } }
    const mouse = async (x, y, type = 'click') => { if (type === 'move') return void (await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })); for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 }) }
    const center = async (sel) => JSON.parse(await ev(`(() => { const r = ${sel}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
    const realClick = async (sel) => { const { x, y } = await center(sel); await mouse(x, y) }
    const key$ = async (k, vk) => { for (const t of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }) }
    const menu = async (top, item, wait = 900) => { await realClick(`document.querySelector('[data-menu="${top}"]')`); await sleep(150); await realClick(`[...document.querySelectorAll('[data-menu-item]')].find((e) => e.getAttribute('data-menu-item') === ${JSON.stringify(item)})`); await sleep(wait) }
    const wordAt = async (lineContains, word) => JSON.parse(await ev(`(() => {
      const line = [...document.querySelectorAll('.monaco-editor .view-line')].find((l) => l.innerText.replace(/\\u00a0/g, ' ').includes(${JSON.stringify(lineContains)}))
      if (!line) return 'null'
      const flat = line.innerText.replace(/\\u00a0/g, ' '); const idx = flat.indexOf(${JSON.stringify(word)}); if (idx < 0) return 'null'
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let offset = 0, node
      while ((node = walker.nextNode())) { const len = node.textContent.length; if (idx < offset + len) { const r = document.createRange(); const s = idx - offset; r.setStart(node, s); r.setEnd(node, Math.min(len, s + ${word.length})); const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 }) } offset += len }
      return 'null' })()`))
    const cursorLine = () => ev(`(() => { const lines = [...document.querySelectorAll('.monaco-editor .view-line')].map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top); const cur = document.querySelector('.monaco-editor .current-line')?.getBoundingClientRect(); if (!cur || lines.length < 2) return -1; return Math.round((cur.top - lines[0].top) / (lines[1].top - lines[0].top)) + 1 })()`)
    const problems = () => ev(`JSON.stringify([...document.querySelectorAll('[data-problem-row]')].map((r) => r.innerText.replace(/\\s+/g, ' ')))`).then((s) => JSON.parse(s || '[]'))

    unc = String.fromCharCode(92, 92) + 'wsl.localhost' + String.fromCharCode(92) + distro + ['', 'root', 'lspwsl', 'uilsp'].join(String.fromCharCode(92))
    await ev(`localStorage.setItem('recent-folders', JSON.stringify([${JSON.stringify(unc)}]))`)
    await send('Page.reload'); await sleep(5000)
    await waitFor(() => ev(`!!document.querySelector('[data-recent]')`), 30000)
    await ev(`document.querySelector('[data-recent]').click()`)
    check('the folder opens, listing app.py', await waitFor(() => ev(`[...document.querySelectorAll('.tree-row')].some((e) => (e.getAttribute('data-tree-path') || '').endsWith('app.py'))`), 40000))
    await ev(`[...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').endsWith('app.py'))?.click()`)
    await sleep(2000)
    const r = JSON.parse(await ev(`JSON.stringify(document.querySelector('.monaco-editor .view-lines').getBoundingClientRect())`))
    await mouse(r.left + 60, r.top + 8)
    check('the status bar names the Python language server, running in the distribution', await waitFor(() => ev(`/Python/.test(document.querySelector('[data-sb="lsp"]')?.innerText ?? '')`), 90000))
    await menu('View', 'Problems', 800)
    const probs = await waitFor(async () => { const p = await problems(); return p.some((t) => /undefined_name/.test(t)) && p }, 90000)
    check('the server\'s errors are in the Problems panel (undefined_name, and the unused import)', !!probs && probs.some((t) => /imported but unused/.test(t)), JSON.stringify(probs))
    let hov = ''
    const hw = await wordAt('x = greet', 'greet')
    await mouse(hw.x - 60, hw.y - 40, 'move'); await sleep(200); await mouse(hw.x, hw.y, 'move')
    for (let i = 0; i < 30 && !/Say hi/.test(hov); i++) { await sleep(500); hov = await ev(`[...document.querySelectorAll('.monaco-hover')].map((h) => h.innerText).join(' ').replace(/\\u00a0/g, ' ')`) }
    check('hovering over greet shows its documentation', /Say hi to someone/.test(hov), hov)
    await key$('Escape', 27); await sleep(200)
    const g2 = await wordAt('x = greet', 'greet')
    await mouse(g2.x, g2.y); await sleep(300); await key$('F12', 123)
    check('F12 on greet goes to its definition (line 3), in the same file in the distribution', await waitFor(async () => (await cursorLine()) === 3, 10000, 400), await cursorLine())
    check('and no second tab was opened for it', (await ev(`[...document.querySelectorAll('.tabs [role="tab"]')].filter((t) => t.innerText.includes('app.py')).length`)) === 1)
    const out = await ev(`(async () => { await new Promise((r) => setTimeout(r, 100)); return 1 })()`)
    void out
    check('the processes in the distribution are the language server only (no stray ones)', wx('pgrep -f "[p]ylsp" | wc -l').stdout.trim() === '1', wx('pgrep -af "[p]ylsp"').stdout)
    stopApp()
    await sleep(2500)
    check('closing the app ends the language server in the distribution', await waitFor(async () => wx('pgrep -f "[p]ylsp" | wc -l').stdout.trim() === '0', 20000, 1000), wx('pgrep -af "[p]ylsp"').stdout)
  } finally { stopApp(); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) } catch { /* temp */ } }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
