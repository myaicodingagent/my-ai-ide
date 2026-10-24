// The debugger for programs on another computer, over SSH: the real debugger and SSH modules run against the test SSH
// server (tests/sshserver.cjs), which runs commands with bash on this machine and forwards ports. The project lives at
// a path written the way a Windows server writes it (/C:/Users/...), so a path on the "server" is also a real path here.
// `npm run test:ssh-debug`: needs node; Python checks need `py -3` with debugpy, Go checks need go and dlv. Does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const handlers = {}
const events = []
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-debug-')))
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f }, on: () => {} },
  shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') }
}
const root = path.join(__dirname, '..')
const stub = path.join(root, 'node_modules', '.cache', 'ssh-debug-stub.cjs'), bundle = path.join(root, 'node_modules', '.cache', 'ssh-debug-bundle.cjs')
const entry = path.join(root, 'node_modules', '.cache', 'ssh-debug-entry.ts')
fs.mkdirSync(path.dirname(stub), { recursive: true })
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
const posix = (p) => p.split(path.sep).join('/')
fs.writeFileSync(entry, `export * as ssh from ${JSON.stringify(posix(path.join(root, 'src/main/sshfs.ts')))}\nexport * as dbg from ${JSON.stringify(posix(path.join(root, 'src/main/debugger.ts')))}\n`)
require('./bundle-main.cjs').bundleSync({ entry, out: bundle, stub, external: ['ssh2', 'ws', 'esbuild'] })
const { ssh, dbg } = require(bundle)
ssh.registerSshHandlers()
dbg.registerDebugHandlers(() => ({ webContents: { send: (_ch, e) => events.push(e) } }))
const call = (n, ...a) => handlers[n]({}, ...a)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitEvent(pred, what, ms = 25000) {
  const t0 = Date.now()
  for (;;) {
    const i = events.findIndex(pred)
    if (i >= 0) return events.splice(i, 1)[0]
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for: ' + what + ' (have: ' + events.map((e) => e.type).join(',') + ')')
    await sleep(40)
  }
}
const paused = (what) => waitEvent((e) => e.type === 'paused', what)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
async function waitDead(pid, ms = 8000) { const t0 = Date.now(); while (alive(pid) && Date.now() - t0 < ms) await sleep(100); return !alive(pid) }
const server = require('./sshserver.cjs')(path.join(tmp, 'server-root'))

