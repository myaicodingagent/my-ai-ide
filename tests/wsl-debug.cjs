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

  // --- TypeScript (bundled by the editor into the distribution's /tmp, run by the node there, shown at its place in the .ts files)
  if (has('node')) {
    wsl(`mkdir -p "${projN}/tsapp/node_modules/tinydep"`)
    put('tsapp/node_modules/tinydep/index.js', 'module.exports = (s) => "**" + s + "**"\n')
    put('tsapp/helper.ts', ['export function triple(n: number): number {', '  const t = n * 3', '  return t', '}', ''].join('\n'))
    put('tsapp/main.ts', ['import { triple } from "./helper"', 'const wrap = require("tinydep")', 'const x: number = triple(2)', 'console.log("ts wsl", wrap(String(x)), process.env.MYVAR)', ''].join('\n'))
    const mainU = unc(projN + '/tsapp/main.ts'), helperU = unc(projN + '/tsapp/helper.ts')
    const r = await call('dbg:start', { file: mainU, env: { MYVAR: 'tsenv' }, breakpoints: { [helperU]: [{ line: 2 }] } })
    check('TypeScript: a program in the distribution is bundled and started under the debugger', r.ok === true, JSON.stringify(r))
    let p = r.ok ? await paused('ts wsl breakpoint') : null
    check('TypeScript: it stops at the breakpoint in the .ts file, in the editor\'s address of it', !!p && p.reason === 'breakpoint' && p.frames[0].name === 'triple' && p.frames[0].line === 2 && p.frames[0].file === helperU, JSON.stringify(p && p.frames[0]))
    await call('dbg:stepOver')
    p = await paused('ts wsl step')
    check('TypeScript: stepping follows the source', p.frames[0].line === 3 && p.frames[0].file === helperU, JSON.stringify(p.frames[0]))
    await call('dbg:setBreakpoints', helperU, [])
    await call('dbg:continue')
    const end = await waitEvent((e) => e.type === 'exited', 'ts wsl exit')
    const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('TypeScript: it ran with the package it imports and finished', end.code === 0 && /ts wsl \*\*6\*\* tsenv/.test(out), JSON.stringify([end.code, out]))
    events.length = 0
    await sleep(800)
    check('TypeScript: the bundle in the distribution is removed afterwards', wsl('ls -d /tmp/ai-ide-debug-* 2>/dev/null | wc -l').stdout.trim() === '0', wsl('ls -d /tmp/ai-ide-debug-*').stdout)
  }

  // --- C and C++ (compiled in the distribution, debugged by its lldb-dap)
  if (!has('lldb-dap-18 || command -v lldb-dap') || !has('gcc')) console.log('SKIP  C/C++ in WSL (gcc or lldb are not installed in ' + distro + ')')
  else {
    put('prog.c', ['#include <stdio.h>', '#include <stdlib.h>', 'int add(int a, int b) {', '  int s = a + b;', '  return s;', '}', 'int main(void) {', '  int r = add(2, 3);', '  printf("c wsl %d %s\\n", r, getenv("MYVAR"));', '  return 0;', '}', ''].join('\n'))
    const cU = unc(projN + '/prog.c')
    const r = await call('dbg:start', { file: cU, env: { MYVAR: 'cenv' }, breakpoints: { [cU]: [{ line: 4 }] } })
    check('C: a program is compiled in the distribution and starts under lldb-dap', r.ok === true, JSON.stringify(r))
    const p = r.ok ? await paused('c wsl breakpoint') : null
    check('C: it stops at the breakpoint in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && p.frames[0].name === 'add' && p.frames[0].line === 4 && p.frames[0].file === cU, JSON.stringify(p && p.frames[0]))
    const ev = await call('dbg:eval', 'a + b', 0)
    check('C: expressions are evaluated there', ev.ok && String(ev.value.value).includes('5'), JSON.stringify(ev))
    await call('dbg:setBreakpoints', cU, [])
    await call('dbg:continue')
    const end = await waitEvent((e) => e.type === 'exited', 'c wsl exit')
    const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('C: it finishes and its output arrives, with the environment variable', end.code === 0 && /c wsl 5 cenv/.test(out), JSON.stringify([end.code, out]))
    events.length = 0
    put('bad.c', 'int main(void) { return undefined_thing; }\n')
    const bad = await call('dbg:start', { file: unc(projN + '/bad.c'), breakpoints: {} })
    check('C: a compile error is reported readably', bad.ok === false && /did not compile/.test(bad.error) && /undefined_thing/.test(bad.error), JSON.stringify(bad))
  }

  // --- Java (compiled in the distribution, debugged by the editor's own adapter running there)
  if (!has('javac')) console.log('SKIP  Java in WSL (no JDK in ' + distro + ')')
  else {
    wsl(`mkdir -p "${projN}/jv/demo"`)
    put('jv/demo/Main.java', ['package demo;', '', 'public class Main {', '  static int add(int a, int b) {', '    int s = a + b;', '    return s;', '  }', '  public static void main(String[] args) {', '    int r = add(2, 3);', '    System.out.println("java wsl " + r + " " + System.getenv("MYVAR"));', '  }', '}', ''].join('\n'))
    const jU = unc(projN + '/jv/demo/Main.java')
    const r = await call('dbg:start', { file: jU, env: { MYVAR: 'jenv' }, breakpoints: { [jU]: [{ line: 5 }] } })
    check('Java: a program is compiled in the distribution and starts under the editor\'s adapter', r.ok === true, JSON.stringify(r))
    const p = r.ok ? await paused('java wsl breakpoint') : null
    check('Java: it stops at the breakpoint in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && /add/.test(p.frames[0].name) && p.frames[0].line === 5 && p.frames[0].file === jU, JSON.stringify(p && p.frames[0]))
    const ev = await call('dbg:eval', 'a + b', 0)
    check('Java: expressions are evaluated there', ev.ok && String(ev.value.value).includes('5'), JSON.stringify(ev))
    await call('dbg:setBreakpoints', jU, [])
    await call('dbg:continue')
    const end = await waitEvent((e) => e.type === 'exited', 'java wsl exit')
    const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('Java: it finishes and its output arrives, with the environment variable', end.code === 0 && /java wsl 5 jenv/.test(out), JSON.stringify([end.code, out]))
    events.length = 0
  }

  // --- C# (built with the distribution's dotnet, debugged by netcoredbg installed there)
  if (!has('dotnet') || wsl('test -x "$HOME/.local/share/my-ai-ide/netcoredbg/netcoredbg" || command -v netcoredbg').status !== 0) console.log('SKIP  C# in WSL (dotnet or netcoredbg is not installed in ' + distro + ')')
  else {
    wsl(`mkdir -p "${projN}/cs"`)
    put('cs/app.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>\n')
    put('cs/Program.cs', ['int Add(int a, int b)', '{', '    int s = a + b;', '    return s;', '}', 'var r = Add(2, 3);', 'Console.WriteLine("cs wsl " + r + " " + Environment.GetEnvironmentVariable("MYVAR"));', ''].join('\n'))
    const csU = unc(projN + '/cs/Program.cs')
    const r = await call('dbg:start', { file: csU, env: { MYVAR: 'csenv' }, breakpoints: { [csU]: [{ line: 3 }] } })
    check('C#: a project is built in the distribution and starts under netcoredbg', r.ok === true, JSON.stringify(r))
    const p = r.ok ? await paused('cs wsl breakpoint') : null
    check('C#: it stops at the breakpoint in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && p.frames[0].line === 3 && p.frames[0].file === csU, JSON.stringify(p && p.frames[0]))
    const ev = await call('dbg:eval', 'a + b', 0)
    check('C#: expressions are evaluated there', ev.ok && String(ev.value.value).includes('5'), JSON.stringify(ev))
    await call('dbg:setBreakpoints', csU, [])
    await call('dbg:continue')
    const end = await waitEvent((e) => e.type === 'exited', 'cs wsl exit', 60000)
    const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('C#: it finishes and its output arrives, with the environment variable', end.code === 0 && /cs wsl 5 csenv/.test(out), JSON.stringify([end.code, out]))
    events.length = 0
  }

  // --- attach to programs that are already running in the distribution (the open folder says which machine the port / pid is on)
  const bg = []
  const startBg = (script) => { const c = cp.spawn('wsl.exe', ['-d', distro, '--user', 'root', '--exec', 'sh', '-c', script], { stdio: 'ignore', windowsHide: true }); bg.push(c); return c }
  const pidOf = async (file) => { for (let i = 0; i < 60; i++) { const v = Number(wsl(`cat ${file} 2>/dev/null`).stdout.trim()); if (v > 0) return v; await sleep(200) } return 0 }
  const killIn = (pid) => wsl(`kill ${pid} 2>/dev/null; true`)
  if (has('node')) {
    wsl(`mkdir -p "${projN}"`)
    put('loop.js', ['let count = 0', 'function tick() {', '  count += 1', '  return count', '}', 'setInterval(tick, 200)', ''].join('\n'))
    const loopU = unc(projN + '/loop.js')
    // by port
    startBg(`cd "${projN}" && echo $$ > ${dir}/loop1.pid && exec node --inspect=127.0.0.1:9339 loop.js`)
    const pid1 = await pidOf(dir + '/loop1.pid')
    let r = await call('dbg:attach', { port: 9339, roots: [unc(projN)], breakpoints: { [loopU]: [{ line: 3 }] } })
    check('Node attach: a program already running in the distribution is attached to by port', r.ok === true, JSON.stringify(r))
    let p = r.ok ? await paused('attach port breakpoint') : null
    check('Node attach: it stops at the breakpoint, in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && p.frames[0].name === 'tick' && p.frames[0].file === loopU && p.frames[0].line === 3, JSON.stringify(p && p.frames[0]))
    await call('dbg:setBreakpoints', loopU, [])
    await call('dbg:continue')
    await call('dbg:stop')
    await waitEvent((e) => e.type === 'exited', 'attach port exit')
    check('Node attach: Stop lets go, the program keeps running', aliveIn(pid1))
    killIn(pid1)
    events.length = 0
    // by process id (the program was not started with --inspect)
    startBg(`cd "${projN}" && echo $$ > ${dir}/loop2.pid && exec node loop.js`)
    const pid2 = await pidOf(dir + '/loop2.pid')
    r = await call('dbg:attach', { pid: pid2, roots: [unc(projN)], breakpoints: { [loopU]: [{ line: 3 }] } })
    check('Node attach: a program is attached to by process id (it is asked to open its debugger)', r.ok === true, JSON.stringify(r))
    p = r.ok ? await paused('attach pid breakpoint') : null
    check('Node attach: and stops at the breakpoint there', !!p && p.frames[0].name === 'tick' && p.frames[0].file === loopU, JSON.stringify(p && p.frames[0]))
    await call('dbg:setBreakpoints', loopU, [])
    await call('dbg:continue')
    await call('dbg:stop')
    await waitEvent((e) => e.type === 'exited', 'attach pid exit')
    check('Node attach: the program keeps running after Stop', aliveIn(pid2))
    killIn(pid2)
    events.length = 0
    r = await call('dbg:attach', { port: 9391, roots: [unc(projN)], breakpoints: {} })
    check('Node attach: a port with nothing behind it gives a readable error', r.ok === false && /Nothing|did not become|not reachable|listen/i.test(r.error), JSON.stringify(r))
  }
  if (wsl('python3 -c "import debugpy"').status === 0) {
    put('pyloop.py', ['import time', 'def tick(n):', '    return n + 1', 'n = 0', 'while n < 600:', '    n = tick(n)', '    time.sleep(0.2)', ''].join('\n'))
    const pyU = unc(projN + '/pyloop.py')
    startBg(`cd "${projN}" && echo $$ > ${dir}/py.pid && exec python3 -m debugpy --listen 127.0.0.1:5691 pyloop.py`)
    const pid3 = await pidOf(dir + '/py.pid')
    await sleep(1500)
    const r = await call('dbg:attach', { language: 'python', port: 5691, roots: [unc(projN)], breakpoints: { [pyU]: [{ line: 3 }] } })
    check('Python attach: a program running under debugpy in the distribution is attached to by port', r.ok === true, JSON.stringify(r))
    const p = r.ok ? await paused('py attach breakpoint') : null
    check('Python attach: it stops at the breakpoint in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && p.frames[0].name === 'tick' && p.frames[0].file === pyU, JSON.stringify(p && p.frames[0]))
    await call('dbg:setBreakpoints', pyU, [])
    await call('dbg:continue')
    await call('dbg:stop')
    await waitEvent((e) => e.type === 'exited', 'py attach exit')
    check('Python attach: the program keeps running after Stop', aliveIn(pid3))
    killIn(pid3)
    events.length = 0
  }
  if (has('javac')) {
    wsl(`mkdir -p "${projN}/jloop"`)
    put('jloop/Loop.java', ['public class Loop {', '  static int tick(int n) {', '    return n + 1;', '  }', '  public static void main(String[] a) throws Exception {', '    int n = 0;', '    while (n < 600) { n = tick(n); Thread.sleep(200); }', '  }', '}', ''].join('\n'))
    const lU = unc(projN + '/jloop/Loop.java')
    const built = wsl(`cd "${projN}/jloop" && javac -g Loop.java 2>&1`)
    startBg(`cd "${projN}/jloop" && echo $$ > ${dir}/jl.pid && exec java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5694 Loop`)
    const pidJ = await pidOf(dir + '/jl.pid')
    await sleep(2000)
    const r = await call('dbg:attach', { language: 'java', port: 5694, roots: [unc(projN + '/jloop')], breakpoints: { [lU]: [{ line: 3 }] } })
    check('Java attach: a program started with a JDWP agent in the distribution is attached to by port', r.ok === true, JSON.stringify(r) + built.stdout)
    const p = r.ok ? await paused('java attach breakpoint') : null
    check('Java attach: it stops at the breakpoint in the editor\'s address of the file', !!p && /tick/.test(p.frames[0].name) && p.frames[0].line === 3 && p.frames[0].file === lU, JSON.stringify(p && p.frames[0]))
    await call('dbg:setBreakpoints', lU, [])
    await call('dbg:continue')
    await call('dbg:stop')
    await waitEvent((e) => e.type === 'exited', 'java attach exit')
    check('Java attach: the program keeps running after Stop', aliveIn(pidJ))
    killIn(pidJ)
    events.length = 0
  }
  if (has('gcc') && has('lldb-dap-18 || command -v lldb-dap')) {
    put('cloop.c', ['#include <unistd.h>', 'int tick(int n) {', '  return n + 1;', '}', 'int main(void) {', '  int n = 0;', '  while (n < 600) { n = tick(n); usleep(200000); }', '  return 0;', '}', ''].join('\n'))
    const cU = unc(projN + '/cloop.c')
    wsl(`cd "${projN}" && gcc -g -O0 cloop.c -o cloop`)
    startBg(`cd "${projN}" && echo $$ > ${dir}/cl.pid && exec ./cloop`)
    const pidC = await pidOf(dir + '/cl.pid')
    const r = await call('dbg:attach', { language: 'cpp', pid: pidC, roots: [unc(projN)], breakpoints: { [cU]: [{ line: 3 }] } })
    check('C attach: a running program in the distribution is attached to by process id', r.ok === true, JSON.stringify(r))
    const p = r.ok ? await paused('c attach breakpoint') : null
    check('C attach: it stops at the breakpoint in the editor\'s address of the file', !!p && p.frames[0].name === 'tick' && p.frames[0].line === 3 && p.frames[0].file === cU, JSON.stringify(p && p.frames[0]))
    await call('dbg:setBreakpoints', cU, [])
    await call('dbg:continue')
    await call('dbg:stop')
    await waitEvent((e) => e.type === 'exited', 'c attach exit')
    check('C attach: the program keeps running after Stop', aliveIn(pidC))
    killIn(pidC)
    events.length = 0
  }
  if (has('dlv') && has('go')) {
    wsl(`mkdir -p "${projN}/goloop"`)
    put('goloop/go.mod', 'module goloop\n\ngo 1.20\n')
    put('goloop/main.go', ['package main', '', 'import "time"', '', 'func tick(n int) int {', '\treturn n + 1', '}', '', 'func main() {', '\tn := 0', '\tfor n < 600 {', '\t\tn = tick(n)', '\t\ttime.Sleep(200 * time.Millisecond)', '\t}', '}', ''].join('\n'))
    const gU = unc(projN + '/goloop/main.go')
    const built = wsl(`cd "${projN}/goloop" && go build -gcflags='all=-N -l' -o loop . 2>&1`)
    startBg(`cd "${projN}/goloop" && exec dlv exec ./loop --headless --listen=127.0.0.1:2392 --api-version=2 --accept-multiclient`)
    await sleep(2500)
    const r = await call('dbg:attach', { language: 'go', port: 2392, roots: [unc(projN)], breakpoints: { [gU]: [{ line: 6 }] } })
    check('Go attach: a program under a Delve server in the distribution is attached to by port', r.ok === true, JSON.stringify(r) + built.stdout)
    const p = r.ok ? await paused('go attach breakpoint') : null
    check('Go attach: it stops at the breakpoint in the editor\'s address of the file', !!p && p.reason === 'breakpoint' && /tick/.test(p.frames[0].name) && p.frames[0].file === gU && p.frames[0].line === 6, JSON.stringify(p && p.frames[0]))
    await call('dbg:setBreakpoints', gU, [])
    await call('dbg:continue')
    await call('dbg:stop')
    await waitEvent((e) => e.type === 'exited', 'go attach exit')
    wsl('pkill -f "dlv exec" ; pkill -f goloop/loop; true')
    events.length = 0
  }
  for (const c of bg) try { c.kill() } catch { /* gone */ }

  wsl(`rm -rf ${dir}`)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); process.exit(1) })
