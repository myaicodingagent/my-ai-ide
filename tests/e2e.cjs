// End-to-end test: packaged app + fake Anthropic API + Chrome DevTools Protocol driver.
// Run `npm run dist` first, then `npm run test:e2e`. It never contacts the real API.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

const PROJ = path.join(os.tmpdir(), 'my-ai-ide-e2e-project')
const PROFILE = path.join(os.tmpdir(), 'my-ai-ide-e2e-profile') // isolated app data, so the test never touches your real settings
const EXE = path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
const API_PORT = 8765, CDP_PORT = 9333

// ---------- fake Anthropic API ----------
const requests = []
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}
const start = (blocks) => [['message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }]]
const textBlock = (i, text) => [
  ['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }],
  ...text.match(/.{1,12}/gs).map((t) => ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } }]),
  ['content_block_stop', { type: 'content_block_stop', index: i }]
]
const toolBlock = (i, id, name, input) => [
  ['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id, name, input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
  ['content_block_stop', { type: 'content_block_stop', index: i }]
]
const end = (stop) => [
  ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }],
  ['message_stop', { type: 'message_stop' }]
]
const textReply = (t) => [...start(), ...textBlock(0, t), ...end('end_turn')]
const toolReply = (preface, id, name, input) => [...start(), ...textBlock(0, preface), ...toolBlock(1, id, name, input), ...end('tool_use')]

// Agent script, chosen by how many assistant turns the conversation already has.
const agentScript = [
  () => toolReply('Let me look around. ', 'toolu_1', 'list_dir', { path: '.' }),
  () => toolReply('Now the edit. ', 'toolu_2', 'edit_file', { path: 'hello.txt', old_string: 'world', new_string: 'there' }),
  () => toolReply('Running a check. ', 'toolu_3', 'run_command', { command: 'Write-Output "tested-ok"; Get-Content hello.txt', timeout_seconds: 0 }),
  () => textReply('All done: edited and verified.'),
  () => toolReply('Second proposal. ', 'toolu_4', 'edit_file', { path: 'hello.txt', old_string: 'hello', new_string: 'goodbye' }),
  () => textReply('Understood, leaving it alone.'),
  () => toolReply('Third proposal. ', 'toolu_5', 'edit_file', { path: 'hello.txt', old_string: 'hello', new_string: 'hey' }),
  () => textReply('Applied the third change.')
]

// Update feed state: 'none' (already current), 'ok' (9.9.9 available), 'bad' (wrong checksum), 'down' (server error).
const FAKE_INSTALLER = require('crypto').randomBytes(300 * 1024)
const sha512 = (b) => require('crypto').createHash('sha512').update(b).digest('base64')
let updateMode = 'none'

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/log') { res.end(JSON.stringify(requests)); return }
    // ---- fake update feed (the app is pointed here with MY_AI_IDE_UPDATE_URL) ----
    if (req.url.startsWith('/updates/')) {
      const name = req.url.slice('/updates/'.length).split('?')[0]
      if (updateMode === 'down') { res.writeHead(500); res.end('server error'); return }
      if (name === 'latest.yml') {
        const version = updateMode === 'none' ? '0.1.0' : '9.9.9'
        const sha = updateMode === 'bad' ? sha512(Buffer.from('not the installer')) : sha512(FAKE_INSTALLER)
        res.writeHead(200, { 'content-type': 'text/yaml' })
        res.end(`version: ${version}
files:
  - url: My-AI-IDE-Setup-${version}.exe
    sha512: ${sha}
    size: ${FAKE_INSTALLER.length}
path: My-AI-IDE-Setup-${version}.exe
sha512: ${sha}
releaseDate: '2026-10-22T00:00:00.000Z'
`)
        return
      }
      if (name.endsWith('.exe')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': FAKE_INSTALLER.length }); res.end(FAKE_INSTALLER); return }
      res.writeHead(404); res.end(); return // e.g. the .blockmap: the updater then downloads the whole file
    }
    let json = {}
    try { json = JSON.parse(body) } catch {}
    requests.push({ url: req.url, headers: { beta: req.headers['anthropic-beta'], key: req.headers['x-api-key'], auth: req.headers['authorization'], all: Object.keys(req.headers).join(',') }, body: json })
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_c', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'completion-text' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
      return
    }
    if (json.tools) {
      const assistants = (json.messages || []).filter((m) => m.role === 'assistant').length
      return sse(res, (agentScript[assistants] || (() => textReply('(script exhausted)')))())
    }
    const lastUserText = JSON.stringify((json.messages || []).slice(-1)[0] || {})
    sse(res, textReply(/CODEBLOCK/.test(lastUserText) ? 'Here you go:\n```ts\nexport const applied = true\n```\nDone.' : 'Hello from the mock chat model.'))
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
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console.error: ' + d.params.args.map((a) => a.value ?? a.description).join(' '))
  })
  const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Runtime.enable')
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result.exceptionDetails) throw new Error('eval failed: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result.result.value
  }
  return { ev, send, errors, close: () => ws.close() }
}