;(async () => {
  fs.mkdirSync(path.join(tmp, 'server-root'), { recursive: true })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const addr = `tester@127.0.0.1:${server.address().port}`
  let c = await ssh.connect(addr, { password: 'secret' })
  if (c.need === 'trust') c = await ssh.connect(addr, { password: 'secret', trust: c.fingerprint })
  check('connects to the test server', c.ok === true, JSON.stringify(c))
  const unc = (p) => ssh.remoteUnc(c.name, '/' + posix(p))
  const proj = path.join(tmp, 'proj with space'); fs.mkdirSync(proj, { recursive: true })

  // --- paths a program on a Windows-style server reports
  const rx = new RegExp(dbg.urlRegexForNative('C:/Users/A B/x.js'))
  check('a file URL from the other computer is matched, whatever the drive-letter case', rx.test('file:///C:/Users/A%20B/x.js') && rx.test('file:///c:/Users/A%20B/x.js') && !rx.test('file:///C:/Users/A%20B/x.json'))
  check('and one from a Linux server', new RegExp(dbg.urlRegexForNative('/home/me/my app/x.js')).test('file:///home/me/my%20app/x.js'))
  check('native paths: /C:/x is C:/x, /home/x stays', ssh.nativePath(ssh.remoteUnc('h', '/C:/x/y.js')) === 'C:/x/y.js' && ssh.nativePath(ssh.remoteUnc('h', '/home/x')) === '/home/x')
  check('and back to the editor\'s address', ssh.fromNativePath('h', 'C:\\x\\y.js') === ssh.remoteUnc('h', '/C:/x/y.js') && ssh.fromNativePath('h', '/home/x') === ssh.remoteUnc('h', '/home/x'))

  // --- Node
  const prog = path.join(proj, 'prog.js')
  fs.writeFileSync(prog, ['function add(a, b) {', '  const sum = a + b', '  return sum', '}', 'const pidFile = process.argv[2]', 'if (pidFile) require("fs").writeFileSync(pidFile, String(process.pid))', 'const r = add(2, 3)', 'console.log("remote result", r, process.env.MYVAR)', 'if (process.argv[3]) setInterval(() => {}, 1000)', ''].join('\n'))
  const progU = unc(prog)
  let r = await call('dbg:start', { file: unc(path.join(proj, 'missing.js')), breakpoints: {} })
  check('a file that does not exist is refused', r.ok === false && /does not exist/.test(r.error), JSON.stringify(r))
  r = await call('dbg:start', { file: unc(path.join(proj, 'x.ts')), breakpoints: {} })
  check('TypeScript on the other computer says it is not supported yet', r.ok === false && /TypeScript/.test(r.error), JSON.stringify(r))
  const localBp = path.join(tmp, 'local.js')
  r = await call('dbg:start', { file: progU, env: { MYVAR: 'hello' }, breakpoints: { [progU]: [{ line: 2 }], [localBp]: [{ line: 1 }] } })
  check('a program on the other computer starts under the debugger', r.ok === true, JSON.stringify(r))
  let p = await paused('remote breakpoint')
  check('it stops at the breakpoint, in the editor\'s address of the file', p.reason === 'breakpoint' && p.frames[0].name === 'add' && p.frames[0].line === 2 && p.frames[0].file === progU, JSON.stringify(p.frames[0]))
  let sc = await call('dbg:scopes', 0)
  check('variables can be read', sc.flatMap((s) => s.vars).some((v) => v.name === 'a' && v.value === '2'), JSON.stringify(sc).slice(0, 200))
  let ev = await call('dbg:eval', 'a + b', 0)
  check('expressions are evaluated there', ev.ok && ev.value.value === '5', JSON.stringify(ev))
  await call('dbg:stepOver')
  p = await paused('remote step')
  check('stepping works', p.frames[0].line === 3 && p.frames[0].file === progU, JSON.stringify([p.frames[0].line]))
  await call('dbg:setBreakpoints', progU, [])
  await call('dbg:continue')
  const end = await waitEvent((e) => e.type === 'exited', 'remote exit')
  const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
  check('it finishes, with its output and the environment variable that was given', end.code === 0 && /remote result 5 hello/.test(out), JSON.stringify([end.code, out]))
  events.length = 0

  // Stop ends the program on the other computer
  const pidFile = path.join(tmp, 'node.pid')
  r = await call('dbg:start', { file: progU, args: [pidFile, 'wait'], breakpoints: { [progU]: [{ line: 8 }] } })
  p = await paused('remote stop test')
  const remotePid = Number(fs.readFileSync(pidFile, 'utf-8'))
  check('(the program is running on this machine, as its server)', alive(remotePid))
  await call('dbg:stop')
  await waitEvent((e) => e.type === 'exited', 'remote stopped')
  check('Stop ends the program on the other computer', await waitDead(remotePid), 'pid ' + remotePid)
  events.length = 0

  // --- Python
  const havePy = cp.spawnSync('py', ['-3', '-c', 'import debugpy'], { windowsHide: true }).status === 0
  const pyDir = (cp.spawnSync('py', ['-3', '-c', 'import sys,os;print(os.path.dirname(sys.executable))'], { encoding: 'utf-8', windowsHide: true }).stdout || '').trim()
  if (!havePy) console.log('SKIP  Python over SSH (py -3 with debugpy not found)')
  else {
    const py = path.join(proj, 'prog.py')
    fs.writeFileSync(py, ['def add(a, b):', '    s = a + b', '    return s', 'import os', 'print("py remote", add(2, 3), os.environ.get("MYVAR"))', ''].join('\n'))
    const pyU = unc(py)
    // The "server" finds Python through its PATH, like a real one would.
    const env = { MYVAR: 'hi', PATH: posix(pyDir).replace(/^([A-Za-z]):/, '/$1') + ':/usr/bin:/bin:/mingw64/bin' }
    r = await call('dbg:start', { file: pyU, env, breakpoints: { [pyU]: [{ line: 2 }] } })
    check('Python: a program on the other computer starts under debugpy', r.ok === true, JSON.stringify(r))
    p = r.ok ? await paused('py remote breakpoint') : null
    check('Python: it stops at the breakpoint in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && p.frames[0].name === 'add' && p.frames[0].line === 2 && p.frames[0].file === pyU, JSON.stringify(p && p.frames[0]))
    ev = await call('dbg:eval', 'a + b', 0)
    check('Python: expressions are evaluated there', ev.ok && ev.value.value === '5', JSON.stringify(ev))
    await call('dbg:continue')
    const pend = await waitEvent((e) => e.type === 'exited', 'py remote exit')
    const pout = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('Python: it finishes and its output arrives', pend.code === 0 && /py remote 5 hi/.test(pout), JSON.stringify([pend.code, pout]))
    events.length = 0
    r = await call('dbg:start', { file: pyU, env: { PATH: '/usr/bin:/bin' }, breakpoints: {} })
    check('Python: without Python on the other computer there is a clear error', r.ok === false && /Python/.test(r.error), JSON.stringify(r))
    events.length = 0
  }

  // --- Go
  const haveGo = cp.spawnSync('go', ['version'], { windowsHide: true }).status === 0 && cp.spawnSync('dlv', ['version'], { windowsHide: true }).status === 0
  if (!haveGo) console.log('SKIP  Go over SSH (go or dlv not found)')
  else {
    const gd = path.join(proj, 'gopkg'); fs.mkdirSync(gd, { recursive: true })
    fs.writeFileSync(path.join(gd, 'go.mod'), 'module gopkg\n\ngo 1.20\n')
    const gf = path.join(gd, 'main.go')
    fs.writeFileSync(gf, ['package main', '', 'import "fmt"', '', 'func add(a, b int) int {', '\ts := a + b', '\treturn s', '}', '', 'func main() {', '\tfmt.Println("go remote", add(2, 3))', '}', ''].join('\n'))
    const gU = unc(gf)
    r = await call('dbg:start', { file: gU, breakpoints: { [gU]: [{ line: 6 }] } })
    check('Go: a program on the other computer starts under Delve', r.ok === true, JSON.stringify(r))
    p = r.ok ? await paused('go remote breakpoint') : null
    check('Go: it stops at the breakpoint in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && /add/.test(p.frames[0].name) && p.frames[0].line === 6 && p.frames[0].file === gU, JSON.stringify(p && p.frames[0]))
    ev = await call('dbg:eval', 'a + b', 0)
    check('Go: expressions are evaluated there', ev.ok && ev.value.value === '5', JSON.stringify(ev))
    await call('dbg:setBreakpoints', gU, [])
    await call('dbg:continue')
    const gend = await waitEvent((e) => e.type === 'exited', 'go remote exit')
    const gout = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('Go: it finishes and its output arrives', gend.code === 0 && /go remote 5/.test(gout), JSON.stringify([gend.code, gout]))
    events.length = 0
  }

  // --- the connection is gone
  ssh.disconnect(c.name)
  r = await call('dbg:start', { file: progU, breakpoints: {} })
  check('without a connection there is a clear error', r.ok === false && /Not connected|connect/i.test(r.error), JSON.stringify(r))

  await sleep(500)
  server.close()
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* a process may still be closing; it is only a temp folder */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); try { server.close() } catch { /* */ } process.exit(1) })
