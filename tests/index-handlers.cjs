// Runs the real codebase-search module (src/main/codeindex.ts) against throwaway projects, with a stub for Electron
// and a fake Claude API for the query-expansion / rerank step. `npm run test:index`: does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const handlers = {}
global.__electronStub = {
  ipcMain: { handle: (name, fn) => { handlers[name] = fn }, on: () => {} },
  shell: {}, app: { getPath: () => os.tmpdir() }, safeStorage: {}, BrowserWindow: class {}
}
const root = path.join(__dirname, '..')
const stubFile = path.join(root, 'node_modules', '.cache', 'index-electron-stub.cjs')
const bundleFile = path.join(root, 'node_modules', '.cache', 'index-bundle.cjs')
fs.mkdirSync(path.dirname(stubFile), { recursive: true })
fs.writeFileSync(stubFile, 'module.exports = global.__electronStub')
require('esbuild').buildSync({
  stdin: { contents: "export * from './codeindex'; export { setEmbedderForTests, embedStatus } from './embeddings'", resolveDir: path.join(root, 'src', 'main'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', alias: { electron: stubFile }, external: ['@huggingface/transformers'], outfile: bundleFile, logLevel: 'error'
})
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_BASE_URL
const mod = require(bundleFile)
mod.registerCodeIndexHandlers()
// The model is not downloaded in tests: meaning search is off except in its own block, which uses a fake embedder.
handlers['index:embeddings']({}, false)
const search = (roots, q, opts) => handlers['index:search']({}, roots, q, opts)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }
const mk = (name) => { const d = path.join(os.tmpdir(), 'index-test-' + name + '-' + process.pid); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d }
const w = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const top = (r, n = 3) => r.hits.slice(0, n).map((h) => h.rel)

;(async () => {
  // --- tokenising
  check('identifiers are split into their words and kept whole', JSON.stringify(mod.tokenize('parseConfigFile HTTPServer snake_case_name')) === JSON.stringify(['parseconfigfile', 'parse', 'config', 'file', 'httpserver', 'http', 'server', 'snake', 'case', 'name']), JSON.stringify(mod.tokenize('parseConfigFile HTTPServer snake_case_name')))

  const p = mk('proj')
  w(p, 'auth/login.ts', 'export async function authenticateUser(email: string, password: string) {\n  // check the password hash and start a session\n  const user = await db.findUserByEmail(email)\n  return createSession(user)\n}\n')
  w(p, 'billing/invoice.ts', 'export function computeInvoiceTotal(items: Item[]) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0)\n}\n')
  w(p, 'utils/config.ts', 'export function parseConfigFile(path: string) {\n  return JSON.parse(readFileSync(path, "utf8"))\n}\n')
  w(p, 'README.md', '# Demo\nA small demo project.\n')
  w(p, 'node_modules/dep/index.js', 'function authenticateUser() { /* vendored login code */ }\n')
  w(p, 'assets/logo.png', Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]).toString('latin1'))
  w(p, 'data/blob.dat', 'looks like text login\u0000\u0000 but is binary')
  w(p, '.hidden/secret.ts', 'function authenticateUser() {}\n')

  let r = await search([p], 'where do users log in with a password')
  check('the search answers in plain words, finding the login code', r.ok && top(r, 1)[0] === 'auth/login.ts', JSON.stringify(top(r)))
  check('without an API key no AI step is used', r.expanded === null && r.reranked === false)
  check('node_modules, hidden folders, images and binary files are not indexed', r.indexed.files === 4 && !r.hits.some((h) => /node_modules|hidden|logo|blob/.test(h.rel)), JSON.stringify(r.indexed))
  r = await search([p], 'compute total of an invoice')
  check('names are matched by their parts (computeInvoiceTotal)', top(r, 1)[0] === 'billing/invoice.ts', JSON.stringify(top(r)))
  r = await search([p], 'parsing the configuration file')
  check('word forms match (parsing ~ parse)', top(r, 1)[0] === 'utils/config.ts', JSON.stringify(top(r)))
  check('each hit carries the file, the line range and the code', r.hits[0].start === 1 && r.hits[0].end >= 3 && r.hits[0].text.includes('parseConfigFile') && r.hits[0].abs === path.join(p, 'utils/config.ts'))
  r = await search([p], 'zzzz-nothing-like-this')
  check('a query that matches nothing returns no hits', r.ok && r.hits.length === 0)
  r = await search([p], '   ')
  check('an empty query returns nothing without error', r.ok && r.hits.length === 0)

  // --- long files are chunked, and a hit says which lines
  const lines = []; for (let i = 1; i <= 200; i++) lines.push(i === 150 ? 'const ZEBRAMARKER = computeStripes(150)' : `// filler line ${i} about nothing`)
  w(p, 'big/long.ts', lines.join('\n'))
  r = await search([p], 'zebramarker stripes')
  const bh = r.hits.find((h) => h.rel === 'big/long.ts')
  check('a hit in a long file points at the chunk holding the line', !!bh && bh.start <= 150 && bh.end >= 150 && bh.end - bh.start < 80, JSON.stringify(bh && [bh.start, bh.end]))

  // --- the index follows changes
  await new Promise((res) => setTimeout(res, 30))
  w(p, 'utils/config.ts', 'export function loadSettings() {\n  return QUOKKAUNIQUE\n}\n')
  r = await search([p], 'quokkaunique')
  check('an edited file is re-indexed', top(r, 1)[0] === 'utils/config.ts', JSON.stringify(top(r)))
  r = await search([p], 'parse configuration file')
  check('and its old content is gone from the index', !r.hits.some((h) => h.text.includes('parseConfigFile')))
  fs.rmSync(path.join(p, 'billing'), { recursive: true })
  r = await search([p], 'invoice total')
  check('deleted files leave the index', !r.hits.some((h) => h.rel.startsWith('billing')))
  w(p, 'new/thing.ts', 'export const WOMBATFEATURE = 1\n')
  r = await search([p], 'wombatfeature')
  check('new files are picked up', top(r, 1)[0] === 'new/thing.ts')

  // --- several folders at once
  const q = mk('second'); w(q, 'src/mailer.ts', 'export function sendWelcomeEmail(to: string) {}\n')
  r = await search([p, q], 'send welcome email')
  check('several folders are searched together; each hit names its folder', top(r, 1)[0] === 'src/mailer.ts' && r.hits[0].root === q && r.indexed.files > 4, JSON.stringify(r.hits.map((h) => [path.basename(h.root), h.rel])))
  r = await search([p, q], 'login password', { limit: 1 })
  check('the limit caps the number of hits', r.hits.length === 1)

  // --- text for the model
  const txt = mod.formatHits((await search([p], 'login password')).hits)
  check('formatted hits list path:lines and the code in fences', /auth\/login\.ts:1-\d+\n```\n/.test(txt) && txt.includes('authenticateUser'), txt.slice(0, 120))
  check('no hits are reported plainly', mod.formatHits([]) === 'No matching code found.')

  // --- query expansion and reranking with Claude (fake API)
  const calls = []
  let mode = 'ok'
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const json = JSON.parse(body || '{}')
      const system = String(json.system || '')
      calls.push({ system, user: JSON.stringify(json.messages) })
      if (mode === 'down') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"api_error","message":"boom"}}') }
      let text = 'nothing'
      if (system.includes('expand a code search query')) text = 'Sure: ["authenticate", "session", "password"]'
      else if (system.includes('rerank code search results')) {
        const m = [...String(json.messages[0].content).matchAll(/\[(\d+)\] ([^\n]+)/g)].map((x) => [Number(x[1]), x[2]])
        const mailer = m.find((x) => /mailer/.test(x[1]))
        text = JSON.stringify(mailer ? [mailer[0]] : [])
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
    })
  })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + server.address().port
  process.env.ANTHROPIC_API_KEY = 'test-key'

  r = await search([p], 'sign people in')
  check('with a key the question is expanded into likely identifiers', Array.isArray(r.expanded) && r.expanded.includes('authenticate'), JSON.stringify(r.expanded))
  check('and a question with no words in common with the code still finds it', top(r, 1)[0] === 'auth/login.ts', JSON.stringify(top(r)))
  check('only the question and short excerpts are sent, not whole files', calls.length >= 1 && calls.every((c) => c.user.length < 6000), calls.map((c) => c.user.length).join(','))

  r = await search([p, q], 'welcome email password')
  check('the ranking Claude returns decides the order', r.reranked === true && top(r, 1)[0] === 'src/mailer.ts', JSON.stringify(top(r)))

  mode = 'down'
  r = await search([p], 'login password')
  check('if the API fails the plain search still works', r.ok && top(r, 1)[0] === 'auth/login.ts' && r.expanded === null && r.reranked === false, JSON.stringify({ ok: r.ok, top: top(r), e: r.expanded }))
  mode = 'ok'
  r = await search([p], 'login password', { ai: false })
  check('ai: false skips Claude entirely', r.expanded === null && r.reranked === false)
  server.close()

  // --- reset
  await handlers['index:reset']({}, p)
  r = await search([p], 'login password', { ai: false })
  check('after a reset the index is rebuilt on demand', top(r, 1)[0] === 'auth/login.ts')

  // --- meaning search (a fake embedder that knows a few synonyms stands in for the model)
  const CONCEPTS = [['login', 'authenticate', 'signin', 'credentials', 'session'], ['invoice', 'bill', 'payment', 'charge', 'total'], ['config', 'settings', 'preferences', 'options'], ['email', 'mail', 'message']]
  const fakeEmbed = async (texts) => texts.map((t) => {
    const v = new Float32Array(384)
    const words = String(t).toLowerCase().match(/[a-z]+/g) || []
    for (const wd of words) CONCEPTS.forEach((group, gi) => { if (group.some((g) => wd.includes(g))) v[gi] += 1 })
    v[100] = 0.05 // never an all-zero vector
    const n = Math.hypot(...v) || 1
    return v.map((x) => x / n)
  })
  const m = mk('meaning')
  w(m, 'auth/gate.ts', 'export function authenticate(credentials) {\n  return startSession(credentials)\n}\n')
  w(m, 'pay/charge.ts', 'export function chargeCustomer(bill) {\n  return bill.total\n}\n')
  w(m, 'ui/prefs.ts', 'export const preferences = { theme: "dark" }\n')
  mod.setEmbedderForTests(fakeEmbed)
  handlers['index:embeddings']({}, true)
  r = await search([m], 'how does a person signin', { ai: false })
  check('meaning search finds code that shares no word with the question', r.ok && top(r, 1)[0] === 'auth/gate.ts', JSON.stringify(top(r)))
  check('and says it was used, with how much of the code has a vector', r.semantic && r.semantic.used === true && r.semantic.done === r.semantic.total && r.semantic.total >= 3, JSON.stringify(r.semantic))
  handlers['index:embeddings']({}, false)
  r = await search([m], 'how does a person signin', { ai: false })
  check('with the setting off the same question finds nothing by words', !r.semantic && !r.hits.some((h) => h.rel === 'auth/gate.ts'), JSON.stringify(top(r)))
  handlers['index:embeddings']({}, true)
  r = await search([m], 'authenticate', { ai: false })
  check('an exact name still ranks first when meaning is on', top(r, 1)[0] === 'auth/gate.ts')
  // the cache on disk: a second process would not need the model again
  let calls2 = 0
  mod.setEmbedderForTests(async (t) => { calls2 += t.length; return fakeEmbed(t) })
  await handlers['index:reset']({}, m)
  r = await search([m], 'a bill to pay', { ai: false })
  check('vectors are remembered between sessions (only the question is embedded again)', calls2 === 1 && top(r, 1)[0] === 'pay/charge.ts', calls2 + ' ' + JSON.stringify(top(r)))
  // changing a file recomputes only that file
  calls2 = 0
  w(m, 'ui/prefs.ts', 'export const preferences = { theme: "light", options: 1 }\n')
  fs.utimesSync(path.join(m, 'ui/prefs.ts'), new Date(), new Date(Date.now() + 5000))
  await search([m], 'settings', { ai: false })
  check('after an edit only the changed piece is embedded again', calls2 === 2, String(calls2)) // the piece and the question
  // a model that cannot load: plain search keeps working and the reason is reported
  mod.setEmbedderForTests(async () => { throw new Error('The search model has not been downloaded yet and there is no internet connection to get it.') })
  await handlers['index:reset']({}, m)
  fs.rmSync(path.join(os.tmpdir(), 'unused'), { force: true })
  r = await search([m], 'chargeCustomer', { ai: false })
  check('if the model is unavailable the word search still answers, and says why', r.ok && top(r, 1)[0] === 'pay/charge.ts' && r.semantic && r.semantic.used === false && /not been downloaded/.test(r.semantic.error || ''), JSON.stringify(r.semantic))
  mod.setEmbedderForTests(null)

  for (const d of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('index-test-'))) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})()
