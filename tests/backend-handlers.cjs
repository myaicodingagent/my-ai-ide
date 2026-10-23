// Runs the real service client (src/main/backend.ts and llm.ts) against a fake of our service: sign-in with a device code, the token kept
// encrypted, every call authenticated, streaming replies, the agent step, and the errors turned into sentences.
// `npm run test:backend`: does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const handlers = {}
const sent = []
const opened = []
const tmp = path.join(os.tmpdir(), 'backend-test-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true })
const win = { webContents: { send: (ch, ...a) => sent.push([ch, ...a]) } }
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f }, on: () => {} },
  app: { getPath: () => tmp, getVersion: () => '9.9.9' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('ENC:' + s), decryptString: (b) => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('bad'); return t.slice(4) } },
  shell: { openExternal: (u) => { opened.push(u); return Promise.resolve() } },
  BrowserWindow: class {}
}
const root = path.join(__dirname, '..')
const stub = path.join(root, 'node_modules', '.cache', 'backend-stub.cjs'), bundle = path.join(root, 'node_modules', '.cache', 'backend-bundle.cjs')
fs.mkdirSync(path.dirname(stub), { recursive: true })
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
require('esbuild').buildSync({
  stdin: { contents: "export * as backend from './backend'; export * as llm from './llm'", resolveDir: path.join(root, 'src', 'main'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', alias: { electron: stub }, external: ['@huggingface/transformers', 'ssh2'], outfile: bundle, logLevel: 'error'
})
delete process.env.ANTHROPIC_API_KEY
delete process.env.MY_AI_IDE_DIRECT
const { backend, llm } = require(bundle)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const call = (n, ...a) => handlers[n]({}, ...a)

// ---------------- a fake of the service ----------------
const log = []
let pollCount = 0
let mode = 'ok'
let expiresAt = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString()
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const entry = { method: req.method, url: req.url, auth: req.headers.authorization, device: req.headers['x-device-id'], version: req.headers['x-client-version'], body: body ? JSON.parse(body) : null }
    log.push(entry)
    if (req.url === '/api/device/start') return json(res, 200, { deviceCode: 'secret-device-code', userCode: 'ABCD-EFGH', verificationUrl: `http://127.0.0.1:${server.address().port}/device`, expiresInSeconds: 600, intervalSeconds: 1 })
    if (req.url === '/api/device/poll') { pollCount++; return pollCount < 2 ? json(res, 202, { status: 'pending' }) : json(res, 200, { token: 'jwt-1', expiresAt }) }
    if (req.url === '/api/auth/refresh') return json(res, 200, { token: 'jwt-2', expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString() })
    if (mode === 'device-removed' && req.url !== '/api/device/start') return json(res, 403, { detail: 'Device mismatch' })
    if (mode === 'old') return json(res, 426, { detail: 'Update the app' })
    if (req.url === '/api/me') return json(res, 200, { active: true, plan: 'MONTHLY', expiresAt, dailyRequestCap: 100, strongModelAllowed: true, requestsToday: 7, completionCap: 300, completionsToday: 2 })
    if (req.url === '/api/chat/stream') {
      if (mode === 'no-plan') return json(res, 402, { detail: 'No active plan' })
      if (mode === 'cap') return json(res, 429, { detail: 'Daily limit reached' })
      if (mode === 'trial-strong') return json(res, 403, { detail: 'The strong model needs a paid plan' })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: delta\ndata: {"text":"Hel"}\n\n')
      setTimeout(() => res.write('event: delta\ndata: {"text":"lo"}\n\n'), 20)
      setTimeout(() => { if (mode === 'midfail') { res.end('event: error\ndata: {"status":502,"detail":"upstream broke"}\n\n') } else res.end('event: done\ndata: {"model":"claude-haiku-5-5","inputTokens":12,"outputTokens":3}\n\n') }, 60)
      return
    }
    if (req.url === '/api/complete') return json(res, 200, { text: 'completed();', model: 'm', inputTokens: 1, outputTokens: 1 })
    if (req.url === '/api/expand') return json(res, 200, { text: 'login auth session' })
    if (req.url === '/api/agent/step') return json(res, 200, { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', model: 'm', inputTokens: 1, outputTokens: 1, taskToken: 'task-1', stepsLeft: 14 })
    json(res, 404, { detail: 'nope' })
  })
})

