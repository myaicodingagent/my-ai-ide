// Cloud agents against a REAL Linux SSH server: the agent loop runs on the server as a detached process and the editor follows it
// through files. The server is the Docker container of tests/ssh-linux.cjs (it needs node 18+ and git; see the top of that file),
// the model is a fake API that runs in the container (tests/fake-anthropic.cjs), and the editor side is the real background and SSH
// modules. Needs the built runner (`node scripts/build-runner.cjs`, done by npm run build).
// `npm run test:cloud-agent`: skipped unless something answers on 127.0.0.1:2222 and docker works; does not start the app.
// Phase 2 runs in a second process: the first one starts a task and then ends abruptly, like an editor that is closed or killed.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), cp = require('child_process')
const root = path.join(__dirname, '..')
const phase = process.env.CLOUD_TEST_PHASE || 'main'
const runnerFile = path.join(root, 'out', 'runner', 'cloud-runner.cjs')
const container = process.env.SSH_TEST_CONTAINER || 'sshtest'
const run = (cmd, args, opts = {}) => cp.spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true, ...opts })
const dx = (script) => run('docker', ['exec', '-u', 'tester', container, 'bash', '-c', script], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const API_PORT = 8799

;(async () => {
  if (phase === 'main') {
    const up = await new Promise((res) => { const s = net.connect(2222, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
    if (!up || run('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0) { console.log('SKIP  needs the Linux SSH container on 127.0.0.1:2222 and docker (see tests/ssh-linux.cjs)'); process.exit(0) }
    if (dx('command -v node && command -v git').status !== 0) { console.log('SKIP  node and git are not installed in the container'); process.exit(0) }
    if (!fs.existsSync(runnerFile)) { console.log('SKIP  the runner is not built (node scripts/build-runner.cjs)'); process.exit(0) }
  }
  const shared = process.env.CLOUD_TEST_DIR || fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-agent-')))
  const baseN = process.env.CLOUD_TEST_BASE || '/home/tester/cloudtest-' + process.pid
  const projN = baseN + '/proj'

  const handlers = {}
  global.__electronStub = {
    ipcMain: { handle: (n, f) => { handlers[n] = f }, on: (n, f) => { handlers[n] = f } },
    shell: {}, safeStorage: { isEncryptionAvailable: () => false, decryptString: (b) => b.toString(), encryptString: (s) => Buffer.from(s) }, BrowserWindow: class {}, app: { getPath: () => path.join(shared, 'userData'), getAppPath: () => root }
  }
  const cache = path.join(root, 'node_modules', '.cache')
  fs.mkdirSync(cache, { recursive: true })
  const stub = path.join(cache, 'cloud-stub.cjs'), bundle = path.join(cache, 'cloud-bundle.cjs'), entry = path.join(cache, 'cloud-entry.ts')
  const posix = (p) => p.split(path.sep).join('/')
  if (phase === 'main') {
    fs.writeFileSync(stub, 'module.exports = global.__electronStub')
    fs.writeFileSync(entry, `export * as ssh from ${JSON.stringify(posix(path.join(root, 'src/main/sshfs.ts')))}\nexport * as bg from ${JSON.stringify(posix(path.join(root, 'src/main/background.ts')))}\n`)
    require('./bundle-main.cjs').bundleSync({ entry, out: bundle, stub, external: ['ssh2', 'ws', 'esbuild', '@anthropic-ai/sdk'] })
  }
  process.env.MY_AI_IDE_RUNNER_FILE = runnerFile
  process.env.ANTHROPIC_API_KEY = 'sk-test-key-123'
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + API_PORT
  const { ssh, bg } = require(bundle)
  ssh.registerSshHandlers()
  bg.registerBackgroundHandlers(() => ({ webContents: { send: () => undefined } }))
  const call = (n, ...a) => handlers[n]({}, ...a)
  const connect = async () => {
    let c = await ssh.connect('tester@127.0.0.1:2222', { password: 'secret' })
    if (c.need === 'trust') c = await ssh.connect('tester@127.0.0.1:2222', { password: 'secret', trust: c.fingerprint })
    if (!c.ok) throw new Error('could not log in: ' + JSON.stringify(c))
    return c
  }
  const conn = await connect()
  const projU = ssh.remoteUnc(conn.name, projN)
  const results = []
  const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }
  async function until(pred, what, ms = 60000) {
    const t0 = Date.now()
    for (;;) {
      const v = await pred()
      if (v) return v
      if (Date.now() - t0 > ms) throw new Error('Timed out: ' + what)
      await sleep(200)
    }
  }
  const catN = (p) => dx(`cat "${p}" 2>/dev/null`).stdout
  const existsN = (p) => dx(`test -e "${p}"`).status === 0
  const git = (args) => dx(`cd ${projN} && git -c user.name=t -c user.email=t@t ${args}`).stdout

  if (phase === 'start') {
    // The first "editor": starts a slow task and ends without any cleanup.
    const r = await call('bg:start', projU, 'create a file and check it', 'm', { cloud: true, sendKey: true, policy: 'auto' })
    if (!r.ok) { console.log('START-FAILED ' + r.error); process.exit(3) }
    await until(async () => (await call('bg:list')).find((t) => t.id === r.task.id && t.steps >= 1), 'first step', 40000)
    await sleep(900) // the task list is saved a moment after a change
    console.log('STARTED ' + r.task.id)
    process.exit(0)
  }

  if (phase === 'resume') {
    // The editor started again: it logged in, reads the task list from disk and picks the task up where its events were left.
    const id = process.env.CLOUD_TEST_ID
    const back = (await call('bg:list')).find((t) => t.id === id)
    console.log('SHOWN ' + JSON.stringify(back))
    const fin = await until(async () => (await call('bg:list')).find((t) => t.id === id && t.status === 'done' && t.committed && t.files.length), 'resumed task done', 120000).catch(async () => {
      const last = (await call('bg:list')).find((t) => t.id === id)
      console.log('LAST ' + JSON.stringify({ status: last.status, error: last.error, activity: last.activity, steps: last.steps, committed: last.committed, files: last.files, offset: last.cloud && last.cloud.offset }))
      process.exit(4)
    })
    console.log('FINISHED ' + JSON.stringify(fin))
    await sleep(500)
    process.exit(0)
  }

  // ---- the server: a repository, and the fake model
  dx(`rm -rf ${baseN} && mkdir -p ${projN} && cd ${projN} && git init -q && printf 'hello\\n' > hello.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm first`)
  run('docker', ['cp', path.join(__dirname, 'fake-anthropic.cjs'), `${container}:/tmp/fake-anthropic.cjs`], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  dx('chmod a+r /tmp/fake-anthropic.cjs')
  const startFake = (delay) => { dx('pkill -f fake-anthropic.cjs; true'); cp.spawn('docker', ['exec', '-d', '-u', 'tester', container, 'bash', '-c', `cd /tmp && rm -f ${API_PORT}.requests.log && exec node fake-anthropic.cjs ${API_PORT} ${delay}`], { stdio: 'ignore', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }) }
  startFake(0)
  await sleep(1500)
  try {
    // ---- where it can run
    let r = await call('bg:start', os.tmpdir(), 'x', 'm', { cloud: true })
    check('a cloud agent needs a folder on a server', r.ok === false && /open a folder over SSH/.test(r.error), JSON.stringify(r))
    r = await call('bg:start', '\\\\wsl.localhost\\Ubuntu-24.04\\root', 'x', 'm', { cloud: true })
    check('a WSL folder is not accepted', r.ok === false && /open a folder over SSH/.test(r.error), JSON.stringify(r))

    // ---- the key must be agreed to before it is sent
    r = await call('bg:start', projU, 'create a file and check it', 'm', { cloud: true, policy: 'ask' })
    check('the server has no key of its own, so starting asks before the key is sent', r.ok === false && r.needsKey !== undefined, JSON.stringify(r))

    // ---- a task that asks before running a command
    r = await call('bg:start', projU, 'create a file and check it', 'm', { cloud: true, sendKey: true, policy: 'ask' })
    const id = r.ok ? r.task.id : ''
    // (the runner is copied and started a moment after bg:start answers)
    const started = r.ok ? await until(async () => (await call('bg:list')).find((t) => t.id === id && t.cloud), 'runner started', 60000) : null
    check('a cloud agent starts on the server', r.ok === true && !!started, JSON.stringify(started && started.cloud) + (r.error || ''))
    check('its task folder is on the server, below ~/.my-ai-ide/cloud/tasks', /^\/home\/tester\/\.my-ai-ide\/cloud\/tasks\//.test(started.cloud.dir), started.cloud.dir)
    const dirN = started.cloud.dir
    check('the runner was copied there once and runs as a detached process', existsN('/home/tester/.my-ai-ide/cloud') && dx('pgrep -f "[r]unner-[0-9a-f]+[.]cjs" | wc -l').stdout.trim() === '1', dx('pgrep -af "[r]unner-[0-9a-f]+[.]cjs"').stdout)
    const waiting = await until(async () => (await call('bg:list')).find((t) => t.id === id && t.status === 'waiting' && t.waitCommand), 'waiting for a command', 60000)
    check('a command waits for permission, and the editor shows it', /cloud-made\.txt/.test(waiting.waitCommand), waiting.waitCommand)
    const wtN = ssh.nativePath(waiting.worktree)
    check('the file the agent made is in its copy on the server, not in the project folder', /made on the server/.test(catN(wtN + '/cloud-made.txt')) && !existsN(projN + '/cloud-made.txt'), wtN)
    handlers['agent:approve']({}, waiting.runId, waiting.waitId, true)
    const done = await until(async () => (await call('bg:list')).find((t) => t.id === id && t.status === 'done' && t.committed && t.files.length), 'task done', 60000)
    check('after the answer the command runs and the task finishes', /Done: cloud task finished/.test(done.summary) && done.steps >= 2, JSON.stringify({ s: done.status, e: done.error, steps: done.steps }))
    check('the changed files are listed', done.files.map((f) => f.status + f.rel).sort().join() === 'Acloud-made.txt,Acloud-ran.txt', JSON.stringify(done.files))
    check('the key was used for the model, and deleted from the server when the task ended', /sk-test-key-123/.test(catN(`/tmp/${API_PORT}.requests.log`)) && !existsN(dirN + '/key'))
    check('the runner process has ended', await until(async () => dx('pgrep -f "[r]unner-[0-9a-f]+[.]cjs" | wc -l').stdout.trim() === '0', 'runner gone', 10000))
    const ap = await call('bg:apply', id)
    check('apply puts the result into the project folder', ap.ok === true && /made on the server/.test(catN(projN + '/cloud-made.txt')), JSON.stringify(ap))
    await call('bg:discard', id)
    check('discarding removes the task folder on the server', !existsN(dirN))
    dx(`cd ${projN} && git rm -qf --ignore-unmatch cloud-made.txt cloud-ran.txt`) // (the applied result, which apply staged, is not part of the next task's starting point)

    // ---- the editor goes away while the task is running
    startFake(4000) // every model answer takes four seconds
    await sleep(1500)
    const env = { ...process.env, CLOUD_TEST_PHASE: 'start', CLOUD_TEST_DIR: shared, CLOUD_TEST_BASE: baseN }
    const first = cp.spawnSync(process.execPath, [__filename], { env, encoding: 'utf-8', timeout: 120000 })
    const idLine = /STARTED (\w+)/.exec(first.stdout || '')
    check('a second task is started by an editor that then ends abruptly', !!idLine, (first.stdout || '') + (first.stderr || '').slice(0, 300))
    const id2 = idLine && idLine[1]
    ssh.disconnect(conn.name)
    const saved = JSON.parse(fs.readFileSync(path.join(shared, 'userData', 'background', 'tasks.json'), 'utf-8')).find((t) => t.id === id2)
    check('it was saved as running, with its place in the event log', !!saved && (saved.status === 'running' || saved.status === 'waiting') && !!saved.cloud, JSON.stringify(saved && { s: saved.status, c: saved.cloud }))
    const logBefore = catN(saved.cloud.dir + '/events.jsonl').split('\n').filter(Boolean).length
    await sleep(10000) // nobody is looking; the agent carries on
    const logWhile = catN(saved.cloud.dir + '/events.jsonl').split('\n').filter(Boolean).length
    check('the agent went on working on the server while no editor was running', logWhile > logBefore, `${logBefore} -> ${logWhile} events`)
    // The editor is started again: logs in, the task list is read from disk, and the task is picked up.
    const second = cp.spawnSync(process.execPath, [__filename], { env: { ...env, CLOUD_TEST_PHASE: 'resume', CLOUD_TEST_ID: id2 }, encoding: 'utf-8', timeout: 180000 })
    const shown = /SHOWN (.*)/.exec(second.stdout || '')
    const back = shown && JSON.parse(shown[1])
    check('the restarted editor shows the task and reconnects to it', !!back && !!back.cloud, (shown && shown[1]) || (second.stdout || '') + (second.stderr || '').slice(0, 300))
    const finLine = /FINISHED (.*)/.exec(second.stdout || '')
    if (!finLine) throw new Error('the restarted editor did not see the task finish: ' + (second.stdout || '').split(String.fromCharCode(10)).filter((l) => /LAST/.test(l)).join(' ') + (second.stderr || '').slice(0, 400))
    const fin = JSON.parse(finLine[1])
    check('it finishes and its result is there (nothing it did while away is lost or repeated)', fin.files.map((f) => f.status + f.rel).sort().join() === 'Acloud-made.txt,Acloud-ran.txt' && fin.steps >= 2 && fin.steps <= 3, JSON.stringify({ steps: fin.steps, files: fin.files }))

    // ---- stop
    await connect() // (this process dropped its connection above, to leave the first task to the second editor)
    startFake(5000)
    await sleep(1500)
    r = await call('bg:start', projU, 'a task that is stopped', 'm', { cloud: true, sendKey: true, policy: 'auto' })
    if (!r.ok) throw new Error('could not start the third task: ' + r.error)
    const run3 = await until(async () => (await call('bg:list')).find((t) => t.id === r.task.id && t.cloud), 'runner 3 started', 60000)
    await until(async () => /"state":"running"/.test(catN(run3.cloud.dir + '/status.json')), 'running', 30000)
    await call('bg:stop', r.task.id)
    const stopped = await until(async () => (await call('bg:list')).find((t) => t.id === r.task.id && t.status !== 'running' && t.status !== 'waiting'), 'stopped', 60000)
    check('Stop ends the agent on the server', stopped.status === 'stopped' && /"state":"stopped"/.test(catN(run3.cloud.dir + '/status.json')), JSON.stringify({ s: stopped.status, e: stopped.error }))
    await call('bg:discard', r.task.id)
  } finally {
    if (process.env.CLOUD_TEST_KEEP) { console.log('kept ' + baseN); process.exit(1) } // (for looking at the server afterwards)
    dx('pkill -f fake-anthropic.cjs; pkill -f "[r]unner-[0-9a-f]+[.]cjs"; rm -rf ' + baseN + ' /tmp/fake-anthropic.cjs /tmp/' + API_PORT + '.requests.log /home/tester/.my-ai-ide/cloud/tasks; true')
    ssh.disconnectAll()
    try { fs.rmSync(shared, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); try { dx('pkill -f fake-anthropic.cjs; pkill -f "[r]unner-[0-9a-f]+[.]cjs"; true') } catch { /* */ } process.exit(1) })
