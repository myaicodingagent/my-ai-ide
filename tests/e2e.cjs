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

// Background agent script (recognised by its system prompt).
const bgScript = [
  () => toolReply('Looking around. ', 'bg_1', 'read_file', { path: 'hello.txt' }),
  () => toolReply('Creating a file. ', 'bg_2', 'write_file', { path: 'bg-created.txt', content: 'made by the background agent\n' }),
  () => toolReply('Editing. ', 'bg_3', 'edit_file', { path: 'hello.txt', old_string: 'hello', new_string: 'bg-hello' }),
  () => toolReply('Checking. ', 'bg_4', 'run_command', { command: 'Write-Output "bg-cmd-ok"', timeout_seconds: 0 }),
  () => textReply('Background work finished: created bg-created.txt and edited hello.txt.')
]

// ---- fake extension registry: two packages built in memory ----
const AdmZip = require('adm-zip')
const makeVsix = (files) => { const z = new AdmZip(); z.addFile('[Content_Types].xml', Buffer.from('<Types/>')); for (const [p, text] of Object.entries(files)) z.addFile(p, Buffer.from(text)); return z.toBuffer() }
const REGISTRY = {
  'acme.nightsnip': makeVsix({
    'extension/package.json': JSON.stringify({ name: 'nightsnip', publisher: 'acme', version: '1.0.0', displayName: 'Night Snip', description: 'A dark theme and a snippet', contributes: { themes: [{ label: 'Night Test', uiTheme: 'vs-dark', path: './night.json' }], snippets: [{ language: 'javascript', path: './s.json' }] } }),
    'extension/night.json': JSON.stringify({ name: 'Night', colors: { 'editor.background': '#011627', 'editor.foreground': '#d6deeb', 'sideBar.background': '#010e1a', 'button.background': '#7e57c2' }, tokenColors: [{ scope: 'keyword', settings: { foreground: '#c792ea' } }] }),
    'extension/s.json': JSON.stringify({ Log: { prefix: 'log', body: 'console.log($1)', description: 'Print' } })
  }),
  'me.hello': makeVsix({
    'extension/package.json': JSON.stringify({ name: 'hello', publisher: 'me', version: '1.0.0', displayName: 'Hello Ext', description: 'Commands written for this editor', engines: { 'my-ai-ide': '*' }, main: 'main.js', contributes: { commands: [{ command: 'hello.upper', title: 'Upper Case Selection' }, { command: 'hello.ask', title: 'Ask For A Name' }, { command: 'hello.fail', title: 'Always Fails' }] } }),
    'extension/main.js': `exports.activate = (ide) => {
  ide.commands.register('hello.upper', async () => {
    const ed = await ide.editor.getActive()
    await ide.editor.replaceSelection(ed.selection.toUpperCase())
    await ide.window.showMessage('upper-cased ' + ed.selection.length + ' characters')
  })
  ide.commands.register('hello.ask', async () => {
    const name = await ide.window.showInput({ prompt: 'Your name?' })
    await ide.window.showMessage('Hello ' + name)
  })
  ide.commands.register('hello.fail', async () => { throw new Error('deliberate failure') })
}
`
  })
}

