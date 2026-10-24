// The debuggers for compiled languages in the PACKAGED app (the source-based tests do not cover what the build bundles, such as
// the Java adapter): Java, C++ and C# programs are opened, given a breakpoint from the Run menu, started with Run > Start
// Debugging, and must stop in the right function with their variables shown. Needs `npm run dist` first. Each language is
// skipped when its tools are missing (a JDK; lldb-dap and clang from LLVM-MinGW; the .NET SDK and internet for netcoredbg).
// `npm run test:packaged-debug` starts the packaged app itself.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }

const EXE = process.env.MY_AI_IDE_EXE || path.join(__dirname, '..', 'release', 'win-unpacked', 'My AI IDE.exe')
if (!fs.existsSync(EXE)) { console.log('SKIP  no packaged app (run npm run dist)'); process.exit(0) }
const have = (cmd, args) => { try { return cp.spawnSync(cmd, args, { windowsHide: true }).status === 0 } catch { return false } }
const wingetHas = (re) => { try { return fs.readdirSync(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages')).some((n) => re.test(n)) } catch { return false } }

const port = 9791
const tmp = path.join(os.tmpdir(), 'packaged-debug-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true })
const proj = path.join(tmp, 'proj'), data = path.join(tmp, 'data')
fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(data, { recursive: true })
const NL = String.fromCharCode(10)
const w = (rel, lines) => { fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true }); fs.writeFileSync(path.join(proj, rel), lines.join(NL) + NL) }
w('Hello.java', ['public class Hello {', '    static int add(int a, int b) {', '        int sum = a + b;', '        return sum;', '    }', '    public static void main(String[] args) {', '        System.out.println("java " + add(2, 3));', '    }', '}'])
w('main.cpp', ['#include <iostream>', 'int add(int a, int b) {', '    int sum = a + b;', '    return sum;', '}', 'int main() {', '    std::cout << "cpp " << add(2, 3) << std::endl;', '    return 0;', '}'])
w('cs/app.csproj', ['<Project Sdk="Microsoft.NET.Sdk">', '  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>', '</Project>'])
w('cs/Program.cs', ['int Add(int a, int b)', '{', '    int sum = a + b;', '    return sum;', '}', 'Console.WriteLine("cs " + Add(2, 3));'])

const cases = [
  { name: 'Java', file: 'Hello.java', line: 3, frame: /Hello\.add/, ok: have('javac', ['-version']) },
  { name: 'C++', file: 'main.cpp', line: 3, frame: /add/, ok: have('lldb-dap', ['--version']) || wingetHas(/LLVM-MinGW/i) },
  { name: 'C#', file: 'Program.cs', line: 3, frame: /Add/, ok: have('dotnet', ['--version']), install: true }
]

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = cp.spawn(EXE, [`--remote-debugging-port=${port}`, `--user-data-dir=${data}`, proj], { env, stdio: 'ignore', windowsHide: false })
const stopApp = () => { try { cp.execSync('taskkill /F /T /PID ' + app.pid, { stdio: 'ignore' }) } catch { /* gone */ } }

;(async () => {
  let list
  for (let i = 0; i < 40; i++) {
    list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null)
    if (list && list.some((t) => t.type === 'page')) break
    await sleep(1500)
  }
  if (!list) throw new Error('the app did not start')
  await sleep(4000)
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  let id = 0; const pend = {}
  ws.on('message', (d) => { const m = JSON.parse(d); if (pend[m.id]) pend[m.id](m) })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend[i] = res; setTimeout(() => rej(new Error('no answer to ' + method)), 40000); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
  const waitFor = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(400) } }
  const mouse = async (x, y) => { for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 }) }
  const click = async (sel) => { const p = JSON.parse(await ev(`(() => { const e = ${sel}; if (!e) return 'null'; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`)); if (p) await mouse(p.x, p.y); return !!p }
  const key = async (k, vk, mods = 0) => { for (const t of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, key: k, code: k, windowsVirtualKeyCode: vk, modifiers: mods }) }
  const menu = async (top, item, wait = 800) => {
    await click(`document.querySelector('[data-menu="${top}"]')`); await sleep(150)
    if (!(await click(`[...document.querySelectorAll('[data-menu-item]')].find((e) => e.getAttribute('data-menu-item') === ${JSON.stringify(item)})`))) throw new Error('no menu entry ' + top + ' > ' + item)
    await sleep(wait)
  }
  const frames = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-dbg-frame]')].map((f) => f.innerText.replace(/\\s+/g, ' ').trim()))`))
  const openFile = async (name) => {
    await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(300)
    await waitFor(() => ev(`[...document.querySelectorAll('.tree-row')].some((e) => (e.getAttribute('data-tree-path') || '').endsWith(${JSON.stringify(path.sep + name)}))`), 15000)
    await ev(`[...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').endsWith(${JSON.stringify(path.sep + name)}))?.click()`)
    await sleep(1500)
  }

  await waitFor(() => ev(`document.querySelectorAll('.tree-row').length > 0`), 60000)
  for (const c of cases) {
    if (!c.ok) { console.log(`SKIP  ${c.name} (its tools were not found)`); continue }
    if (c.install) {
      const r = await ev(`window.api.dbgInstallCsharp().then((r) => JSON.stringify(r))`)
      if (!JSON.parse(r).ok) { console.log('SKIP  C# (netcoredbg could not be downloaded: ' + r + ')'); continue }
    }
    if (c.name === 'C#') await ev(`document.querySelector('[data-view="files"]').click()`)
    // C# lives in a sub-folder: open it through the tree
    if (c.name === 'C#') {
      await waitFor(() => ev(`[...document.querySelectorAll('.tree-row')].some((e) => (e.getAttribute('data-tree-path') || '').endsWith('${path.sep}cs'))`), 10000)
      await ev(`[...document.querySelectorAll('.tree-row')].find((e) => (e.getAttribute('data-tree-path') || '').endsWith('${path.sep}cs'))?.click()`); await sleep(800)
    }
    await openFile(c.file)
    // the caret to the line, with the keyboard, then F9 through the Run menu
    const r = JSON.parse(await ev(`JSON.stringify(document.querySelector('.monaco-editor .view-lines').getBoundingClientRect())`))
    await mouse(r.left + 60, r.top + 8)
    await key('Home', 36, 2)
    for (let i = 1; i < c.line; i++) await key('ArrowDown', 40)
    await menu('Run', 'Toggle Breakpoint', 600)
    await menu('Run', 'Start Debugging', 500)
    const stopped = await waitFor(async () => (await frames()).length > 0, 90000)
    const fr = stopped ? await frames() : []
    check(`${c.name}: in the packaged app, F5 compiles the file and stops at the breakpoint in the right function`, c.frame.test(fr[0] ?? ''), JSON.stringify(fr).slice(0, 200))
    check(`${c.name}: the variables of the stopped frame are listed`, await waitFor(() => ev(`/\\ba\\b[^a-z]*2/.test(document.querySelector('.sidebar')?.innerText ?? '')`), 8000), (await ev(`document.querySelector('.sidebar')?.innerText ?? ''`)).replace(/\s+/g, ' ').slice(0, 200))
    await menu('Run', 'Remove All Breakpoints', 400)
    await menu('Run', 'Stop Debugging', 1500)
    check(`${c.name}: Stop Debugging ends the session`, await waitFor(async () => (await frames()).length === 0, 10000))
    await ev(`document.querySelector('[data-view="files"]').click()`); await sleep(300)
  }
  // Nothing the sessions started may still be running (a debuggee whose adapter was ended first used to be left behind).
  await sleep(2500)
  const left = cp.spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'java.exe' -and $_.CommandLine -like '*jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0*') -or $_.ExecutablePath -like '*cppbuild*' } | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.Name }"], { encoding: 'utf-8', windowsHide: true }).stdout.trim()
  check('the programs the sessions started are all gone', left === '', left)
  stopApp()
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); stopApp(); process.exit(1) })