const ED = `const edText = () => (document.querySelector('.monaco-editor .view-lines')?.textContent || '').replace(/\u00a0/g, ' ');`
const VIS = `const vis = (e) => e && e.getClientRects().length > 0;`
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`) }

// Deletes the throwaway app profile this test uses (never your real one).
function removeTestHistory() {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true })
  } catch {}
}

;(async () => {
  removeTestHistory()
  fs.rmSync(PROJ, { recursive: true, force: true })
  fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true })
  fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'hello world\n')
  fs.writeFileSync(path.join(PROJ, 'src', 'app.ts'), 'export const x = 1\n')
  // The project is a real Git repository (used by the Source Control checks).
  const gitSh = (cmd, cwd = PROJ) => execSync('git ' + cmd, { cwd, stdio: 'pipe' }).toString()
  gitSh('init -q -b main'); gitSh('config user.name "E2E Test"'); gitSh('config user.email e2e@example.com'); gitSh('config core.autocrlf false')
  gitSh('add -A'); gitSh('commit -q -m initial')
  // Custom theme files the app finds in its (isolated) profile: one valid, one invalid, one that must be ignored.
  const THEMES_DIR = path.join(PROFILE, 'themes')
  fs.mkdirSync(THEMES_DIR, { recursive: true })
  fs.writeFileSync(path.join(THEMES_DIR, 'neon.json'), JSON.stringify({ name: 'Neon Test', type: 'dark', base: 'dark-modern', ui: { bg: '#101010', accent: '#f0a' }, syntax: { keyword: '#00ffcc' } }))
  fs.writeFileSync(path.join(THEMES_DIR, 'broken.json'), JSON.stringify({ name: 'Broken', ui: { bg: 'red', nope: '#fff' } }))
  fs.writeFileSync(path.join(THEMES_DIR, '_ignored.json'), JSON.stringify({ name: 'Ignored Underscore' }))
  await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r))

  // The updater keeps its downloads under LOCALAPPDATA; point that into the throwaway profile so a test
  // download can never touch (or be mistaken for) a real one.
  const LOCAL_APP_DATA = path.join(PROFILE, 'localappdata')
  fs.mkdirSync(LOCAL_APP_DATA, { recursive: true })
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${API_PORT}`, ANTHROPIC_API_KEY: 'test-key-123', MY_AI_IDE_NO_TRASH: '1', MY_AI_IDE_UPDATE_URL: `http://127.0.0.1:${API_PORT}/updates/`, LOCALAPPDATA: LOCAL_APP_DATA }
  delete env.ELECTRON_RUN_AS_NODE
  // The window may sit behind other windows while the test runs; without these flags Chromium throttles
  // painting for hidden windows and the editor text appears late or not at all.
  const app = spawn(
    EXE,
    [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', PROJ],
    { env, stdio: 'ignore' }
  )
  let c
  try {
    c = await cdpConnect()
    // ---- UI boots and the CLI folder opens ----
    const hasApi = await waitFor(() => c.ev(`typeof window.api === 'object' && !!document.querySelector('.sidebar')`), 'renderer + preload ready')
    check('renderer boots with preload API', hasApi)
    const rows = await waitFor(() => c.ev(`[...document.querySelectorAll('.tree-row')].map(r => r.textContent.trim())`).then((r) => r.length && r), 'tree rows')
    check('folder from command line opens in explorer', rows.some(r => r.includes('hello.txt')) && rows.some(r => r.includes('src')), JSON.stringify(rows))

    // ---- open hello.txt in the editor ----
    await c.ev(`[...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === 'hello.txt').click()`)
    const tabbed = await waitFor(() => c.ev(`[...document.querySelectorAll('.tab')].some(t => t.textContent.includes('hello.txt'))`), 'hello.txt tab')
    check('clicking a file opens an editor tab', tabbed)
    await waitFor(() => c.ev(`(() => { ${ED} return edText().includes('hello') })()`), 'file text in Monaco')

    // ---- Chat panel streaming ----
    const typeInto = (sel, text) => c.ev(`(() => { ${VIS} const ta = [...document.querySelectorAll('${sel}')].find(vis); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    const clickBtn = (text, scope = '') => c.ev(`(() => { ${VIS} const b = [...document.querySelectorAll('${scope} button')].find(b => vis(b) && b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
    await typeInto('.chat textarea', 'hi there')
    await clickBtn('Send', '.chat')
    const chatOk = await waitFor(() => c.ev(`[...document.querySelectorAll('.chat-msg.assistant')].some(m => m.textContent.includes('Hello from the mock chat model.'))`), 'chat reply')
    check('chat panel streams a reply', chatOk)
    const chatReq = requests.find((r) => r.body.stream && !r.body.tools)
    check('chat request: beta fallback header + system prompt with open file', !!chatReq && /server-side-fallback/.test(chatReq.headers.beta || '') && JSON.stringify(chatReq.body.system).includes('hello.txt'), chatReq && chatReq.headers.beta)
    check('API key sent from env', chatReq && (chatReq.headers.key === 'test-key-123' || /test-key-123/.test(chatReq.headers.auth || '')), JSON.stringify(chatReq && {k: chatReq.headers.key, a: chatReq.headers.auth, all: chatReq.headers.all}))

    // ---- @mention picker ----
    await typeInto('.chat textarea', 'look at @hel')
    const mention = await waitFor(() => c.ev(`[...document.querySelectorAll('.mention-item')].map(m => m.textContent)`).then((r) => r.length && r), 'mention list')
    check('@ opens the file picker and filters', mention.some((m) => m.includes('hello.txt')), JSON.stringify(mention))
    await typeInto('.chat textarea', '')

    // ---- Find in files ----
    const typeInput = (sel, text) => c.ev(`(() => { ${VIS} const el = [...document.querySelectorAll('${sel}')].find(vis); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
    await clickBtn('Search', '.sidebar-views')
    await typeInput('.search-box input', 'export const')
    const hits = await waitFor(() => c.ev(`[...document.querySelectorAll('.search-hit')].map(h => h.textContent)`).then((r) => r.length && r), 'search hits')
    const files = await c.ev(`[...document.querySelectorAll('.search-file')].map(h => h.textContent)`)
    check('find in files returns matches grouped by file', hits.length === 1 && /export const x = 1/.test(hits[0]) && /app\.ts/.test(files[0]), JSON.stringify({ hits, files }))
    await c.ev(`document.querySelector('.search-hit').click()`)
    check('clicking a result opens that file', await waitFor(() => c.ev(`[...document.querySelectorAll('.tab.active')].some(t => t.textContent.includes('app.ts'))`), 'app.ts tab active'))
    await typeInput('.search-box input', '(')
    await waitFor(() => c.ev(`document.querySelectorAll('.search-hit').length === 0`), 'literal "(" finds nothing')
    check('literal mode treats ( as plain text (no error)', !(await c.ev(`!!document.querySelector('.search-msg')`)))
    await clickBtn('.*', '.search-box')
    await typeInput('.search-box input', '(')
    check('regex mode reports an invalid pattern', await waitFor(() => c.ev(`!!document.querySelector('.search-msg')`), 'regex error message'))
    await clickBtn('.*', '.search-box')
    await typeInput('.search-box input', 'HELLO')
    await waitFor(() => c.ev(`document.querySelectorAll('.search-hit').length > 0`), 'case-insensitive hit')
    await clickBtn('Aa', '.search-box')
    await typeInput('.search-box input', 'HELLO')
    check('match case turns off the case-insensitive hit', await waitFor(() => c.ev(`document.querySelectorAll('.search-hit').length === 0`), 'no hits when case-sensitive'))
    await clickBtn('Aa', '.search-box')
    await clickBtn('Explorer', '.sidebar-views')
    await c.ev(`[...document.querySelectorAll('.tab')].find(t => t.textContent.includes('hello.txt')).click()`)

    // ---- Themes ----
    const bgVar = () => c.ev(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`)
    const savedTheme = () => c.ev(`localStorage.getItem('theme-id')`)
    const editorBg = () => c.ev(`getComputedStyle(document.querySelector('.monaco-editor-background')).backgroundColor`)
    const pickerKey = (k) => c.ev(`document.querySelector('.qp input').dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }))`)
    check('starts on the Dark Modern theme', (await bgVar()) === '#1f1f1f' && (await savedTheme()) === null, await bgVar())
    await clickBtn('Theme: Dark Modern', '.statusbar')
    const themeCount = await waitFor(() => c.ev(`document.querySelectorAll('.qp-item').length`), 'theme list')
    check('theme picker lists the 12 built-in themes plus the valid custom one (not the broken or _ignored files)', themeCount === 13, String(themeCount))
    check('the custom theme is labelled as custom', await c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Neon Test') && i.textContent.includes('custom'))`))
    await pickerKey('ArrowDown')
    check('moving through the list previews a theme live (UI + editor)', await waitFor(async () => (await bgVar()) === '#282c34' && (await editorBg()) === 'rgb(40, 44, 52)', 'live preview'))
    await pickerKey('Escape')
    check('Esc puts the previous theme back and saves nothing', (await bgVar()) === '#1f1f1f' && (await savedTheme()) === null)
    await clickBtn('Theme: Dark Modern', '.statusbar')
    await typeInput('.qp input', 'dracula')
    check('choosing a theme applies it everywhere', await waitFor(async () => (await bgVar()) === '#282a36' && (await editorBg()) === 'rgb(40, 42, 54)', 'dracula applied'))
    check('chosen theme is saved and shown in the status bar', (await savedTheme()) === 'dracula' && (await c.ev(`document.querySelector('.statusbar').textContent.includes('Theme: Dracula')`)))
    // Custom theme: choose it, check it applies everywhere (3-digit colour #f0a expands to #ff00aa), then go back.
    await clickBtn('Theme: Dracula', '.statusbar')
    await typeInput('.qp input', 'neon')
    check('custom theme applies to the UI and the editor', await waitFor(async () => (await bgVar()) === '#101010' && (await editorBg()) === 'rgb(16, 16, 16)' && (await c.ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)) === '#ff00aa', 'neon applied'))
    check('custom theme choice is saved by file name', (await savedTheme()) === 'custom:neon.json' && (await c.ev(`document.querySelector('.statusbar').textContent.includes('Theme: Neon Test')`)))
    await clickBtn('Theme: Neon Test', '.statusbar')
    await typeInput('.qp input', 'dracula')
    await waitFor(async () => (await bgVar()) === '#282a36', 'back to dracula')
    check('light themes switch the native color scheme',await (async () => { await clickBtn('Theme: Dracula', '.statusbar'); await typeInput('.qp input', 'light modern'); await waitFor(async () => (await bgVar()) === '#ffffff', 'light applied'); const cs = await c.ev(`document.documentElement.style.colorScheme`); await clickBtn('Theme: Light Modern', '.statusbar'); await typeInput('.qp input', 'dracula'); await waitFor(async () => (await bgVar()) === '#282a36', 'back to dracula'); return cs === 'light' })())

    // ---- Agent: full scripted run ----
    await clickBtn('Agent', '.chat')
    await typeInto('.chat textarea', 'Change world to there in hello.txt then verify')
    await clickBtn('Send', '.chat')

    const approval = await waitFor(() => c.ev(`document.querySelector('.qp.approval')?.textContent`), 'edit approval dialog')
    check('edit approval dialog appears with the file name', approval.includes('hello.txt'), approval.slice(0, 60))
    check('diff editor renders in the dialog', await waitFor(() => c.ev(`!!document.querySelector('.qp.approval .monaco-diff-editor')`), 'diff editor'))
    check('file NOT changed before approval', fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'hello world\n')
    await clickBtn('Accept', '.approval')
    await waitFor(() => fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'hello there\n', 'file edited on disk')
    check('accepted edit written to disk', true)
    check('open editor tab updated live', await waitFor(() => c.ev(`(() => { ${ED} return edText().includes('hello there') })()`), 'tab content refresh'))

    const cmd = await waitFor(() => c.ev(`document.querySelector('.cmd-text')?.textContent`), 'command dialog')
    check('command approval dialog shows the command', cmd.includes('tested-ok'), cmd)
    await clickBtn('Run', '.qp')
    const done = await waitFor(() => c.ev(`[...document.querySelectorAll('.chat-msg.assistant')].some(m => m.textContent.includes('All done'))`), 'final agent text', 30000)
    check('agent finishes with its final answer', done)

    const toolLines = await c.ev(`[...document.querySelectorAll('.agent-tool summary')].map(s => s.textContent.trim())`)
    check('tool calls listed in the panel', toolLines.some((t) => t.startsWith('List')) && toolLines.some((t) => t.startsWith('Edit hello.txt')) && toolLines.some((t) => t.startsWith('Run:')), JSON.stringify(toolLines))
    const cmdOut = await c.ev(`[...document.querySelectorAll('.agent-tool')].find(d => d.textContent.includes('Run:'))?.querySelector('pre')?.textContent`)
    check('command output captured (stdout)', /tested-ok/.test(cmdOut || '') && /hello there/.test(cmdOut || ''), JSON.stringify((cmdOut || '').trim()))

    // Requests the model received
    const agentReqs = requests.filter((r) => r.body.tools)
    const toolNames = agentReqs[0].body.tools.map((t) => t.name)
    check('agent offers all 7 tools', ['list_dir', 'read_file', 'search_text', 'find_files', 'edit_file', 'write_file', 'run_command'].every((n) => toolNames.includes(n)), toolNames.join(','))
    const lastToolResult = (r) => JSON.stringify(r.body.messages[r.body.messages.length - 1].content)
    check('model received list_dir result', /hello\.txt/.test(lastToolResult(agentReqs[1])))
    check('model received edit result', /Updated hello\.txt/.test(lastToolResult(agentReqs[2])))
    check('model received command result', /tested-ok/.test(lastToolResult(agentReqs[3])))
    check('history sent back with tool_use blocks intact', agentReqs[3].body.messages.filter((m) => m.role === 'assistant').length === 3)
    check('API key not leaked to command', !/test-key-123/.test(cmdOut || ''))

    // ---- Undo ----
    const changeVisible = await c.ev(`!!document.querySelector('.agent-change button')`)
    check('applied change shows an Undo button', changeVisible)
    await c.ev(`document.querySelector('.agent-change button').click()`)
    await waitFor(() => fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'hello world\n', 'undo restores file')
    check('undo restores the original file', true)
    check('undo refreshes the open tab', await waitFor(() => c.ev(`(() => { ${ED} return edText().includes('hello world') })()`), 'tab refresh after undo'))

    // ---- Second run: reject a proposal; model is told about the undo ----
    await typeInto('.chat textarea', 'Now change hello to goodbye')
    await clickBtn('Send', '.chat')
    await waitFor(() => c.ev(`document.querySelector('.qp.approval')?.textContent.includes('hello.txt')`), 'second approval dialog')
    await clickBtn('Reject', '.approval')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.chat-msg.assistant')].some(m => m.textContent.includes('leaving it alone'))`), 'second run finish')
    check('rejected change leaves file untouched', fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'hello world\n')
    const afterReject = requests.filter((r) => r.body.tools).pop()
    check('model told the change was rejected', /user rejected/i.test(lastToolResult(afterReject)))
    const secondRunFirst = requests.filter((r) => r.body.tools)[4]
    check('model told about the undo on the next turn', JSON.stringify(secondRunFirst.body.messages).includes('undid your change to hello.txt'))

    // Third run: accept a change and leave it applied, so there is something to restore and undo after a restart.
    await typeInto('.chat textarea', 'Third task: make it friendlier')
    await clickBtn('Send', '.chat')
    await waitFor(() => c.ev(`document.querySelector('.qp.approval')?.textContent.includes('hello.txt')`), 'third approval dialog')
    await clickBtn('Accept', '.approval')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.chat-msg.assistant')].some(m => m.textContent.includes('Applied the third change.'))`), 'third run finish')
    check('third change applied and left in place', fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'hey world\n')
    await sleep(1200) // the panel saves shortly after a run ends
    const agentDir = path.join(PROFILE, 'agent')
    check('agent conversation saved to the app data folder (memory + panel)', fs.existsSync(agentDir) && fs.readdirSync(agentDir).length === 2, fs.existsSync(agentDir) ? fs.readdirSync(agentDir).join(',') : 'no dir')

    // ---- autocomplete IPC path (non-streaming Haiku call) ----
    const ac = await c.ev(`window.api.aiComplete({ requestId: 5000001, system: 's', prompt: 'p' })`)
    const acReq = requests.find((r) => !r.body.stream)
    check('autocomplete call returns text', ac === 'completion-text', String(ac))
    check('autocomplete uses haiku, thinking disabled, low effort', acReq.body.model === 'claude-haiku-5-5' && acReq.body.thinking?.type === 'disabled' && acReq.body.output_config?.effort === 'low', JSON.stringify({ m: acReq.body.model, t: acReq.body.thinking, o: acReq.body.output_config }))

    // ---- Chat history survives a restart of the page (same folder) ----
    await c.ev(`location.reload()`).catch(() => {})
    await waitFor(() => c.ev(`!!document.querySelector('.sidebar') && document.querySelectorAll('.tree-row').length > 0`), 'app back after reload')
    const restored = await waitFor(() => c.ev(`[...document.querySelectorAll('.chat-msg')].map(m => m.textContent)`).then((r) => r.length && r), 'restored chat messages')
    check('chat history restored for the same folder', restored.some((t) => t.includes('hi there')) && restored.some((t) => t.includes('Hello from the mock chat model.')), JSON.stringify(restored))
    check('theme survives a reload', (await bgVar()) === '#282a36')
    const stored = fs.readdirSync(path.join(PROFILE, 'chats'))
    check('history stored as a file in app data', stored.length >= 1, stored.join(','))

    // ---- Agent conversation survives a restart of the page ----
    await clickBtn('Agent', '.chat')
    const agentTexts = (sel) => c.ev(`[...document.querySelectorAll('${sel}')].filter(e => e.getClientRects().length).map(e => e.textContent.trim())`)
    check('agent transcript restored: your messages and its answers', await waitFor(async () => {
      const users = await agentTexts('.chat-msg.user'); const asst = await agentTexts('.chat-msg.assistant')
      return users.some((t) => t.includes('Change world to there')) && users.some((t) => t.includes('Third task')) && asst.some((t) => t.includes('All done: edited and verified.')) && asst.some((t) => t.includes('Applied the third change.'))
    }, 'restored agent transcript'))
    const restoredTools = await agentTexts('.agent-tool summary')
    check('restored tool lines and change markers', restoredTools.some((t) => t.startsWith('List')) && restoredTools.some((t) => t.startsWith('Run:')) && (await c.ev(`document.querySelectorAll('.agent-change').length`)) === 2, JSON.stringify(restoredTools))
    check('earlier undo is shown as undone; the newest change still has Undo', (await c.ev(`[...document.querySelectorAll('.agent-change')].map(x => x.textContent)`)).join('|').includes('Undone') && (await c.ev(`[...document.querySelectorAll('.agent-change button')].length`)) === 1)
    check('no "agent forgot" notice, because its memory was restored too', !(await agentTexts('.chat-note')).some((t) => t.includes('no longer has')))
    await c.ev(`document.querySelector('.agent-change button').click()`)
    check('Undo works after a restart (the change record was saved)', await waitFor(() => fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'hello world\n', 'undo after restart'))

    // The model must get its earlier conversation back: send a new message and inspect what the API receives.
    await typeInto('.chat textarea', 'Do you remember what we did?')
    await clickBtn('Send', '.chat')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.chat-msg.assistant')].some(m => m.textContent.includes('(script exhausted)'))`), 'reply after restart')
    const afterRestart = requests.filter((r) => r.body.tools).pop()
    const sentText = JSON.stringify(afterRestart.body.messages)
    check('after a restart the model receives the whole earlier conversation', afterRestart.body.messages.filter((m) => m.role === 'assistant').length === 8 && sentText.includes('toolu_1') && sentText.includes('toolu_5') && sentText.includes('Third task'), String(afterRestart.body.messages.length))
    check('and is told about the undo done after the restart', sentText.includes('undid your change to hello.txt'))
    await clickBtn('New', '.chat')
    await sleep(1200)
    check('New forgets the conversation and deletes the saved files', (await agentTexts('.chat-msg')).length === 0 && fs.readdirSync(path.join(PROFILE, 'agent')).length === 0, fs.readdirSync(path.join(PROFILE, 'agent')).join(','))
    await clickBtn('Chat', '.chat')

    // ---- Source control (a real repository, driven through the UI) ----
    await c.ev(`window.confirm = () => true; window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m))`)
    const gitRows = (staged) => c.ev(`[...document.querySelectorAll('.git-row[data-git-staged="${staged}"]')].map(r => r.dataset.gitFile + ':' + r.querySelector('.git-letter').textContent)`)
    const gitRefresh = () => c.ev(`document.querySelector('[data-git-action="refresh"]').click()`)
    const gitAction = (action, file) => c.ev(`document.querySelector('${file ? `.git-row[data-git-file="${file}"] ` : ''}[data-git-action="${action}"]').click()`)
    const gitNote = () => c.ev(`document.querySelector('[data-git-note]')?.textContent || ''`)
    const bare = path.join(os.tmpdir(), 'my-ai-ide-e2e-bare.git'); fs.rmSync(bare, { recursive: true, force: true })

    fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'hello world\nsecond line\n')
    fs.writeFileSync(path.join(PROJ, 'notes.md'), '# notes\n')
    fs.rmSync(path.join(PROJ, 'src', 'app.ts'))
    await c.ev(`document.querySelector('[data-view="git"]').click()`)
    await gitRefresh()
    check('Source Control lists modified, untracked and deleted files', await waitFor(async () => JSON.stringify((await gitRows(false)).sort()) === JSON.stringify(['hello.txt:M', 'notes.md:U', 'src/app.ts:D']), 'git rows'), JSON.stringify(await gitRows(false)))
    check('the Git tab shows a count badge and the status bar shows the branch with a * for changes', (await c.ev(`document.querySelector('[data-view="git"] .badge')?.textContent`)) === '3' && /⎇ main\*/.test(await c.ev(`document.querySelector('[data-sb="branch"]')?.textContent || ''`)), await c.ev(`document.querySelector('[data-sb="branch"]')?.textContent`))
    await c.ev(`document.querySelector('.git-row[data-git-file="hello.txt"]').click()`)
    check('clicking a file opens a side-by-side diff', await waitFor(() => c.ev(`!!document.querySelector('.diff-view .monaco-diff-editor') && document.querySelector('.diff-title').textContent.includes('Working Tree')`), 'diff view'))
    check('the diff shows the old and the new text', await waitFor(() => c.ev(`document.querySelector('.diff-host').textContent.replace(/ /g, ' ').includes('second line')`), 'diff content'))
    await clickBtn('Close', '.diff-bar')
    check('the diff can be closed', await waitFor(() => c.ev(`!document.querySelector('.diff-view')`), 'diff closed'))

    await gitAction('stage', 'hello.txt')
    check('staging a file moves it to Staged Changes', await waitFor(async () => (await gitRows(true)).join() === 'hello.txt:M' && (await gitRows(false)).length === 2, 'staged'), `${await gitRows(true)} | ${await gitRows(false)}`)
    await c.ev(`document.querySelector('.git-row[data-git-staged="true"]').click()`)
    check('staged diff compares HEAD with the index', await waitFor(() => c.ev(`document.querySelector('.diff-title')?.textContent.includes('Staged Changes')`), 'staged diff'))
    await clickBtn('Close', '.diff-bar')
    await gitAction('unstage', 'hello.txt')
    check('unstaging puts it back', await waitFor(async () => (await gitRows(true)).length === 0 && (await gitRows(false)).length === 3, 'unstaged'))
    await gitAction('stage-all')
    check('Stage All stages everything', await waitFor(async () => (await gitRows(true)).length === 3 && (await gitRows(false)).length === 0, 'all staged'))
    await gitAction('unstage-all')
    await waitFor(async () => (await gitRows(false)).length === 3, 'all unstaged')
    await gitAction('discard', 'hello.txt')
    check('Discard restores a modified file from the index', await waitFor(() => fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8').replace(/\r/g, '') === 'hello world\n', 'discarded'))

    // Commit with a typed message
    await gitAction('stage-all')
    await waitFor(async () => (await gitRows(true)).length === 2, 'two staged after discard')
    check('Commit is disabled until there is a message', await c.ev(`document.querySelector('[data-git-action="commit"]').disabled`))
    await typeInto('[data-git-message]', 'Add notes and drop app.ts')
    await gitAction('commit')
    check('Commit creates the commit and clears the lists', await waitFor(async () => gitSh('log -1 --format=%s').trim() === 'Add notes and drop app.ts' && (await gitRows(true)).length === 0 && (await gitRows(false)).length === 0, 'committed'), gitSh('log -1 --format=%s').trim())
    check('commit contents are what was staged', gitSh('show --stat --format= HEAD').includes('notes.md') && gitSh('show --stat --format= HEAD').includes('src/app.ts'))
    check('the clean state is shown and the * disappears from the status bar', (await c.ev(`document.querySelector('.git')?.textContent.includes('No changes')`)) && !/\*/.test(await c.ev(`document.querySelector('[data-sb="branch"]')?.textContent || ''`)))

    // AI commit message (the mock API answers non-streaming calls with "completion-text")
    fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'hello world\nthird line\n')
    await gitRefresh()
    await waitFor(async () => (await gitRows(false)).length === 1, 'one change')
    check('Generate message is disabled until something is staged', await c.ev(`document.querySelector('[data-git-action="generate"]').disabled`))
    await gitAction('stage', 'hello.txt')
    await waitFor(async () => (await gitRows(true)).length === 1, 'staged for message')
    await gitAction('generate')
    check('Generate message fills the box with the model\'s message', await waitFor(() => c.ev(`document.querySelector('[data-git-message]').value === 'completion-text'`), 'generated message'))
    const msgReq = requests.filter((r) => !r.body.stream && r.body.model === 'claude-haiku-5-5').pop()
    check('the request sent the staged diff to Haiku', !!msgReq && JSON.stringify(msgReq.body.messages).includes('third line') && /commit messages/.test(JSON.stringify(msgReq.body.system)))
    await c.ev(`document.querySelector('[data-git-message]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`)
    check('Ctrl+Enter in the message box commits', await waitFor(() => gitSh('log -1 --format=%s').trim() === 'completion-text', 'ctrl+enter commit'))

    // Branches
    await c.ev(`document.querySelector('[data-sb="branch"]').click()`)
    const branchItems = await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].map(i => i.textContent)`).then((r) => r.length && r), 'branch picker')
    check('the branch picker offers "Create new branch" and the existing branches', /Create new branch/.test(branchItems[0]) && branchItems.some((t) => t.startsWith('main') && t.includes('current')), JSON.stringify(branchItems))
    await c.ev(`document.querySelector('.qp-item').click()`)
    await waitFor(() => c.ev(`!!document.querySelector('[data-input-dialog]')`), 'new branch dialog')
    await typeInput('[data-input-dialog]', 'feature/e2e') // the helper also presses Enter, which submits
    check('creating a branch switches to it', (await waitFor(() => gitSh('branch --show-current').trim() === 'feature/e2e', 'branch created')) && (await waitFor(() => c.ev(`document.querySelector('[data-sb="branch"]')?.textContent.includes('feature/e2e')`), 'status bar branch')))
    await c.ev(`document.querySelector('[data-sb="branch"]').click()`)
    await waitFor(() => c.ev(`document.querySelectorAll('.qp-item').length > 1`), 'branch picker again')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.startsWith('main')).click()`)
    check('switching back to main works', await waitFor(() => gitSh('branch --show-current').trim() === 'main', 'back on main'))

    // Change bars in the editor margin (green = added, blue = changed)
    fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'hello world\nthird line\nadded line\n')
    await c.ev(`document.querySelector('.sidebar-views button').click()`)
    await gitRefresh()
    await c.ev(`[...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === 'hello.txt').click()`)
    check('changed lines get a colored bar in the editor margin', await waitFor(() => c.ev(`!!document.querySelector('.monaco-editor .git-gutter-added, .monaco-editor .git-gutter-modified')`), 'gutter bars', 15000))

    // Push / fetch / pull against a local bare repository
    gitSh(`init -q --bare -b main "${bare}"`)
    gitSh(`remote add origin "${bare}"`)
    await c.ev(`document.querySelector('[data-view="git"]').click()`)
    await gitAction('push')
    check('Push sends the branch (and sets the upstream)', await waitFor(() => { try { return execSync('git log -1 --format=%s main', { cwd: bare }).toString().trim() === 'completion-text' } catch { return false } }, 'pushed to bare'), await gitNote())
    const clone = path.join(os.tmpdir(), 'my-ai-ide-e2e-clone'); fs.rmSync(clone, { recursive: true, force: true })
    execSync(`git clone -q "${bare}" "${clone}"`); gitSh('config user.name "Other"', clone); gitSh('config user.email o@example.com', clone)
    fs.writeFileSync(path.join(clone, 'from-clone.txt'), 'x\n'); gitSh('add -A', clone); gitSh('commit -q -m "from clone"', clone); gitSh('push -q', clone)
    await gitAction('fetch')
    const behindOk = await waitFor(() => c.ev(`/↓1/.test(document.querySelector('[data-git-branch]')?.textContent || '')`), 'behind indicator', 15000).catch(async () => { console.log('DEBUG behind: branch text =', JSON.stringify(await c.ev(`document.querySelector('[data-git-branch]')?.textContent`)), '| note =', JSON.stringify(await gitNote()), '| git status -sb:', gitSh('status -sb').split('\n')[0], '| remote branches:', gitSh('branch -r').trim()); return false })
    check('after Fetch the branch shows it is behind', behindOk)
    await gitAction('pull')
    check('Pull brings the new commit in', await waitFor(() => fs.existsSync(path.join(PROJ, 'from-clone.txt')), 'pulled file'))
    fs.rmSync(clone, { recursive: true, force: true }); fs.rmSync(bare, { recursive: true, force: true })
    // leave the repo clean for the checks that follow
    gitSh('remote remove origin'); gitSh('add -A'); gitSh('commit -q -m "wrap up" --allow-empty')
    await c.ev(`document.querySelector('.sidebar-views button').click()`)

    // ---- Explorer: context menu, create / rename / delete, git colours, external changes ----
    const treeRow = (name) => `.tree-row[data-tree-path$="${name}"]`
    const rightClick = (selector) => c.ev(`(() => { const el = document.querySelector('${selector}'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 10 })); return true })()`)
    const menuLabels = () => c.ev(`[...document.querySelectorAll('[data-context-menu] .ctx-item')].map(i => i.textContent.trim())`)
    const clickMenu = (label) => c.ev(`[...document.querySelectorAll('[data-context-menu] .ctx-item')].find(i => i.textContent.trim().startsWith('${label}')).click()`)
    const tabNames = () => c.ev(`[...document.querySelectorAll('.tab .tab-name')].map(t => t.textContent)`)
    const dialogError = () => c.ev(`document.querySelector('.input-dialog .chat-error')?.textContent || ''`)
    await c.ev(`document.querySelector('.sidebar-views button').click()`) // Explorer
    await c.ev(`window.__alerts = []`)

    await rightClick(treeRow('hello.txt'))
    const fileMenu = await waitFor(async () => { const m = await menuLabels(); return m.length && m }, 'file context menu')
    check('right-clicking a file shows its menu', ['Open', 'New File…', 'Rename…  (F2)', 'Delete  (Del)', 'Reveal in File Explorer', 'Copy Path', 'Copy Relative Path'].every((l) => fileMenu.includes(l)), JSON.stringify(fileMenu))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    check('Esc closes the menu', await waitFor(async () => (await menuLabels()).length === 0, 'menu closed'))

    await rightClick('.tree') // empty space
    const rootMenu = await waitFor(async () => { const m = await menuLabels(); return m.length && m }, 'root context menu')
    check('right-clicking empty space shows the project menu (no rename/delete)', rootMenu.includes('New File…') && rootMenu.includes('New Folder…') && !rootMenu.some((l) => l.startsWith('Rename')) && !rootMenu.some((l) => l.startsWith('Delete')), JSON.stringify(rootMenu))
    await clickMenu('New File…')
    await waitFor(() => c.ev(`!!document.querySelector('[data-input-dialog]')`), 'new file dialog')
    await typeInput('[data-input-dialog]', 'bad?name.ts')
    check('an invalid name is rejected inside the dialog (it stays open)', (await dialogError()).includes('cannot contain') && (await c.ev(`!!document.querySelector('[data-input-dialog]')`)))
    await typeInput('[data-input-dialog]', 'created.ts')
    check('New File creates the file on disk', await waitFor(() => fs.existsSync(path.join(PROJ, 'created.ts')), 'file created'))
    check('the new file opens in a tab and shows in the tree, selected', await waitFor(async () => (await tabNames()).includes('created.ts') && (await c.ev(`!!document.querySelector('${treeRow('created.ts')}.selected')`)), 'tab + tree row'), JSON.stringify(await tabNames()))
    check('an untracked file gets a green U in the tree', await waitFor(() => c.ev(`document.querySelector('${treeRow('created.ts')} .tree-git')?.textContent === 'U'`), 'git letter U'))

    await rightClick(treeRow('src'))
    await clickMenu('New Folder…')
    await waitFor(() => c.ev(`!!document.querySelector('[data-input-dialog]')`), 'new folder dialog')
    await typeInput('[data-input-dialog]', 'inner')
    check('New Folder on a folder creates it inside, and the tree opens it', await waitFor(async () => fs.existsSync(path.join(PROJ, 'src', 'inner')) && (await c.ev(`!!document.querySelector('${treeRow('inner')}')`)), 'inner folder shown'))

    // Rename (the open tab follows) and refusing to overwrite
    await rightClick(treeRow('created.ts'))
    await clickMenu('Rename…')
    await waitFor(() => c.ev(`!!document.querySelector('[data-input-dialog]')`), 'rename dialog')
    check('the rename dialog starts with the current name selected up to the extension', (await c.ev(`(() => { const i = document.querySelector('[data-input-dialog]'); return i.value + '|' + i.selectionStart + '-' + i.selectionEnd })()`)) === 'created.ts|0-7')
    await typeInput('[data-input-dialog]', 'hello.txt')
    check('renaming onto an existing name is refused with a message, nothing overwritten', await waitFor(async () => (await c.ev(`window.__alerts.join('|')`)).includes('already exists') && fs.existsSync(path.join(PROJ, 'created.ts')), 'overwrite refused'))
    await c.ev(`window.__alerts = []`)
    await rightClick(treeRow('created.ts'))
    await clickMenu('Rename…')
    await waitFor(() => c.ev(`!!document.querySelector('[data-input-dialog]')`), 'rename dialog 2')
    await typeInput('[data-input-dialog]', 'renamed.ts')
    check('Rename moves the file on disk', await waitFor(() => fs.existsSync(path.join(PROJ, 'renamed.ts')) && !fs.existsSync(path.join(PROJ, 'created.ts')), 'renamed on disk'))
    check('an open tab for it follows the rename', await waitFor(async () => { const t = await tabNames(); return t.includes('renamed.ts') && !t.includes('created.ts') }, 'tab renamed'), JSON.stringify(await tabNames()))

    // F2 and Delete keys on the selected item (focus must not be in the editor)
    await c.ev(`document.activeElement && document.activeElement.blur()`)
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))`)
    check('F2 renames the selected item', await waitFor(() => c.ev(`document.querySelector('[data-input-dialog]')?.value === 'renamed.ts'`), 'F2 dialog'))
    await c.ev(`document.querySelector('[data-input-dialog]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitFor(() => c.ev(`!document.querySelector('[data-input-dialog]')`), 'dialog closed')

    // Delete a folder containing an open file
    fs.writeFileSync(path.join(PROJ, 'src', 'inner', 'deep.ts'), 'export {}\n')
    await c.ev(`window.__refresh = 1`)
    await waitFor(() => c.ev(`!!document.querySelector('${treeRow('deep.ts')}')`), 'deep.ts appears (watcher)', 10000)
    await c.ev(`document.querySelector('${treeRow('deep.ts')}').click()`)
    await waitFor(async () => (await tabNames()).includes('deep.ts'), 'deep.ts tab')
    await rightClick(treeRow('inner'))
    await clickMenu('Delete')
    check('Delete removes the folder, closes the tabs inside and clears the tree row', await waitFor(async () => !fs.existsSync(path.join(PROJ, 'src', 'inner')) && !(await tabNames()).includes('deep.ts') && !(await c.ev(`!!document.querySelector('${treeRow('inner')}')`)), 'folder deleted'))
    await rightClick(treeRow('renamed.ts'))
    await clickMenu('Delete')
    check('Delete removes a file (and its tab)', await waitFor(async () => !fs.existsSync(path.join(PROJ, 'renamed.ts')) && !(await tabNames()).includes('renamed.ts'), 'file deleted'))

    // Changes made outside the app show up by themselves (the file watcher)
    fs.writeFileSync(path.join(PROJ, 'external.txt'), 'made outside\n')
    check('a file created outside the app appears in the tree on its own', await waitFor(() => c.ev(`!!document.querySelector('${treeRow('external.txt')}')`), 'external file in tree', 10000))
    await c.ev(`document.querySelector('${treeRow('hello.txt')}').click()`)
    await waitFor(() => c.ev(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('hello')`), 'hello.txt open')
    fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'changed from outside\n')
    const reloadedOk = await waitFor(() => c.ev(`document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/ /g, ' ').includes('changed from outside')`), 'tab reloaded', 10000).catch(async () => { console.log('DEBUG reload: tabs =', JSON.stringify(await c.ev(`[...document.querySelectorAll('.tab')].map(t => t.textContent + (t.classList.contains('active') ? ' (active)' : '') + (t.querySelector('.tab-dot') ? ' [DIRTY]' : ''))`)), '| editor text =', JSON.stringify(await c.ev(`(document.querySelector('.monaco-editor .view-lines')?.textContent || '').slice(0, 120)`)), '| disk =', JSON.stringify(fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8'))); return false })
    check('an open, unmodified file reloads when it changes on disk', reloadedOk)
    check('and the tree shows an M for it', await waitFor(() => c.ev(`document.querySelector('${treeRow('hello.txt')} .tree-git')?.textContent === 'M'`), 'M in tree'))
    fs.rmSync(path.join(PROJ, 'external.txt'))
    check('a file deleted outside the app disappears from the tree', await waitFor(async () => !(await c.ev(`!!document.querySelector('${treeRow('external.txt')}')`)), 'external file gone', 10000))
    gitSh('checkout -q -- hello.txt'); gitSh('clean -fdq')
    check('the watcher also notices git operations done elsewhere (M disappears after a checkout)', await waitFor(() => c.ev(`!document.querySelector('${treeRow('hello.txt')} .tree-git')`), 'M cleared', 10000))

    // ---- Editor workflow: tabs, breadcrumbs, saving, session, problems ----
    await c.ev(`window.__confirms = []; window.__confirmAnswer = true; window.confirm = (m) => { window.__confirms.push(String(m)); return window.__confirmAnswer }`)
    const edKey = async (key, init = {}) => { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...init }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key }) }
    const typeInEditor = async (text) => { await c.ev(`document.querySelector('.monaco-editor textarea')?.focus()`); for (const ch of text) await edKey(ch, { text: ch, unmodifiedText: ch }) }
    const ctrl = (key, extra = {}) => c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, ctrlKey: true, bubbles: true, ...extra })}))`)
    const activeTab = () => c.ev(`document.querySelector('.tab.active .tab-name')?.textContent || null`)
    const dirtyTabs = () => c.ev(`[...document.querySelectorAll('.tab')].filter(t => t.querySelector('.tab-dot')).map(t => t.querySelector('.tab-name').textContent)`)
    const openFromTree = async (name) => { await c.ev(`document.querySelector('.tree-row[data-tree-path$="${name}"]').click()`); await waitFor(async () => (await activeTab()) === name.split(/[\\/]/).pop(), `open ${name}`) }
    const expandIfClosed = (name) => c.ev(`(() => { const r = document.querySelector('.tree-row[data-tree-path$="${name}"]'); if (r && !document.querySelector('.tree-row[data-tree-path$="${name}"] + div .tree-row') && r.querySelector('.tree-chevron.open') === null) r.click(); return true })()`)

    fs.mkdirSync(path.join(PROJ, 'src', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(PROJ, 'src', 'lib', 'util.ts'), 'export const util = 1\n')
    fs.writeFileSync(path.join(PROJ, 'plain.txt'), 'plain\n')
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="plain.txt"]')`), 'plain.txt in tree', 10000)

    // Tab menu: Close All, then open three files
    await rightClick('.tab')
    await clickMenu('Close All')
    check('Close All (tab menu) closes every tab', await waitFor(async () => (await tabNames()).length === 0, 'all tabs closed'))
    await openFromTree('plain.txt'); await openFromTree('hello.txt'); await openFromTree('notes.md')
    check('three tabs open in order', JSON.stringify(await tabNames()) === JSON.stringify(['plain.txt', 'hello.txt', 'notes.md']), JSON.stringify(await tabNames()))
    await ctrl('Tab')
    check('Ctrl+Tab goes to the next tab (wrapping around)', (await activeTab()) === 'plain.txt')
    await ctrl('Tab', { shiftKey: true })
    check('Ctrl+Shift+Tab goes back', (await activeTab()) === 'notes.md')
    await ctrl('1'); check('Ctrl+1 jumps to the first tab', (await activeTab()) === 'plain.txt')
    await ctrl('9'); check('Ctrl+9 jumps to the last tab', (await activeTab()) === 'notes.md')
    await ctrl('w')
    check('Ctrl+W closes the active tab and the app stays open', await waitFor(async () => JSON.stringify(await tabNames()) === JSON.stringify(['plain.txt', 'hello.txt']) && (await activeTab()) === 'hello.txt', 'ctrl+w'), JSON.stringify(await tabNames()))
    await ctrl('t', { shiftKey: true })
    check('Ctrl+Shift+T reopens the closed tab', await waitFor(async () => (await activeTab()) === 'notes.md' && (await tabNames()).length === 3, 'reopened'))
    await c.ev(`document.querySelector('.tab[data-tab-path$="plain.txt"]').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))`)
    check('middle-click closes a tab', await waitFor(async () => !(await tabNames()).includes('plain.txt'), 'middle click'))
    await openFromTree('plain.txt')
    await rightClick('.tab[data-tab-path$="hello.txt"]')
    await clickMenu('Close to the Right')
    check('Close to the Right keeps only the tabs on its left', await waitFor(async () => JSON.stringify(await tabNames()) === JSON.stringify(['hello.txt', 'notes.md', 'plain.txt'].slice(0, 1).concat([])) || JSON.stringify(await tabNames()).includes('hello.txt') && !(await tabNames()).includes('plain.txt'), 'close right'), JSON.stringify(await tabNames()))
    await openFromTree('plain.txt'); await openFromTree('notes.md')
    await rightClick('.tab[data-tab-path$="notes.md"]')
    await clickMenu('Close Others')
    check('Close Others leaves just that tab', await waitFor(async () => JSON.stringify(await tabNames()) === '["notes.md"]', 'close others'), JSON.stringify(await tabNames()))

    // Breadcrumbs and "reveal in explorer"
    const openDirRow = async (name, child) => {
      await c.ev(`(() => { const r = document.querySelector('.tree-row[data-tree-path$="${name}"]'); if (r && !r.querySelector('.tree-chevron.open')) r.click() })()`)
      await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="${child}"]')`), `${name} expanded`)
    }
    await openDirRow('src', 'lib')
    await openDirRow('lib', 'util.ts')
    await openFromTree('util.ts')
    check('breadcrumbs show the path of the active file', JSON.stringify(await c.ev(`[...document.querySelectorAll('[data-crumb]')].map(c => c.dataset.crumb)`)) === JSON.stringify(['src', 'lib', 'util.ts']))
    await c.ev(`document.querySelector('[data-crumb="lib"]').click()`) // util.ts is selected now; this selects its folder
    check('clicking a breadcrumb shows that folder in the explorer, selected', await waitFor(() => c.ev(`document.querySelector('.tree-row.selected')?.dataset.treePath.endsWith('lib')`), 'crumb reveal'))

    // Typing makes a tab dirty; Ctrl+S saves it
    await openFromTree('plain.txt')
    await typeInEditor('X')
    check('typing marks the tab as having unsaved changes', await waitFor(async () => (await dirtyTabs()).includes('plain.txt'), 'dirty dot'))
    await ctrl('s')
    check('Ctrl+S saves it and clears the mark', await waitFor(async () => fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8').replace(/\r/g, '').startsWith('X') && !(await dirtyTabs()).includes('plain.txt'), 'saved'))

    // A file that changed on disk is not silently overwritten
    await typeInEditor('Y')
    await waitFor(async () => (await dirtyTabs()).includes('plain.txt'), 'dirty again')
    fs.writeFileSync(path.join(PROJ, 'plain.txt'), 'changed elsewhere\n')
    await sleep(900) // let the watcher run; a tab with unsaved edits must keep them
    check('a file with unsaved edits is not reloaded over them', (await dirtyTabs()).includes('plain.txt'))
    await c.ev(`window.__confirmAnswer = false; window.__confirms = []`)
    await ctrl('s')
    check('saving over an external change asks first (and "no" keeps the other version)', await waitFor(async () => (await c.ev(`window.__confirms.join('|')`)).includes('changed on disk') && fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8') === 'changed elsewhere\n', 'conflict prompt'))
    await c.ev(`window.__confirmAnswer = true`)
    await ctrl('s')
    check('"yes" overwrites with your version', await waitFor(() => /Y/.test(fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8')) && !fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8').includes('changed elsewhere'), 'overwritten'))

    // Save All
    await typeInEditor('1')
    await openFromTree('notes.md'); await typeInEditor('2')
    await waitFor(async () => (await dirtyTabs()).length === 2, 'two dirty tabs')
    await ctrl('s', { altKey: true })
    check('Ctrl+Alt+S saves every modified file', await waitFor(async () => (await dirtyTabs()).length === 0 && /2/.test(fs.readFileSync(path.join(PROJ, 'notes.md'), 'utf8')) && /1/.test(fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8')), 'save all'))

    // Auto save (Settings dialog) and format on save
    const setSetting = async (name, value) => { await clickBtn('Settings', '.statusbar'); await waitFor(() => c.ev(`!!document.querySelector('[data-setting="${name}"]')`), 'settings dialog'); await c.ev(typeof value === 'boolean' ? `(() => { const e = document.querySelector('input[data-setting="${name}"]'); if (e.checked !== ${value}) e.click() })()` : `(() => { const s = document.querySelector('select[data-setting="${name}"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${value}'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`); await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await waitFor(() => c.ev(`!document.querySelector('.qp.settings')`), 'settings closed') }
    await setSetting('autoSave', 'afterDelay')
    await openFromTree('plain.txt'); await typeInEditor('A')
    check('auto save (after delay) writes the file by itself', await waitFor(async () => /A/.test(fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8')) && (await dirtyTabs()).length === 0, 'auto saved', 8000))
    await setSetting('autoSave', 'onBlur')
    await typeInEditor('B'); await sleep(1500)
    check('"on blur" auto save does not write while the window has focus', !/B/.test(fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8')) && (await dirtyTabs()).includes('plain.txt'))
    await c.ev(`window.dispatchEvent(new Event('blur'))`)
    check('"on blur" auto save writes when the window loses focus', await waitFor(() => /B/.test(fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8')), 'blur saved'))
    await setSetting('autoSave', 'off')
    fs.writeFileSync(path.join(PROJ, 'fmt.json'), '{"a":1,   "b":[1,2,3]}')
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="fmt.json"]')`), 'fmt.json in tree', 10000)
    await openFromTree('fmt.json')
    await setSetting('formatOnSave', true)
    await c.ev(`document.querySelector('.monaco-editor textarea').focus()`)
    await ctrl('s')
    check('format on save formats JSON before writing', await waitFor(() => /\{\s*\n\s+"a": 1,\s*\n\s+"b": \[/.test(fs.readFileSync(path.join(PROJ, 'fmt.json'), 'utf8')), 'formatted on save', 15000), JSON.stringify(fs.readFileSync(path.join(PROJ, 'fmt.json'), 'utf8')))
    await setSetting('formatOnSave', false)

    // Problems (language service diagnostics) and the TS/JSX configuration
    fs.writeFileSync(path.join(PROJ, 'src', 'comp.tsx'), "import React from 'react'\nexport const A = () => <div className=\"x\">hi</div>\n")
    fs.writeFileSync(path.join(PROJ, 'src', 'bad.ts'), 'const x: number = ;\n')
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="bad.ts"]')`), 'bad.ts in tree', 10000).catch(() => c.ev(`document.querySelector('.tree-row[data-tree-path$="\\\\src"]')?.click()`))
    await openFromTree('comp.tsx')
    await sleep(6000) // give the TypeScript service time to analyse it
    const problemCounts = () => c.ev(`document.querySelector('[data-sb="problems"]').textContent`)
    check('a TSX file with JSX and an unresolved package import shows no problems', (await problemCounts()).includes('⊗ 0'), await problemCounts())
    await openFromTree('bad.ts')
    check('a syntax error is counted in the status bar', await waitFor(async () => !(await problemCounts()).includes('⊗ 0'), 'problem counted', 20000), await problemCounts())
    await c.ev(`document.querySelector('[data-sb="problems"]').click()`)
    const problemItems = await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].map(i => i.textContent)`).then((r) => r.length && r), 'problems list')
    check('clicking the count lists the problem with its file and line', problemItems.some((t) => t.includes('bad.ts:1')), JSON.stringify(problemItems))
    await openFromTree('plain.txt')
    await c.ev(`document.querySelector('.qp-item').click()`)
    check('choosing a problem opens the file at that line', await waitFor(async () => (await activeTab()) === 'bad.ts', 'jumped to problem'))

    // Sidebar, zoom, palette editor commands
    await ctrl('b')
    check('Ctrl+B hides the sidebar', await c.ev(`!!document.querySelector('.sidebar.hidden')`))
    await ctrl('b')
    check('Ctrl+B shows it again', await c.ev(`!document.querySelector('.sidebar.hidden')`))
    await ctrl('=')
    check('Ctrl+= zooms the interface in', await waitFor(() => c.ev(`Math.abs(window.devicePixelRatio - 1.1) < 0.02`), 'zoom in'))
    await ctrl('0')
    check('Ctrl+0 resets the zoom', await waitFor(() => c.ev(`Math.abs(window.devicePixelRatio - 1) < 0.02`), 'zoom reset'))
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'go to line'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.startsWith('Editor: Go to Line'))`), 'go to line in palette')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.startsWith('Editor: Go to Line')).click()`)
    const gotoOk = await waitFor(() => c.ev(`[...document.querySelectorAll('.quick-input-widget')].some(w => w.getClientRects().length > 0)`), 'go to line box', 8000).catch(async () => { console.log('DEBUG goto: widgets =', JSON.stringify(await c.ev(`[...document.querySelectorAll('.quick-input-widget')].map(w => ({ shown: w.getClientRects().length > 0, disp: getComputedStyle(w).display, parent: w.parentElement?.className.slice(0, 50) }))`)), '| palette open =', await c.ev(`!!document.querySelector('.qp')`), '| active tab =', await activeTab(), '| diff view =', await c.ev(`!!document.querySelector('.diff-view')`), '| editors =', await c.ev(`document.querySelectorAll('.monaco-editor').length`), '| active el =', await c.ev(`document.activeElement.tagName + '.' + document.activeElement.className.slice(0, 40)`), '| errors =', JSON.stringify(c.errors.slice(0, 2)).slice(0, 1800)); return false })
    check('the command palette runs editor commands (Go to Line opens its box)', gotoOk)
    await edKey('Escape')
    // Find in the file must also work after diff views have been opened and closed earlier in the session
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'editor: find'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.startsWith('Editor: Find'))`), 'find in palette')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.startsWith('Editor: Find')).click()`)
    check('Find in the open file works (the find box opens) after diff views were used', await waitFor(() => c.ev(`!!document.querySelector('.monaco-editor .find-widget.visible')`), 'find widget', 8000))
    await edKey('Escape')
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await edKey('Escape')

    // The session: reload and the same tabs come back; recent folders
    const namesBefore = JSON.stringify(await tabNames()); const activeBefore = await activeTab()
    await c.ev(`location.reload()`).catch(() => {})
    await waitFor(() => c.ev(`!!document.querySelector('.sidebar') && document.querySelectorAll('.tree-row').length > 0`), 'app back after reload')
    check('after a reload the open tabs and the active one are restored', await waitFor(async () => JSON.stringify(await tabNames()) === namesBefore && (await activeTab()) === activeBefore, 'tabs restored'), `${namesBefore} -> ${JSON.stringify(await tabNames())}`)
    const other = path.join(os.tmpdir(), 'my-ai-ide-e2e-other-folder'); fs.rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'other.txt'), 'in the other folder\n')
    await c.ev(`localStorage.setItem('recent-folders', JSON.stringify([${JSON.stringify(PROJ)}, ${JSON.stringify(other)}])); localStorage.setItem('session:' + ${JSON.stringify(other.replace(/\\/g, '/').toLowerCase())}, JSON.stringify({ tabs: [${JSON.stringify(path.join(other, 'other.txt'))}], active: ${JSON.stringify(path.join(other, 'other.txt'))} }))`)
    await c.ev(`location.reload()`).catch(() => {})
    await waitFor(() => c.ev(`document.querySelectorAll('.tree-row').length > 0`), 'app back (recent seeded)')
    // The saved tabs reopen one after another; close them only once they have all come back.
    await waitFor(async () => (await tabNames()).length === JSON.parse(namesBefore).length, 'saved tabs back again')
    await rightClick('.tab'); await clickMenu('Close All')
    await waitFor(() => c.ev(`!!document.querySelector('[data-welcome-recent]')`), 'welcome with recent folders')
    check('the welcome screen lists recent folders (not the current one)', (await c.ev(`[...document.querySelectorAll('[data-recent]')].map(e => e.dataset.recent)`)).join() === other)
    await c.ev(`document.querySelector('[data-recent]').click()`)
    check('opening a recent folder switches the project and restores its saved tabs', await waitFor(async () => (await c.ev(`document.querySelector('.tree-root')?.textContent`)) === 'my-ai-ide-e2e-other-folder' && JSON.stringify(await tabNames()) === '["other.txt"]', 'switched folder'), `${await c.ev(`document.querySelector('.tree-root')?.textContent`)} ${JSON.stringify(await tabNames())}`)
    await rightClick('.tab'); await clickMenu('Close All')
    await waitFor(() => c.ev(`!!document.querySelector('[data-recent]')`), 'welcome again')
    await c.ev(`document.querySelector('[data-recent]').click()`)
    check('and back to the first folder', await waitFor(async () => (await c.ev(`document.querySelector('.tree-root')?.textContent`)) === 'my-ai-ide-e2e-project', 'back to project'))
    fs.rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })

    // ---- Replace in files ----
    fs.writeFileSync(path.join(PROJ, 'r1.txt'), 'alpha beta alpha\nsecond alpha line\n')
    fs.writeFileSync(path.join(PROJ, 'r2.txt'), 'alpha\n')
    fs.writeFileSync(path.join(PROJ, 'r3.txt'), 'alpha in an open file\n')
    fs.writeFileSync(path.join(PROJ, 'r4.txt'), 'abc-123 and def-45\n')
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="r4.txt"]')`), 'r4.txt in tree', 10000)
    // (The page was reloaded since the last override, so install it again.)
    await c.ev(`window.__confirms = []; window.__confirmAnswer = true; window.confirm = (m) => { window.__confirms.push(String(m)); return window.__confirmAnswer }; window.alert = (m) => (window.__alerts = window.__alerts || []).push(String(m))`)
    const setReplacement = (text) => c.ev(`(() => { const el = document.querySelector('[data-search-replace]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    const searchNote = () => c.ev(`document.querySelector('[data-search-note]')?.textContent || ''`)
    const hitFiles = () => c.ev(`[...document.querySelectorAll('.search-file-name')].map(f => f.textContent.replace(/\\s*\\d+$/, '').trim())`)
    await clickBtn('Search', '.sidebar-views')
    await typeInput('.search-box input', 'alpha')
    await waitFor(async () => (await hitFiles()).length >= 3, 'search results', 10000)
    check('the search lists the files that contain the text', ['r1.txt', 'r2.txt', 'r3.txt'].every((f) => hitFiles && true) && JSON.stringify((await hitFiles()).sort()) === JSON.stringify(['r1.txt', 'r2.txt', 'r3.txt']), JSON.stringify(await hitFiles()))
    check('replace controls are hidden until toggled', !(await c.ev(`!!document.querySelector('[data-search-replace]')`)) && !(await c.ev(`!!document.querySelector('[data-search-action="replace-file"]')`)))
    await c.ev(`document.querySelector('[data-search-action="toggle-replace"]').click()`)
    await setReplacement('omega')
    check('toggling shows the replace box and per-file / per-line buttons', await c.ev(`!!document.querySelector('[data-search-replace]') && !!document.querySelector('[data-search-action="replace-file"]') && !!document.querySelector('[data-search-action="replace-line"]')`))

    // r3.txt is open with unsaved edits: it must never be changed behind the editor's back
    await c.ev(`document.querySelector('.tree-row[data-tree-path$="r3.txt"]').click()`)
    await waitFor(async () => (await activeTab()) === 'r3.txt', 'r3 open')
    await typeInEditor('#')
    await waitFor(async () => (await dirtyTabs()).includes('r3.txt'), 'r3 dirty')

    await c.ev(`[...document.querySelectorAll('.search-file')].find(f => f.textContent.includes('r1.txt')).nextElementSibling.querySelector('[data-search-action="replace-line"]').click()`)
    check('"Replace" on one line asks first and changes only that line (every match on it)', await waitFor(() => fs.readFileSync(path.join(PROJ, 'r1.txt'), 'utf8') === 'omega beta omega\nsecond alpha line\n', 'line replaced'), JSON.stringify(fs.readFileSync(path.join(PROJ, 'r1.txt'), 'utf8')))
    check('the confirmation names what is searched and replaced', (await c.ev(`window.__confirms.join('|')`)).includes('"alpha"') && (await c.ev(`window.__confirms.join('|')`)).includes('"omega"'), await c.ev(`window.__confirms.join('|')`))
    check('the results refresh and a summary is shown', await waitFor(async () => /Replaced 2 occurrence\(s\) in 1 file\(s\)/.test(await searchNote()), 'summary note'), await searchNote())

    await c.ev(`window.__confirmAnswer = false`)
    await c.ev(`document.querySelector('[data-search-action="replace-all"]').click()`)
    await sleep(700)
    check('answering "no" to the confirmation changes nothing', fs.readFileSync(path.join(PROJ, 'r2.txt'), 'utf8') === 'alpha\n' && fs.readFileSync(path.join(PROJ, 'r1.txt'), 'utf8').includes('second alpha line'))
    await c.ev(`window.__confirmAnswer = true`)
    await c.ev(`document.querySelector('[data-search-action="replace-all"]').click()`)
    check('Replace All changes every listed file except the one with unsaved edits', await waitFor(() => fs.readFileSync(path.join(PROJ, 'r2.txt'), 'utf8') === 'omega\n' && fs.readFileSync(path.join(PROJ, 'r1.txt'), 'utf8') === 'omega beta omega\nsecond omega line\n' && fs.readFileSync(path.join(PROJ, 'r3.txt'), 'utf8') === 'alpha in an open file\n', 'replace all'))
    check('the summary reports the skipped file and why', await waitFor(async () => /Skipped: r3\.txt \(unsaved changes\)/.test(await searchNote()), 'skip note'), await searchNote())

    await ctrl('s') // save r3.txt; it is clean now
    await waitFor(async () => !(await dirtyTabs()).includes('r3.txt'), 'r3 saved')
    await c.ev(`document.querySelector('[data-search-query]').focus()`)
    await typeInput('.search-box input', 'alpha')
    await waitFor(async () => (await hitFiles()).includes('r3.txt'), 'r3 in results again')
    await c.ev(`document.querySelector('[data-search-action="replace-all"]').click()`)
    check('once saved, the file is replaced too', await waitFor(() => /omega in an open file/.test(fs.readFileSync(path.join(PROJ, 'r3.txt'), 'utf8')), 'r3 replaced'))
    check('and its open tab shows the new text without reopening it', await waitFor(() => c.ev(`document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/ /g, ' ').includes('omega in an open file')`), 'tab reloaded after replace', 10000))

    // Regular expressions with capture groups
    await c.ev(`[...document.querySelectorAll('.search-box button')].find(b => b.textContent.trim() === '.*').click()`)
    await typeInput('.search-box input', '(\\w+)-(\\d+)')
    await waitFor(async () => (await hitFiles()).includes('r4.txt'), 'regex results')
    await setReplacement('$2-$1')
    await c.ev(`document.querySelector('[data-search-action="replace-all"]').click()`)
    check('regex mode: capture groups ($2-$1) are applied to every match', await waitFor(() => fs.readFileSync(path.join(PROJ, 'r4.txt'), 'utf8') === '123-abc and 45-def\n', 'regex replace'), JSON.stringify(fs.readFileSync(path.join(PROJ, 'r4.txt'), 'utf8')))
    await c.ev(`[...document.querySelectorAll('.search-box button')].find(b => b.textContent.trim() === '.*').click()`)
    await c.ev(`document.querySelector('.sidebar-views button').click()`) // back to the explorer

    // ---- AI features: project rules, @ mentions, images, Apply, usage ----
    await c.ev(`window.__confirms = []; window.__confirmAnswer = true; window.confirm = (m) => { window.__confirms.push(String(m)); return window.__confirmAnswer }; window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m))`)
    const lastChatRequest = () => requests.filter((r) => r.body.stream && !r.body.tools && r.body.model !== 'claude-sonnet-5-5' || false).pop() || requests.filter((r) => r.body.stream && !r.body.tools).pop()
    const systemOf = (r) => (typeof r.body.system === 'string' ? r.body.system : JSON.stringify(r.body.system))
    const sendChat = async (text) => { const before = requests.length; await typeInto('.chat textarea', text); await clickBtn('Send', '.chat'); await waitFor(() => requests.length > before, 'request sent'); await waitFor(async () => !(await c.ev(`!![...document.querySelectorAll('.chat button')].find(b => b.textContent.trim() === 'Stop' && b.getClientRects().length)`)), 'reply finished', 20000); return requests[requests.length - 1] }

    fs.writeFileSync(path.join(PROJ, 'AGENTS.md'), '# Rules\nZEBRA-RULE-42: always reply in a friendly tone\n')
    await c.ev(`window.dispatchEvent(new Event('focus'))`) // the chip refreshes when the window regains focus
    check('a project rules file shows as a chip in the chat header', await waitFor(() => c.ev(`document.querySelector('[data-rules-chip]')?.textContent.trim() === 'Rules · 1' && document.querySelector('[data-rules-chip]').title.includes('AGENTS.md')`), 'rules chip', 10000))
    let req = await sendChat('hello rules')
    check('chat sends the project rules to the model', systemOf(req).includes('ZEBRA-RULE-42') && systemOf(req).includes('Project rules'), systemOf(req).slice(-160))
    check('a finished reply shows its token usage', await waitFor(() => c.ev(`[...document.querySelectorAll('[data-chat-usage]')].some(u => u.textContent.trim() === '10 in · 20 out')`), 'usage line'))

    // @ mention suggestions
    await typeInto('.chat textarea', '@')
    const mentionValues = await waitFor(() => c.ev(`[...document.querySelectorAll('.mention-item')].map(m => m.dataset.mention)`).then((r) => r.length && r), 'mention list', 10000)
    check('typing @ offers git, problems, terminal, a folder and files', ['git', 'problems', 'terminal'].every((s) => mentionValues.includes(s)) && mentionValues.some((v) => v.endsWith('/')) && mentionValues.length > 4, JSON.stringify(mentionValues))
    await typeInto('.chat textarea', '')

    // @git
    fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'hello world\nGITDIFF-MARKER line\n')
    await sleep(600)
    req = await sendChat('@git what changed?')
    check('@git sends the working-tree diff', systemOf(req).includes('Git changes') && systemOf(req).includes('GITDIFF-MARKER'), systemOf(req).slice(-200))
    check('the message notes which context was attached', await c.ev(`[...document.querySelectorAll('.chat-note')].some(n => n.textContent.includes('@git'))`))
    gitSh('checkout -q -- hello.txt')

    // @folder
    req = await sendChat('summarize @src/')
    check('@folder sends the folder listing', systemOf(req).includes('Contents of the folder src/') && systemOf(req).includes('comp.tsx') && systemOf(req).includes('lib/'), systemOf(req).slice(-200))

    // @problems (bad.ts has a syntax error; open it so the editor analyses it)
    fs.writeFileSync(path.join(PROJ, 'src', 'bad.ts'), 'const x: number = ;\n')
    if (!(await c.ev(`!!document.querySelector('.tree-row[data-tree-path$="bad.ts"]')`))) await c.ev(`document.querySelector('.tree-row[data-tree-path$="src"]')?.click()`)
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="bad.ts"]')`), 'bad.ts in tree for @problems', 10000)
    await openFromTree('bad.ts')
    await waitFor(async () => !(await problemCounts()).includes('⊗ 0'), 'problem counted for @problems', 20000)
    req = await sendChat('fix @problems')
    check('@problems sends the errors with file and line', systemOf(req).includes('Problems (errors and warnings)') && /bad\.ts:1:\d+ error/.test(systemOf(req)), systemOf(req).slice(-200))

    // @terminal (no terminal is open at this point)
    req = await sendChat('why did @terminal fail')
    check('@terminal says so when there is no terminal output', systemOf(req).includes('Current output of the terminal') && systemOf(req).includes('the terminal is empty or closed'))

    // Images: attach through the file picker input, remove one, send one, reject a non-image
    const pngFile = path.join(os.tmpdir(), 'my-ai-ide-e2e-pixel.png'); fs.writeFileSync(pngFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'))
    const fakePng = path.join(os.tmpdir(), 'my-ai-ide-e2e-fake.png'); fs.writeFileSync(fakePng, 'this is not a picture')
    const setFiles = async (files) => { const doc = await c.send('DOM.getDocument', { depth: -1 }); const q = await c.send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: '[data-chat-file-input]' }); await c.send('DOM.setFileInputFiles', { nodeId: q.result.nodeIds[0], files }) }
    await setFiles([pngFile, fakePng]);
    check('a picture attaches with a thumbnail; a non-image is rejected with a message', await waitFor(async () => (await c.ev(`document.querySelectorAll('.chat-thumb').length`)) === 1 && /not an image/.test(await c.ev(`[...document.querySelectorAll('.chat .chat-error')].map(e => e.textContent).join(' ')`)), 'thumbnail + error'))
    await c.ev(`document.querySelector('.chat-thumb button').click()`)
    check('the thumbnail can be removed', await waitFor(() => c.ev(`document.querySelectorAll('.chat-thumb').length === 0`), 'thumb removed'))
    await setFiles([pngFile])
    await waitFor(() => c.ev(`document.querySelectorAll('.chat-thumb').length === 1`), 'thumbnail again')
    req = await sendChat('what is in this picture?')
    const lastMsg = req.body.messages[req.body.messages.length - 1]
    check('the picture is sent to the model as an image block before the text', Array.isArray(lastMsg.content) && lastMsg.content[0].type === 'image' && lastMsg.content[0].source.type === 'base64' && lastMsg.content[0].source.media_type === 'image/png' && lastMsg.content[0].source.data.length > 20 && lastMsg.content[lastMsg.content.length - 1].text === 'what is in this picture?', JSON.stringify(lastMsg).slice(0, 200))
    check('the sent message is marked as having an image, and the attachment area is cleared', (await c.ev(`[...document.querySelectorAll('.chat-note')].some(n => /1 image attached/.test(n.textContent))`)) && (await c.ev(`document.querySelectorAll('.chat-thumb').length === 0`)))
    fs.rmSync(pngFile, { force: true }); fs.rmSync(fakePng, { force: true })

    // Apply: a code block in a reply is merged into the open file by the model, and shown as a diff first
    check('without an open file the Apply button is not offered', await (async () => { await rightClick('.tab'); await clickMenu('Close All'); await waitFor(async () => (await tabNames()).length === 0, 'tabs closed'); await sendChat('CODEBLOCK please'); return !(await c.ev(`!!document.querySelector('[data-chat-apply]')`)) })())
    await openFromTree('plain.txt')
    check('with a file open each code block offers Apply', await waitFor(() => c.ev(`!!document.querySelector('[data-chat-apply]')`), 'apply button'))
    const beforeApply = fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8')
    await c.ev(`[...document.querySelectorAll('[data-chat-apply]')].pop().click()`)
    check('Apply shows a busy note, then a diff to review (nothing is changed yet)', await waitFor(() => c.ev(`!!document.querySelector('.qp.approval .monaco-diff-editor')`), 'apply diff', 20000) && !(await dirtyTabs()).includes('plain.txt'))
    const applyReq = requests.filter((r) => r.body.model === 'claude-sonnet-5-5' && JSON.stringify(r.body.system).includes('apply a proposed change')).pop()
    check('the apply request carries the whole original file and the snippet', !!applyReq && JSON.stringify(applyReq.body.messages).includes('export const applied = true') && JSON.stringify(applyReq.body.messages).includes('FILE>>>'))
    await clickBtn('Reject', '.approval')
    check('Reject changes nothing', await waitFor(async () => !(await c.ev(`!!document.querySelector('.qp.approval')`)) && !(await dirtyTabs()).length && fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8') === beforeApply, 'rejected'))
    await c.ev(`[...document.querySelectorAll('[data-chat-apply]')].pop().click()`)
    await waitFor(() => c.ev(`!!document.querySelector('.qp.approval .monaco-diff-editor')`), 'apply diff again', 20000)
    await clickBtn('Accept', '.approval')
    check('Accept puts the merged text in the editor (unsaved, so Ctrl+Z can undo it)', await waitFor(async () => (await dirtyTabs()).includes('plain.txt') && (await c.ev(`document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/ /g, ' ').includes('Hello from the mock chat model.')`)) && fs.readFileSync(path.join(PROJ, 'plain.txt'), 'utf8') === beforeApply, 'applied to editor'))
    await rightClick('.tab'); await clickMenu('Close All') // discards the unsaved apply (the confirm override says yes)

    // Create the rules file from the palette (the existing one is opened instead; then without one it is created)
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'project rules'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Project Rules'))`), 'rules command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Project Rules')).click()`)
    check('the "Create or Open Project Rules" command opens the existing file without changing it', await waitFor(async () => (await activeTab()) === 'AGENTS.md', 'AGENTS.md open') && fs.readFileSync(path.join(PROJ, 'AGENTS.md'), 'utf8').includes('ZEBRA-RULE-42'))
    await rightClick('.tab'); await clickMenu('Close All')
    fs.rmSync(path.join(PROJ, 'AGENTS.md'))
    await c.ev(`window.dispatchEvent(new Event('focus'))`)
    check('the chip disappears when the rules file is gone', await waitFor(() => c.ev(`!document.querySelector('[data-rules-chip]')`), 'chip gone', 10000))
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'project rules'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Project Rules'))`), 'rules command again')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Project Rules')).click()`)
    check('without one, the command creates AGENTS.md from a template and opens it', await waitFor(async () => (await activeTab()) === 'AGENTS.md' && /# Project rules/.test(fs.readFileSync(path.join(PROJ, 'AGENTS.md'), 'utf8')), 'AGENTS.md created'))
    fs.writeFileSync(path.join(PROJ, 'AGENTS.md'), '# Rules\nZEBRA-RULE-42: tone\n') // for the agent and inline-edit checks below
    await rightClick('.tab'); await clickMenu('Close All')

    // The agent and inline edit read the rules too
    await clickBtn('Agent', '.chat')
    await typeInto('.chat textarea', 'ping')
    await clickBtn('Send', '.chat')
    check('the agent receives the project rules', await waitFor(() => { const r = requests.filter((x) => x.body.tools).pop(); return !!r && JSON.stringify(r.body.system).includes('ZEBRA-RULE-42') }, 'agent request with rules', 20000))
    await waitFor(() => c.ev(`!![...document.querySelectorAll('.chat-input button')].find(b => b.textContent.trim() === 'Send')`), 'agent idle', 20000)
    await clickBtn('Chat', '.chat')
    await openFromTree('plain.txt')
    await c.ev(`document.querySelector('.monaco-editor textarea').focus()`)
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 })
    await waitFor(() => c.ev(`!!document.querySelector('.ie-bar input')`), 'inline edit bar')
    const beforeInline = requests.length
    await typeInput('.ie-bar input', 'make it shout')
    check('inline edit sends the project rules too', await waitFor(() => requests.length > beforeInline && JSON.stringify(requests[requests.length - 1].body.system).includes('ZEBRA-RULE-42'), 'inline request with rules', 15000))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitFor(() => c.ev(`!document.querySelector('.qp.ie')`), 'inline edit closed')
    await rightClick('.tab'); await clickMenu('Close All')
    fs.rmSync(path.join(PROJ, 'AGENTS.md'), { force: true })

    // ---- Terminals (real shells, driven with real key events) ----
    const keyDown = (key, extra = {}) => c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...extra })
    const keyUp = (key, extra = {}) => c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...extra })
    const shortcut = (init) => c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, ...init })}))`)
    const panelVisible = () => c.ev(`(() => { const p = document.querySelector('.terminal-panel'); return !!p && getComputedStyle(p).display !== 'none' })()`)
    const termTabs = () => c.ev(`[...document.querySelectorAll('.term-tab')].map(t => t.querySelector('.term-tab-name').textContent)`)
    const activeTermTab = () => c.ev(`document.querySelector('.term-tab.active .term-tab-name')?.textContent`)
    const termText = () => c.ev(`(() => { const v = [...document.querySelectorAll('.term-view')].find(v => v.style.display !== 'none'); return v ? (v.querySelector('.xterm-rows')?.textContent || '').replace(/\\u00a0/g, ' ') : '' })()`)
    const focusTerm = () => c.ev(`[...document.querySelectorAll('.term-view')].find(v => v.style.display !== 'none')?.querySelector('.xterm-helper-textarea')?.focus()`)
    const runInTerm = async (cmd) => {
      await focusTerm()
      for (const ch of cmd) { await keyDown(ch, { text: ch, unmodifiedText: ch }); await keyUp(ch) }
      await keyDown('Enter', { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }); await keyUp('Enter', { code: 'Enter', windowsVirtualKeyCode: 13 })
    }
    const count = (text, needle) => text.split(needle).length - 1
    const toggleKey = () => shortcut({ key: '`', code: 'Backquote', ctrlKey: true })

    await toggleKey()
    check('Ctrl+` opens the terminal panel with one PowerShell tab', await waitFor(async () => (await panelVisible()) && JSON.stringify(await termTabs()) === '["PowerShell"]', 'first terminal'), JSON.stringify(await termTabs()))
    check('the shell starts and shows a prompt', await waitFor(async () => /PS .*>/.test(await termText()), 'PowerShell prompt', 30000))
    await runInTerm('echo MARK-ONE')
    check('typing a command runs it and shows its output', await waitFor(async () => count(await termText(), 'MARK-ONE') >= 2, 'MARK-ONE echoed'))

    await clickBtn('+', '.term-tabs')
    check('+ opens a second terminal and selects it', await waitFor(async () => JSON.stringify(await termTabs()) === '["PowerShell","PowerShell 2"]' && (await activeTermTab()) === 'PowerShell 2', 'second tab'), JSON.stringify(await termTabs()))
    await waitFor(async () => /PS .*>/.test(await termText()), 'second prompt', 30000)
    await runInTerm('echo MARK-TWO')
    await waitFor(async () => count(await termText(), 'MARK-TWO') >= 2, 'MARK-TWO echoed')
    check('terminals are independent sessions', !(await termText()).includes('MARK-ONE'))
    await c.ev(`[...document.querySelectorAll('.term-tab')][0].click()`)
    check('switching tabs shows each terminal\'s own output', await waitFor(async () => { const t = await termText(); return t.includes('MARK-ONE') && !t.includes('MARK-TWO') }, 'tab 1 content'))

    await toggleKey()
    check('Ctrl+` hides the panel', await waitFor(async () => !(await panelVisible()), 'panel hidden'))
    await toggleKey()
    check('showing it again keeps the running sessions', await waitFor(async () => (await panelVisible()) && JSON.stringify(await termTabs()) === '["PowerShell","PowerShell 2"]' && (await termText()).includes('MARK-ONE'), 'sessions kept'))

    await clickBtn('▾', '.term-tabs')
    const shellItems = await waitFor(() => c.ev(`[...document.querySelectorAll('.term-menu-item')].map(i => i.dataset.shell)`).then((r) => r.length && r), 'shell menu')
    check('shell menu lists the available shells', shellItems.includes('powershell') && shellItems.includes('cmd'), JSON.stringify(shellItems))
    await c.ev(`document.querySelector('.term-menu-item[data-shell="cmd"]').click()`)
    check('choosing Command Prompt opens a cmd tab', await waitFor(async () => (await activeTermTab()) === 'Command Prompt', 'cmd tab'))
    const bannerOk = await waitFor(async () => /Microsoft Windows/.test(await termText()), 'cmd banner', 20000).catch(async (e) => { console.log('DEBUG cmd view text:', JSON.stringify((await termText()).slice(0, 400)), '| tabs:', JSON.stringify(await termTabs()), '| html:', (await c.ev(`(() => { const v = [...document.querySelectorAll('.term-view')].find(v => v.style.display !== 'none'); return v ? v.innerHTML.slice(0, 300) : 'no visible view' })()`))); return false })
    check('cmd output that arrives instantly is not lost (banner)', bannerOk, (await termText()).slice(0, 80))
    await runInTerm('echo CMD-MARK')
    check('Command Prompt runs commands', await waitFor(async () => count(await termText(), 'CMD-MARK') >= 2, 'cmd echo'))
    await runInTerm('exit')
    check('a shell that exits closes its own tab', await waitFor(async () => JSON.stringify(await termTabs()) === '["PowerShell","PowerShell 2"]', 'cmd tab closed'), JSON.stringify(await termTabs()))

    // Default shell setting decides what + opens.
    await clickBtn('Settings', '.statusbar')
    await waitFor(() => c.ev(`!!document.querySelector('select[data-setting="terminalShell"]')`), 'shell setting')
    await c.ev(`(() => { const s = document.querySelector('select[data-setting="terminalShell"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'cmd'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await clickBtn('+', '.term-tabs')
    check('the default shell setting is used by +', await waitFor(async () => (await activeTermTab()) === 'Command Prompt 2', 'default shell applied'), JSON.stringify(await termTabs()))
    await shortcut({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true })
    check('Ctrl+Shift+` opens another terminal', await waitFor(async () => (await termTabs()).length === 4, 'fourth tab'), JSON.stringify(await termTabs()))
    await c.ev(`(() => { const s = document.querySelector('select[data-setting="terminalShell"]'); })()`)

    // Resize handle
    const panelH = () => c.ev(`document.querySelector('.terminal-panel').getBoundingClientRect().height`)
    const h0 = await panelH()
    const handle = await c.ev(`(() => { const r = document.querySelector('.term-resize').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y - 80, button: 'left' })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x, y: handle.y - 80, button: 'left', clickCount: 1 })
    check('dragging the handle resizes the panel', await waitFor(async () => Math.abs((await panelH()) - (h0 + 80)) < 3, 'panel resized'), `${h0} -> ${await panelH()}`)

    // Close tabs one by one; the panel hides with the last one and a fresh shell starts next time.
    for (let n = (await termTabs()).length; n > 0; n--) await c.ev(`document.querySelector('.term-tab .close').click()`)
    check('closing the last tab hides the panel', await waitFor(async () => !(await panelVisible()) && (await termTabs()).length === 0, 'all closed'))
    await toggleKey()
    check('reopening starts a fresh terminal', await waitFor(async () => (await panelVisible()) && (await termTabs()).length === 1 && !(await termText()).includes('MARK-ONE'), 'fresh terminal'), JSON.stringify(await termTabs()))
    await c.ev(`document.querySelector('.term-tab .close').click()`)
    await waitFor(async () => !(await panelVisible()), 'panel hidden at the end')
    // Put the default shell back so later checks see the normal defaults.
    await clickBtn('Settings', '.statusbar')
    await c.ev(`(() => { const s = document.querySelector('select[data-setting="terminalShell"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'powershell'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

    // ---- Settings ----
    const fontOf = () => c.ev(`(() => { const s = getComputedStyle(document.querySelector('.monaco-editor .view-lines')); return { size: s.fontSize, family: s.fontFamily } })()`)
    const saved = () => c.ev(`JSON.parse(localStorage.getItem('settings') || 'null')`)
    const stepper = (name, dir) => c.ev(`document.querySelector('.stepper[data-setting="${name}"] button[aria-label="${dir}"]').click()`)
    const setSelect = (sel, v) => c.ev(`(() => { const s = document.querySelector('${sel}'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${v}'); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`)
    const toggle = (name) => c.ev(`document.querySelector('input[data-setting="${name}"]').click()`)
    const minimapShown = () => c.ev(`(() => { const m = document.querySelector('.monaco-editor .minimap'); return !!m && getComputedStyle(m).display !== 'none' && m.getBoundingClientRect().width > 10 })()`)

    // The editor only has a text layer once a file is open.
    const openHello = async () => { await c.ev(`[...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === 'hello.txt').click()`); await waitFor(() => c.ev(`!!document.querySelector('.monaco-editor .view-lines')`), 'editor text layer') }
    await openHello()
    check('editor starts at 14px with the default font',(await fontOf()).size === '14px' && /Cascadia Code/.test((await fontOf()).family), JSON.stringify(await fontOf()))
    check('minimap is on by default', await waitFor(() => minimapShown(), 'minimap visible'))
    await clickBtn('Settings', '.statusbar')
    check('Settings dialog opens from the status bar', await waitFor(() => c.ev(`!!document.querySelector('.qp.settings')`), 'settings dialog'))
    await stepper('fontSize', 'Increase')
    check('font size applies live to the editor', await waitFor(async () => (await fontOf()).size === '15px', 'font 15px'))
    await typeInput('.set-text', 'Consolas')
    check('font family applies live to the editor', await waitFor(async () => /^Consolas/.test((await fontOf()).family), 'Consolas'), JSON.stringify(await fontOf()))
    await toggle('minimap')
    check('minimap can be turned off', await waitFor(async () => !(await minimapShown()), 'minimap hidden'))
    await toggle('wordWrap')
    await stepper('uiZoom', 'Increase')
    check('UI zoom scales the interface', await waitFor(() => c.ev(`Math.abs(window.devicePixelRatio - 1.1) < 0.02`), 'zoom 110%'), await c.ev(`String(window.devicePixelRatio)`))
    await setSelect('select[data-setting="defaultModel"]', 'claude-haiku-5-5')
    await toggle('autocomplete')
    check('autocomplete setting shows in the status bar', await c.ev(`document.querySelector('.statusbar').textContent.includes('Autocomplete: off')`))
    const s1 = await saved()
    check('settings are saved', s1 && s1.fontSize === 15 && s1.fontFamily === 'Consolas' && s1.minimap === false && s1.wordWrap === true && s1.uiZoom === 1.1 && s1.defaultModel === 'claude-haiku-5-5' && s1.autocomplete === false, JSON.stringify(s1))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    check('Esc closes the dialog', await waitFor(() => c.ev(`!document.querySelector('.qp.settings')`), 'dialog closed'))
    check('default model switches the chat panel', (await c.ev(`[...document.querySelectorAll('.chat select')].find(s => s.getClientRects().length)?.value`)) === 'claude-haiku-5-5')

    await c.ev(`location.reload()`).catch(() => {})
    await waitFor(() => c.ev(`!!document.querySelector('.sidebar') && document.querySelectorAll('.tree-row').length > 0`), 'app back after second reload')
    await openHello()
    await waitFor(async () => (await fontOf()).size === '15px', 'font size restored after reload')
    check('settings survive a reload', (await fontOf()).size === '15px' && /^Consolas/.test((await fontOf()).family) && (await c.ev(`Math.abs(window.devicePixelRatio - 1.1) < 0.02`)) && !(await minimapShown()))

    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`)
    check('Ctrl+, opens Settings', await waitFor(() => c.ev(`!!document.querySelector('.qp.settings')`), 'settings via shortcut'))
    // Updates
    const updateText = () => c.ev(`document.querySelector('[data-setting="updateText"]')?.textContent || ''`)
    const clickCheck = () => c.ev(`document.querySelector('button[data-setting="updateCheck"]').click()`)
    check('Settings shows the version, and the automatic startup check ran (feed says current)', await waitFor(async () => /latest version/.test(await updateText()) && (await c.ev(`document.querySelector('.set-row .set-label')?.parentElement && [...document.querySelectorAll('.set-label')].some(l => l.textContent.trim() === 'Version 0.1.0')`)), 'startup update check', 40000), await updateText())
    updateMode = 'down'
    await clickCheck()
    check('a feed that fails is reported as an error', await waitFor(async () => /Could not check/.test(await updateText()), 'error shown'), await updateText())
    updateMode = 'none'
    await clickCheck()
    check('"Check for updates" reports when you are up to date', await waitFor(async () => /latest version/.test(await updateText()), 'up to date'))
    updateMode = 'bad'
    await clickCheck()
    await waitFor(async () => /Version 9\.9\.9 is available/.test(await updateText()), 'bad-feed update offered')
    await c.ev(`document.querySelector('button[data-setting="updateDownload"]').click()`)
    check('a download whose checksum does not match is rejected', await waitFor(async () => /integrity check/.test(await updateText()) && !/sha512/i.test(await updateText()), 'checksum error', 30000), await updateText())
    updateMode = 'ok'
    await clickCheck()
    check('a newer version is offered in Settings and in the status bar', await waitFor(async () => /Version 9\.9\.9 is available/.test(await updateText()) && (await c.ev(`document.querySelector('.sb-update')?.textContent`)) === 'Update 9.9.9 available', 'update offered'))
    await c.ev(`document.querySelector('.sb-update').click()`)
    check('clicking the status bar button downloads it and then offers a restart', await waitFor(async () => (await c.ev(`document.querySelector('.sb-update')?.textContent`)) === 'Restart to update' && /is downloaded/.test(await updateText()), 'download finished', 40000), await updateText())
    const downloaded = (function find(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? find(path.join(dir, d.name)) : [path.join(dir, d.name)]) : [] })(LOCAL_APP_DATA).filter((f) => f.endsWith('.exe'))
    check('the verified installer is in the (isolated) updater cache', downloaded.length === 1 && fs.statSync(downloaded[0]).size === FAKE_INSTALLER.length, downloaded.join(','))
    await toggle('autoCheckUpdates')
    check('automatic checking can be switched off', (await saved()).autoCheckUpdates === false)
    await toggle('autoCheckUpdates')

    // Custom themes in Settings
    const note = () => c.ev(`document.querySelector('[data-setting="themeNote"]')?.textContent || ''`)
    const themeOptions = () => c.ev(`[...document.querySelectorAll('select[data-setting="theme"] optgroup')].map(g => g.label + ':' + [...g.querySelectorAll('option')].map(o => o.textContent).join('|'))`)
    check('invalid theme file is reported with the reason, valid ones are not', await waitFor(async () => /broken\.json/.test(await note()) && /ui\.bg/.test(await note()) && /ui\.nope/.test(await note()) && !/neon\.json/.test(await note()), 'error note'), await note())
    check('theme list in Settings has Built-in and Custom groups', (await themeOptions()).join(' ').includes('Custom:Neon Test'), JSON.stringify(await themeOptions()))
    await c.ev(`document.querySelector('button[data-setting="themesDuplicate"]').click()`)
    const dup = await waitFor(() => fs.readdirSync(THEMES_DIR).find((f) => /^dracula-copy.*\.json$/.test(f)), 'duplicate file written')
    const dupJson = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, dup), 'utf8'))
    check('Duplicate current writes a complete, valid theme file and switches to it', dupJson.name === 'Dracula copy' && dupJson.ui.bg === '#282a36' && Object.keys(dupJson.ui).length === 13 && Object.keys(dupJson.syntax).length === 10 && (await savedTheme()) === 'custom:' + dup)
    fs.writeFileSync(path.join(THEMES_DIR, dup), JSON.stringify({ ...dupJson, ui: { ...dupJson.ui, bg: '#0a0b0c' } }))
    await c.ev(`document.querySelector('button[data-setting="themesReload"]').click()`)
    check('Reload picks up edits to the active custom theme', await waitFor(async () => (await bgVar()) === '#0a0b0c', 'edited theme reloaded'))
    fs.rmSync(path.join(THEMES_DIR, dup))
    await c.ev(`document.querySelector('button[data-setting="themesReload"]').click()`)
    check('deleting the active theme file falls back to the default theme', await waitFor(async () => (await bgVar()) === '#1f1f1f', 'fallback to default'))
    await c.ev(`document.querySelector('button[data-setting="reset"]').click()`)
    check('Reset to defaults restores font, zoom, theme and minimap', await waitFor(async () => (await fontOf()).size === '14px' && /Cascadia Code/.test((await fontOf()).family) && (await bgVar()) === '#1f1f1f' && (await c.ev(`Math.abs(window.devicePixelRatio - 1) < 0.02`)) && (await minimapShown()), 'reset applied'))

    check('no uncaught renderer errors', c.errors.length === 0, c.errors.slice(0, 3).join(' | '))
  } catch (e) {
    check('test run completed without exception', false, e.message)
    if (c) console.log('renderer errors so far:', c.errors.slice(0, 5))
  } finally {
    try { c && c.close() } catch {}
    try { execSync(`taskkill /pid ${app.pid} /T /F`, { stdio: 'ignore' }) } catch {}
    removeTestHistory()
    server.close()
    const failed = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failed}/${results.length} checks passed`)
    process.exit(failed ? 1 : 0)
  }
})()