// Update feed state: 'none' (already current), 'ok' (9.9.9 available), 'bad' (wrong checksum), 'down' (server error).
const FAKE_INSTALLER = require('crypto').randomBytes(300 * 1024)
const sha512 = (b) => require('crypto').createHash('sha512').update(b).digest('base64')
let updateMode = 'none'

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/log') { res.end(JSON.stringify(requests)); return }
    // ---- fake extension registry (MY_AI_IDE_REGISTRY_URL) ----
    if (req.url.startsWith('/registry/api/-/search')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ extensions: [
        { namespace: 'acme', name: 'nightsnip', version: '1.0.0', displayName: 'Night Snip', description: 'A dark theme and a snippet', downloadCount: 4321, files: { download: `http://127.0.0.1:${API_PORT}/registry/dl/acme.nightsnip.vsix` } },
        { namespace: 'me', name: 'hello', version: '1.0.0', displayName: 'Hello Ext', description: 'Commands written for this editor', downloadCount: 12, files: { download: `http://127.0.0.1:${API_PORT}/registry/dl/me.hello.vsix` } }
      ] }))
      return
    }
    if (req.url.startsWith('/registry/dl/')) {
      const id = req.url.slice('/registry/dl/'.length).replace(/.vsix$/, '')
      if (REGISTRY[id]) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(REGISTRY[id]); return }
      res.writeHead(404); res.end(); return
    }
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
      const sys = JSON.stringify(json.system || '')
      const reply = /predict the next edit/.test(sys) ? '{"startLine":3,"endLine":3,"newText":"const renamed = 2"}' : /expand a code search query/.test(sys) ? '["charge", "credit", "card"]' : /rerank code search results/.test(sys) ? '[0]' : 'completion-text'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_c', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
      return
    }
    if (json.tools && JSON.stringify(json.system || '').includes('This is a background task')) {
      const assistants = (json.messages || []).filter((m) => m.role === 'assistant').length
      return sse(res, (bgScript[assistants] || (() => textReply('(background script exhausted)')))())
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
  // A command that never answers (a native dialog blocking the page, say) must not hang the whole run.
  const send = (method, params) => new Promise((r, rej) => { const i = ++id; const timer = setTimeout(() => { pending.delete(i); rej(new Error('CDP timed out after 40s: ' + method + ' ' + JSON.stringify(params).slice(0, 160))) }, 40000); pending.set(i, (d) => { clearTimeout(timer); r(d) }); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Runtime.enable')
  // The window should count as focused even if another program has the real focus while the test runs
  // (otherwise "on blur" auto save fires at random). Tests that need a blur send one themselves.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
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
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${API_PORT}`, ANTHROPIC_API_KEY: 'test-key-123', MY_AI_IDE_NO_TRASH: '1', MY_AI_IDE_UPDATE_URL: `http://127.0.0.1:${API_PORT}/updates/`, MY_AI_IDE_REGISTRY_URL: `http://127.0.0.1:${API_PORT}/registry`, LOCALAPPDATA: LOCAL_APP_DATA }
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
    check('agent offers all 8 tools', ['list_dir', 'read_file', 'search_text', 'search_codebase', 'find_files', 'edit_file', 'write_file', 'run_command'].every((n) => toolNames.includes(n)), toolNames.join(','))
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
    const other = path.join(os.tmpdir(), 'my-ai-ide-e2e-other-' + process.pid); fs.rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); fs.mkdirSync(other, { recursive: true })
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
    check('opening a recent folder switches the project and restores its saved tabs', await waitFor(async () => (await c.ev(`document.querySelector('.tree-root')?.textContent`)) === path.basename(other) && JSON.stringify(await tabNames()) === '["other.txt"]', 'switched folder'), `${await c.ev(`document.querySelector('.tree-root')?.textContent`)} ${JSON.stringify(await tabNames())}`)
    await rightClick('.tab'); await clickMenu('Close All')
    await waitFor(() => c.ev(`!!document.querySelector('[data-recent]')`), 'welcome again')
    await c.ev(`document.querySelector('[data-recent]').click()`)
    check('and back to the first folder', await waitFor(async () => (await c.ev(`document.querySelector('.tree-root')?.textContent`)) === 'my-ai-ide-e2e-project', 'back to project'))
    try { fs.rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }) } catch { /* a terminal started in that folder may still hold it; it is only a temp folder */ }

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

    // ---- Stash, history and merge conflicts ----
    // Stash takes untracked files too and branch switches move files around, so start from a clean tree.
    gitSh('add -A'); gitSh('commit -q -m snapshot --allow-empty')
    await c.ev(`document.querySelector('[data-view="git"]').click()`)
    await gitRefresh()
    fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'stash me\n')
    fs.writeFileSync(path.join(PROJ, 'stash-new.txt'), 'brand new\n')
    await gitRefresh()
    await waitFor(() => c.ev(`!!document.querySelector('.git-row[data-git-file="hello.txt"]')`), 'changed file listed')
    await typeInput('[data-git-stash-message]', 'my stash') // Enter in the box stashes
    check('Stash sets all changes aside (including new files)', await waitFor(() => gitSh('stash list').includes('my stash') && !fs.existsSync(path.join(PROJ, 'stash-new.txt')) && fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') !== 'stash me\n', 'stashed'))
    check('the stash is listed with its message', await waitFor(() => c.ev(`[...document.querySelectorAll('[data-git-stash]')].some(r => r.textContent.includes('my stash'))`), 'stash row'))
    await c.ev(`document.querySelector('[data-git-stash] [data-git-action="stash-apply"]').click()`)
    check('Apply brings the changes back and keeps the stash', await waitFor(() => fs.existsSync(path.join(PROJ, 'stash-new.txt')) && gitSh('stash list').includes('my stash'), 'applied'))
    gitSh('stash drop -q'); gitSh('checkout -- hello.txt'); fs.rmSync(path.join(PROJ, 'stash-new.txt'))
    await gitRefresh()
    await waitFor(() => c.ev(`document.querySelectorAll('[data-git-stash]').length === 0`), 'stash row gone after outside drop')
    fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'pop me\n'); await gitRefresh()
    await waitFor(() => c.ev(`!document.querySelector('[data-git-action="stash"]').disabled`), 'stash enabled')
    await c.ev(`document.querySelector('[data-git-action="stash"]').click()`)
    await waitFor(() => c.ev(`document.querySelectorAll('[data-git-stash]').length === 1`), 'stash row again')
    await c.ev(`document.querySelector('[data-git-stash] [data-git-action="stash-pop"]').click()`)
    check('Pop restores the changes and removes the stash', await waitFor(() => fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'pop me\n' && gitSh('stash list').trim() === '', 'popped'))
    fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'drop me\n'); await gitRefresh()
    await waitFor(() => c.ev(`!document.querySelector('[data-git-action="stash"]').disabled`), 'stash enabled again')
    await c.ev(`document.querySelector('[data-git-action="stash"]').click()`)
    await waitFor(() => c.ev(`document.querySelectorAll('[data-git-stash]').length === 1`), 'stash row to drop')
    await c.ev(`document.querySelector('[data-git-stash] [data-git-action="stash-drop"]').click()`)
    check('Delete removes a stash (after a confirmation)', await waitFor(() => gitSh('stash list').trim() === '', 'dropped'))
    gitSh('checkout -- hello.txt'); await gitRefresh()

    // History
    await c.ev(`document.querySelector('[data-git-view="history"]').click()`)
    const commitSubjects = () => c.ev(`[...document.querySelectorAll('[data-git-commit] .git-subject')].map(e => e.textContent)`)
    check('History lists the commits, newest first', await waitFor(async () => { const s = await commitSubjects(); return s.length >= 3 && s[0] === gitSh('log -1 --format=%s').trim() && s[s.length - 1] === 'initial' }, 'history list'), JSON.stringify(await commitSubjects()))
    check('the newest commit shows the branch it is on', await c.ev(`!!document.querySelector('[data-git-commit] .git-ref')`))
    const hash = gitSh('log --format=%H -- hello.txt').trim().split('\n')[0]
    await c.ev(`document.querySelector('[data-git-commit="${hash}"]').click()`)
    check('clicking a commit shows the files it changed', await waitFor(() => c.ev(`!!document.querySelector('[data-git-commit-file="hello.txt"]')`), 'commit file row'))
    await c.ev(`document.querySelector('[data-git-commit-file="hello.txt"]').click()`)
    check('clicking a file opens a diff of that commit', await waitFor(() => c.ev(`!!document.querySelector('.diff-view .monaco-diff-editor') && document.querySelector('.diff-title').textContent.includes('hello.txt (${hash.slice(0, 7)})')`), 'commit diff'))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitFor(() => c.ev(`!document.querySelector('.diff-view')`), 'diff closed')
    // File history from the palette
    await openFromTree('hello.txt')
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'file history'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('File History'))`), 'file history command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('File History')).click()`)
    const fileLog = gitSh('log --format=%s --follow -- hello.txt').trim().split('\n')
    check('File History shows only the commits that touched the file', await waitFor(async () => (await c.ev(`!!document.querySelector('.git-filter')`)) && JSON.stringify(await commitSubjects()) === JSON.stringify(fileLog), 'file history'), JSON.stringify(await commitSubjects()) + ' vs ' + JSON.stringify(fileLog))
    await c.ev(`document.querySelector('[data-git-action="clear-filter"]').click()`)
    check('"Show all" returns to the full history', await waitFor(async () => (await commitSubjects()).length > fileLog.length, 'filter cleared'))
    await rightClick('.tab'); await clickMenu('Close All')
    await c.ev(`document.querySelector('[data-git-view="changes"]').click()`)

    // Merge conflicts
    gitSh('checkout -q -b conflict-branch')
    fs.writeFileSync(path.join(PROJ, 'conf.txt'), 'top\nbranch version\nbottom\n'); fs.writeFileSync(path.join(PROJ, 'conf2.txt'), 'branch two\n')
    gitSh('add conf.txt conf2.txt'); gitSh('commit -q -m "branch side"')
    gitSh('checkout -q main')
    fs.writeFileSync(path.join(PROJ, 'conf.txt'), 'top\nmain version\nbottom\n'); fs.writeFileSync(path.join(PROJ, 'conf2.txt'), 'main two\n')
    gitSh('add conf.txt conf2.txt'); gitSh('commit -q -m "main side"')
    try { gitSh('merge conflict-branch') } catch { /* conflicts are the point */ }
    await gitRefresh()
    check('a merge with conflicts shows a banner with the count', await waitFor(() => c.ev(`/Merge in progress: 2 conflicted files/.test(document.querySelector('[data-git-merge]')?.textContent || '')`), 'merge banner'))
    check('conflicted files are marked with !', await waitFor(async () => (await gitRows(false)).includes('conf.txt:!') && (await gitRows(false)).includes('conf2.txt:!'), 'conflict rows'), JSON.stringify(await gitRows(false)))
    await openFromTree('conf.txt')
    check('the editor colours the two sides of a conflict', await waitFor(() => c.ev(`!!document.querySelector('.monaco-editor .conflict-current') && !!document.querySelector('.monaco-editor .conflict-incoming')`), 'conflict colours'))
    check('and offers Accept Current / Incoming / Both above it', await waitFor(() => c.ev(`(() => { const t = [...document.querySelectorAll('.monaco-editor .codelens-decoration a')].map(a => a.textContent); return ['Accept Current Change', 'Accept Incoming Change', 'Accept Both Changes'].every(x => t.includes(x)) })()`), 'codelens', 15000))
    const lensBox = await c.ev(`(() => { const r = [...document.querySelectorAll('.monaco-editor .codelens-decoration a')].find(a => a.textContent === 'Accept Both Changes').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: lensBox.x, y: lensBox.y, button: 'left', clickCount: 1 })
    check('Accept Both keeps both sides and removes the markers', await waitFor(() => c.ev(`(() => { const t = document.querySelector('.monaco-editor .view-lines').textContent.replace(/ /g, ' '); return t.includes('main version') && t.includes('branch version') && !t.includes('<<<<<<<') && !t.includes('>>>>>>>') && !t.includes('=======') })()`), 'accepted both'))
    check('the colours are gone once resolved', await waitFor(() => c.ev(`!document.querySelector('.monaco-editor .conflict-current')`), 'colours cleared'))
    await ctrl('s')
    check('saving writes the resolved text', await waitFor(() => fs.readFileSync(path.join(PROJ, 'conf.txt'), 'utf8').replace(/\r/g, '') === 'top\nmain version\nbranch version\nbottom\n', 'saved resolved'))
    await rightClick('.tab'); await clickMenu('Close All')
    await gitAction('stage', 'conf.txt')
    check('a resolved and staged file leaves the conflicts', await waitFor(async () => !(await gitRows(false)).includes('conf.txt:!') && (await gitRows(true)).some((r) => r.startsWith('conf.txt:')), 'conf.txt staged'), JSON.stringify(await gitRows(true)))
    await gitAction('take-theirs', 'conf2.txt')
    check('the row buttons take a whole side of a file', await waitFor(() => fs.readFileSync(path.join(PROJ, 'conf2.txt'), 'utf8').replace(/\r/g, '') === 'branch two\n' && gitSh('status --porcelain').includes('M  conf2.txt'), 'took theirs'))
    check('with everything resolved the banner asks you to commit', await waitFor(() => c.ev(`/Commit to finish/.test(document.querySelector('[data-git-merge]')?.textContent || '')`), 'banner commit'))
    await typeInto('[data-git-message]', 'Merge conflict-branch')
    await c.ev(`document.querySelector('[data-git-action="commit"]').click()`)
    check('committing finishes the merge and the banner goes away', await waitFor(async () => gitSh('log -1 --format=%s').trim() === 'Merge conflict-branch' && (await c.ev(`!document.querySelector('[data-git-merge]')`)), 'merge committed'))
    // abort
    gitSh('checkout -q -b abort-branch'); fs.writeFileSync(path.join(PROJ, 'conf.txt'), 'abort side\n'); gitSh('commit -q -m "abort side" conf.txt')
    gitSh('checkout -q main'); fs.writeFileSync(path.join(PROJ, 'conf.txt'), 'main again\n'); gitSh('commit -q -m "main again" conf.txt')
    try { gitSh('merge abort-branch') } catch { /* conflict */ }
    await gitRefresh()
    await waitFor(() => c.ev(`!!document.querySelector('[data-git-merge]')`), 'second merge banner')
    await c.ev(`document.querySelector('[data-git-action="merge-abort"]').click()`)
    check('Abort goes back to before the merge', await waitFor(async () => fs.readFileSync(path.join(PROJ, 'conf.txt'), 'utf8').replace(/\r/g, '') === 'main again\n' && (await c.ev(`!document.querySelector('[data-git-merge]')`)), 'aborted'))
    gitSh('checkout -q main'); gitSh('branch -D conflict-branch -q'); gitSh('branch -D abort-branch -q')
    await c.ev(`document.querySelector('.sidebar-views button').click()`)

    // ---- Split editor ----
    if ((await tabNames()).length) { await rightClick('.tab'); await clickMenu('Close All') }
    const helloOrig = fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8')
    await openFromTree('hello.txt')
    check('no split group at first', await c.ev(`!document.querySelector('[data-split-pane]')`))
    await rightClick('.tab'); await clickMenu('Split Right')
    check('"Split Right" opens a second editor group showing the file', await waitFor(() => c.ev(`!!document.querySelector('[data-split-pane] .monaco-editor') && document.querySelector('[data-split-pane] .stab.active .tab-name')?.textContent === 'hello.txt'`), 'split opened'))
    const splitText = () => c.ev(`document.querySelector('[data-split-pane] .view-lines')?.textContent.replace(/ /g, ' ') || ''`)
    const mainText = () => c.ev(`document.querySelector('.group-main .view-lines')?.textContent.replace(/ /g, ' ') || ''`)
    check('both groups show the same text', await waitFor(async () => (await splitText()).includes('hello world') && (await mainText()).includes('hello world'), 'same text'))
    const sideBySide = await c.ev(`(() => { const a = document.querySelector('.group-main').getBoundingClientRect(), b = document.querySelector('[data-split-pane]').getBoundingClientRect(); return b.left >= a.right - 1 && Math.abs(a.top - b.top) < 3 && a.width > 100 && b.width > 100 })()`)
    check('the groups sit side by side', sideBySide)
    // Typing in the split editor edits the shared model
    await c.ev(`document.querySelector('[data-split-pane] .monaco-editor textarea').focus()`)
    await c.send('Input.insertText', { text: 'SPLIT-EDIT ' })
    check('an edit made in the split group shows in the main group and marks the file unsaved', await waitFor(async () => (await mainText()).includes('SPLIT-EDIT') && (await dirtyTabs()).includes('hello.txt'), 'shared edit'))
    check('and the split group tab shows the unsaved dot too', await c.ev(`!!document.querySelector('[data-split-pane] .stab .tab-dot')`))
    await ctrl('s')
    check('Ctrl+S in the split group saves the file', await waitFor(() => fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8').includes('SPLIT-EDIT') && !fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8').startsWith('hello world'), 'saved from split'))
    check('the unsaved dots clear', await waitFor(async () => !(await dirtyTabs()).length && (await c.ev(`!document.querySelector('[data-split-pane] .tab-dot')`)), 'dots cleared'))
    fs.writeFileSync(path.join(PROJ, 'hello.txt'), helloOrig)
    await waitFor(async () => (await mainText()).includes('hello world') && !(await mainText()).includes('SPLIT-EDIT'), 'reloaded original')
    // With the split group in use, new files open there
    await c.ev(`document.querySelector('.tree-row[data-tree-path$="notes.md"]').click()`)
    check('with the split group in use, a file opened from the explorer opens there', await waitFor(() => c.ev(`document.querySelector('[data-split-pane] .stab.active .tab-name')?.textContent === 'notes.md'`), 'opened in split'))
    check('and the main group keeps showing its own file', (await activeTab()) === 'hello.txt')
    check('the split group has a tab for each of its files', (await c.ev(`document.querySelectorAll('[data-split-pane] .stab').length`)) === 2)
    await c.ev(`document.querySelector('[data-split-pane] .monaco-editor textarea').focus()`)
    await ctrl('w')
    check('Ctrl+W in the split group closes only its tab', await waitFor(async () => (await c.ev(`document.querySelectorAll('[data-split-pane] .stab').length`)) === 1 && (await tabNames()).includes('notes.md'), 'split tab closed'))
    // Clicking in the main group sends new files back there
    await c.ev(`document.querySelector('.group-main .monaco-editor textarea').focus()`)
    await c.ev(`document.querySelector('.group-main .tabs').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await openFromTree('plain.txt')
    check('after working in the main group, files open there again', await waitFor(async () => (await activeTab()) === 'plain.txt' && (await c.ev(`document.querySelectorAll('[data-split-pane] .stab').length`)) === 1, 'opened in main'))
    // Resizing, split down, close
    const widthBefore = await c.ev(`document.querySelector('[data-split-pane]').getBoundingClientRect().width`)
    const hb = await c.ev(`(() => { const r = document.querySelector('[data-split-handle]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hb.x, y: hb.y, button: 'left', clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hb.x - 150, y: hb.y, button: 'left' })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hb.x - 150, y: hb.y, button: 'left', clickCount: 1 })
    check('dragging the divider resizes the groups', await waitFor(async () => (await c.ev(`document.querySelector('[data-split-pane]').getBoundingClientRect().width`)) > widthBefore + 80, 'resized'))
    await rightClick('.tab'); await clickMenu('Split Down')
    check('"Split Down" stacks the groups', await waitFor(() => c.ev(`(() => { const a = document.querySelector('.group-main').getBoundingClientRect(), b = document.querySelector('[data-split-pane]').getBoundingClientRect(); return !!document.querySelector('.groups.down') && b.top >= a.bottom - 1 })()`), 'stacked'))
    await c.ev(`document.querySelector('[data-split-close]').click()`)
    check('the close button removes the split group', await waitFor(() => c.ev(`!document.querySelector('[data-split-pane]')`), 'split closed'))
    // Ctrl+\ toggles; closing the file in the main group closes a split that only showed it
    await ctrl('\\')
    check('Ctrl+\\ opens a split of the current file', await waitFor(() => c.ev(`!!document.querySelector('[data-split-pane]')`), 'ctrl+backslash'))
    await ctrl('\\')
    check('and closes it again', await waitFor(() => c.ev(`!document.querySelector('[data-split-pane]')`), 'toggled off'))
    await rightClick('.tab'); await clickMenu('Split Right')
    await waitFor(() => c.ev(`!!document.querySelector('[data-split-pane]')`), 'split again')
    await c.ev(`document.querySelector('.group-main .tabs').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await rightClick('.tab'); await clickMenu('Close All')
    check('closing the file everywhere closes the split group', await waitFor(() => c.ev(`!document.querySelector('[data-split-pane]')`), 'split gone with its files'))
    check('no tabs are left over', (await tabNames()).length === 0)

    // ---- Multi-root workspace (a second folder with its own git repository) ----
    if ((await tabNames()).length) { await rightClick('.tab'); await clickMenu('Close All') }
    const ws2 = path.join(os.tmpdir(), 'my-ai-ide-e2e-ws2-' + process.pid)
    fs.rmSync(ws2, { recursive: true, force: true }); fs.mkdirSync(path.join(ws2, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(ws2, 'second.txt'), 'second folder line\n'); fs.writeFileSync(path.join(ws2, 'sub', 'deep.txt'), 'deep\n')
    gitSh('init -q -b main', ws2); gitSh('config user.name "E2E Two"', ws2); gitSh('config user.email two@example.com', ws2); gitSh('config core.autocrlf false', ws2)
    gitSh('add -A', ws2); gitSh('commit -q -m "ws2 first"', ws2)
    fs.writeFileSync(path.join(ws2, 'second.txt'), 'second folder line\nUNIQUEWORD changed\n') // an uncommitted change in the second repository
    const ws2name = path.basename(ws2)
    // The Add Folder dialog is native, so seed what it would have saved and reload.
    await c.ev(`(() => { const r = document.querySelector('.tree-root').title; localStorage.setItem('workspace:' + r.replace(/\\\\/g, '/').toLowerCase(), JSON.stringify([${JSON.stringify(ws2)}])) })()`)
    await c.ev(`location.reload()`).catch(() => {})
    await waitFor(() => c.ev(`document.querySelectorAll('[data-workspace-folder]').length === 2`), 'two workspace folders', 20000)
    await c.ev(`window.confirm = () => true; window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m))`)
    check('the explorer shows both workspace folders', (await c.ev(`[...document.querySelectorAll('[data-workspace-folder] .tree-root span')].map(e => e.textContent)`)).includes(ws2name))
    check('only the added folder has a remove button', (await c.ev(`document.querySelectorAll('[data-remove-folder]').length`)) === 1)
    check('files of the second folder are listed', await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="second.txt"]')`), 'second.txt in tree'))
    await c.ev(`document.querySelector('[data-view="git"]').click()`)
    await waitFor(() => c.ev(`!!document.querySelector('[data-git-action="refresh"]')`), 'git panel after reload', 15000)
    await gitRefresh()
    check('the second folder repository is tracked: its change shows a git letter in the explorer', await waitFor(async () => { await c.ev(`document.querySelector('.sidebar-views button').click()`); return c.ev(`!!document.querySelector('.tree-row[data-tree-path$="second.txt"] .tree-git')`) }, 'git letter in second folder', 15000))
    // Quick open lists files from every folder
    await ctrl('p')
    const quickItems = await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].map(i => i.textContent)`).then((r) => r.length && r), 'quick open list')
    check('Quick Open lists files of both folders, naming the folder', quickItems.some((t) => t.includes('second.txt') && t.includes(ws2name + '/')) && quickItems.some((t) => t.includes('hello.txt')), JSON.stringify(quickItems.slice(0, 4)))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    // Search across folders
    await c.ev(`document.querySelector('[data-view="search"]')?.click() || [...document.querySelectorAll('.sidebar-views button')][1].click()`)
    await typeInput('[data-search-query]', 'UNIQUEWORD')
    const wsHits = await waitFor(() => c.ev(`[...document.querySelectorAll('.search-file-name')].map(e => e.textContent)`).then((r) => r.length && r), 'search hits')
    check('Find in files searches every folder and names the folder in the result', wsHits.some((h) => h.includes(ws2name + '/second.txt')), JSON.stringify(wsHits))
    // Open a file from the second folder: change bars come from its own repository
    await c.ev(`document.querySelector('.sidebar-views button').click()`)
    await c.ev(`document.querySelector('.tree-row[data-tree-path$="second.txt"]').click()`)
    await waitFor(async () => (await activeTab()) === 'second.txt', 'second.txt open')
    check('a file of the second folder gets change bars from its own repository', await waitFor(() => c.ev(`!!document.querySelector('.monaco-editor .git-gutter-added, .monaco-editor .git-gutter-modified')`), 'gutter in second folder', 15000))
    // Source control: pick the repository
    await c.ev(`document.querySelector('[data-view="git"]').click()`)
    check('Source Control offers a picker with both folders', await waitFor(() => c.ev(`document.querySelectorAll('[data-git-repo] option').length === 2`), 'repo picker'))
    await c.ev(`(() => { const s = document.querySelector('[data-git-repo]'); s.value = [...s.options].find(o => o.textContent === '${ws2name}').value; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    check('choosing the second folder shows its repository changes', await waitFor(async () => (await gitRows(false)).join() === 'second.txt:M', 'ws2 rows'), JSON.stringify(await gitRows(false)))
    await gitAction('stage', 'second.txt')
    check('and staging there changes that repository, not the main one', await waitFor(() => gitSh('status --porcelain', ws2).startsWith('M  second.txt') && !gitSh('status --porcelain').includes('second.txt'), 'staged in ws2'))
    await typeInto('[data-git-message]', 'ws2 second commit')
    await waitFor(() => c.ev(`!document.querySelector('[data-git-action="commit"]').disabled`), 'commit enabled')
    await c.ev(`document.querySelector('[data-git-action="commit"]').click()`)
    check('committing there commits in the second repository', await waitFor(() => gitSh('log -1 --format=%s', ws2).trim() === 'ws2 second commit', 'ws2 commit').catch(async (e) => { console.log('DEBUG ws2 commit: note =', await c.ev(`document.querySelector('[data-git-note]')?.textContent`), '| msg =', await c.ev(`document.querySelector('[data-git-message]')?.value`), '| commit disabled =', await c.ev(`document.querySelector('[data-git-action="commit"]')?.disabled`), '| ws2 status =', gitSh('status --porcelain', ws2), '| main log =', gitSh('log -1 --format=%s').trim()); return false }))
    await c.ev(`document.querySelector('[data-git-view="history"]').click()`)
    check('its history lists its own commits', await waitFor(async () => (await c.ev(`[...document.querySelectorAll('[data-git-commit] .git-subject')].map(e => e.textContent)`)).join('|') === 'ws2 second commit|ws2 first', 'ws2 history'))
    await c.ev(`document.querySelector('[data-git-view="changes"]').click()`)
    // File history from a tab in the second folder jumps to that repository
    await c.ev(`(() => { const s = document.querySelector('[data-git-repo]'); s.value = [...s.options].find(o => o.textContent !== '${ws2name}').value; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await rightClick('.tab'); await clickMenu('Git: File History')
    check('"File History" on a file of the second folder switches to that repository', await waitFor(() => c.ev(`document.querySelector('[data-git-repo]').selectedOptions[0].textContent === '${ws2name}' && !!document.querySelector('.git-filter')`), 'history repo switch'))
    await rightClick('.tab'); await clickMenu('Close All')
    await c.ev(`document.querySelector('.sidebar-views button').click()`)
    // Replace across folders
    await c.ev(`document.querySelectorAll('.sidebar-views button')[1].click()`)
    await c.ev(`document.querySelector('[data-search-action="toggle-replace"]').click()`)
    await typeInput('[data-search-replace]', 'REPLACED')
    await waitFor(() => c.ev(`!document.querySelector('[data-search-action="replace-all"]').disabled`), 'replace enabled')
    await c.ev(`document.querySelector('[data-search-action="replace-all"]').click()`)
    check('Replace All rewrites files in the second folder too', await waitFor(() => fs.readFileSync(path.join(ws2, 'second.txt'), 'utf8').includes('REPLACED changed') && !fs.readFileSync(path.join(ws2, 'second.txt'), 'utf8').includes('UNIQUEWORD'), 'replaced in ws2'))
    await c.ev(`document.querySelector('.sidebar-views button').click()`)
    // Remove the folder again
    await c.ev(`document.querySelector('[data-remove-folder]').click()`)
    check('Remove takes the folder out of the workspace (the files stay on disk)', await waitFor(() => c.ev(`document.querySelectorAll('[data-workspace-folder]').length === 1`), 'removed') && fs.existsSync(path.join(ws2, 'second.txt')))
    await c.ev(`location.reload()`).catch(() => {})
    await waitFor(() => c.ev(`!!document.querySelector('.sidebar') && document.querySelectorAll('.tree-row').length > 0`), 'app back after removing the folder')
    await c.ev(`window.confirm = () => true; window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m))`)
    check('and the removal is remembered', (await c.ev(`document.querySelectorAll('[data-workspace-folder]').length`)) === 1)
    for (let i = 0; i < 10; i++) { try { fs.rmSync(ws2, { recursive: true, force: true }); break } catch { await sleep(500) } } // a watcher may still hold it for a moment

    // ---- Next edit suggestions ----
    if ((await tabNames()).length) { await rightClick('.tab'); await clickMenu('Close All') }
    await setSetting('autocomplete', false) // ghost text would take the Tab key first
    const edTextNow = () => c.ev(`(document.querySelector('.group-main .view-lines')?.textContent || document.querySelector('.monaco-editor .view-lines')?.textContent || '').replace(/ /g, ' ')`)
    fs.writeFileSync(path.join(PROJ, 'nextedit.ts'), 'const alpha = 1\nconst beta = 2\nconst gamma = 3\nconst delta = 4\n')
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="nextedit.ts"]')`), 'nextedit.ts in tree', 10000)
    await openFromTree('nextedit.ts')
    const nextEditRequests = () => requests.filter((r) => !r.body.stream && JSON.stringify(r.body.system || '').includes('predict the next edit')).length
    const beforeNE = nextEditRequests()
    await c.ev(`document.querySelector('.monaco-editor textarea').focus()`)
    await edKey('End', { code: 'End', windowsVirtualKeyCode: 35 }) // end of line 1
    await typeInEditor(' // changed')
    check('after you stop typing, a next edit is requested', await waitFor(() => nextEditRequests() > beforeNE, 'next edit request', 15000))
    const neReq = requests.filter((r) => !r.body.stream && JSON.stringify(r.body.system || '').includes('predict the next edit')).pop()
    const nePrompt = String(neReq.body.messages[0].content)
    check('the request carries the numbered file, the caret and the recent edit', /1\| const alpha = 1 \/\/ changed/.test(nePrompt) && /3\| const gamma = 3/.test(nePrompt) && /Caret: line 1/.test(nePrompt) && /Recent edits:\nline 1: "const alpha = 1" -> "const alpha = 1 \/\/ changed"/.test(nePrompt), nePrompt.slice(0, 400))
    check('the suggestion appears under the target line', await waitFor(() => c.ev(`(() => { const z = document.querySelector('[data-next-edit]'); return !!z && z.textContent.includes('lines 3') && z.textContent.includes('const renamed = 2') })()`), 'next edit zone', 10000))
    check('and the target line is highlighted', await c.ev(`!!document.querySelector('.monaco-editor .next-edit-target')`))
    const lineNow = () => c.ev(`document.querySelector('.statusbar')?.textContent || ''`)
    await edKey('Tab', { code: 'Tab', windowsVirtualKeyCode: 9 })
    check('the first Tab takes the caret to the suggested line without changing anything', await waitFor(async () => /Ln 3/.test(await lineNow()), 'jumped to line 3') && !(await edTextNow()).includes('renamed'))
    await edKey('Tab', { code: 'Tab', windowsVirtualKeyCode: 9 })
    check('the second Tab applies it', await waitFor(async () => (await edTextNow()).includes('const renamed = 2') && !(await edTextNow()).includes('const gamma = 3'), 'applied'))
    check('the suggestion box is gone and the file shows as modified', (await c.ev(`!document.querySelector('[data-next-edit]')`)) && (await dirtyTabs()).includes('nextedit.ts'))
    check('the other lines are untouched', (await edTextNow()).includes('const alpha = 1 // changed') && (await edTextNow()).includes('const delta = 4') && (await edTextNow()).includes('const beta = 2'))
    // Escape dismisses
    const before2 = nextEditRequests()
    await c.ev(`document.querySelector('.monaco-editor textarea').focus()`)
    await typeInEditor('!')
    await waitFor(() => nextEditRequests() > before2, 'second request', 15000)
    await waitFor(() => c.ev(`!!document.querySelector('[data-next-edit]')`), 'zone again', 10000)
    await edKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
    check('Escape dismisses a suggestion without changing the file', await waitFor(() => c.ev(`!document.querySelector('[data-next-edit]')`), 'dismissed') && (await edTextNow()).includes('const delta = 4'))
    // Typing again clears it
    await typeInEditor('?')
    await waitFor(() => c.ev(`!!document.querySelector('[data-next-edit]')`), 'zone third time', 10000)
    await typeInEditor('x')
    check('typing more removes the suggestion straight away', await waitFor(() => c.ev(`!document.querySelector('[data-next-edit]')`), 'cleared by typing', 3000))
    // The setting turns it off
    await waitFor(() => c.ev(`!!document.querySelector('[data-next-edit]')`), 'zone fourth time', 10000)
    await setSetting('nextEdit', false)
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    const before3 = nextEditRequests()
    await c.ev(`document.querySelector('.monaco-editor textarea').focus()`)
    await typeInEditor('y')
    await sleep(2500)
    check('with the setting off no requests are made', nextEditRequests() === before3)
    await setSetting('nextEdit', true)
    await setSetting('autocomplete', true)
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await rightClick('.tab'); await clickMenu('Close All')
    fs.rmSync(path.join(PROJ, 'nextedit.ts'), { force: true })

    // ---- Background agents (their own git worktree; nothing changes until Apply) ----
    if ((await tabNames()).length) { await rightClick('.tab'); await clickMenu('Close All') }
    gitSh('add -A'); gitSh('commit -q -m "bg snapshot" --allow-empty')
    const helloBefore = fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8')
    const bgCards = () => c.ev(`[...document.querySelectorAll('[data-bg-card]')].map(e => e.dataset.bgStatus)`)
    await c.ev(`document.querySelector('[data-view="agents"]').click()`)
    check('the Agents view explains how background tasks work', await waitFor(() => c.ev(`/Apply to my files/.test(document.querySelector('[data-bg-panel]')?.textContent || '')`), 'agents panel'))
    await typeInto('[data-bg-input]', 'Create bg-created.txt and rename the greeting in hello.txt')
    await c.ev(`document.querySelector('[data-bg-start]').click()`)
    check('Start adds a task card', await waitFor(async () => (await bgCards()).length === 1, 'card appears').catch(async () => { console.log('DEBUG bg start error:', await c.ev(`document.querySelector('[data-bg-error]')?.textContent`), '| root:', await c.ev(`document.querySelector('.tree-root')?.title`)); return false }))
    check('the task waits for approval of its command', await waitFor(async () => (await bgCards())[0] === 'waiting', 'waiting', 30000))
    check('the command is shown in full with Run and Skip', await c.ev(`(() => { const w = document.querySelector('[data-bg-wait]'); return !!w && w.textContent.includes('bg-cmd-ok') && !!w.querySelector('[data-bg-action="run"]') && !!w.querySelector('[data-bg-action="skip"]') })()`))
    check('the Agents tab shows a badge while it needs you', await c.ev(`!!document.querySelector('[data-bg-badge]')`))
    check('so far nothing in your project has changed', fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === helloBefore && !fs.existsSync(path.join(PROJ, 'bg-created.txt')) && gitSh('status --porcelain').trim() === '')
    const worktrees = gitSh('worktree list')
    check('the agent works in a separate git worktree on its own branch', /agent\/[0-9a-f]{8}-create-bg-created/.test(worktrees) && gitSh('branch --list "agent/*"').includes('agent/'), worktrees)
    const wtPath = (/^(.+?)\s+[0-9a-f]+ \[agent\//m.exec(worktrees.split('\n').filter((l) => l.includes('agent/')).join('\n')) || [])[1]
    check('its edits are already in that copy', !!wtPath && fs.existsSync(path.join(wtPath, 'bg-created.txt')) && /bg-hello/.test(fs.readFileSync(path.join(wtPath, 'hello.txt'), 'utf8')), String(wtPath))
    check('the system prompt tells it that it works on a copy without anyone watching', requests.some((r) => r.body.tools && JSON.stringify(r.body.system).includes('This is a background task')))
    await c.ev(`document.querySelector('[data-bg-action="run"]').click()`)
    check('after Run it finishes', await waitFor(async () => (await bgCards())[0] === 'done', 'done', 30000))
    check('the command ran in the copy', requests.some((r) => JSON.stringify(r.body.messages || []).includes('bg-cmd-ok')))
    check('it reports what it did', await c.ev(`/created bg-created\.txt/.test(document.querySelector('[data-bg-summary]')?.textContent || '')`))
    check('and lists the files it changed', await waitFor(() => c.ev(`(() => { const f = [...document.querySelectorAll('[data-bg-file]')].map(e => e.dataset.bgFile + ':' + e.querySelector('.git-letter').textContent).sort(); return f.join() === 'bg-created.txt:A,hello.txt:M' })()`), 'file list'))
    check('your project is still untouched', fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === helloBefore && !fs.existsSync(path.join(PROJ, 'bg-created.txt')))
    await c.ev(`document.querySelector('[data-bg-file="hello.txt"]').click()`)
    check('clicking a file shows what the agent changed', await waitFor(() => c.ev(`!!document.querySelector('.diff-view .monaco-diff-editor') && document.querySelector('.diff-title').textContent.includes('hello.txt (agent)')`), 'agent diff'))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitFor(() => c.ev(`!document.querySelector('.diff-view')`), 'diff closed')
    await c.ev(`document.querySelector('[data-bg-action="apply"]').click()`)
    check('Apply puts the changes into your working tree', await waitFor(() => fs.existsSync(path.join(PROJ, 'bg-created.txt')) && /bg-hello/.test(fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8')), 'applied'))
    check('the card says so, and the files show in Source Control', (await waitFor(async () => (await bgCards())[0] === 'applied', 'applied status')) && /bg-created\.txt/.test(gitSh('status --porcelain')) && /hello\.txt/.test(gitSh('status --porcelain')), gitSh('status --porcelain'))
    await c.ev(`document.querySelector('[data-bg-action="discard"]').click()`)
    check('Remove deletes the copy and its branch', await waitFor(async () => (await bgCards()).length === 0 && !gitSh('worktree list').includes('agent/') && gitSh('branch --list "agent/*"').trim() === '' && !fs.existsSync(wtPath), 'removed'))
    gitSh('reset -q --hard'); fs.rmSync(path.join(PROJ, 'bg-created.txt'), { force: true })
    // Started from the agent panel, then stopped while it waits
    await clickBtn('Agent', '.chat')
    await typeInto('.chat textarea', 'Another background job')
    await c.ev(`document.querySelector('[data-agent-background]').click()`)
    check('"Background" in the agent panel starts the task there and shows the Agents view', await waitFor(async () => (await bgCards()).length === 1 && (await c.ev(`document.querySelector('[data-view="agents"]').classList.contains('on')`)), 'second task'))
    await waitFor(async () => (await bgCards())[0] === 'waiting', 'second waiting', 30000)
    await c.ev(`document.querySelector('[data-bg-action="skip"]').click()`)
    await waitFor(async () => (await bgCards())[0] !== 'waiting', 'skipped')
    await clickBtn('Chat', '.chat')
    await waitFor(async () => ['done', 'failed', 'stopped'].includes((await bgCards())[0]), 'second finished', 30000)
    check('Skip tells the agent the command was declined', requests.some((r) => JSON.stringify(r.body.messages || []).includes('The user declined to run this command')))
    await c.ev(`document.querySelector('[data-bg-action="discard"]').click()`)
    check('Discard throws away an unapplied task completely', await waitFor(async () => (await bgCards()).length === 0 && gitSh('branch --list "agent/*"').trim() === '' && !gitSh('worktree list').includes('agent/'), 'discarded') && !fs.existsSync(path.join(PROJ, 'bg-created.txt')))
    check('and your project was never touched', gitSh('status --porcelain').trim() === '')
    await c.ev(`document.querySelector('.sidebar-views button').click()`)

    // ---- Debugger (a real Node program under the V8 inspector) ----
    if ((await tabNames()).length) { await rightClick('.tab'); await clickMenu('Close All') }
    fs.writeFileSync(path.join(PROJ, 'dbgtest.js'), 'function add(a, b) {\n  const sum = a + b\n  return sum\n}\nconst result = add(2, 3)\nconsole.log("result", result)\n')
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="dbgtest.js"]')`), 'dbgtest.js in tree', 10000)
    await openFromTree('notes.md')
    await c.ev(`document.querySelector('[data-view="debug"]').click()`)
    check('Start Debugging is disabled for a file Node cannot run', await waitFor(() => c.ev(`document.querySelector('[data-dbg-action="start"]')?.disabled === true`), 'start disabled for markdown'))
    await openFromTree('dbgtest.js')
    check('and enabled for a .js file', await waitFor(() => c.ev(`document.querySelector('[data-dbg-action="start"]')?.disabled === false`), 'start enabled'))
    // A breakpoint from the margin: click next to line number 2
    const glyphPoint = await c.ev(`(() => { const ln = [...document.querySelectorAll('.group-main .monaco-editor .line-numbers')].find((e) => e.textContent === '2'); const ed = document.querySelector('.group-main .monaco-editor').getBoundingClientRect(); const r = ln.getBoundingClientRect(); return { x: ed.left + 9, y: r.top + r.height / 2 } })()`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: glyphPoint.x, y: glyphPoint.y, button: 'left', clickCount: 1 })
    check('clicking the margin sets a breakpoint (a red dot appears)', await waitFor(() => c.ev(`document.querySelectorAll('.group-main .monaco-editor .debug-bp').length === 1`), 'breakpoint dot'))
    check('and the Run view lists it', await c.ev(`!!document.querySelector('[data-dbg-bp="dbgtest.js:2"]')`))
    // F9 toggles on the caret line
    await c.ev(`document.querySelector('.group-main .monaco-editor textarea').focus()`)
    await ctrl('Home')
    await edKey('F9', { code: 'F9', windowsVirtualKeyCode: 120 })
    check('F9 sets a breakpoint on the caret line (line 1)', await waitFor(() => c.ev(`!!document.querySelector('[data-dbg-bp="dbgtest.js:1"]')`), 'F9 breakpoint'))
    await edKey('F9', { code: 'F9', windowsVirtualKeyCode: 120 })
    check('and F9 again removes it', await waitFor(() => c.ev(`!document.querySelector('[data-dbg-bp="dbgtest.js:1"]')`), 'F9 off'))
    // Start with F5
    await edKey('F5', { code: 'F5', windowsVirtualKeyCode: 116 })
    check('F5 starts the program and it stops at the breakpoint', await waitFor(() => c.ev(`document.querySelector('[data-dbg-status]')?.dataset.dbgStatus === 'paused'`), 'paused', 30000))
    check('the status says why', await c.ev(`/on a breakpoint/.test(document.querySelector('[data-dbg-status]').textContent)`))
    check('the stopped line is highlighted with an arrow in the margin', await waitFor(() => c.ev(`!!document.querySelector('.group-main .monaco-editor .debug-current-line') && !!document.querySelector('.group-main .monaco-editor .debug-arrow')`), 'current line'))
    check('the call stack names the function and line', await c.ev(`document.querySelector('[data-dbg-frame="0"]')?.textContent.includes('add') && document.querySelector('[data-dbg-frame="0"]').textContent.includes('dbgtest.js:2')`))
    check('variables show the arguments', await waitFor(() => c.ev(`document.querySelector('[data-dbg-var="a"] .dbg-var-value')?.textContent === '2' && document.querySelector('[data-dbg-var="b"] .dbg-var-value')?.textContent === '3'`), 'variables a, b'))
    check('and a variable that is not assigned yet has no value to show (undefined, or not listed until it exists)', await waitFor(() => c.ev(`(() => { const v = document.querySelector('[data-dbg-var="sum"] .dbg-var-value')?.textContent; return v === undefined || v === 'undefined' || /TDZ|initiali[sz]ed/i.test(v) })()`), 'variable sum'))
    // Watch and console
    await typeInput('[data-dbg-watch-input]', 'a * b')
    check('a watch expression is evaluated in the stopped frame', await waitFor(() => c.ev(`document.querySelector('[data-dbg-watch="a * b"] .dbg-var-value')?.textContent === '6'`), 'watch value'))
    await typeInput('[data-dbg-console-input]', 'a + b')
    check('the debug console evaluates expressions', await waitFor(() => c.ev(`/> a \\+ b\\n5\\n/.test(document.querySelector('[data-dbg-output]').textContent)`), 'console result'))
    await typeInput('[data-dbg-console-input]', 'nope.x')
    check('an error in the console is reported', await waitFor(() => c.ev(`/not defined/.test(document.querySelector('[data-dbg-output]').textContent)`), 'console error'))
    // Stepping
    await edKey('F10', { code: 'F10', windowsVirtualKeyCode: 121 })
    check('F10 steps to the next line', await waitFor(() => c.ev(`document.querySelector('[data-dbg-frame="0"]')?.textContent.includes('dbgtest.js:3')`), 'stepped to line 3'))
    check('and the variable now has its value (and the watch still works)', await waitFor(() => c.ev(`document.querySelector('[data-dbg-var="sum"] .dbg-var-value')?.textContent === '5' && document.querySelector('[data-dbg-watch="a * b"] .dbg-var-value')?.textContent === '6'`), 'sum = 5'))
    check('the highlighted line moved with it', await c.ev(`(() => { const hl = document.querySelector('.group-main .monaco-editor .debug-current-line'); const ln = [...document.querySelectorAll('.group-main .monaco-editor .line-numbers')].find((e) => e.textContent === '3'); if (!hl || !ln) return false; const a = hl.getBoundingClientRect(), b = ln.getBoundingClientRect(); return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 6 })()`))
    await c.ev(`document.querySelector('[data-dbg-action="continue"]').click()`)
    check('Continue runs the program to the end', await waitFor(() => c.ev(`document.querySelector('[data-dbg-status]')?.dataset.dbgStatus === 'ended'`), 'ended', 20000))
    check('its output is in the debug console, with the exit code', await c.ev(`(() => { const t = document.querySelector('[data-dbg-output]').textContent; return t.includes('result 5') && /exit code 0/.test(t) })()`))
    check('the stop highlight is gone', await c.ev(`!document.querySelector('.group-main .monaco-editor .debug-current-line')`))
    // Stop while paused, condition
    await c.ev(`document.querySelector('[data-dbg-bp="dbgtest.js:2"] [data-dbg-condition]').focus()`)
    await typeInput('[data-dbg-bp="dbgtest.js:2"] [data-dbg-condition]', 'a === 99')
    check('a breakpoint can have a condition (shown with a different dot)', await waitFor(() => c.ev(`!!document.querySelector('.group-main .monaco-editor .debug-bp-cond')`), 'conditional dot'))
    await c.ev(`document.querySelector('.group-main .monaco-editor textarea').focus()`)
    await edKey('F5', { code: 'F5', windowsVirtualKeyCode: 116 })
    await sleep(2500)
    check('a condition that is false lets the program run straight through', await c.ev(`document.querySelector('[data-dbg-status]')?.dataset.dbgStatus === 'ended' && document.querySelector('[data-dbg-output]').textContent.split('result 5').length === 2 && !document.querySelector('.group-main .monaco-editor .debug-current-line')`))
    await typeInput('[data-dbg-bp="dbgtest.js:2"] [data-dbg-condition]', '')
    await c.ev(`document.querySelector('[data-dbg-bp="dbgtest.js:2"] [data-dbg-condition]').blur()`)
    await waitFor(() => c.ev(`!document.querySelector('.group-main .monaco-editor .debug-bp-cond')`), 'condition cleared')
    await c.ev(`document.querySelector('.group-main .monaco-editor textarea').focus()`)
    await edKey('F5', { code: 'F5', windowsVirtualKeyCode: 116 })
    await waitFor(() => c.ev(`document.querySelector('[data-dbg-status]')?.dataset.dbgStatus === 'paused'`), 'paused again', 30000)
    await edKey('F5', { code: 'F5', shiftKey: true, windowsVirtualKeyCode: 116, modifiers: 8 })
    check('Shift+F5 stops a stopped program', await waitFor(() => c.ev(`document.querySelector('[data-dbg-status]')?.dataset.dbgStatus === 'ended'`), 'stopped', 20000))
    await c.ev(`document.querySelector('[data-dbg-action="clear-breakpoints"]').click()`)
    check('Remove All Breakpoints clears the margin and the list', await waitFor(() => c.ev(`!document.querySelector('.group-main .monaco-editor .debug-bp') && !document.querySelector('[data-dbg-bp]')`), 'breakpoints cleared'))
    await rightClick('.tab'); await clickMenu('Close All')
    await c.ev(`document.querySelector('.sidebar-views button').click()`)
    fs.rmSync(path.join(PROJ, 'dbgtest.js'), { force: true })

    // ---- Extensions (from a fake registry: a theme + snippets package and a native extension with code) ----
    if ((await tabNames()).length) { await rightClick('.tab'); await clickMenu('Close All') }
    await c.ev(`document.querySelector('[data-view="ext"]').click()`)
    check('the Extensions view starts empty and says what is supported', await waitFor(() => c.ev(`/Themes and snippets from VS Code extensions work here/.test(document.querySelector('[data-ext-panel]')?.textContent || '')`), 'ext panel'))
    await typeInput('[data-ext-query]', 'test')
    check('searching the registry lists the extensions', await waitFor(() => c.ev(`document.querySelectorAll('[data-ext-result]').length === 2`), 'registry results'))
    check('each result shows its id and download count', await c.ev(`(() => { const t = document.querySelector('[data-ext-result="acme.nightsnip"]').textContent; return t.includes('acme.nightsnip') && t.includes('4,321 downloads') })()`))
    await c.ev(`document.querySelector('[data-ext-result="acme.nightsnip"] [data-ext-install]').click()`)
    check('installing a theme + snippets package from the registry works', await waitFor(() => c.ev(`!!document.querySelector('[data-ext="acme.nightsnip"]')`), 'nightsnip installed', 30000))
    check('the Installed list says what it brings', await c.ev(`(() => { const t = document.querySelector('[data-ext="acme.nightsnip"]').textContent; return t.includes('Night Snip') && t.includes('1 theme') && t.includes('1 snippet file') })()`))
    check('it is data only: no "runs code" warning', await c.ev(`!document.querySelector('[data-ext="acme.nightsnip"] [data-ext-runs-code]')`))
    check('the registry list now shows it as installed', await c.ev(`!document.querySelector('[data-ext-result="acme.nightsnip"] [data-ext-install]')`))
    // The theme is in the theme list
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'color theme'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Color Theme'))`), 'theme command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Color Theme')).click()`)
    const themeNames = await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].map(i => i.textContent)`).then((r) => r.length > 5 && r), 'theme list')
    const themeBefore = (themeNames.find((n) => n.includes('current')) || '').replace(/(dark|light|high contrast|custom).*$/i, '').trim()
    check('the extension\'s theme appears in the theme picker', themeNames.some((n) => n.includes('Night Test')), JSON.stringify(themeNames.slice(-4)))
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Night Test')).click()`)
    check('choosing it applies its colours to the editor and the UI', await waitFor(async () => (await bgVar()) === '#011627' && (await c.ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)) === '#7e57c2', 'night theme applied'), await bgVar())
    // Snippets
    fs.writeFileSync(path.join(PROJ, 'snip.js'), '')
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="snip.js"]')`), 'snip.js in tree', 10000)
    await c.ev(`document.querySelector('[data-view="ext"]').click()`)
    await openFromTree('snip.js')
    await typeInEditor('log')
    await edKey(' ', { code: 'Space', modifiers: 2, windowsVirtualKeyCode: 32 }) // Ctrl+Space
    await c.ev(`document.querySelector('.group-main .monaco-editor textarea').focus()`)
    check('typing a snippet prefix offers the snippet', await waitFor(() => c.ev(`[...document.querySelectorAll('.suggest-widget .monaco-list-row')].some(r => r.textContent.includes('log') && r.textContent.includes('Print'))`), 'snippet suggestion', 10000).catch(() => false) || await waitFor(() => c.ev(`[...document.querySelectorAll('.suggest-widget .monaco-list-row')].some(r => r.textContent.includes('log'))`), 'snippet suggestion (label only)', 5000))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await edKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
    await rightClick('.tab'); await clickMenu('Close All')
    fs.rmSync(path.join(PROJ, 'snip.js'), { force: true })
    // A native extension with code
    await c.ev(`document.querySelector('[data-view="ext"]').click()`)
    await c.ev(`document.querySelector('[data-ext-result="me.hello"] [data-ext-install]').click()`)
    check('an extension that runs code is installed, with a warning', await waitFor(() => c.ev(`!!document.querySelector('[data-ext="me.hello"] [data-ext-runs-code]')`), 'hello installed', 30000))
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'upper case'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    check('its commands appear in the command palette', await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Hello Ext: Upper Case Selection'))`), 'extension command in palette'))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    fs.writeFileSync(path.join(PROJ, 'shout.txt'), 'make me loud\n')
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="shout.txt"]')`), 'shout.txt in tree', 10000)
    await openFromTree('shout.txt')
    await c.ev(`document.querySelector('.group-main .monaco-editor textarea').focus()`)
    await ctrl('a')
    await edKey('a', { code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'upper case'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Upper Case Selection'))`), 'command again')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Upper Case Selection')).click()`)
    check('running it changes the selected text in the editor (the extension used the editor API)', await waitFor(() => c.ev(`document.querySelector('.group-main .view-lines').textContent.replace(/ /g, ' ').includes('MAKE ME LOUD')`), 'upper-cased', 30000))
    check('and it showed a message', await waitFor(() => c.ev(`/upper-cased/.test(document.querySelector('[data-toast]')?.textContent || '')`), 'extension toast'))
    // A command that asks for input
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'ask'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Ask For A Name'))`), 'ask command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Ask For A Name')).click()`)
    check('a command can ask the user for text in the editor\'s own dialog', await waitFor(() => c.ev(`!!document.querySelector('[data-input-dialog]') && document.body.textContent.includes('Your name?')`), 'input dialog from extension'))
    await typeInput('[data-input-dialog]', 'Zed')
    check('and gets the answer', await waitFor(() => c.ev(`/Hello Zed/.test(document.querySelector('[data-toast]')?.textContent || '')`), 'greeting toast'))
    // Command that fails
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'always'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Always Fails'))`), 'fail command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Always Fails')).click()`)
    check('an error in an extension command is shown, not swallowed', await waitFor(() => c.ev(`document.querySelector('[data-toast]')?.classList.contains('error') && /deliberate failure/.test(document.querySelector('[data-toast]').textContent)`), 'error toast'))
    // Disable, uninstall
    await rightClick('.tab'); await clickMenu('Close All')
    fs.rmSync(path.join(PROJ, 'shout.txt'), { force: true })
    await c.ev(`document.querySelector('[data-view="ext"]').click()`)
    await c.ev(`document.querySelector('[data-ext="me.hello"] [data-ext-enabled]').click()`)
    await waitFor(() => c.ev(`document.querySelector('[data-ext="me.hello"]')?.classList.contains('off')`), 'row shows disabled')
    await ctrl('p', { shiftKey: true })
    await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'upper case'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await sleep(500)
    check('disabling an extension removes its commands', await waitFor(() => c.ev(`![...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Upper Case Selection'))`), 'command gone when disabled'))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await c.ev(`document.querySelector('[data-ext="me.hello"] [data-ext-uninstall]').click()`)
    check('uninstalling removes it from the list', await waitFor(() => c.ev(`!document.querySelector('[data-ext="me.hello"]')`), 'hello uninstalled'))
    await c.ev(`document.querySelector('[data-ext="acme.nightsnip"] [data-ext-uninstall]').click()`)
    check('uninstalling the theme package puts the default theme back', await waitFor(async () => !(await c.ev(`!!document.querySelector('[data-ext="acme.nightsnip"]')`)) && (await bgVar()) === '#1f1f1f', 'theme reverted'), await bgVar())
    // give the later tests the theme they started with
    if (themeBefore && !/dark modern/i.test(themeBefore)) {
      await ctrl('p', { shiftKey: true })
      await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'color theme'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Color Theme'))`), 'theme command again')
      await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Color Theme')).click()`)
      await waitFor(() => c.ev(`document.querySelectorAll('.qp-item').length > 5`), 'theme list again')
      await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.startsWith(${JSON.stringify(themeBefore)})).click()`)
      await sleep(400)
    }
    await c.ev(`document.querySelector('.sidebar-views button').click()`)

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

    // Search by meaning (local index, Claude expands the question) and @codebase
    fs.writeFileSync(path.join(PROJ, 'src', 'payments.ts'), 'export function chargeCreditCard(customer: Customer, cents: number) {\n  return gateway.charge(customer.card, cents)\n}\n')
    await c.ev(`document.querySelectorAll('.sidebar-views button')[1].click()`)
    await c.ev(`document.querySelector('[data-search-semantic]').click()`)
    check('the search box switches to asking about the code', await c.ev(`/Ask about the code/.test(document.querySelector('[data-search-query]').placeholder) && ![...document.querySelectorAll('.search-box button')].some(b => b.textContent === 'Aa')`))
    await typeInput('[data-search-query]', 'bill the customer')
    check('a plain-words question finds the code that does it', await waitFor(() => c.ev(`document.querySelector('[data-sem-hit]')?.dataset.semHit === 'src/payments.ts'`), 'semantic hit', 25000))
    check('the result shows what Claude added to the question and how many files were indexed', await c.ev(`(() => { const t = document.querySelector('[data-search-sem-info]').textContent; return /files indexed/.test(t) && /also looked for: charge, credit/.test(t) })()`), await c.ev(`document.querySelector('[data-search-sem-info]')?.textContent`))
    const meaningNote = await c.ev(`document.querySelector('[data-search-sem-info]').textContent + ' | ' + (document.querySelector('[data-search-meaning]')?.textContent || '')`)
    check('the search model runs in the packaged app (or says why it cannot, e.g. offline)', /matched by meaning/.test(meaningNote) || /Learning your code|not available/.test(meaningNote), meaningNote)
    check('each result shows the first lines of the code', await c.ev(`document.querySelector('[data-sem-hit] .search-sem-code').textContent.includes('chargeCreditCard')`))
    await c.ev(`document.querySelector('[data-sem-hit]').click()`)
    check('clicking a result opens the file', await waitFor(async () => (await activeTab()) === 'payments.ts', 'payments.ts open'))
    await rightClick('.tab'); await clickMenu('Close All')
    await c.ev(`document.querySelector('[data-search-semantic]').click()`)
    check('switching it off brings back match case and regex', await c.ev(`[...document.querySelectorAll('.search-box button')].some(b => b.textContent === 'Aa')`))
    await c.ev(`document.querySelector('.sidebar-views button').click()`)
    await typeInto('.chat textarea', '@co')
    check('@ offers codebase', await waitFor(() => c.ev(`[...document.querySelectorAll('.mention-item')].some(m => m.dataset.mention === 'codebase')`), 'codebase mention'))
    await typeInto('.chat textarea', '')
    req = await sendChat('@codebase how do we bill the customer?')
    check('@codebase sends the code found by searching the project', systemOf(req).includes('Code found by searching the whole project') && systemOf(req).includes('chargeCreditCard') && systemOf(req).includes('src/payments.ts:1-'), systemOf(req).slice(-300))
    check('the question itself is sent without the @codebase word', JSON.stringify(req.body.messages[req.body.messages.length - 1]).includes('how do we bill the customer?'))
    check('and the message notes it', await c.ev(`[...document.querySelectorAll('.chat-note')].some(n => n.textContent.includes('@codebase'))`))
    fs.rmSync(path.join(PROJ, 'src', 'payments.ts'), { force: true })

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
    await waitFor(() => c.ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return !document.querySelector('.qp.ie') })()`), 'inline edit closed')
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

    // ---- Tasks and launch configurations ----
    // the page was reloaded by the update tests, which dropped the dialog overrides
    await c.ev(`window.confirm = () => true; window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m))`)
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitFor(() => c.ev(`!document.querySelector('.qp.settings')`), 'settings closed before tasks')
    const paletteT = async (text) => {
      await ctrl('p', { shiftKey: true })
      await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    }
    fs.writeFileSync(path.join(PROJ, 'package.json'), JSON.stringify({ name: 'proj', scripts: { hello: 'echo hi' } }))
    fs.mkdirSync(path.join(PROJ, '.ai-ide'), { recursive: true })
    fs.writeFileSync(path.join(PROJ, '.ai-ide', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
      { label: 'Echo it', type: 'shell', command: 'Write-Host', args: ['task-ran-ok', 'two words'], group: 'build' },
      { label: 'Second step', command: 'Write-Output "second-step-ok"', dependsOn: ['Echo it'] }
    ] }))
    fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true })
    fs.writeFileSync(path.join(PROJ, 'argsprog.js'), 'console.log("ARGS=" + process.argv.slice(2).join(",") + " FOO=" + process.env.FOO + " CWD=" + require("path").basename(process.cwd()))\n')
    fs.writeFileSync(path.join(PROJ, '.ai-ide', 'launch.json'), '{ "version": "0.2.0", "configurations": [ { "name": "With args", "type": "node", "request": "launch", "program": "${workspaceFolder}/argsprog.js", "args": ["a1", "b2"], "env": { "FOO": "bar" }, "cwd": "${workspaceFolder}/src" }, { "name": "Broken", "type": "chrome", "program": "x" } ] }')
    await paletteT('run task')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Tasks: Run Task'))`), 'run task command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Tasks: Run Task')).click()`)
    await c.ev(`window.__alerts = []`)
    const taskItems = await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].map(i => i.textContent)`).then((r) => r.some((t) => t.includes('Echo it')) && r), 'task list')
    check('Run Task lists the tasks of the file and the npm scripts', taskItems.some((t) => t.includes('Echo it') && t.includes('[build]')) && taskItems.some((t) => t.includes('Second step')) && taskItems.some((t) => t.includes('npm: ')), JSON.stringify(taskItems))
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Second step')).click()`)
    check('running a task opens a terminal named after it', await waitFor(async () => (await termTabs()).includes('Task: Second step'), 'task terminal tab'), JSON.stringify(await termTabs()))
    check('the command ran in the terminal (an argument with spaces stayed one argument)', await waitFor(async () => { const t = await termText(); return t.includes('task-ran-ok two words') }, 'task output', 30000))
    check('and its dependency ran first, then the task itself', await waitFor(async () => { const t = await termText(); return t.indexOf('task-ran-ok') >= 0 && t.indexOf('second-step-ok') > t.indexOf('task-ran-ok') }, 'dependency order', 30000))
    await c.ev(`[...document.querySelectorAll('.term-tab')].find(t => t.textContent.includes('Task: Second step'))?.querySelector('.close')?.click()`)
    await paletteT('build task')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Run Build Task'))`), 'build task command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Run Build Task')).click()`)
    check('Run Build Task runs the only task in the build group straight away', await waitFor(async () => (await termTabs()).includes('Task: Echo it'), 'build task tab'))
    await c.ev(`[...document.querySelectorAll('.term-tab')].find(t => t.textContent.includes('Task: Echo it'))?.querySelector('.close')?.click()`)
    // Launch configuration
    await c.ev(`document.querySelector('[data-view="debug"]').click()`)
    check('the Run view offers the launch configurations that can be used', await waitFor(() => c.ev(`[...document.querySelectorAll('[data-dbg-config] option')].map(o => o.textContent).join() === 'Current file,With args'`), 'config options'))
    check('and says why another one cannot', await c.ev(`/Broken.*only "node"/.test(document.querySelector('[data-dbg-problems]')?.textContent || '')`))
    await c.ev(`(() => { const s = document.querySelector('[data-dbg-config]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'With args'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await waitFor(() => c.ev(`document.querySelector('[data-dbg-action="start"]')?.disabled === false`), 'start enabled for the configuration')
    await c.ev(`document.querySelector('[data-dbg-action="start"]').click()`)
    check('Start runs the configuration with its arguments, environment and folder', await waitFor(() => c.ev(`/ARGS=a1,b2 FOO=bar CWD=src/.test(document.querySelector('[data-dbg-output]')?.textContent || '')`), 'launch config output', 30000).catch(async (e) => { console.log('DIAG', JSON.stringify(await c.ev(`[document.querySelector('[data-dbg-output]')?.textContent, document.querySelector('[data-dbg-status]')?.dataset.dbgStatus, document.querySelector('[data-dbg-config]')?.value, document.querySelector('[data-dbg-problems]')?.textContent]`))); throw e }))
    await c.ev(`(() => { const s = document.querySelector('[data-dbg-config]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ''); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    // Starter files
    fs.rmSync(path.join(PROJ, '.ai-ide'), { recursive: true, force: true })
    await paletteT('tasks file')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Open Tasks File'))`), 'open tasks file command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Open Tasks File')).click()`)
    check('"Open Tasks File" creates a starter file and opens it', await waitFor(async () => (await activeTab()) === 'tasks.json' && fs.existsSync(path.join(PROJ, '.ai-ide', 'tasks.json')), 'tasks.json opened'))
    await rightClick('.tab'); await clickMenu('Close All')
    fs.rmSync(path.join(PROJ, '.ai-ide'), { recursive: true, force: true }); fs.rmSync(path.join(PROJ, 'argsprog.js'), { force: true })
    await c.ev(`document.querySelector('.sidebar-views button').click()`)

    // ---- Three-way merge editor ----
    if ((await tabNames()).length) { await rightClick('.tab'); await clickMenu('Close All') }
    gitSh('add -A'); gitSh('commit -q -m "before merge editor test" --allow-empty')
    fs.writeFileSync(path.join(PROJ, 'merge3.txt'), 'a\nb\nc\nd\ne\nm\nn\no\np\nf\ng\n'); gitSh('add merge3.txt'); gitSh('commit -q -m "merge3 base"')
    gitSh('checkout -q -b m3-theirs')
    fs.writeFileSync(path.join(PROJ, 'merge3.txt'), 'a\nB-theirs\nc\nd\ne\nm\nn\no\np\nF-theirs\ng\n'); gitSh('commit -q -am "theirs side"')
    gitSh('checkout -q main')
    fs.writeFileSync(path.join(PROJ, 'merge3.txt'), 'a\nB-ours\nc\nd\ne\nm\nn\no\np\nF-ours\ng\n'); gitSh('commit -q -am "ours side"')
    try { gitSh('merge m3-theirs') } catch { /* conflicts are the point */ }
    await c.ev(`document.querySelector('[data-view="git"]').click()`)
    await gitRefresh()
    await waitFor(async () => (await gitRows(false)).includes('merge3.txt:!'), 'merge3.txt conflicted')
    await c.ev(`document.querySelector('.git-row[data-git-file="merge3.txt"] [data-git-action="merge-editor"]').click()`)
    check('a conflicted file has a button that opens the merge editor', await waitFor(() => c.ev(`!!document.querySelector('[data-merge-view]')`), 'merge view'))
    check('it has two panes for the two versions and a result pane', await c.ev(`['ours', 'theirs', 'result'].every((p) => !!document.querySelector('[data-merge-pane="' + p + '"] .monaco-editor'))`))
    check('it counts the conflicts', await waitFor(() => c.ev(`document.querySelector('[data-merge-left]')?.textContent === '2 conflicts left'`), 'two conflicts'))
    const paneText = (p) => c.ev(`(document.querySelector('[data-merge-pane="${p}"] .view-lines')?.textContent || '').replace(/ /g, ' ')`)
    check('the top panes show each side\'s whole file', await waitFor(async () => { const o = await paneText('ours'), t = await paneText('theirs'); return o.includes('B-ours') && o.includes('F-ours') && !o.includes('B-theirs') && t.includes('B-theirs') && t.includes('F-theirs') && !t.includes('B-ours') }, 'pane texts'))
    check('the conflicting lines are marked in them', await c.ev(`!!document.querySelector('[data-merge-pane="ours"] .conflict-current') && !!document.querySelector('[data-merge-pane="theirs"] .conflict-incoming')`))
    check('the result starts as the file with its conflict markers', await waitFor(async () => { const r = await paneText('result'); return r.includes('<<<<<<<') && r.includes('B-ours') && r.includes('B-theirs') && r.includes('>>>>>>>') }, 'result with markers'))
    await c.ev(`document.querySelector('[data-merge-action="theirs"]').click()`)
    check('Accept Incoming resolves the selected conflict', await waitFor(() => c.ev(`document.querySelector('[data-merge-left]')?.textContent === '1 conflict left'`), 'one left'))
    const r1 = await paneText('result')
    check('with the incoming lines and without markers for it', r1.includes('B-theirs') && !r1.includes('B-ours') && r1.includes('F-ours') && r1.includes('F-theirs'), r1.slice(0, 160))
    await c.ev(`document.querySelector('[data-merge-action="next"]').click()`)
    check('Next conflict takes the caret to the one left', await waitFor(() => c.ev(`(() => { const r = document.querySelector('[data-merge-pane="result"] .current-line'); return !!r })()`), 'caret in result'))
    await c.ev(`document.querySelector('[data-merge-action="both"]').click()`)
    check('Accept Both keeps both sides of the other conflict', await waitFor(() => c.ev(`document.querySelector('[data-merge-left]')?.textContent === 'All conflicts resolved'`), 'all resolved'))
    await waitFor(async () => !(await paneText('result')).includes('<<<<<<<'), 'result without markers', 10000).catch(() => undefined)
    const r2 = await paneText('result')
    check('so nothing is left to decide', !r2.includes('<<<<<<<') && !r2.includes('=======') && r2.indexOf('F-ours') > 0 && r2.indexOf('F-theirs') > r2.indexOf('F-ours'), r2.slice(0, 160))
    await c.ev(`document.querySelector('[data-merge-action="complete"]').click()`)
    check('Complete Merge writes the file and closes the editor', await waitFor(() => !fs.readFileSync(path.join(PROJ, 'merge3.txt'), 'utf8').includes('<<<<<<<') && fs.readFileSync(path.join(PROJ, 'merge3.txt'), 'utf8').replace(/\r/g, '') === 'a\nB-theirs\nc\nd\ne\nm\nn\no\np\nF-ours\nF-theirs\ng\n', 'file written') && (await c.ev(`!document.querySelector('[data-merge-view]')`)), fs.readFileSync(path.join(PROJ, 'merge3.txt'), 'utf8'))
    check('and marks the file resolved: it is no longer a conflict and is staged', await waitFor(async () => !(await gitRows(false)).includes('merge3.txt:!') && (await gitRows(true)).some((x) => x.startsWith('merge3.txt:')), 'staged after merge editor'), JSON.stringify(await gitRows(true)))
    check('the merge can now be committed', await c.ev(`/Commit to finish/.test(document.querySelector('[data-git-merge]')?.textContent || '')`))
    gitSh('commit -q -m "merged with the merge editor"')
    // No conflicts: nothing to open
    await openFromTree('merge3.txt')
    await c.ev(`window.__alerts = []`)
    await paletteT('merge editor')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Open Merge Editor'))`), 'merge editor command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Open Merge Editor')).click()`)
    check('asking for the merge editor on a file without conflicts says so', await waitFor(() => c.ev(`window.__alerts.some((a) => /no merge conflicts/.test(a))`), 'no conflicts alert') && (await c.ev(`!document.querySelector('[data-merge-view]')`)))
    await rightClick('.tab'); await clickMenu('Close All')
    // A conflict opened from the editor's own link
    gitSh('checkout -q -b m3-again'); fs.writeFileSync(path.join(PROJ, 'merge3.txt'), 'x\n'); gitSh('commit -q -am "again"')
    gitSh('checkout -q main'); fs.writeFileSync(path.join(PROJ, 'merge3.txt'), 'y\n'); gitSh('commit -q -am "main again"')
    try { gitSh('merge m3-again') } catch { /* conflict */ }
    await gitRefresh()
    await openFromTree('merge3.txt')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.monaco-editor .codelens-decoration a')].some(a => a.textContent === 'Open Merge Editor')`), 'open merge editor link', 15000)
    await c.ev(`window.__alerts = []; window.__mergeEvents = 0; window.addEventListener('myaiide-open-merge', () => { window.__mergeEvents++ })`)
    const lensBox2 = await c.ev(`(() => { const r = [...document.querySelectorAll('.monaco-editor .codelens-decoration a')].find(a => a.textContent === 'Open Merge Editor').getBoundingClientRect(); return { x: r.x + 6, y: r.y + r.height / 2 } })()`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: lensBox2.x, y: lensBox2.y, button: 'left', clickCount: 1 })
    check('the link above a conflict in the editor opens the merge editor too', await waitFor(() => c.ev(`!!document.querySelector('[data-merge-view]')`), 'merge editor from link').catch(async (e) => { console.log('DIAG2', JSON.stringify(await c.ev(`[window.__alerts, window.__mergeEvents, document.querySelector('[data-diff-view]') ? 'diff' : '', [...document.querySelectorAll('.codelens-decoration a')].map(a => a.textContent), !!document.querySelector('[data-merge-view]')]`))); return false }))
    await c.ev(`document.querySelector('[data-merge-action="close"]').click()`)
    check('Close leaves the file as it was', await waitFor(() => c.ev(`!document.querySelector('[data-merge-view]')`), 'closed') && fs.readFileSync(path.join(PROJ, 'merge3.txt'), 'utf8').includes('<<<<<<<'))
    await rightClick('.tab'); await clickMenu('Close All')
    gitSh('merge --abort'); gitSh('checkout -q main'); gitSh('branch -D m3-theirs -q'); gitSh('branch -D m3-again -q')
    await c.ev(`document.querySelector('.sidebar-views button').click()`)

    // ---- Accessibility: landmarks, roles, keyboard, focus, announcements ----
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    if ((await tabNames()).length) { await rightClick('.tab'); await clickMenu('Close All') }
    const pressKey = (k, vk, extra = {}) => edKey(k, { code: extra.code ?? k, windowsVirtualKeyCode: vk, ...extra })
    const activeEl = () => c.ev(`(() => { const a = document.activeElement; return a ? (a.getAttribute('data-tree-path') || a.getAttribute('data-tab-path') || a.getAttribute('aria-label') || a.id || a.tagName + '.' + a.className) : null })()`)
    check('the main parts of the window are landmarks with names', await c.ev(`!!document.querySelector('aside[aria-label="Side bar"]') && !!document.querySelector('main[aria-label="Editor"]') && !!document.querySelector('footer[aria-label="Status bar"]') && !!document.querySelector('aside.chat[aria-label]')`))
    check('the sidebar views are a tablist whose selected tab is marked', await c.ev(`(() => { const l = document.querySelector('.sidebar-views'); return l.getAttribute('role') === 'tablist' && l.querySelectorAll('[role="tab"]').length >= 6 && l.querySelectorAll('[aria-selected="true"]').length === 1 })()`))
    check('there are live regions for announcements', await c.ev(`!!document.querySelector('[data-live-polite][aria-live="polite"]') && !!document.querySelector('[data-live-assertive][role="alert"]')`))

    // File tree: roles and arrow keys
    await c.ev(`document.querySelector('[data-view="files"]')?.click() || document.querySelector('.sidebar-views [role="tab"]').click()`)
    check('the explorer is a tree of treeitems with levels', await c.ev(`document.querySelector('.tree[role="tree"]') && [...document.querySelectorAll('.tree-row')].every((r) => r.getAttribute('role') === 'treeitem' && Number(r.getAttribute('aria-level')) >= 1)`))
    await c.ev(`document.querySelector('.tree-row[tabindex="0"]').focus()`)
    const firstFocus = await activeEl()
    await pressKey('ArrowDown', 40)
    check('the arrow keys move through the tree', (await activeEl()) !== firstFocus && /\.|[\\/]/.test(String(await activeEl())), String(await activeEl()))
    await c.ev(`[...document.querySelectorAll('.tree-row')].find((r) => r.getAttribute('aria-expanded') === 'false')?.focus()`)
    const folderPath = await activeEl()
    await pressKey('ArrowRight', 39)
    check('Right opens a folder (aria-expanded changes)', await waitFor(() => c.ev(`[...document.querySelectorAll('.tree-row')].find((r) => r.dataset.treePath === ${JSON.stringify(String(folderPath))})?.getAttribute('aria-expanded') === 'true'`), 'folder expanded by key'), String(folderPath))
    await pressKey('ArrowLeft', 37)
    check('Left closes it again', await waitFor(() => c.ev(`[...document.querySelectorAll('.tree-row')].find((r) => r.dataset.treePath === ${JSON.stringify(String(folderPath))})?.getAttribute('aria-expanded') === 'false'`), 'folder collapsed by key'))
    await c.ev(`document.querySelector('.tree-row[data-tree-path$="hello.txt"]').focus()`)
    await pressKey('Enter', 13, { code: 'Enter' })
    check('Enter opens the file', await waitFor(async () => (await activeTab()) === 'hello.txt', 'hello.txt by Enter'))
    // Context menu from the keyboard, with focus coming back
    await c.ev(`document.querySelector('.tree-row[data-tree-path$="hello.txt"]').focus()`)
    await pressKey('F10', 121, { modifiers: 8 })
    check('Shift+F10 opens the context menu, which is a menu of menuitems', await waitFor(() => c.ev(`document.querySelector('[data-context-menu][role="menu"] [role="menuitem"]') !== null`), 'keyboard menu'))
    await pressKey('ArrowDown', 40)
    check('the arrow keys move through its items', await c.ev(`document.querySelectorAll('[data-context-menu] .ctx-item.hi').length === 1 && document.querySelector('[data-context-menu]').getAttribute('aria-activedescendant') === document.querySelector('.ctx-item.hi').id`))
    await pressKey('Escape', 27, { code: 'Escape' })
    check('Escape closes it and focus returns to the row', await waitFor(async () => (await c.ev(`!document.querySelector('[data-context-menu]')`)) && /hello\.txt$/.test(String(await activeEl())), 'focus restored after menu'), String(await activeEl()))

    // Tabs
    await c.ev(`document.querySelector('.tree-row[data-tree-path$="notes.md"]').click()`)
    await waitFor(async () => (await tabNames()).length === 2, 'two tabs')
    check('open files are tabs in a tablist; only the current one is in the tab order', await c.ev(`(() => { const l = document.querySelector('.tabs'); const t = [...l.querySelectorAll('[role="tab"]')]; return l.getAttribute('role') === 'tablist' && t.length === 2 && t.filter((x) => x.getAttribute('aria-selected') === 'true').length === 1 && t.filter((x) => x.tabIndex === 0).length === 1 })()`))
    await c.ev(`document.querySelector('.tabs [aria-selected="true"]').focus()`)
    const tabBefore = await activeTab()
    await pressKey('ArrowLeft', 37)
    check('the arrow keys switch tabs and move focus with them', await waitFor(async () => (await activeTab()) !== tabBefore && /data-tab-path|\.|[\\/]/.test(String(await activeEl())), 'tab by arrow'))
    await rightClick('.tab'); await clickMenu('Close All')

    // Quick pick
    await ctrl('p')
    check('Quick Open is a dialog with a combobox and a listbox of options', await waitFor(() => c.ev(`(() => { const d = document.querySelector('.qp[role="dialog"]'); const i = d?.querySelector('input[role="combobox"]'); return !!d && d.getAttribute('aria-modal') === 'true' && !!i && i.getAttribute('aria-expanded') === 'true' && d.querySelector('[role="listbox"] [role="option"]') !== null })()`), 'quick open roles'))
    const act0 = await c.ev(`document.querySelector('input[role="combobox"]').getAttribute('aria-activedescendant')`)
    await pressKey('ArrowDown', 40)
    const act1 = await c.ev(`document.querySelector('input[role="combobox"]').getAttribute('aria-activedescendant')`)
    check('the highlighted option is named by aria-activedescendant and it changes with the arrows', !!act0 && !!act1 && act0 !== act1 && (await c.ev(`document.getElementById(${JSON.stringify(act1)})?.getAttribute('aria-selected') === 'true'`)))
    for (let i = 0; i < 4; i++) await pressKey('Tab', 9)
    check('Tab cannot leave the dialog', await c.ev(`!!document.activeElement.closest('.qp')`))
    await typeInput('.qp input', 'zzzz-no-such-file')
    check('how many results there are is announced', await waitFor(() => c.ev(`/No results|result/.test(document.querySelector('[data-live-polite]').textContent)`), 'quick pick announcement', 5000).catch(() => false))
    await pressKey('Escape', 27, { code: 'Escape' })

    // Dialogs keep focus and give it back
    await c.ev(`document.querySelector('.statusbar button').focus()`)
    const opener = await c.ev(`document.activeElement.textContent`)
    await clickBtn('Settings', '.statusbar')
    check('Settings is a modal dialog and focus is inside it', await waitFor(() => c.ev(`(() => { const d = document.querySelector('.qp.settings'); return !!d && d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true' && d.contains(document.activeElement) })()`), 'settings dialog focus'))
    check('the accessibility settings are there', await c.ev(`!!document.querySelector('[data-setting="screenReader"]') && !!document.querySelector('[data-setting="reduceMotion"]')`))
    await c.ev(`document.querySelector('input[data-setting="reduceMotion"]').click()`)
    check('Reduce motion switches animations off for the whole window', await waitFor(() => c.ev(`document.documentElement.classList.contains('reduce-motion')`), 'reduce motion class'))
    await c.ev(`document.querySelector('input[data-setting="reduceMotion"]').click()`)
    await c.ev(`document.querySelector('input[data-setting="screenReader"]').click()`)
    check('Screen reader support is remembered', await waitFor(() => c.ev(`JSON.parse(localStorage.getItem('settings') || localStorage.getItem('app-settings') || '{}').screenReader === true || document.querySelector('input[data-setting="screenReader"]').checked`), 'screen reader setting'))
    await c.ev(`document.querySelector('input[data-setting="screenReader"]').click()`)
    await pressKey('Escape', 27, { code: 'Escape' })
    check('closing it puts focus back where it was', await waitFor(() => c.ev(`document.activeElement && document.activeElement.closest('.statusbar') !== null`), 'focus restored after settings'), opener)

    // Moving between regions
    await openFromTree('hello.txt')
    await c.ev(`document.querySelector('.group-main .monaco-editor textarea').focus()`)
    await pressKey('F6', 117)
    check('F6 moves from the editor to the next part of the window', await waitFor(() => c.ev(`!!document.activeElement.closest('aside.chat') || !!document.activeElement.closest('.terminal-panel')`), 'F6 forward'))
    await pressKey('F6', 117, { modifiers: 8 })
    check('Shift+F6 goes back', await waitFor(() => c.ev(`!!document.activeElement.closest('.groups')`), 'F6 back'))
    await paletteT('focus side bar')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Focus Side Bar'))`), 'focus command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Focus Side Bar')).click()`)
    check('"Focus Side Bar" puts the keyboard in the explorer', await waitFor(() => c.ev(`!!document.activeElement.closest('.sidebar')`), 'focus side bar'))
    check('the move is announced', await c.ev(`/Side bar/.test(document.querySelector('[data-live-polite]').textContent)`))
    await rightClick('.tab'); await clickMenu('Close All')

    // Focus is visible, and colours are readable
    await c.ev(`document.body.focus(); document.activeElement && document.activeElement.blur()`)
    await pressKey('Tab', 9)
    const ring = await c.ev(`(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) } })()`)
    check('a control reached with the Tab key has a visible focus ring', ring.style !== 'none' && ring.width >= 2, JSON.stringify(ring))
    const cssv = await c.ev(`(() => { const g = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return { bg: g('--bg'), side: g('--side'), fg: g('--fg'), muted: g('--muted'), accentText: g('--accent-text'), danger: g('--danger') } })()`)
    const lumOf = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] }
    const ratioOf = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
    check('the colours in use now pass WCAG AA (text, secondary text, links, errors)', ratioOf(cssv.fg, cssv.bg) >= 4.5 && ratioOf(cssv.muted, cssv.bg) >= 4.5 && ratioOf(cssv.muted, cssv.side) >= 4.5 && ratioOf(cssv.accentText, cssv.bg) >= 4.5 && ratioOf(cssv.danger, cssv.bg) >= 4.5, JSON.stringify(cssv))

    // ---- Notebooks ----
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    if ((await tabNames()).length) { await rightClick('.tab'); await clickMenu('Close All') }
    const nbKernels = await c.ev(`window.api.nbKernels()`)
    const hasPy = nbKernels.some((k) => k.id === 'python')
    await paletteT('create new notebook')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Create New Notebook'))`), 'new notebook command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Create New Notebook')).click()`)
    await waitFor(() => c.ev(`!!document.querySelector('[data-input-dialog]')`), 'notebook name dialog')
    await typeInput('[data-input-dialog]', 'e2e.ipynb')
    check('"Create New Notebook" makes the file and opens it as a notebook', await waitFor(async () => (await activeTab()) === 'e2e.ipynb' && (await c.ev(`!!document.querySelector('[data-notebook] [data-nb-cell]')`)), 'notebook opened'))
    const onDisk = () => JSON.parse(fs.readFileSync(path.join(PROJ, 'e2e.ipynb'), 'utf8'))
    check('the new file is a valid, empty Python notebook with one code cell', onDisk().nbformat === 4 && onDisk().cells.length === 1 && onDisk().cells[0].cell_type === 'code' && onDisk().metadata.kernelspec.language === 'python')
    const cellTextarea = (n = 0) => `[...document.querySelectorAll('[data-nb-cell]')][${n}].querySelector('.monaco-editor textarea')`
    const typeInCell = async (n, text) => { await waitFor(() => c.ev(`!!${cellTextarea(n)}`), 'cell editor ' + n); await c.ev(`${cellTextarea(n)}.focus()`); for (const ch of text) await edKey(ch, { text: ch, unmodifiedText: ch }) }
    const nbCount = () => c.ev(`document.querySelectorAll('[data-nb-cell]').length`)
    const nbStatus = () => c.ev(`document.querySelector('[data-nb-status]')?.dataset.nbStatus`)
    await typeInCell(0, hasPy ? 'print("hi from notebook")' : '1 + 1')
    if (!hasPy) await c.ev(`(() => { const s = document.querySelector('[data-nb-kernel]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'javascript'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    check('typing in a cell marks the file as modified', await waitFor(async () => (await dirtyTabs()).includes('e2e.ipynb'), 'notebook dirty'))
    await edKey('Enter', { code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }) // Shift+Enter
    check('Shift+Enter runs the cell; its output appears under it', await waitFor(() => c.ev(hasPy ? `/hi from notebook/.test(document.querySelector('[data-nb-cell] [data-nb-outputs]')?.textContent || '')` : `document.querySelector('[data-nb-cell] [data-nb-outputs]')?.textContent.includes('2')`), 'cell output', 30000))
    check('the cell shows its execution number', await c.ev(`document.querySelector('[data-nb-cell] [data-nb-count]').textContent === '[1]'`))
    check('and a new cell was added after it, with the caret in it', (await nbCount()) === 2)
    check('the kernel is ready afterwards', await waitFor(async () => (await nbStatus()) === 'ready', 'kernel ready', 10000))
    await ctrl('s')
    const nbSaved = await waitFor(() => { try { return onDisk().cells[0].outputs.length > 0 && onDisk() } catch { return false } }, 'notebook saved with outputs', 10000)
    check('saving writes the cells and the outputs in nbformat 4', !!nbSaved && nbSaved.cells[0].execution_count === 1 && nbSaved.cells[0].source.join('').length > 0 && (nbSaved.cells[0].outputs[0].output_type === 'stream') === hasPy, JSON.stringify(nbSaved && nbSaved.cells[0]).slice(0, 200))
    // Markdown
    await c.ev(`document.querySelector('[data-nb-action="add-markdown"]').click()`)
    await waitFor(async () => (await nbCount()) === 3, 'text cell added')
    await typeInCell(2, '# A heading')
    await edKey('Enter', { code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
    check('a text cell is shown as formatted text once run', await waitFor(() => c.ev(`document.querySelector('[data-nb-type="markdown"] [data-nb-md] h1')?.textContent === 'A heading'`), 'markdown rendered'))
    // an error, a kernel switch
    await typeInCell(1, hasPy ? '1 / 0' : 'null.boom')
    await c.ev(`document.querySelectorAll('[data-nb-cell]')[1].querySelector('[data-nb-run]').click()`)
    check('an error is shown in the cell with its name', await waitFor(() => c.ev(`/ZeroDivisionError|TypeError/.test(document.querySelectorAll('[data-nb-cell]')[1].querySelector('.nb-error')?.textContent || '')`), 'error output', 30000))
    await c.ev(`(() => { const s = document.querySelector('[data-nb-kernel]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'javascript'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await waitFor(async () => onDisk().metadata.kernelspec.language === 'javascript', 'kernel recorded', 10000).catch(() => undefined)
    await ctrl('s')
    check('changing the kernel is recorded in the notebook\'s metadata', await waitFor(() => onDisk().metadata.kernelspec.language === 'javascript', 'metadata saved', 10000))
    await c.ev(`document.querySelectorAll('[data-nb-cell]')[1].querySelector('.nb-error') && (document.querySelector('[data-nb-action="clear"]').click(), true)`)
    check('Clear Outputs empties the outputs and numbers', await waitFor(() => c.ev(`document.querySelectorAll('[data-nb-outputs]').length === 0 && document.querySelector('[data-nb-count]').textContent === '[ ]'`), 'outputs cleared'))
    // a JavaScript cell on the JavaScript kernel
    await c.ev(`document.querySelectorAll('[data-nb-cell]')[1].querySelector('.monaco-editor') && (() => { const ta = ${cellTextarea(1)}; ta.focus(); })()`)
    await c.ev(`${cellTextarea(1)}.focus()`)
    await edKey('a', { code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }) // select all
    await edKey('Backspace', { code: 'Backspace', windowsVirtualKeyCode: 8 }) // typing over a selection would wrap it in brackets
    for (const ch of '[1, 2, 3].map((n) => n * 2)') await edKey(ch, { text: ch, unmodifiedText: ch })
    await c.ev(`document.querySelectorAll('[data-nb-cell]')[1].querySelector('[data-nb-run]').click()`)
    check('the JavaScript kernel runs a cell too', await waitFor(() => c.ev(`/2, 4, 6/.test(document.querySelectorAll('[data-nb-cell]')[1].querySelector('[data-nb-outputs]')?.textContent || '')`), 'js result', 30000))
    // keyboard: command mode
    await edKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
    check('Escape leaves the cell editor for command mode (the cell itself has focus)', await waitFor(() => c.ev(`document.activeElement?.hasAttribute('data-nb-cell')`), 'command mode'))
    const nbBefore = await nbCount()
    await edKey('b', { text: 'b', unmodifiedText: 'b', code: 'KeyB' })
    check('B adds a cell below', await waitFor(async () => (await nbCount()) === nbBefore + 1, 'cell added by key'))
    for (let i = 0; i < 6 && !(await c.ev(`document.activeElement?.hasAttribute('data-nb-cell')`)); i++) { await edKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(400) }
    await waitFor(() => c.ev(`document.activeElement?.hasAttribute('data-nb-cell')`), 'command mode before D D')
    await c.ev(`(() => { const el = document.activeElement; for (let i = 0; i < 2; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })) })()`) // both inside the double-press window, however busy the machine is
    check('D twice deletes the cell', await waitFor(async () => (await nbCount()) === nbBefore, 'cell deleted by key'))
    // stop, text view
    await c.ev(`document.querySelector('[data-nb-action="stop"]').click()`)
    check('Stop ends the kernel', await waitFor(async () => (await nbStatus()) === 'stopped', 'kernel stopped'))
    await c.ev(`document.querySelector('[data-notebook] .nb-toolbar button:last-child').click()`)
    check('"{ }" shows the notebook as JSON text', await waitFor(() => c.ev(`!document.querySelector('[data-notebook]') && /"cells"/.test(document.querySelector('.group-main .view-lines')?.textContent || '')`), 'text view'))
    await paletteT('as notebook')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Open as Notebook'))`), 'toggle command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Open as Notebook')).click()`)
    check('and the palette brings the cells back', await waitFor(() => c.ev(`!!document.querySelector('[data-notebook] [data-nb-cell]')`), 'notebook view again'))
    await ctrl('s')
    await rightClick('.tab'); await clickMenu('Close All')
    fs.writeFileSync(path.join(PROJ, 'broken.ipynb'), '{ not json')
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="broken.ipynb"]')`), 'broken.ipynb in tree', 10000)
    await openFromTree('broken.ipynb')
    check('a damaged notebook says what is wrong and offers the text', await waitFor(() => c.ev(`/not valid JSON/.test(document.querySelector('[data-nb-error]')?.textContent || '')`), 'notebook error'))
    await rightClick('.tab'); await clickMenu('Close All')
    fs.rmSync(path.join(PROJ, 'broken.ipynb'), { force: true }); fs.rmSync(path.join(PROJ, 'e2e.ipynb'), { force: true })

    // ---- SSH terminal and WSL folder ----
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitFor(() => c.ev(`!document.querySelector('.qp.settings')`), 'settings closed')
    const palette = async (text) => {
      await ctrl('p', { shiftKey: true })
      await c.ev(`(() => { const el = document.querySelector('.qp input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    }
    await palette('ssh terminal')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('New SSH Terminal'))`), 'ssh command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('New SSH Terminal')).click()`)
    check('"New SSH Terminal" asks for an address', await waitFor(() => c.ev(`!!document.querySelector('[data-input-dialog]') && /SSH address/.test(document.querySelector('.input-dialog').textContent)`), 'ssh dialog'))
    const tabsBeforeSsh = (await termTabs()).length
    await typeInput('[data-input-dialog]', '-oProxyCommand=calc')
    check('something that ssh would read as an option is refused with a message', await waitFor(() => c.ev(`/host name/.test(document.querySelector('.input-dialog')?.textContent || '')`), 'ssh validation') && (await termTabs()).length === tabsBeforeSsh)
    await typeInput('[data-input-dialog]', '10.255.255.1')
    check('a valid address opens a terminal tab for the session', await waitFor(async () => (await termTabs()).includes('SSH: 10.255.255.1'), 'ssh tab', 4000), JSON.stringify(await termTabs()))
    await c.ev(`[...document.querySelectorAll('.term-tab')].find(t => t.textContent.includes('SSH: 10.255.255.1'))?.querySelector('.close')?.click()`)
    await palette('wsl folder')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Open WSL Folder'))`), 'wsl command')
    await c.ev(`window.__alerts = []; [...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Open WSL Folder')).click()`)
    const wslOutcome = await waitFor(async () => (await c.ev(`window.__alerts.some(a => /No WSL distribution/.test(a))`)) ? 'none' : (await c.ev(`[...document.querySelectorAll('.qp-item')].some(i => /Open a folder in this Linux distribution/.test(i.textContent))`)) ? 'list' : false, 'WSL answer', 10000)
    check('"Open WSL Folder" lists the installed distributions, or says that there are none', wslOutcome === 'none' || wslOutcome === 'list', String(wslOutcome))
    await c.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

    // ---- Folder over SSH (against an SSH server in this process) ----
    const sshRoot = path.join(os.tmpdir(), 'e2e-ssh-' + process.pid)
    fs.rmSync(sshRoot, { recursive: true, force: true })
    fs.mkdirSync(path.join(sshRoot, 'home', 'tester', 'proj', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(sshRoot, 'home', 'tester', 'proj', 'remote.ts'), 'export const remote = 1\n')
    fs.writeFileSync(path.join(sshRoot, 'home', 'tester', 'proj', 'sub', 'deep.txt'), 'a needle-in-the-remote here\n')
    const sshServer = require('./sshserver.cjs')(sshRoot)
    await new Promise((r) => sshServer.listen(0, '127.0.0.1', r))
    const sshPort = sshServer.address().port
    const localRoot = await c.ev(`document.querySelector('.statusbar .sb-item').title`)
    await palette('folder over ssh')
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Open Folder over SSH'))`), 'ssh folder command')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Open Folder over SSH')).click()`)
    check('"Open Folder over SSH" asks for an address', await waitFor(() => c.ev(`!!document.querySelector('[data-input-dialog]') && /over SSH/.test(document.querySelector('.input-dialog').textContent)`), 'ssh folder dialog'))
    await typeInput('[data-input-dialog]', 'tester@127.0.0.1:' + sshPort)
    check('a computer seen for the first time asks you to trust its fingerprint', await waitFor(() => c.ev(`/SHA256:/.test(document.querySelector('[data-choice-dialog]')?.textContent || '')`), 'trust dialog'))
    await c.ev(`document.querySelector('[data-choice="Trust and connect"]').click()`)
    check('then asks for the password, hiding what is typed', await waitFor(() => c.ev(`document.querySelector('[data-input-dialog]')?.type === 'password'`), 'password dialog'))
    await typeInput('[data-input-dialog]', 'secret')
    check('and shows the folders of the computer to pick from', await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Open this folder')) && [...document.querySelectorAll('.qp-item')].some(i => i.textContent.trim().startsWith('proj'))`), 'remote folder picker'))
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.trim().startsWith('proj')).click()`)
    await waitFor(() => c.ev(`[...document.querySelectorAll('.qp-item')].some(i => i.textContent.includes('Open this folder') && i.textContent.includes('/home/tester/proj'))`), 'inside proj')
    await c.ev(`[...document.querySelectorAll('.qp-item')].find(i => i.textContent.includes('Open this folder')).click()`)
    check('opening it makes that folder the project, with an SSH badge in the status bar', await waitFor(() => c.ev(`!!document.querySelector('[data-sb="ssh"]') && /proj/.test(document.querySelector('.statusbar .sb-item').textContent)`), 'remote root open'))
    check('the explorer lists the files on the other computer', await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="remote.ts"]') && !!document.querySelector('.tree-row[data-tree-path$="sub"]')`), 'remote tree'))
    await openFromTree('remote.ts')
    check('a remote file opens in the editor with its contents', await waitFor(() => c.ev(`/export\\s+const\\s+remote\\s*=\\s*1/.test(document.querySelector('.group-main .view-lines')?.textContent || '')`), 'remote content'))
    await typeInEditor('// edited over ssh\n')
    await ctrl('s')
    check('saving writes the change to the other computer', await waitFor(() => fs.readFileSync(path.join(sshRoot, 'home', 'tester', 'proj', 'remote.ts'), 'utf8').includes('// edited over ssh'), 'remote file saved', 10000))
    await c.ev(`document.querySelectorAll('.sidebar-views button')[1].click()`)
    await typeInput('.search-box input', 'needle-in-the-remote')
    check('Find in files searches the other computer', await waitFor(() => c.ev(`[...document.querySelectorAll('.search-hit')].some(h => /needle-in-the-remote/.test(h.textContent))`), 'remote search', 15000))
    await c.ev(`document.querySelector('[data-view="git"]').click()`)
    check('Source Control says it is not available there instead of failing', await waitFor(() => c.ev(`/over SSH/.test(document.querySelector('.sidebar')?.textContent || '')`), 'git remote message'))
    await c.ev(`document.querySelectorAll('.sidebar-views button')[0].click()`)
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="remote.ts"]')`), 'remote.ts in the tree again')
    await rightClick('.tree-row[data-tree-path$="remote.ts"]')
    await clickMenu('Rename')
    await typeInput('[data-input-dialog]', 'renamed.ts')
    check('renaming a remote file works', await waitFor(() => fs.existsSync(path.join(sshRoot, 'home', 'tester', 'proj', 'renamed.ts')) && !fs.existsSync(path.join(sshRoot, 'home', 'tester', 'proj', 'remote.ts')), 'remote rename', 10000))
    await waitFor(() => c.ev(`!!document.querySelector('.tree-row[data-tree-path$="renamed.ts"]')`), 'renamed.ts in the tree')
    await rightClick('.tree-row[data-tree-path$="renamed.ts"]')
    await clickMenu('Delete')
    check('and deleting one removes it from the other computer', await waitFor(() => !fs.existsSync(path.join(sshRoot, 'home', 'tester', 'proj', 'renamed.ts')), 'remote delete', 10000))
    await c.ev(`window.__alerts = []`)
    const back = await c.ev(`window.api.fsIsDir(${JSON.stringify(localRoot)})`)
    check('the local project folder is still there to go back to', back === true)
    await c.ev(`window.api.sshDisconnect('127-0-0-1')`)
    sshServer.close()
    fs.rmSync(sshRoot, { recursive: true, force: true })

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
