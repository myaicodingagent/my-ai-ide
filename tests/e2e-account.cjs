// End-to-end test of signing in: the packaged app started WITHOUT a developer key, talking to a fake of our service.
// Run `npm run dist` first, then `npm run test:e2e-account`. It never contacts the real service or the model provider.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

const PROJ = path.join(os.tmpdir(), 'my-ai-ide-e2e-account-project')
const PROFILE = path.join(os.tmpdir(), 'my-ai-ide-e2e-account-profile')
const EXE = path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
const SERVICE_PORT = 8791, CDP_PORT = 9334

// ---------- a fake of the service ----------
const log = []
let approved = false
let planActive = true
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const b = body ? JSON.parse(body) : null
    log.push({ url: req.url, auth: req.headers.authorization, device: req.headers['x-device-id'], body: b })
    if (req.url === '/api/device/start') return json(res, 200, { deviceCode: 'dev-code', userCode: 'WXYZ-1234', verificationUrl: `http://127.0.0.1:${SERVICE_PORT}/device`, expiresInSeconds: 600, intervalSeconds: 2 })
    if (req.url === '/api/device/poll') return approved ? json(res, 200, { token: 'e2e-jwt', expiresAt: new Date(Date.now() + 90 * 864e5).toISOString() }) : json(res, 202, { status: 'pending' })
    if (!req.headers.authorization) return json(res, 401, { detail: 'No token' })
    if (req.url === '/api/me') return json(res, 200, { active: planActive, plan: 'MONTHLY', expiresAt: null, dailyRequestCap: 100, strongModelAllowed: true, requestsToday: 4, completionCap: 300, completionsToday: 0 })
    if (req.url === '/api/chat/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: delta\ndata: {"text":"Hello from the "}\n\n')
      res.write('event: delta\ndata: {"text":"service."}\n\n')
      return res.end('event: done\ndata: {"model":"claude-haiku-5-5","inputTokens":5,"outputTokens":4}\n\n')
    }
    if (req.url === '/api/agent/step') {
      const assistants = (b.messages || []).filter((m) => m.role === 'assistant').length
      const script = [
        { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'list_files', input: {} }], stopReason: 'tool_use' },
        { content: [{ type: 'tool_use', id: 't2', name: 'edit_file', input: { path: 'hello.txt', old_text: 'hello world', new_text: 'hello service' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'Finished through the service.' }], stopReason: 'end_turn' }
      ]
      return json(res, 200, { ...(script[assistants] || script[2]), model: 'claude-haiku-5-5', inputTokens: 1, outputTokens: 1, taskToken: 'task-' + assistants, stepsLeft: 10 })
    }
    json(res, 404, { detail: 'nope' })
  })
})

// ---------- CDP driver ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now()
  for (;;) {
    try { const v = await fn(); if (v) return v } catch {}
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for: ' + what)
    await sleep(150)
  }
}
async function cdpConnect() {
  const target = await waitFor(async () => {
    const list = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(JSON.parse(d))) }).on('error', reject))
    return list.find((t) => t.type === 'page')
  }, 'devtools page target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  let id = 0; const pending = new Map(); const errors = []
  ws.on('message', (m) => {
    const d = JSON.parse(m)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)
  })
  const send = (method, params) => new Promise((r, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('CDP timed out: ' + method)) }, 40000); pending.set(i, (d) => { clearTimeout(t); r(d.result ?? d) }); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { ev, send, errors, close: () => ws.close() }
}

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }
const VIS = `const vis = (e) => e && e.getClientRects().length > 0;`

