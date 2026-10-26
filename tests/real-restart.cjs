// Real-API check that the agent's saved conversation survives quitting and relaunching the app:
// run the agent (Opus), quit, relaunch with the same app data, and ask something only answerable if the
// model got its earlier conversation (including its thinking blocks) back from disk.
// Uses ANTHROPIC_API_KEY from the environment and costs a few cents. Run `npm run dist` first.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { spawn, execSync } = require('child_process')
const WebSocket = require('ws')
const PROJ = path.join(os.tmpdir(), 'my-ai-ide-restart-project')
const PROFILE = path.join(os.tmpdir(), 'my-ai-ide-restart-profile')
const EXE = path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
const PORT = 9340
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 300) : ''}`) }

async function waitFor(fn, what, ms = 30000) {
  const t0 = Date.now()
  for (;;) {
    try { const v = await fn(); if (v) return v } catch (e) { if (/^app error/.test(e.message)) throw e }
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for: ' + what)
    await sleep(250)
  }
}

async function launch() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ANTHROPIC_BASE_URL
  const app = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', PROJ], { env, stdio: 'ignore' })
  const target = await waitFor(async () => {
    const list = await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))) }).on('error', rej))
    return list.find((t) => t.type === 'page')
  }, 'devtools')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  let id = 0; const pend = new Map()
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) } })
  const ev = (expression) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })) }).then((d) => d.result.result.value)
  await waitFor(() => ev(`document.querySelectorAll('.tree-row').length > 0`), 'app + folder')
  // Closing the window normally lets the app flush everything to disk (killing it would not).
  const quit = async () => { await ev('window.close()'); await new Promise((r) => { app.on('exit', r); setTimeout(r, 10000) }); try { ws.close() } catch {}; try { execSync(`taskkill /pid ${app.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
  return { ev, quit }
}

const VIS = `const vis = (e) => e && e.getClientRects().length > 0;`
const typeInto = (c, text) => c.ev(`(() => { ${VIS} const el = [...document.querySelectorAll('.chat textarea')].find(vis); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
const clickBtn = (c, text, scope = '.chat') => c.ev(`(() => { ${VIS} const b = [...document.querySelectorAll('${scope} button')].find(b => vis(b) && b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
const pickModel = (c, id) => c.ev(`(() => { ${VIS} const s = [...document.querySelectorAll('.chat select')].find(vis); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${id}'); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`)
const assistantCount = (c) => c.ev(`[...document.querySelectorAll('.chat-msg.assistant')].filter(m => m.getClientRects().length).length`)
const lastAssistant = (c) => c.ev(`([...document.querySelectorAll('.chat-msg.assistant')].filter(m => m.getClientRects().length).pop() || {}).textContent || ''`)
const errors = (c) => c.ev(`[...document.querySelectorAll('.chat-error')].map(e => e.textContent)`)

;(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.rmSync(PROJ, { recursive: true, force: true })
  fs.mkdirSync(PROJ, { recursive: true })
  fs.writeFileSync(path.join(PROJ, 'secret-note.txt'), 'zephyr is the codeword\n')

  // ---- First session ----
  let s = await launch()
  try {
    await clickBtn(s, 'Agent')
    console.log('model:', await pickModel(s, 'claude-opus-5-5'))
    await typeInto(s, 'Use your read_file tool to read secret-note.txt, then tell me the first word in it. Be brief.')
    await clickBtn(s, 'Send')
    const first = await waitFor(async () => { const e = await errors(s); if (e.length) throw new Error('app error: ' + e.join('|')); const t = await lastAssistant(s); const idle = await s.ev(`!document.body.textContent.includes('Working')`); return idle && /zephyr/i.test(t) && t }, 'first answer mentions zephyr', 120000)
    check('session 1: agent read the file and answered', !!first, first)
    await sleep(1500) // the panel saves shortly after a run ends
  } finally { await s.quit() }

  const agentDir = path.join(PROFILE, 'agent')
  check('conversation files were written to disk', fs.existsSync(agentDir) && fs.readdirSync(agentDir).length === 2, fs.existsSync(agentDir) ? fs.readdirSync(agentDir).join(',') : 'no folder')
  const memFile = fs.readdirSync(agentDir).find((f) => !f.includes('.ui.'))
  // Saved conversations are encrypted with Windows (safeStorage) when it is available: then the file is "AIDE1" + the encrypted bytes,
  // which only the app can read (the second session below proves it can); otherwise it is plain JSON.
  const raw = fs.readFileSync(path.join(agentDir, memFile))
  if (raw.subarray(0, 5).toString() === 'AIDE1') check('the saved conversation is encrypted (the codeword is not in the file)', !raw.toString('latin1').includes('zephyr'))
  else {
    const saved = JSON.parse(raw.toString('utf8'))
    console.log('  saved message blocks:', saved.messages.map((m) => m.role + ':' + (typeof m.content === 'string' ? 'text' : m.content.map((b) => b.type).join('+'))).join(' | '))
  }

  // ---- Second session: same app data ----
  s = await launch()
  try {
    await clickBtn(s, 'Agent')
    console.log('model:', await pickModel(s, 'claude-opus-5-5'))
    const restored = await waitFor(async () => (await s.ev(`[...document.querySelectorAll('.chat-msg.user')].some(m => m.textContent.includes('secret-note.txt'))`)), 'restored transcript')
    check('session 2: the earlier conversation is shown again', restored)
    // The restored transcript already contains an answer mentioning the word, so wait for a NEW assistant message.
    const before = await assistantCount(s)
    await typeInto(s, 'Without using any tools: what was the codeword in the file you read earlier? Answer with just the word.')
    await clickBtn(s, 'Send')
    const second = await waitFor(async () => { const e = await errors(s); if (e.length) throw new Error('app error: ' + e.join('|')); const idle = await s.ev(`!document.body.textContent.includes('Working')`); if (!idle || (await assistantCount(s)) <= before) return false; const t = await lastAssistant(s); return /zephyr/i.test(t) && t }, 'new answer mentions zephyr', 120000)
    check('session 2: the model remembered the file from before the restart (history accepted by the real API)', !!second, second)
    check('no error shown', (await errors(s)).length === 0)
  } catch (e) { check('second session completed', false, e.message) } finally { await s.quit() }

  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.rmSync(PROJ, { recursive: true, force: true })
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('ERR', e.message); try { execSync('taskkill /im "My AI IDE.exe" /T /F', { stdio: 'ignore' }) } catch {} process.exit(1) })

