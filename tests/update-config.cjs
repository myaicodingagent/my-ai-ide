// The build as shipped has no update source (the owner in electron-builder.yml is a placeholder), so the
// app must say so plainly and never try the network. Run `npm run dist` first.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { spawn, execSync } = require('child_process')
const WebSocket = require('ws')
const EXE = path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
const PROFILE = path.join(os.tmpdir(), 'my-ai-ide-updatecfg-profile')
const PORT = 9341
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`) }
async function waitFor(fn, what, ms = 20000) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v } catch {} if (Date.now() - t0 > ms) throw new Error('Timed out waiting for: ' + what); await sleep(200) } }

;(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.MY_AI_IDE_UPDATE_URL
  const app = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' })
  try {
    const target = await waitFor(async () => (await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))) }).on('error', rej))).find((t) => t.type === 'page'), 'devtools')
    const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r))
    let id = 0; const pend = new Map()
    ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) } })
    const ev = (expression) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })) }).then((d) => d.result.result.value)
    if (!fs.readFileSync(path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app-update.yml'), 'utf8').includes('YOUR_GITHUB_USER')) { console.log('SKIP  update source is configured, so the unconfigured-build checks do not apply'); process.exit(0) }
    await waitFor(() => ev(`!!document.querySelector('.statusbar')`), 'app ready')
    await ev(`[...document.querySelectorAll('.statusbar button')].find(b => b.textContent.trim() === 'Settings').click()`)
    await waitFor(() => ev(`!!document.querySelector('button[data-setting="updateCheck"]')`), 'settings open')
    await ev(`document.querySelector('button[data-setting="updateCheck"]').click()`)
    const text = await waitFor(async () => { const t = await ev(`document.querySelector('[data-setting="updateText"]')?.textContent || ''`); return /not set up/.test(t) && t }, 'unconfigured message')
    check('a build without an update source says so instead of checking', !!text, text)
    check('no update button appears in the status bar', !(await ev(`!!document.querySelector('.sb-update')`)))
    check('the shipped update config still has the placeholder owner', fs.readFileSync(path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app-update.yml'), 'utf8').includes('YOUR_GITHUB_USER'))
    try { ws.close() } catch {}
  } catch (e) { check('run completed', false, e.message) }
  finally { try { execSync(`taskkill /pid ${app.pid} /T /F`, { stdio: 'ignore' }) } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {} }
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})()