;(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true }); fs.rmSync(PROJ, { recursive: true, force: true })
  fs.mkdirSync(PROJ, { recursive: true })
  fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'hello world\n')
  await new Promise((r) => server.listen(SERVICE_PORT, '127.0.0.1', r))
  const env = { ...process.env, MY_AI_IDE_BACKEND_URL: `http://127.0.0.1:${SERVICE_PORT}`, MY_AI_IDE_NO_TRASH: '1', MY_AI_IDE_UPDATE_URL: `http://127.0.0.1:${SERVICE_PORT}/updates/` }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ANTHROPIC_API_KEY; delete env.MY_AI_IDE_DIRECT
  const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', PROJ], { env, stdio: 'ignore' })
  let c
  try {
    c = await cdpConnect()
    await waitFor(() => c.ev(`typeof window.api === 'object' && !!document.querySelector('.sidebar')`), 'renderer ready')
    const typeInto = (sel, text) => c.ev(`(() => { ${VIS} const ta = [...document.querySelectorAll('${sel}')].find(vis); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    const clickBtn = (text, scope = '') => c.ev(`(() => { ${VIS} const b = [...document.querySelectorAll('${scope} button')].find(b => vis(b) && b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)

    // ---- signed out
    check('the status bar offers "Sign in"', await waitFor(() => c.ev(`/Sign in/.test(document.querySelector('[data-sb="account"]')?.textContent || '')`), 'sign-in in the status bar'))
    check('the chat asks to sign in instead of asking for an API key', await waitFor(() => c.ev(`!!document.querySelector('.chat [data-signin-card]') && !document.querySelector('.chat input[type="password"]')`), 'sign-in card'))
    check('the key button is gone from the chat header', await c.ev(`![...document.querySelectorAll('.chat button')].some(b => b.textContent.trim() === 'Key')`))

    // ---- sign in
    await c.ev(`document.querySelector('.chat [data-signin-start]').click()`)
    check('the code to confirm is shown', await waitFor(() => c.ev(`document.querySelector('.chat [data-signin-code]')?.textContent === 'WXYZ-1234'`), 'user code'))
    check('the status bar says it is signing in', await c.ev(`/Signing in/.test(document.querySelector('[data-sb="account"]').textContent)`))
    approved = true // the person confirmed the code on the website
    check('once confirmed, the chat opens and the status bar shows the plan and the allowance left', await waitFor(() => c.ev(`!!document.querySelector('.chat textarea') && /MONTHLY/.test(document.querySelector('[data-sb="account"]')?.textContent || '') && /96 requests left/.test(document.querySelector('[data-sb="account"]').textContent)`), 'signed in', 30000), await c.ev(`document.querySelector('[data-sb="account"]')?.textContent`))

    // ---- chat through the service
    await typeInto('.chat textarea', 'Explain the file please')
    await clickBtn('Send', '.chat')
    check('a chat reply comes from the service', await waitFor(() => c.ev(`[...document.querySelectorAll('.chat-msg.assistant')].some(m => m.textContent.includes('Hello from the service.'))`), 'service reply'))
    const chatCall = log.filter((l) => l.url === '/api/chat/stream').pop()
    check('the question reached the service with the account\'s token and the message in it', chatCall.auth === 'Bearer e2e-jwt' && /Explain the file please/.test(chatCall.body.prompt) && chatCall.body.prompt.length <= 20000, chatCall && chatCall.body.prompt.slice(0, 80))
    check('the device id was sent', /^ide-[0-9a-f]{32}$/.test(String(chatCall.device)))

    // ---- agent through the service (its tools still run here, with approval)
    await clickBtn('Agent', '.chat')
    await typeInto('.chat textarea', 'Change world to service in hello.txt')
    await clickBtn('Send', '.chat')
    const approval = await waitFor(() => c.ev(`document.querySelector('.qp.approval')?.textContent`), 'edit approval')
    check('the agent\'s edit still asks for approval, with the file name', approval.includes('hello.txt'))
    check('and nothing was changed before it', fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'hello world\n')
    await clickBtn('Accept', '.approval')
    check('accepting writes the change to disk', await waitFor(() => fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'hello service\n', 'edit applied'))
    check('the agent ends with the service\'s final answer', await waitFor(() => c.ev(`[...document.querySelectorAll('.chat-msg.assistant')].some(m => m.textContent.includes('Finished through the service.'))`), 'final text'))
    const steps = log.filter((l) => l.url === '/api/agent/step')
    check('each step handed the task token back, the first one without', steps.length === 3 && steps[0].body.taskToken === undefined && steps[1].body.taskToken === 'task-0' && steps[2].body.taskToken === 'task-1', JSON.stringify(steps.map((s) => s.body.taskToken)))
    check('the project listing tool ran here and its result went back to the model', JSON.stringify(steps[1].body.messages).includes('hello.txt'))
    check('the task carried the user\'s words', JSON.stringify(steps[0].body.messages).includes('Change world to service'))

    // ---- account dialog and sign out
    await c.ev(`document.querySelector('[data-sb="account"]').click()`)
    check('the Account dialog shows the plan', await waitFor(() => c.ev(`/MONTHLY/.test(document.querySelector('[data-account-plan]')?.textContent || '')`), 'account dialog'))
    await c.ev(`document.querySelector('[data-account-signout]').click()`)
    check('signing out brings back the sign-in offer', await waitFor(() => c.ev(`/Sign in/.test(document.querySelector('[data-sb="account"]')?.textContent || '') && !!document.querySelector('.chat [data-signin-card]')`), 'signed out again'))
    check('the stored token is gone', !fs.existsSync(path.join(PROFILE, 'service-token.bin')))

    // ---- signed in again after a restart keeps working: the token survives
    approved = true
    await c.ev(`document.querySelector('.chat [data-signin-start]').click()`)
    await waitFor(() => c.ev(`!!document.querySelector('.chat textarea')`), 'signed in again', 30000)
    await waitFor(() => fs.existsSync(path.join(PROFILE, 'service-token.bin')), 'token file written')
    check('the token is saved encrypted in the profile', fs.existsSync(path.join(PROFILE, 'service-token.bin')) && !fs.readFileSync(path.join(PROFILE, 'service-token.bin')).includes('e2e-jwt'))
    check('no uncaught renderer errors', c.errors.length === 0, c.errors.slice(0, 2).join(' | '))
  } catch (e) {
    check('test run completed without exception', false, e.message)
  } finally {
    try { c && c.close() } catch {}
    try { execSync(`taskkill /pid ${app.pid} /T /F`, { stdio: 'ignore' }) } catch {}
    server.close()
    await sleep(500)
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); fs.rmSync(PROJ, { recursive: true, force: true }) } catch {}
    const failed = results.filter((x) => !x).length
    console.log(`\n${results.length - failed}/${results.length} checks passed`)
    process.exit(failed ? 1 : 0)
  }
})()
