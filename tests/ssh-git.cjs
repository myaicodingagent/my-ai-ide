// Git over SSH: the real git module (src/main/git.ts) and SSH module run against the test SSH server, which executes
// commands with the local git in a temporary folder. `npm run test:ssh-git`: does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const NL = String.fromCharCode(10)
const handlers = {}
const tmp = path.join(os.tmpdir(), 'ssh-git-test-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true })
const remoteRoot = path.join(tmp, 'server-root'); fs.mkdirSync(remoteRoot, { recursive: true })
global.__electronStub = { ipcMain: { handle: (n, f) => { handlers[n] = f } }, shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') } }
const root = path.join(__dirname, '..')
const stub = path.join(root, 'node_modules', '.cache', 'ssh-stub.cjs'), bundle = path.join(root, 'node_modules', '.cache', 'ssh-git-bundle.cjs')
fs.mkdirSync(path.dirname(stub), { recursive: true })
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
const entry = path.join(root, 'node_modules', '.cache', 'ssh-git-entry.ts')
fs.writeFileSync(entry, `export * as ssh from ${JSON.stringify(path.join(root, 'src/main/sshfs.ts').split(require('path').sep).join('/'))}\nexport * as git from ${JSON.stringify(path.join(root, 'src/main/git.ts').split(require('path').sep).join('/'))}\n`)
fs.appendFileSync(entry, `export * as codeindex from ${JSON.stringify(path.join(root, 'src/main/codeindex.ts').split(path.sep).join('/'))}
export { setEmbedderForTests } from ${JSON.stringify(path.join(root, 'src/main/embeddings.ts').split(path.sep).join('/'))}
export * as agent from ${JSON.stringify(path.join(root, 'src/main/agent.ts').split(path.sep).join('/'))}
`)
require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['ssh2', '@anthropic-ai/sdk'], alias: { electron: stub }, outfile: bundle, logLevel: 'error' })
const { ssh, git, agent, codeindex, setEmbedderForTests } = require(bundle)
ssh.registerSshHandlers(); git.registerGitHandlers(); codeindex.registerCodeIndexHandlers()
const call = (n, ...a) => handlers[n]({}, ...a)
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }
const server = require('./sshserver.cjs')(remoteRoot)
const sh = (cwd, ...args) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf-8' })

