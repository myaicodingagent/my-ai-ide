// A cloud agent started from the PACKAGED app (the runner is read from inside app.asar): the app is started with a fake model API
// address, logs in to the Docker SSH server of tests/ssh-linux.cjs, and runs a cloud task to its end through the same calls the
// Agents tab makes. `npm run test:cloud-packaged`: skipped unless that server answers on 127.0.0.1:2222 (with node + git) and the packaged
// app exists (MY_AI_IDE_EXE, or release\win-unpacked). Needs `npm run build` + a packaged app made after it.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }
const run = (cmd, args, opts = {}) => cp.spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true, ...opts })
const container = process.env.SSH_TEST_CONTAINER || 'sshtest'
const dx = (script) => run('docker', ['exec', '-u', 'tester', container, 'bash', '-c', script], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
const EXE = process.env.MY_AI_IDE_EXE || path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
const API_PORT = 8799, CDP_PORT = 9341

;(async () => {
  const up = await new Promise((res) => { const s = net.connect(2222, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
  if (!up || run('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0 || dx('command -v node && command -v git').status !== 0) { console.log('SKIP  needs the Linux SSH container (with node and git) on 127.0.0.1:2222'); process.exit(0) }
  if (!fs.existsSync(EXE)) { console.log('SKIP  no packaged app at ' + EXE); process.exit(0) }
  const base = '/home/tester/cloudpk-' + process.pid
  dx(`rm -rf ${base} && mkdir -p ${base}/proj && cd ${base}/proj && git init -q && printf 'hello\\n' > hello.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm first`)
  run('docker', ['cp', path.join(__dirname, 'fake-anthropic.cjs'), `${container}:/tmp/fake-anthropic.cjs`], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  dx('chmod a+r /tmp/fake-anthropic.cjs; pkill -f fake-anthropic.cjs; true')
  cp.spawn('docker', ['exec', '-d', '-u', 'tester', container, 'bash', '-c', `cd /tmp && rm -f ${API_PORT}.requests.log && exec node fake-anthropic.cjs ${API_PORT} 0`], { stdio: 'ignore', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  await sleep(1500)
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-pk-'))
  const env = { ...process.env, ANTHROPIC_API_KEY: 'sk-test-key-123', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + API_PORT }
  delete env.ELECTRON_RUN_AS_NODE
  const app = cp.spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${data}`], { env, stdio: 'ignore', windowsHide: true })
  const stopApp = () => { try { cp.execSync('taskkill /F /T /PID ' + app.pid, { stdio: 'ignore' }) } catch { /* gone */ } }
  try {
    let list
    for (let i = 0; i < 60; i++) { list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => null); if (list && list.some((t) => t.type === 'page')) break; await sleep(1000) }
    if (!list) throw new Error('the app did not start')
    await sleep(4000)
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((r) => ws.on('open', r))
    let id = 0; const pend = {}
    ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m) })
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 60000); ws.send(JSON.stringify({ id: i, method, params })) })
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
    const first = JSON.parse(await ev(`window.api.sshConnect('tester@127.0.0.1:2222', { password: 'secret' }).then((r) => JSON.stringify(r))`))
    const conn = first.need === 'trust' ? JSON.parse(await ev(`window.api.sshConnect('tester@127.0.0.1:2222', { password: 'secret', trust: ${JSON.stringify(first.fingerprint)} }).then((r) => JSON.stringify(r))`)) : first
    check('the packaged app logs in to the server', conn.ok === true, JSON.stringify(conn))
    const unc = String.fromCharCode(92, 92) + 'ssh.' + conn.name + base.split('/').join(String.fromCharCode(92)) + String.fromCharCode(92) + 'proj'
    const r = JSON.parse(await ev(`window.api.bgStart(${JSON.stringify(unc)}, 'create a file and check it', 'm', { cloud: true, sendKey: true, policy: 'auto' }).then((r) => JSON.stringify(r))`))
    check('a cloud agent is started from the packaged app (the runner comes out of app.asar)', r.ok === true, JSON.stringify(r).slice(0, 200))
    const t0 = Date.now()
    let task = null
    while (Date.now() - t0 < 90000) {
      task = JSON.parse(await ev(`window.api.bgList().then((l) => JSON.stringify(l.find((t) => t.id === ${JSON.stringify(r.task && r.task.id)}) || null))`))
      if (task && task.status === 'done' && task.committed && task.files.length) break
      if (task && task.status === 'failed') break
      await sleep(1000)
    }
    check('it runs on the server and finishes', !!task && task.status === 'done' && /Done: cloud task finished/.test(task.summary), JSON.stringify(task && { s: task.status, e: task.error, steps: task.steps }))
    check('with the files it made listed', !!task && task.files.map((f) => f.status + f.rel).sort().join() === 'Acloud-made.txt,Acloud-ran.txt', JSON.stringify(task && task.files))
    const api = dx(`cat /tmp/${API_PORT}.requests.log`).stdout
    check('the model was called from the server with the key', /sk-test-key-123/.test(api) && api.split('\n').filter(Boolean).length >= 3, api.slice(0, 200))
  } finally {
    stopApp()
    dx(`pkill -f fake-anthropic.cjs; pkill -f "[r]unner-[0-9a-f]+[.]cjs"; rm -rf ${base} /tmp/fake-anthropic.cjs /tmp/${API_PORT}.requests.log /home/tester/.my-ai-ide/cloud/tasks; true`)
    await sleep(500)
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); process.exit(1) })