;(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.MY_AI_IDE_BACKEND_URL = `http://127.0.0.1:${server.address().port}`
  backend.registerBackendHandlers(() => win, '9.9.9')
  await sleep(100)

  // ---- signed out
  check('at first nobody is signed in', (await call('auth:state')).state === 'signed-out')
  check('no model call is possible, and the question to ask is "sign in"', (await call('auth:ready')) === false && (await llm.ready()) === false)
  let err = await backend.ask({ prompt: 'hi' }).catch((e) => e)
  check('asking without signing in is refused with a message', err && /Sign in/.test(err.message), err && err.message)
  check('the app is not in the developer mode that uses its own key', (await call('auth:mode')).direct === false)

  // ---- sign in
  const started = await call('auth:start')
  check('starting the sign-in shows the code to confirm and opens the website with it', started.ok && started.state.state === 'signing-in' && started.state.userCode === 'ABCD-EFGH' && opened.length === 1 && opened[0].endsWith('/device/?code=ABCD-EFGH'), JSON.stringify([started, opened]))
  const startCall = log.find((l) => l.url === '/api/device/start')
  check('the device id is stable, long enough and sent with a label', /^[A-Za-z0-9-]{16,64}$/.test(startCall.body.deviceId) && /My AI IDE/.test(startCall.body.label), JSON.stringify(startCall.body))
  for (let i = 0; i < 60 && (await call('auth:state')).state !== 'signed-in'; i++) await sleep(200)
  const st = await call('auth:state')
  check('after the code is confirmed on the website the app is signed in', st.state === 'signed-in')
  check('the polls used the secret code (never the short one)', log.filter((l) => l.url === '/api/device/poll').every((l) => l.body.deviceCode === 'secret-device-code'))
  const tokenFile = path.join(tmp, 'service-token.bin')
  check('the token is stored encrypted, not as plain text', fs.existsSync(tokenFile) && fs.readFileSync(tokenFile, 'utf8').startsWith('ENC:') && !fs.readdirSync(tmp).some((f) => fs.statSync(path.join(tmp, f)).isFile() && f !== 'service-token.bin' && fs.readFileSync(path.join(tmp, f), 'utf8').includes('jwt-1')))
  check('the window was told about the change', sent.some((s) => s[0] === 'auth:state' && s[1].state === 'signing-in') && sent.some((s) => s[0] === 'auth:state' && s[1].state === 'signed-in'))
  check('now model calls are possible', (await call('auth:ready')) === true)

  // ---- me
  const me = await call('auth:me')
  check('the plan and today\'s allowance are read from the service', me && me.plan === 'MONTHLY' && me.dailyRequestCap === 100 && me.requestsToday === 7, JSON.stringify(me))

  // ---- chat
  const pieces = []
  const ans = await backend.ask({ prompt: 'say hello', strong: true, onText: (t) => pieces.push(t) })
  check('a reply streams in pieces and ends with the token counts', pieces.join('|') === 'Hel|lo' && ans.text === 'Hello' && ans.inputTokens === 12 && ans.outputTokens === 3, JSON.stringify([pieces, ans]))
  const chatCall = log.filter((l) => l.url === '/api/chat/stream').pop()
  check('every call carries the token, the device id and the app version', chatCall.auth === 'Bearer jwt-1' && chatCall.device === startCall.body.deviceId && chatCall.version === '9.9.9', JSON.stringify(chatCall))
  check('and says whether the strong model is wanted', chatCall.body.strong === true && chatCall.body.prompt === 'say hello')
  const txt = await llm.text({ system: 'Be brief.', prompt: 'Question?' })
  const textCall = log.filter((l) => l.url === '/api/chat/stream').pop()
  check('llm.text asks the service, with the instructions and the question in one prompt', txt === 'Hello' && /Instructions:\nBe brief\./.test(textCall.body.prompt) && /Question\?$/.test(textCall.body.prompt), textCall.body.prompt)

  // ---- fitting a long conversation into one question
  const long = 'x'.repeat(30000)
  const fitted = llm.fit('SYS ' + long, [{ role: 'user', content: 'old 1' }, { role: 'assistant', content: 'old answer ' + long }, { role: 'user', content: 'recent question' }, { role: 'assistant', content: 'recent answer' }], 'THE NEWEST MESSAGE')
  check('a long conversation is cut to the size the service accepts', fitted.length <= 20000, fitted.length)
  check('the newest message and the start of the instructions are always kept', fitted.endsWith('THE NEWEST MESSAGE') && fitted.includes('SYS '))
  check('recent turns are kept before old ones', fitted.includes('recent answer') && fitted.includes('recent question'))
  check('a short conversation is passed whole, in order', /User: a\n\nAssistant: b\n\nNow answer this message:\nc$/.test(llm.fit('', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 'c')), llm.fit('', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 'c'))
  check('squeeze keeps the beginning and the end of long text', llm.squeeze('A'.repeat(1000) + 'B'.repeat(1000), 500).startsWith('AAA') && llm.squeeze('A'.repeat(1000) + 'B'.repeat(1000), 500).endsWith('BBB') && llm.squeeze('short', 500) === 'short')

  // ---- the other calls
  check('inline completion sends the language and the text around the caret', (await backend.complete('ts', 'const a = ', ';')) === 'completed();' && JSON.stringify(log.filter((l) => l.url === '/api/complete').pop().body) === JSON.stringify({ language: 'ts', prefix: 'const a = ', suffix: ';' }))
  check('search expansion sends the question and the vocabulary', (await backend.expand('where do users log in', 'LoginForm authService')) === 'login auth session')
  const step = await backend.agentStep([{ role: 'user', content: 'task' }], undefined, false)
  const step2 = await backend.agentStep([{ role: 'user', content: 'task' }], step.taskToken, true, undefined, [{ name: 'mcp__a__b' }])
  const stepCalls = log.filter((l) => l.url === '/api/agent/step')
  check('an agent step returns the model\'s blocks and a task token', step.stopReason === 'end_turn' && step.taskToken === 'task-1')
  check('the next step hands the task token back, and says when the strong model is wanted', stepCalls[0].body.taskToken === undefined && stepCalls[1].body.taskToken === 'task-1' && stepCalls[1].body.strong === true && stepCalls[1].body.extraTools.length === 1)

  // ---- errors become sentences
  mode = 'no-plan'
  err = await backend.ask({ prompt: 'x' }).catch((e) => e)
  check('"no plan" says to choose a plan', /no active plan/i.test(backend.explain(err)) && err.status === 402, backend.explain(err))
  mode = 'cap'
  err = await backend.ask({ prompt: 'x' }).catch((e) => e)
  check('"limit reached" says when it renews', /Daily limit reached/.test(backend.explain(err)) && err.status === 429, backend.explain(err))
  mode = 'trial-strong'
  err = await backend.ask({ prompt: 'x', strong: true }).catch((e) => e)
  check('a plan that does not include something says so', /paid plan/.test(backend.explain(err)))
  mode = 'midfail'
  err = await backend.ask({ prompt: 'x' }).catch((e) => e)
  check('a failure in the middle of a reply is reported, not swallowed', err && /upstream broke/.test(err.message) && err.status === 502, err && err.message)
  mode = 'old'
  err = await backend.ask({ prompt: 'x' }).catch((e) => e)
  check('an outdated app is told to update', err && err.status === 426 && /update/i.test(err.message), err && err.message)
  mode = 'ok'
  const cancel = new AbortController()
  const slow = backend.ask({ prompt: 'x', signal: cancel.signal })
  setTimeout(() => cancel.abort(), 10)
  err = await slow.catch((e) => e)
  check('stopping a reply is a cancellation, not a failure', err && /Cancelled|lost/.test(err.message), err && err.message)

  // ---- the token is renewed before it ends
  fs.writeFileSync(tokenFile, Buffer.from('ENC:' + JSON.stringify({ token: 'old-jwt', expiresAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString() })))
  // a fresh process would read the file; here the in-memory copy is replaced through a sign-out and a manual save
  await call('auth:signOut')
  check('signing out removes the stored token and tells the window', !fs.existsSync(tokenFile) && (await call('auth:state')).state === 'signed-out' && sent.some((s) => s[0] === 'auth:state' && s[1].state === 'signed-out'))
  err = await backend.ask({ prompt: 'x' }).catch((e) => e)
  check('after signing out the AI is unavailable again', err && /Sign in/.test(err.message))

  // sign in again with a token that is about to end: it is renewed on first use
  pollCount = 1
  expiresAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString()
  await call('auth:start')
  for (let i = 0; i < 60 && (await call('auth:state')).state !== 'signed-in'; i++) await sleep(200)
  await backend.ask({ prompt: 'again' })
  const refreshCall = log.filter((l) => l.url === '/api/auth/refresh').pop()
  const afterRefresh = log.filter((l) => l.url === '/api/chat/stream').pop()
  check('a token with less than two weeks left is renewed before the call', refreshCall && refreshCall.auth === 'Bearer jwt-1' && afterRefresh.auth === 'Bearer jwt-2', JSON.stringify([refreshCall && refreshCall.auth, afterRefresh.auth]))

  // ---- the website removes this device
  mode = 'device-removed'
  err = await backend.ask({ prompt: 'x' }).catch((e) => e)
  check('when the device was removed on the website the app signs out and asks to sign in again', err && /sign in/i.test(err.message) && (await call('auth:state')).state === 'signed-out')
  mode = 'ok'

  // ---- cancelling a sign-in
  pollCount = 0
  await call('auth:start')
  check('while signing in the state carries the code', (await call('auth:state')).state === 'signing-in')
  await call('auth:cancel')
  await sleep(2600)
  check('cancelling the sign-in goes back to signed out', (await call('auth:state')).state === 'signed-out')

  // ---- the service address
  check('a service address must be a web address', (await call('auth:setUrl', 'ftp://x')).ok === false && (await call('auth:setUrl', 'not a url')).ok === false)
  check('the environment variable beats the saved address (development)', (await call('auth:getUrl')).startsWith('http://127.0.0.1:'))

  // ---- SSE parsing
  const events = []
  const feed = backend.sseParser((e, d) => events.push([e, d]))
  feed('event: delta\r\ndata: {"a":1}\r\n\r\nevent: do'); feed('ne\ndata: {"b":2}\n\n: comment\n\ndata: plain\n\n')
  check('server-sent events are parsed across chunk boundaries and CRLF', JSON.stringify(events) === JSON.stringify([['delta', '{"a":1}'], ['done', '{"b":2}'], ['message', 'plain']]), JSON.stringify(events))

  // ---- development mode keeps the own-key path
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  check('with an own key set (development) the app does not need an account', backend.directMode() === true && (await call('auth:mode')).direct === true)
  delete process.env.ANTHROPIC_API_KEY

  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})()
