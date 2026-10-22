// Drives the packaged app through its UI against the REAL Claude API. Uses ANTHROPIC_API_KEY from the
// environment and costs a few cents per run (Haiku for chat, Sonnet for the agent and inline edit).
// Run `npm run dist` first, then `npm run test:real`.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { spawn, execSync } = require('child_process')
const WebSocket = require('ws')
const PROJ = path.join(os.tmpdir(), 'my-ai-ide-real-project')
const PROFILE = path.join(os.tmpdir(), 'my-ai-ide-real-profile') // isolated app data, so the test never touches your real settings
const EXE = path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
const CDP_PORT = 9334

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now()
  let lastErr
  for (;;) {
    try { const v = await fn(); if (v) return v } catch (e) { if (/^(chat|agent|inline edit) error/.test(e.message)) throw e; lastErr = e }
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for: ' + what + (lastErr ? ' (' + lastErr.message + ')' : ''))
    await sleep(200)
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

const VIS = `const vis = (e) => e && e.getClientRects().length > 0;`
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 300) : ''}`) }
function removeHistory() {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true })
  } catch {}
}

;(async () => {
  removeHistory()
  fs.rmSync(PROJ, { recursive: true, force: true })
  fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true })
  fs.writeFileSync(path.join(PROJ, 'hello.txt'), 'hello world\n')
  fs.writeFileSync(path.join(PROJ, 'src', 'app.ts'), 'export const answerToEverything = 42\n')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ANTHROPIC_BASE_URL
  const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', PROJ], { env, stdio: 'ignore' })
  let c
  const typeInto = (sel, text, proto = 'HTMLTextAreaElement') => c.ev(`(() => { ${VIS} const el = [...document.querySelectorAll('${sel}')].find(vis); const set = Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const clickBtn = (text, scope = '') => c.ev(`(() => { ${VIS} const b = [...document.querySelectorAll('${scope} button')].find(b => vis(b) && b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
  const pickModel = (scope, id) => c.ev(`(() => { ${VIS} const s = [...document.querySelectorAll('${scope} select')].find(vis); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, '${id}'); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`)
  const asstTexts = () => c.ev(`[...document.querySelectorAll('.chat-msg.assistant')].filter(m => m.getClientRects().length).map(m => m.textContent)`)
  const errorsShown = () => c.ev(`[...document.querySelectorAll('.chat-error')].map(e => e.textContent)`)
  try {
    c = await cdpConnect()
    await waitFor(() => c.ev(`document.querySelectorAll('.tree-row').length > 0`), 'app + folder')
    check('app starts with the real key available (no key prompt)', await c.ev(`!document.querySelector('.chat-key')`))

    // 1. Chat (Haiku to keep it cheap)
    console.log('model picked:', await pickModel('.chat', 'claude-haiku-5-5'))
    await typeInto('.chat textarea', 'Reply with exactly one word: pong')
    await clickBtn('Send', '.chat')
    const r1 = await waitFor(async () => { const e = await errorsShown(); if (e.length) throw new Error('chat error: ' + e.join('|')); return (await asstTexts()).find((x) => /pong/i.test(x)) }, 'real chat reply', 60000)
    check('real chat reply streams in', !!r1, r1)

    // 2. @file mention
    await typeInto('.chat textarea', 'What number does @src/app.ts export? Answer with just the number.')
    await clickBtn('Send', '.chat')
    const note = await waitFor(() => c.ev(`[...document.querySelectorAll('.chat-note')].map(n => n.textContent).find(t => t.includes('@src/app.ts'))`), 'mention note')
    const r2 = await waitFor(async () => { const e = await errorsShown(); if (e.length) throw new Error('chat error: ' + e.join('|')); const t = await asstTexts(); return t.length >= 2 && /42/.test(t[t.length - 1]) && t[t.length - 1] }, 'mention reply mentions 42', 60000)
    check('@file mention: Claude read the referenced file', !!r2 && !!note, r2)

    // 3. Agent (Sonnet 5.5) with real approvals
    await clickBtn('Agent', '.chat')
    console.log('agent model:', await pickModel('.chat', 'claude-sonnet-5-5'))
    await typeInto('.chat textarea', 'Read hello.txt, change the word "world" to "there", then run the PowerShell command Get-Content hello.txt to confirm. Be brief.')
    await clickBtn('Send', '.chat')
    let sawEdit = false, sawCmd = false, finished = false
    const t0 = Date.now()
    while (Date.now() - t0 < 180000 && !finished) {
      const ap = await c.ev(`document.querySelector('.qp.approval')?.textContent || ''`)
      const cmd = await c.ev(`document.querySelector('.cmd-text')?.textContent || ''`)
      if (ap) { sawEdit = true; console.log('  approving edit dialog:', ap.slice(0, 40)); await clickBtn('Accept', '.approval') }
      else if (cmd) { sawCmd = true; console.log('  approving command:', cmd.slice(0, 80)); await clickBtn('Run', '.qp') }
      const errs = await errorsShown()
      if (errs.length) { console.log('  agent error shown:', errs.join('|')); break }
      const idle = await c.ev(`(() => { ${VIS} const working = [...document.querySelectorAll('.chat-note')].some(n => vis(n) && n.textContent.includes('Working')); return !working && !document.querySelector('.qp-backdrop') && [...document.querySelectorAll('.agent-tool')].some(vis) })()`)
      if (idle && sawEdit && sawCmd) finished = true
      await sleep(500)
    }
    const disk = fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8')
    const tools = await c.ev(`[...document.querySelectorAll('.agent-tool summary')].map(s => s.textContent.trim())`)
    console.log('  tool calls:', JSON.stringify(tools))
    check('agent proposed an edit and you approved it', sawEdit)
    check('agent edit written correctly', disk === 'hello there\n', JSON.stringify(disk))
    check('agent ran the verification command after approval', sawCmd)
    const lastAgentText = (await asstTexts()).pop()
    console.log('  agent final text:', JSON.stringify((lastAgentText || '').slice(0, 200)))
    check('agent finished with a final answer and no error', finished && (await errorsShown()).length === 0)

    // 4. Undo through the UI
    await clickBtn('Undo', '.agent-change')
    await waitFor(() => fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8') === 'hello world\n', 'undo on disk')
    check('undo restored the file', true)

    // 5. Follow-up turn: history round-trip, and the model is told about the undo
    await typeInto('.chat textarea', 'Without using any tools: which file did you just edit, and was that change undone?')
    await clickBtn('Send', '.chat')
    const r5 = await waitFor(async () => { const e = await errorsShown(); if (e.length) throw new Error('agent error: ' + e.join('|')); const l = (await asstTexts()).pop() || ''; return /hello\.txt/i.test(l) && /undo|undid|revert|restor/i.test(l) && l }, 'follow-up answer', 90000)
    check('agent follow-up turn works and knows about the undo', !!r5, r5)

    // 6. Inline edit (Ctrl+K) with a real model
    await clickBtn('Chat', '.chat')
    await c.ev(`[...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === 'hello.txt').click()`)
    await waitFor(() => c.ev(`document.querySelector('.monaco-editor .view-lines')?.textContent.includes('hello')`), 'editor shows file')
    await c.ev(`document.querySelector('.monaco-editor textarea').focus()`)
    const key = (type, k, code, vk, mod) => c.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: mod })
    await key('keyDown', 'a', 'KeyA', 65, 2); await key('keyUp', 'a', 'KeyA', 65, 2)
    await key('keyDown', 'k', 'KeyK', 75, 2); await key('keyUp', 'k', 'KeyK', 75, 2)
    const bar = await waitFor(() => c.ev(`!!document.querySelector('.ie-bar input')`), 'inline edit bar opens on Ctrl+K')
    check('Ctrl+K opens the inline edit bar', bar)
    await pickModel('.ie-bar', 'claude-sonnet-5-5')
    await typeInto('.ie-bar input', 'Rewrite this text in uppercase.', 'HTMLInputElement')
    await c.ev(`document.querySelector('.ie-bar input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    const review = await waitFor(async () => { const e = await c.ev(`document.querySelector('.ie .chat-error')?.textContent || ''`); if (e) throw new Error('inline edit error: ' + e); return c.ev(`!!document.querySelector('.ie-diff .monaco-diff-editor')`) }, 'inline edit diff', 90000)
    check('inline edit produced a diff to review', review)
    await clickBtn('Accept', '.ie-actions')
    const upper = await waitFor(() => c.ev(`(document.querySelector('.monaco-editor .view-lines')?.textContent || '').replace(/\u00a0/g, ' ').includes('HELLO WORLD')`), 'uppercase applied', 15000)
    check('accepting inline edit applied the change in the editor', upper)

    check('no uncaught renderer errors', c.errors.length === 0, c.errors.slice(0, 3).join(' | '))
  } catch (e) {
    check('run completed without exception', false, e.message)
    if (c) console.log('renderer errors:', c.errors.slice(0, 5))
  } finally {
    try { c && c.close() } catch {}
    try { execSync(`taskkill /pid ${app.pid} /T /F`, { stdio: 'ignore' }) } catch {}
    removeHistory()
    const failed = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failed}/${results.length} checks passed`)
    process.exit(failed ? 1 : 0)
  }
})()