;(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const proj = path.join(remoteRoot, 'home', 'tester', 'proj'); fs.mkdirSync(proj, { recursive: true })
  sh(proj, 'init', '-q'); fs.writeFileSync(path.join(proj, 'a.txt'), 'one\n'); sh(proj, 'add', '-A'); sh(proj, 'commit', '-qm', 'first')
  const c = await ssh.connect(`tester@127.0.0.1:${server.address().port}`, { password: 'secret', trust: undefined }).then(async (r) => (r.need === 'trust' ? ssh.connect(`tester@127.0.0.1:${server.address().port}`, { password: 'secret', trust: r.fingerprint }) : r))
  check('connects to the test server', c.ok === true, JSON.stringify(c))
  const dir = ssh.remoteUnc(c.name, '/home/tester/proj')

  let st = await call('git:status', dir)
  check('status works over SSH: repository found, branch known, clean', st.state === 'ok' && !!st.branch && st.files.length === 0, JSON.stringify(st))
  fs.writeFileSync(path.join(proj, 'a.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(proj, 'b.txt'), 'new\n')
  st = await call('git:status', dir)
  check('changed and new files are listed with paths relative to the folder', st.files.map((f) => f.rel).sort().join() === 'a.txt,b.txt', JSON.stringify(st.files))
  const d = await call('git:diff', dir, 'a.txt', false)
  check('the diff has both sides', d.original === 'one\n' && d.modified === 'one\ntwo\n', JSON.stringify(d))
  let r = await call('git:stage', dir, null)
  check('stage all', r.ok === true, JSON.stringify(r))
  r = await call('git:commit', dir, 'second: two files\n\nbody')
  check('commit sends the message through stdin', r.ok === true && sh(proj, 'log', '-1', '--format=%B').startsWith('second: two files'), JSON.stringify(r))
  r = await call('git:checkout', dir, 'feature x', true)
  check('an invalid branch name is refused', r.ok === false)
  r = await call('git:checkout', dir, 'feature-x', true)
  check('create and switch branch', r.ok === true && sh(proj, 'branch', '--show-current').trim() === 'feature-x', JSON.stringify(r))
  fs.writeFileSync(path.join(proj, 'tmp.txt'), 'x\n')
  r = await call('git:discard', dir, [], ['tmp.txt'])
  check('discarding an untracked file removes it on the server', r.ok === true && !fs.existsSync(path.join(proj, 'tmp.txt')), JSON.stringify(r))
  const odd = path.join(proj, "it's a file.txt"); fs.writeFileSync(odd, 'q\n')
  st = await call('git:status', dir)
  check('file names with spaces and quotes survive the remote shell', st.files.some((f) => f.rel === "it's a file.txt"), JSON.stringify(st.files))
  const nr = await call('git:status', ssh.remoteUnc(c.name, '/home/tester'))
  check('a folder that is not a repository says so', nr.state === 'norepo', JSON.stringify(nr))

  // ---------------- the agent's tools over SSH
  const sent = []
  const approve = async () => true
  const out = await agent.runTool(dir, 'list_dir', { path: '.' })
  check('agent: list_dir shows the remote folder', /a\.txt/.test(out) && /b\.txt/.test(out), out)
  check('agent: read_file numbers the lines', (await agent.runTool(dir, 'read_file', { path: 'a.txt', start_line: 1, end_line: 0 })).startsWith('1\tone'))
  check('agent: search_text finds a line', /a\.txt:2: two/.test(await agent.runTool(dir, 'search_text', { pattern: 'two', path: '.', case_sensitive: false })))
  check('agent: find_files', /b\.txt/.test(await agent.runTool(dir, 'find_files', { pattern: '*.txt' })))
  const wctx = { root: dir, sessionId: 'sshtest', toolUseId: 't1', send: (e) => sent.push(e), requestApproval: approve }
  await agent.runWriteTool(wctx, 'edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO' })
  check('agent: edit_file changes the file on the server', fs.readFileSync(path.join(proj, 'a.txt'), 'utf-8').includes('TWO'))
  await agent.runWriteTool(wctx, 'write_file', { path: 'new/deep/c.txt', content: 'made\n' })
  check('agent: write_file creates folders as needed', fs.readFileSync(path.join(proj, 'new', 'deep', 'c.txt'), 'utf-8') === 'made\n')
  const esc = await agent.runTool(dir, 'read_file', { path: '../../x', start_line: 1, end_line: 0 }).then(() => 'read', (e) => e.message)
  check('agent: a path outside the project is refused', /outside the project/.test(esc), esc)
  const cmd = await agent.runCommand({ root: dir, toolUseId: 't2', signal: new AbortController().signal, send: (e) => sent.push(e), requestApproval: approve }, { command: 'echo hello-remote; pwd' })
  check('agent: run_command runs on the server in the project folder', /hello-remote/.test(cmd) && /proj/.test(cmd), cmd)
  const bad = await agent.runCommand({ root: dir, toolUseId: 't3', signal: new AbortController().signal, send: () => undefined, requestApproval: approve }, { command: 'exit 3' }).then(() => 'ok', (e) => e.message)
  check('agent: a failing command reports its exit code', /Exit code: 3/.test(bad), bad)

  // search by meaning (the words part; no model is downloaded here) over SSH
  fs.mkdirSync(path.join(proj, 'util'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'util', 'greeter.js'), ['export function greetUser(name) {', '  return "hello " + name', '}', ''].join(NL))
  fs.writeFileSync(path.join(proj, 'util', 'maths.js'), ['export function addNumbers(a, b) {', '  return a + b', '}', ''].join(NL))
  fs.mkdirSync(path.join(proj, 'node_modules', 'dep'), { recursive: true }); fs.writeFileSync(path.join(proj, 'node_modules', 'dep', 'greeter.js'), 'function greetUser() {}' + NL)
  const found = await agent.runTool(dir, 'search_codebase', { query: 'greet user' }).catch((e) => 'ERR ' + e.message)
  check('agent: search_codebase finds code by its words in a folder on the server', /greeter[.]js/.test(found) && !/node_modules/.test(found), found)
  fs.writeFileSync(path.join(proj, 'util', 'maths.js'), ['export function addNumbers(a, b) {', '  return a + b', '}', 'export function farewellUser() {}', ''].join(NL))
  const later = await agent.runTool(dir, 'search_codebase', { query: 'farewell user' }).catch((e) => 'ERR ' + e.message)
  check('and a file changed on the server is searched again', /maths[.]js/.test(later), later)

  // search by meaning over SSH: a fake embedder knows a few synonyms and stands in for the model
  const CONCEPTS = [['login', 'authenticate', 'signin', 'credentials', 'session'], ['invoice', 'bill', 'payment', 'charge', 'total']]
  let embedded = 0
  const fakeEmbed = async (texts) => { embedded += texts.length; return texts.map((t) => {
    const v = new Float32Array(384)
    for (const wd of String(t).toLowerCase().match(/[a-z]+/g) || []) CONCEPTS.forEach((group, gi) => { if (group.some((g) => wd.includes(g))) v[gi] += 1 })
    v[100] = 0.05
    const n = Math.hypot(...v) || 1
    return v.map((x) => x / n)
  }) }
  fs.mkdirSync(path.join(proj, 'auth'), { recursive: true }); fs.mkdirSync(path.join(proj, 'pay'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'auth', 'gate.ts'), 'export function authenticate(credentials) {' + NL + '  return startSession(credentials)' + NL + '}' + NL)
  fs.writeFileSync(path.join(proj, 'pay', 'charge.ts'), 'export function chargeCustomer(bill) {' + NL + '  return bill.total' + NL + '}' + NL)
  setEmbedderForTests(fakeEmbed)
  call('index:embeddings', true)
  let sr = await call('index:search', [dir], 'how does a person signin', { ai: false })
  const topRel = (x) => x.hits.map((h) => h.rel)
  check('meaning: finds code that shares no word with the question in a folder on the server', sr.ok && topRel(sr)[0] === 'auth/gate.ts', JSON.stringify(topRel(sr)))
  check('meaning: reports that vectors were used', sr.semantic && sr.semantic.used === true && sr.semantic.done === sr.semantic.total && sr.semantic.total >= 2, JSON.stringify(sr.semantic))
  check('meaning: the hit opens the remote file', sr.hits[0] && sr.hits[0].abs === dir.replace(/[\\/]+$/, '') + '\\auth\\gate.ts', sr.hits[0] && sr.hits[0].abs)
  call('index:embeddings', false)
  sr = await call('index:search', [dir], 'how does a person signin', { ai: false })
  check('meaning: with the toggle off the same question finds nothing by words', !sr.semantic && !topRel(sr).includes('auth/gate.ts'), JSON.stringify(topRel(sr)))
  call('index:embeddings', true)
  await call('index:reset', dir)
  embedded = 0
  sr = await call('index:search', [dir], 'a bill to pay', { ai: false })
  check('meaning: vectors of the server folder are remembered (only the question is embedded again)', embedded === 1 && topRel(sr)[0] === 'pay/charge.ts', embedded + ' ' + JSON.stringify(topRel(sr)))
  call('index:embeddings', false); setEmbedderForTests(null)


  ssh.disconnectAll(); server.close()
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
