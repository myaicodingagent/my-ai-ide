// The debugger for programs inside a WSL distribution: the real debugger module runs against a real distribution (default
// Ubuntu-24.04; set WSL_TEST_DISTRO). The program, Node / debugpy / Delve, runs inside it; the project folder is its
// \\wsl.localhost\<distro>\... address. `npm run test:wsl-debug`: skipped without the distribution; Node needs `node`, Python
// `python3-debugpy`, Go `golang-go` and `delve` installed in it. Does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const distro = process.env.WSL_TEST_DISTRO || 'Ubuntu-24.04'
const wsl = (script) => cp.spawnSync('wsl.exe', ['-d', distro, '--user', 'root', '--exec', 'sh', '-c', script], { encoding: 'utf-8', windowsHide: true })
if (wsl('echo ok').stdout.trim() !== 'ok') { console.log('SKIP  no WSL distribution ' + distro); process.exit(0) }
const has = (cmd) => wsl('command -v ' + cmd).status === 0

const handlers = {}
const events = []
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-debug-')))
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f }, on: () => {} },
  shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') }
}
const root = path.join(__dirname, '..')
const stub = path.join(root, 'node_modules', '.cache', 'wsl-debug-stub.cjs'), bundle = path.join(root, 'node_modules', '.cache', 'wsl-debug-bundle.cjs')
const entry = path.join(root, 'node_modules', '.cache', 'wsl-debug-entry.ts')
fs.mkdirSync(path.dirname(stub), { recursive: true })
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
const posix = (p) => p.split(path.sep).join('/')
fs.writeFileSync(entry, `export * as dbg from ${JSON.stringify(posix(path.join(root, 'src/main/debugger.ts')))}\nexport * as host from ${JSON.stringify(posix(path.join(root, 'src/main/hostenv.ts')))}\n`)
require('./bundle-main.cjs').bundleSync({ entry, out: bundle, stub, external: ['ssh2', 'ws', 'esbuild'] })
const { dbg, host } = require(bundle)
dbg.registerDebugHandlers(() => ({ webContents: { send: (_ch, e) => events.push(e) } }))
const call = (n, ...a) => handlers[n]({}, ...a)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitEvent(pred, what, ms = 40000) {
  const t0 = Date.now()
  for (;;) {
    const i = events.findIndex(pred)
    if (i >= 0) return events.splice(i, 1)[0]
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for: ' + what + ' (have: ' + events.map((e) => e.type).join(',') + ')')
    await sleep(40)
  }
}
const paused = (what) => waitEvent((e) => e.type === 'paused', what)
const aliveIn = (pid) => wsl(`kill -0 ${pid} 2>/dev/null`).status === 0
async function waitDead(pid, ms = 10000) { const t0 = Date.now(); while (aliveIn(pid) && Date.now() - t0 < ms) await sleep(200); return !aliveIn(pid) }

