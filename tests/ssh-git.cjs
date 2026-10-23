// Git over SSH: the real git module (src/main/git.ts) and SSH module run against the test SSH server, which executes
// commands with the local git in a temporary folder. `npm run test:ssh-git`: does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
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
fs.appendFileSync(entry, `export * as agent from ${JSON.stringify(path.join(root, 'src/main/agent.ts').split(path.sep).join('/'))}
`)
require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['ssh2', '@anthropic-ai/sdk'], alias: { electron: stub }, outfile: bundle, logLevel: 'error' })
const { ssh, git, agent } = require(bundle)
ssh.registerSshHandlers(); git.registerGitHandlers()
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


  ssh.disconnectAll(); server.close()
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