;(async () => {
  const dir = '/root/wsldbg-' + process.pid
  wsl(`rm -rf ${dir}; mkdir -p "${dir}/proj with space"`)
  const unc = (p) => host.fromNativePath('wsl:' + distro, p)
  const projN = dir + '/proj with space'
  const put = (name, text) => fs.writeFileSync(unc(projN + '/' + name), text)

  // --- paths
  check('a WSL address is recognised and translated both ways', host.isRemotePath(unc(projN)) && host.nativePath(unc(projN + '/a.js')) === projN + '/a.js' && host.parseRemote(unc(projN))?.name === 'wsl:' + distro, unc(projN))

  // --- Node
  if (!has('node')) console.log('SKIP  Node in WSL (node is not installed in ' + distro + ')')
  else {
    put('prog.js', ['function add(a, b) {', '  const sum = a + b', '  return sum', '}', 'const pidFile = process.argv[2]', 'if (pidFile) require("fs").writeFileSync(pidFile, String(process.pid))', 'const r = add(2, 3)', 'console.log("wsl result", r, process.env.MYVAR, process.platform)', 'if (pidFile) setInterval(() => {}, 1000)', ''].join('\n'))
    const progU = unc(projN + '/prog.js')
    let r = await call('dbg:start', { file: unc(projN + '/missing.js'), breakpoints: {} })
    check('a file that does not exist is refused', r.ok === false && /does not exist/.test(r.error), JSON.stringify(r))
    r = await call('dbg:start', { file: progU, env: { MYVAR: 'hello' }, breakpoints: { [progU]: [{ line: 2 }] } })
    check('Node: a program in the distribution starts under the debugger', r.ok === true, JSON.stringify(r))
    let p = await paused('wsl breakpoint')
    check('Node: it stops at the breakpoint, in the editor\'s address of the file', p.reason === 'breakpoint' && p.frames[0].name === 'add' && p.frames[0].line === 2 && p.frames[0].file === progU, JSON.stringify(p.frames[0]))
    const sc = await call('dbg:scopes', 0)
    check('Node: variables can be read', sc.flatMap((s) => s.vars).some((v) => v.name === 'a' && v.value === '2'), JSON.stringify(sc).slice(0, 200))
    const ev = await call('dbg:eval', 'a + b', 0)
    check('Node: expressions are evaluated there', ev.ok && ev.value.value === '5', JSON.stringify(ev))
    await call('dbg:stepOver')
    p = await paused('wsl step')
    check('Node: stepping works', p.frames[0].line === 3 && p.frames[0].file === progU, JSON.stringify([p.frames[0].line]))
    await call('dbg:setBreakpoints', progU, [])
    await call('dbg:continue')
    const end = await waitEvent((e) => e.type === 'exited', 'wsl exit')
    const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('Node: it finishes, with its output, the environment variable and Linux as its platform', end.code === 0 && /wsl result 5 hello linux/.test(out), JSON.stringify([end.code, out]))
    events.length = 0
    const pidFile = dir + '/node.pid'
    r = await call('dbg:start', { file: progU, args: [pidFile, 'wait'], breakpoints: { [progU]: [{ line: 8 }] } })
    p = await paused('wsl stop test')
    const pid = Number(wsl(`cat ${pidFile}`).stdout.trim())
    check('(the program is running inside the distribution)', pid > 0 && aliveIn(pid), 'pid ' + pid)
    await call('dbg:stop')
    await waitEvent((e) => e.type === 'exited', 'wsl stopped')
    check('Node: Stop ends the program inside the distribution', await waitDead(pid), 'pid ' + pid)
    events.length = 0
  }

  // --- Python
  if (wsl('python3 -c "import debugpy"').status !== 0) console.log('SKIP  Python in WSL (python3-debugpy is not installed in ' + distro + ')')
  else {
    put('prog.py', ['def add(a, b):', '    s = a + b', '    return s', 'import os', 'print("py wsl", add(2, 3), os.environ.get("MYVAR"))', ''].join('\n'))
    const pyU = unc(projN + '/prog.py')
    let r = await call('dbg:start', { file: pyU, env: { MYVAR: 'hi' }, breakpoints: { [pyU]: [{ line: 2 }] } })
    check('Python: a program in the distribution starts under debugpy', r.ok === true, JSON.stringify(r))
    const p = r.ok ? await paused('py wsl breakpoint') : null
    check('Python: it stops at the breakpoint in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && p.frames[0].name === 'add' && p.frames[0].line === 2 && p.frames[0].file === pyU, JSON.stringify(p && p.frames[0]))
    const ev = await call('dbg:eval', 'a + b', 0)
    check('Python: expressions are evaluated there', ev.ok && ev.value.value === '5', JSON.stringify(ev))
    await call('dbg:continue')
    const pend = await waitEvent((e) => e.type === 'exited', 'py wsl exit')
    const pout = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('Python: it finishes and its output arrives', pend.code === 0 && /py wsl 5 hi/.test(pout), JSON.stringify([pend.code, pout]))
    events.length = 0
  }

  // --- Go
  if (!has('dlv') || !has('go')) console.log('SKIP  Go in WSL (go or delve is not installed in ' + distro + ')')
  else {
    wsl(`mkdir -p "${projN}/gopkg"`)
    put('gopkg/go.mod', 'module gopkg\n\ngo 1.20\n')
    put('gopkg/main.go', ['package main', '', 'import "fmt"', '', 'func add(a, b int) int {', '\ts := a + b', '\treturn s', '}', '', 'func main() {', '\tfmt.Println("go wsl", add(2, 3))', '}', ''].join('\n'))
    const gU = unc(projN + '/gopkg/main.go')
    const r = await call('dbg:start', { file: gU, breakpoints: { [gU]: [{ line: 6 }] } })
    check('Go: a program in the distribution starts under Delve', r.ok === true, JSON.stringify(r))
    const p = r.ok ? await paused('go wsl breakpoint') : null
    check('Go: it stops at the breakpoint in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && /add/.test(p.frames[0].name) && p.frames[0].line === 6 && p.frames[0].file === gU, JSON.stringify(p && p.frames[0]))
    const ev = await call('dbg:eval', 'a + b', 0)
    check('Go: expressions are evaluated there', ev.ok && ev.value.value === '5', JSON.stringify(ev))
    await call('dbg:setBreakpoints', gU, [])
    await call('dbg:continue')
    const gend = await waitEvent((e) => e.type === 'exited', 'go wsl exit')
    const gout = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('Go: it finishes and its output arrives', gend.code === 0 && /go wsl 5/.test(gout), JSON.stringify([gend.code, gout]))
    events.length = 0
  }

  wsl(`rm -rf ${dir}`)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); process.exit(1) })
