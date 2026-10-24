// Runs the real debugger module (src/main/debugger.ts) against real Node programs, with a stub for Electron.
// `npm run test:debug`: needs `node` on PATH; it does not start the app.
const fs = require('fs'), os = require('os'), path = require('path')
const handlers = {}
const events = []
global.__electronStub = {
  ipcMain: { handle: (name, fn) => { handlers[name] = fn }, on: () => {} },
  shell: {}, app: { getPath: () => os.tmpdir() }, safeStorage: {}, BrowserWindow: class {}
}
const root = path.join(__dirname, '..')
const stubFile = path.join(root, 'node_modules', '.cache', 'debug-electron-stub.cjs')
const bundleFile = path.join(root, 'node_modules', '.cache', 'debug-bundle.cjs')
fs.mkdirSync(path.dirname(stubFile), { recursive: true })
fs.writeFileSync(stubFile, 'module.exports = global.__electronStub')
// The program imports a few files as text (JavaDap.java?raw), which needs an esbuild plugin, so it is built in a child process (plugins need the async API).
require('child_process').execFileSync(process.execPath, ['-e', `
const path = require('path'), fs = require('fs')
const o = JSON.parse(process.argv[1])
require('esbuild').build({
  entryPoints: [o.entry], bundle: true, platform: 'node', format: 'cjs', external: ['ws', 'esbuild'], alias: { electron: o.stub }, outfile: o.out, logLevel: 'error',
  plugins: [{ name: 'raw', setup(b) { b.onResolve({ filter: /[?]raw$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.replace(/[?]raw$/, '')), namespace: 'raw' })); b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: fs.readFileSync(a.path, 'utf-8'), loader: 'text' })) } }]
}).catch((e) => { console.error(e.message); process.exit(1) })
`, JSON.stringify({ entry: path.join(root, 'src', 'main', 'debugger.ts'), stub: stubFile, out: bundleFile })], { cwd: root, stdio: 'inherit' })
const mod = require(bundleFile)
mod.registerDebugHandlers(() => ({ webContents: { send: (_ch, e) => events.push(e) } }))
const call = (n, ...a) => handlers[n]({}, ...a)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitEvent(pred, what, ms = 15000) {
  const t0 = Date.now()
  for (;;) {
    const i = events.findIndex(pred)
    if (i >= 0) return events.splice(i, 1)[0]
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for: ' + what + ' (have: ' + events.map((e) => e.type).join(',') + ')')
    await sleep(40)
  }
}
const paused = (what) => waitEvent((e) => e.type === 'paused', what)
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

;(async () => {
  const dir = path.join(os.tmpdir(), 'debug-test-' + process.pid)
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'sp ace'), { recursive: true })
  const script = path.join(dir, 'sp ace', 'prog.js')
  fs.writeFileSync(script, [
    'function add(a, b) {',          // 1
    '  const sum = a + b',           // 2
    '  return sum',                  // 3
    '}',                             // 4
    'function outer(x) {',           // 5
    '  const y = add(x, 1)',         // 6
    '  return y * 2',                // 7
    '}',                             // 8
    'const result = outer(4)',       // 9
    'console.log("result", result)', // 10
    'const obj = { name: "n", list: [1, 2, 3] }', // 11
    'console.log("end")'             // 12
  ].join('\n') + '\n')

  // --- breakpoint URL matching
  const rx = new RegExp(mod.urlRegexFor('C:\\Users\\A B\\x.js'))
  check('breakpoints match the file URL whatever the drive-letter case, and spaces', rx.test('file:///c:/Users/A%20B/x.js') && rx.test('file:///C:/Users/A%20B/x.js') && !rx.test('file:///C:/Users/A%20B/x.json') && !rx.test('file:///C:/Other/x.js'))

  // --- start with a breakpoint
  let r = await call('dbg:start', { file: script, breakpoints: { [script]: [{ line: 2 }] } })
  check('a program starts under the debugger', r.ok === true, JSON.stringify(r))
  await waitEvent((e) => e.type === 'started', 'started')
  let p = await paused('first breakpoint')
  check('it stops at the breakpoint, in the right function, file and line', p.reason === 'breakpoint' && p.frames[0].name === 'add' && p.frames[0].line === 2 && same(p.frames[0].file, script), JSON.stringify(p.frames[0]))
  check('the call stack lists the callers', p.frames.slice(0, 3).map((f) => f.name).join() === 'add,outer,(anonymous)' || p.frames.slice(0, 2).map((f) => f.name).join() === 'add,outer', p.frames.map((f) => f.name).join())
  check('Node\'s own start-up code is not reported as a stop (it resumed past "break on start")', p.reason !== 'Break on start')

  let scopes = await call('dbg:scopes', 0)
  const local = scopes.find((s) => s.name === 'Local')
  check('the local scope shows the arguments (a variable not assigned yet is listed by older Node versions only)', !!local && local.vars.find((v) => v.name === 'a')?.value === '4' && local.vars.find((v) => v.name === 'b')?.value === '1', JSON.stringify(local))
  let ev = await call('dbg:eval', 'a + b', 0)
  check('an expression is evaluated in the stopped frame', ev.ok && ev.value.value === '5', JSON.stringify(ev))
  ev = await call('dbg:eval', 'a +', 0)
  check('a bad expression reports its error', ev.ok === false && /Unexpected|SyntaxError|token/i.test(ev.error), JSON.stringify(ev))
  ev = await call('dbg:eval', 'x * 10', 1)
  check('another frame can be inspected (the caller\'s x)', ev.ok && ev.value.value === '40', JSON.stringify(ev))
  ev = await call('dbg:eval', '"a" + "b"', null)
  check('the console can evaluate without a frame', ev.ok && ev.value.value === '"ab"', JSON.stringify(ev))

  // --- stepping
  await call('dbg:stepOver')
  p = await paused('step over')
  check('step over moves to the next line', p.reason === 'step' && p.frames[0].line === 3 && p.frames[0].name === 'add', JSON.stringify([p.reason, p.frames[0].line]))
  scopes = await call('dbg:scopes', 0)
  check('and the new value of sum is visible', scopes.find((s) => s.name === 'Local').vars.find((v) => v.name === 'sum')?.value === '5')
  await call('dbg:stepOut')
  p = await paused('step out')
  check('step out returns to the caller', p.frames[0].name === 'outer' && p.frames[0].line >= 6 && p.frames[0].line <= 7, JSON.stringify([p.frames[0].name, p.frames[0].line]))
  let guard = 0
  while (p.frames[0].name === 'outer' && guard++ < 6) { await call('dbg:stepOver'); p = await paused('step over in outer') }
  check('stepping off the end of a function lands in the code that called it', p.frames[0].name !== 'outer' && p.frames[0].line >= 9, JSON.stringify([p.frames[0].name, p.frames[0].line]))

  // --- setting a breakpoint while stopped, objects, output, exit
  await call('dbg:setBreakpoints', script, [{ line: 12 }])
  await call('dbg:continue')
  await waitEvent((e) => e.type === 'resumed', 'resumed')
  p = await paused('breakpoint added while stopped')
  check('a breakpoint added while stopped is used when the program continues', p.reason === 'breakpoint' && p.frames[0].line === 12, JSON.stringify([p.reason, p.frames[0].line]))
  scopes = await call('dbg:scopes', 0)
  const objVar = scopes.flatMap((s) => s.vars).find((v) => v.name === 'obj')
  check('objects can be expanded', !!objVar && !!objVar.objectId && /Object/.test(objVar.value), JSON.stringify(objVar))
  const kids = await call('dbg:props', objVar.objectId)
  const list = kids.find((k) => k.name === 'list')
  check('with their properties', kids.map((k) => k.name).sort().join() === 'list,name' && kids.find((k) => k.name === 'name').value === '"n"' && !!list.objectId, JSON.stringify(kids))
  const items = await call('dbg:props', list.objectId)
  check('and nested objects (array items)', ['0', '1', '2'].every((i) => items.some((k) => k.name === i)) && items.find((k) => k.name === '1').value === '2', JSON.stringify(items))
  await call('dbg:continue')
  const ended = await waitEvent((e) => e.type === 'exited', 'exit')
  check('the program runs to the end with exit code 0', ended.code === 0)
  const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
  check('its output is captured', out.includes('result 10') && out.includes('end'), JSON.stringify(out))
  events.length = 0

  // --- a condition that is never true
  r = await call('dbg:start', { file: script, breakpoints: { [script]: [{ line: 2, condition: 'a === 100' }] } })
  const done = await waitEvent((e) => e.type === 'exited', 'exit without stopping')
  check('a conditional breakpoint whose condition is false never stops the program', r.ok && done.code === 0 && !events.some((e) => e.type === 'paused'))
  events.length = 0
  r = await call('dbg:start', { file: script, breakpoints: { [script]: [{ line: 2, condition: 'a === 4' }] } })
  p = await paused('conditional hit')
  check('and one whose condition is true does stop it', p.reason === 'breakpoint' && p.frames[0].line === 2)
  await call('dbg:stop')
  await waitEvent((e) => e.type === 'exited', 'stopped')
  check('Stop ends the program', true)
  events.length = 0

  // --- stop on entry, then stop
  r = await call('dbg:start', { file: script, stopOnEntry: true, breakpoints: {} })
  p = await paused('entry')
  check('"stop on entry" pauses at the first statement of the program', p.frames[0].line === 9 && same(p.frames[0].file, script), JSON.stringify([p.frames[0].name, p.frames[0].line]))
  await call('dbg:stepInto')
  p = await paused('step into')
  check('step into enters the function being called', p.frames[0].name === 'outer' && p.frames[0].line === 6, JSON.stringify([p.frames[0].name, p.frames[0].line]))
  await call('dbg:stop')
  await waitEvent((e) => e.type === 'exited', 'stop on entry exit')
  events.length = 0

  // --- uncaught exception
  const bad = path.join(dir, 'bad.js')
  fs.writeFileSync(bad, 'function boom() {\n  throw new Error("kaboom")\n}\nboom()\n')
  r = await call('dbg:start', { file: bad, breakpoints: {} })
  p = await paused('exception')
  check('an uncaught exception stops the program where it happened', p.reason === 'exception' && /kaboom/.test(p.exception || '') && p.frames[0].line === 2, JSON.stringify([p.reason, p.exception, p.frames[0].line]))
  await call('dbg:continue')
  await waitEvent((e) => e.type === 'exited', 'exit after exception')
  events.length = 0

  // --- problems
  r = await call('dbg:start', { file: path.join(dir, 'missing.js'), breakpoints: {} })
  check('a file that does not exist is refused with a clear message', r.ok === false && /does not exist/.test(r.error), JSON.stringify(r))
  r = await call('dbg:start', { file: script, breakpoints: {} })
  const second = await call('dbg:start', { file: script, breakpoints: {} })
  check('only one session at a time', r.ok === true && second.ok === false && /already running/.test(second.error))
  await call('dbg:stop'); await waitEvent((e) => e.type === 'exited', 'exit')
  let threw = false
  try { await call('dbg:scopes', 0) } catch { threw = true }
  check('asking for variables with no session fails cleanly', threw)

  // ================= TypeScript (bundled with esbuild, mapped back through the source map) =================
  const tsDir = path.join(dir, 'tsproj'); fs.mkdirSync(path.join(tsDir, 'node_modules', 'padder'), { recursive: true })
  fs.writeFileSync(path.join(tsDir, 'node_modules', 'padder', 'index.js'), 'module.exports = (s, n) => String(s).padStart(n, "*")\n')
  const tsMain = path.join(tsDir, 'main.ts'), tsHelper = path.join(tsDir, 'helper.ts')
  fs.writeFileSync(tsHelper, [
    'export interface Pair { a: number; b: number }',   // 1
    'export function add(p: Pair): number {',            // 2
    '  const sum: number = p.a + p.b',                   // 3
    '  return sum',                                      // 4
    '}'                                                  // 5
  ].join('\n') + '\n')
  fs.writeFileSync(tsMain, [
    "import { add, Pair } from './helper'",               // 1
    "import padder from 'padder'",                        // 2
    'type Label = string',                                // 3
    'const input: Pair = { a: 2, b: 3 }',                 // 4
    'const label: Label = "ts result"',                   // 5
    'const result: number = add(input)',                  // 6
    'console.log(label, padder(result, 3))',              // 7
    'const obj: { name: string; list: number[] } = { name: "n", list: [1, 2] }', // 8
    'console.log("end", obj.name)'                        // 9
  ].join('\n') + '\n')
  r = await call('dbg:start', { file: tsMain, cwd: tsDir, breakpoints: { [tsHelper]: [{ line: 3 }], [tsMain]: [{ line: 8 }] } })
  check('a TypeScript program starts (it is compiled first)', r.ok === true, JSON.stringify(r))
  p = await paused('ts breakpoint in an imported file')
  check('a breakpoint in a TypeScript file imported by the program stops there, shown at its own file and line', p.reason === 'breakpoint' && p.frames[0].name === 'add' && same(p.frames[0].file, tsHelper) && p.frames[0].line === 3, JSON.stringify(p.frames.slice(0, 2)))
  check('the caller is shown in the main file at the right line', same(p.frames[1].file, tsMain) && p.frames[1].line === 6, JSON.stringify(p.frames[1]))
  scopes = await call('dbg:scopes', 0)
  check('variables keep their TypeScript names', scopes.flatMap((s) => s.vars).some((v) => v.name === 'p'), JSON.stringify(scopes.map((s) => s.vars.map((v) => v.name))))
  ev = await call('dbg:eval', 'p.a + p.b', 0)
  check('expressions are evaluated in the stopped frame', ev.ok && ev.value.value === '5', JSON.stringify(ev))
  await call('dbg:stepOver')
  p = await paused('ts step')
  check('stepping follows the TypeScript source', p.frames[0].line === 4 && same(p.frames[0].file, tsHelper), JSON.stringify(p.frames[0]))
  await call('dbg:continue')
  p = await paused('ts second breakpoint')
  check('the next breakpoint (main.ts, line 8) is hit', p.reason === 'breakpoint' && same(p.frames[0].file, tsMain) && p.frames[0].line === 8, JSON.stringify(p.frames[0]))
  await call('dbg:setBreakpoints', tsMain, [{ line: 9 }])
  await call('dbg:continue')
  p = await paused('ts breakpoint added while stopped')
  check('a breakpoint added while stopped is used', p.frames[0].line === 9 && same(p.frames[0].file, tsMain), JSON.stringify(p.frames[0]))
  await call('dbg:continue')
  const tsEnd = await waitEvent((e) => e.type === 'exited', 'ts exit')
  const tsOut = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
  check('the program ran with its package imports and finished', tsEnd.code === 0 && tsOut.includes('ts result **5') && tsOut.includes('end n'), JSON.stringify(tsOut))
  events.length = 0
  await sleep(700)
  check('the temporary bundle is removed afterwards', fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ai-ide-debug-')).length === 0, fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ai-ide-debug-')).join())
  // a line with no code moves to the next line that has some
  fs.writeFileSync(tsMain, 'interface A { x: number }\n\n\nconst v: A = { x: 1 }\nconsole.log(v.x)\n')
  r = await call('dbg:start', { file: tsMain, cwd: tsDir, breakpoints: { [tsMain]: [{ line: 1 }] } })
  p = await paused('ts breakpoint on a type line')
  check('a breakpoint on a line that has no code (a type) stops at the next line of code', p.reason === 'breakpoint' && p.frames[0].line === 4, JSON.stringify(p.frames[0]))
  await call('dbg:stop'); await waitEvent((e) => e.type === 'exited', 'ts stop')
  events.length = 0
  // errors
  fs.writeFileSync(tsMain, 'const x: number = ;\n')
  r = await call('dbg:start', { file: tsMain, cwd: tsDir, breakpoints: {} })
  check('a TypeScript program that does not compile is refused with the error', r.ok === false && /Could not compile/.test(r.error) && /main\.ts:1/.test(r.error), JSON.stringify(r))
  fs.writeFileSync(tsMain, 'function boom(): never {\n  throw new Error("ts kaboom")\n}\nboom()\n')
  r = await call('dbg:start', { file: tsMain, cwd: tsDir, breakpoints: {} })
  p = await paused('ts exception')
  check('an exception is shown at the TypeScript line', p.reason === 'exception' && /ts kaboom/.test(p.exception || '') && p.frames[0].line === 2 && same(p.frames[0].file, tsMain), JSON.stringify([p.reason, p.exception, p.frames[0].line]))
  await call('dbg:continue'); await waitEvent((e) => e.type === 'exited', 'ts exc exit'); events.length = 0

  // ================= Python (debugpy, over the Debug Adapter Protocol) =================
  const pyFile = path.join(dir, 'prog.py')
  fs.writeFileSync(pyFile, [
    'def add(a, b):',                                       // 1
    '    total = a + b',                                    // 2
    '    return total',                                     // 3
    '',                                                     // 4
    'result = add(2, 3)',                                   // 5
    'print("py result", result)',                           // 6
    'data = {"name": "n", "items": [1, 2, 3]}',             // 7
    'print("end", data["name"])'                            // 8
  ].join('\n') + '\n')
  r = await call('dbg:start', { file: pyFile, breakpoints: { [pyFile]: [{ line: 2 }] } })
  const havePy = r.ok === true || !/Python 3 was not found|debugpy/.test(r.error || '')
  if (!r.ok && /debugpy|Python 3 was not found/.test(r.error || '')) {
    console.log('SKIP  Python or debugpy is not installed here, so the Python debugger was not tested: ' + r.error)
  } else {
    check('a Python program starts under the debugger', r.ok === true, JSON.stringify(r))
    await waitEvent((e) => e.type === 'started', 'py started')
    p = await paused('py breakpoint')
    check('Python: it stops at the breakpoint, in the right function, file and line', p.reason === 'breakpoint' && p.frames[0].name === 'add' && p.frames[0].line === 2 && same(p.frames[0].file, pyFile), JSON.stringify(p.frames.slice(0, 2)))
    check('Python: the caller is in the call stack', p.frames.some((f) => same(f.file || '', pyFile) && f.line === 5))
    scopes = await call('dbg:scopes', 0)
    const pl = scopes.find((s) => s.name === 'Local')
    check('Python: the local variables are shown with their values', !!pl && pl.vars.find((v) => v.name === 'a')?.value === '2' && pl.vars.find((v) => v.name === 'b')?.value === '3', JSON.stringify(scopes))
    ev = await call('dbg:eval', 'a + b', 0)
    check('Python: an expression is evaluated in the stopped frame', ev.ok && ev.value.value === '5', JSON.stringify(ev))
    ev = await call('dbg:eval', 'nope + 1', 0)
    check('Python: a bad expression reports its error', ev.ok === false && /nope|not defined/i.test(ev.error), JSON.stringify(ev))
    await call('dbg:stepOver')
    p = await paused('py step over')
    check('Python: step over moves to the next line', p.reason === 'step' && p.frames[0].line === 3 && p.frames[0].name === 'add', JSON.stringify([p.reason, p.frames[0].line]))
    scopes = await call('dbg:scopes', 0)
    check('Python: and total now has its value', scopes.find((s) => s.name === 'Local').vars.find((v) => v.name === 'total')?.value === '5')
    await call('dbg:stepOut')
    p = await paused('py step out')
    check('Python: step out returns to the caller', p.frames[0].line >= 5 && p.frames[0].name !== 'add', JSON.stringify(p.frames[0]))
    await call('dbg:setBreakpoints', pyFile, [{ line: 8 }])
    await call('dbg:continue')
    p = await paused('py breakpoint added while stopped')
    check('Python: a breakpoint added while stopped is used', p.reason === 'breakpoint' && p.frames[0].line === 8, JSON.stringify([p.reason, p.frames[0].line]))
    scopes = await call('dbg:scopes', 0)
    const dv = scopes.flatMap((s) => s.vars).find((v) => v.name === 'data')
    check('Python: a dictionary can be expanded', !!dv && /^dap:/.test(dv.objectId || ''), JSON.stringify(dv))
    const kids = await call('dbg:props', dv.objectId)
    check('Python: with its entries (and a list inside can be expanded in turn)', kids.some((k) => /name/.test(k.name) && /n/.test(k.value)) && kids.some((k) => /items/.test(k.name) && !!k.objectId), JSON.stringify(kids))
    await call('dbg:continue')
    const pe = await waitEvent((e) => e.type === 'exited', 'py exit')
    const pyOut = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('Python: the program ends with code 0 and its output was captured', pe.code === 0 && pyOut.includes('py result 5') && pyOut.includes('end n'), JSON.stringify([pe.code, pyOut]))
    events.length = 0
    r = await call('dbg:start', { file: pyFile, breakpoints: { [pyFile]: [{ line: 2, condition: 'a == 100' }] } })
    const done2 = await waitEvent((e) => e.type === 'exited', 'py exit without stopping')
    check('Python: a conditional breakpoint whose condition is false does not stop it', r.ok && done2.code === 0 && !events.some((e) => e.type === 'paused'))
    events.length = 0
    r = await call('dbg:start', { file: pyFile, breakpoints: { [pyFile]: [{ line: 2, condition: 'a == 2' }] } })
    p = await paused('py conditional')
    check('Python: and one whose condition is true does', p.reason === 'breakpoint' && p.frames[0].line === 2)
    await call('dbg:stop')
    await waitEvent((e) => e.type === 'exited', 'py stopped')
    check('Python: Stop ends the session', true)
    events.length = 0
    fs.writeFileSync(pyFile, 'def f():\n    return 1 / 0\nf()\n')
    r = await call('dbg:start', { file: pyFile, breakpoints: {} })
    p = await paused('py exception')
    check('Python: an uncaught exception stops the program where it happened', p.reason === 'exception' && /ZeroDivisionError/.test(p.exception || '') && p.frames[0].line === 2, JSON.stringify([p.reason, p.exception, p.frames[0].line]))
    await call('dbg:continue'); await waitEvent((e) => e.type === 'exited', 'py exc exit'); events.length = 0
    fs.writeFileSync(pyFile, 'import sys\nprint(sys.argv[1:])\nimport os\nprint(os.environ.get("MYVAR"))\n')
    r = await call('dbg:start', { file: pyFile, args: ['one', 'two'], env: { MYVAR: 'hello' }, breakpoints: {} })
    await waitEvent((e) => e.type === 'exited', 'py args exit')
    const argsOut = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
    check('Python: arguments and environment variables reach the program', /\['one', 'two'\]/.test(argsOut) && /hello/.test(argsOut), JSON.stringify(argsOut))
    events.length = 0
  }
  void havePy

  // --- Go, through Delve (skipped when Go or dlv is not installed)
  {
    const have = (cmd) => { try { require('child_process').execSync(cmd, { stdio: 'ignore' }); return true } catch { return false } }
    const dlvOk = have('go version') && (have('dlv version') || fs.existsSync(path.join(os.homedir(), 'go', 'bin', process.platform === 'win32' ? 'dlv.exe' : 'dlv')))
    if (!dlvOk) console.log('SKIP  Go debugging (Go or Delve not installed)')
    else {
      events.length = 0
      const gdir = path.join(dir, 'gosrc'); fs.mkdirSync(gdir, { recursive: true })
      fs.writeFileSync(path.join(gdir, 'go.mod'), 'module prog\n\ngo 1.21\n')
      const goFile = path.join(gdir, 'main.go')
      fs.writeFileSync(goFile, [
        'package main',                       // 1
        '',                                   // 2
        'import "fmt"',                       // 3
        '',                                   // 4
        'func add(a, b int) int {',           // 5
        '\tsum := a + b',                     // 6
        '\treturn sum',                       // 7
        '}',                                  // 8
        '',                                   // 9
        'func main() {',                      // 10
        '\tr := add(4, 1)',                   // 11
        '\tfmt.Println("go result", r)',      // 12
        '}'                                   // 13
      ].join('\n') + '\n')
      r = await call('dbg:start', { file: goFile, breakpoints: { [goFile]: [{ line: 7 }] } })
      check('Go: a program starts under Delve', r.ok === true, JSON.stringify(r))
      p = await paused('go breakpoint')
      check('Go: it stops at the breakpoint, in the right function and line', p.reason === 'breakpoint' && /add$/.test(p.frames[0].name) && p.frames[0].line === 7 && same(p.frames[0].file, goFile), JSON.stringify(p.frames[0]))
      scopes = await call('dbg:scopes', 0)
      const gl = scopes.flatMap((s) => s.vars)
      check('Go: the variables are listed', gl.find((v) => v.name === 'sum')?.value === '5' && gl.find((v) => v.name === 'a')?.value === '4', JSON.stringify(gl))
      ev = await call('dbg:eval', 'a * 10', 0)
      check('Go: an expression is evaluated in the stopped frame', ev.ok && ev.value.value === '40', JSON.stringify(ev))
      await call('dbg:stepOut')
      p = await paused('go step out')
      check('Go: Step Out returns to the caller', p.frames[0].name.endsWith('main') && p.frames[0].line >= 11, JSON.stringify(p.frames[0]))
      await call('dbg:continue')
      const gend = await waitEvent((e) => e.type === 'exited', 'go exit')
      const gout = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
      check('Go: the program finishes and its output arrives', gend.code === 0 && /go result 5/.test(gout), JSON.stringify([gend, gout]))
      events.length = 0
      r = await call('dbg:start', { file: goFile, breakpoints: {} })
      await waitEvent((e) => e.type === 'exited', 'go no breakpoints')
      check('Go: without breakpoints it just runs to the end', r.ok === true)
      events.length = 0
    }
  }

  // --- C# (netcoredbg + the .NET SDK)
  {
    events.length = 0
    const cp = require('child_process')
    const haveDotnet = cp.spawnSync('dotnet', ['--version'], { windowsHide: true }).status === 0
    if (!haveDotnet) console.log('SKIP  C# (dotnet not found)')
    else {
      const inst = await call('dbg:installCsharp')
      check('C#: netcoredbg is found or downloaded', inst.ok === true && fs.existsSync(inst.path), JSON.stringify(inst))
      const csDir = path.join(dir, 'cs app')
      fs.mkdirSync(csDir, { recursive: true })
      const loose = path.join(dir, 'loose.cs')
      fs.writeFileSync(loose, 'class A {}\n')
      let r = await call('dbg:start', { file: loose, breakpoints: {} })
      check('C#: a file with no project gives a clear message', r.ok === false && /\.csproj/.test(r.error), JSON.stringify(r))
      fs.writeFileSync(path.join(csDir, 'app.csproj'), ['<Project Sdk="Microsoft.NET.Sdk">', '  <PropertyGroup>', '    <OutputType>Exe</OutputType>', '    <TargetFramework>net8.0</TargetFramework>', '    <ImplicitUsings>enable</ImplicitUsings>', '  </PropertyGroup>', '</Project>', ''].join('\n'))
      const prog = path.join(csDir, 'Program.cs')
      fs.writeFileSync(prog, 'this is not C#\n')
      r = await call('dbg:start', { file: prog, breakpoints: {} })
      check('C#: a program that does not build reports the compiler error', r.ok === false && /did not build/.test(r.error) && /error CS/.test(r.error), JSON.stringify(r).slice(0, 300))
      fs.writeFileSync(prog, [
        'int Add(int a, int b)',                                            // 1
        '{',                                                                // 2
        '    int sum = a + b;',                                             // 3
        '    return sum;',                                                  // 4
        '}',                                                                // 5
        'var total = Add(2, 3);',                                           // 6
        'Console.WriteLine("cs result " + total + " " + Environment.GetEnvironmentVariable("MYVAR") + " " + string.Join(",", args));', // 7
        'var items = new List<int> { 1, 2, 3 };',                           // 8
        'Console.WriteLine(items.Count);',                                  // 9
        ''
      ].join('\n'))
      r = await call('dbg:start', { file: prog, args: ['x', 'y'], env: { MYVAR: 'hi' }, breakpoints: { [prog]: [{ line: 3 }] } })
      check('C#: the program is built and started under the debugger', r.ok === true, JSON.stringify(r).slice(0, 400))
      let p = r.ok ? await paused('cs breakpoint') : null
      check('C#: it stops at the breakpoint in Add', !!p && p.reason === 'breakpoint' && p.frames[0].line === 3 && /Add/.test(p.frames[0].name) && same(p.frames[0].file, prog), JSON.stringify(p && p.frames[0]))
      let scopes = await call('dbg:scopes', 0)
      const names = scopes.flatMap((s) => s.vars).map((v) => v.name + '=' + v.value)
      check('C#: local variables are shown', names.includes('a=2') && names.includes('b=3'), names.join())
      let ev = await call('dbg:eval', 'a + b', 0)
      check('C#: an expression is evaluated in the stopped frame', ev.ok && ev.value.value === '5', JSON.stringify(ev))
      await call('dbg:stepOver')
      p = await paused('cs step')
      check('C#: step over goes to the next line', p.frames[0].line === 4, JSON.stringify(p.frames[0]))
      await call('dbg:stepOut')
      p = await paused('cs step out')
      check('C#: step out returns to the caller', p.frames[0].line >= 6 && p.frames[0].line <= 7, JSON.stringify(p.frames[0]))
      await call('dbg:setBreakpoints', prog, [{ line: 9 }])
      await call('dbg:continue')
      p = await paused('cs breakpoint added while stopped')
      check('C#: a breakpoint added while stopped is used', p.reason === 'breakpoint' && p.frames[0].line === 9, JSON.stringify([p.reason, p.frames[0].line]))
      scopes = await call('dbg:scopes', 0)
      const iv = scopes.flatMap((s) => s.vars).find((v) => v.name === 'items')
      const kids = iv && iv.objectId ? await call('dbg:props', iv.objectId) : []
      check('C#: a list can be expanded', !!iv && kids.length > 0, JSON.stringify([iv, kids]).slice(0, 300))
      await call('dbg:continue')
      const end = await waitEvent((e) => e.type === 'exited', 'cs exit')
      const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
      check('C#: it finishes with code 0; arguments, environment and output arrive', end.code === 0 && /cs result 5 hi x,y/.test(out), JSON.stringify([end.code, out]))
      events.length = 0
      r = await call('dbg:start', { file: prog, breakpoints: { [prog]: [{ line: 3, condition: 'a == 100' }] } })
      const end2 = await waitEvent((e) => e.type === 'exited', 'cs no stop')
      check('C#: a conditional breakpoint whose condition is false does not stop it', r.ok && end2.code === 0 && !events.some((e) => e.type === 'paused'))
      events.length = 0
      r = await call('dbg:start', { file: prog, breakpoints: { [prog]: [{ line: 3 }] } })
      await paused('cs for stop')
      await call('dbg:stop')
      await waitEvent((e) => e.type === 'exited', 'cs stopped')
      check('C#: Stop ends the session', true)
      events.length = 0
      fs.writeFileSync(prog, ['int Boom() { throw new InvalidOperationException("kaboom"); }', 'Boom();', ''].join('\n'))
      r = await call('dbg:start', { file: prog, breakpoints: {} })
      p = r.ok ? await paused('cs exception') : null
      check('C#: an unhandled exception stops the program where it happened', !!p && p.reason === 'exception' && /kaboom|InvalidOperation/.test(p.exception || '') , JSON.stringify(p && [p.reason, p.exception, p.frames[0] && p.frames[0].line]))
      await call('dbg:stop'); await waitEvent((e) => e.type === 'exited', 'cs exc stop'); events.length = 0
    }
  }

  // --- C and C++ (lldb-dap or GDB, and clang or gcc)
  {
    events.length = 0
    const cppDir = path.join(dir, 'cpp app')
    fs.mkdirSync(cppDir, { recursive: true })
    const cpp = path.join(cppDir, 'main.cpp')
    fs.writeFileSync(cpp, [
      '#include <iostream>',                                                  // 1
      '#include <vector>',                                                    // 2
      'int add(int a, int b) {',                                              // 3
      '    int sum = a + b;',                                                 // 4
      '    return sum;',                                                      // 5
      '}',                                                                    // 6
      'int main(int argc, char** argv) {',                                    // 7
      '    int total = add(2, 3);',                                           // 8
      '    std::vector<int> v{1, 2, 3};',                                     // 9
      '    std::cout << "cpp result " << total << " " << (argc > 1 ? argv[1] : "-") << " " << v.size() << std::endl;', // 10
      '    return 0;',                                                        // 11
      '}',                                                                    // 12
      ''
    ].join('\n'))
    let r = await call('dbg:start', { file: cpp, breakpoints: {} })
    if (r.ok === false && /^C and C\+\+ debugging needs/.test(r.error)) {
      console.log('SKIP  C/C++ (no lldb-dap or GDB 14+ with clang or gcc found)')
    } else {
      await waitEvent((e) => e.type === 'exited', 'cpp run to the end')
      check('C/C++: a program without breakpoints is compiled and runs to the end', r.ok === true)
      events.length = 0
      const bad = path.join(cppDir, 'bad.cpp')
      fs.writeFileSync(bad, 'int main() { return undefined_thing; }\n')
      r = await call('dbg:start', { file: bad, breakpoints: {} })
      check('C/C++: a program that does not compile reports the compiler error', r.ok === false && /did not compile/.test(r.error) && /undefined_thing/.test(r.error), JSON.stringify(r).slice(0, 300))
      r = await call('dbg:start', { file: path.join(cppDir, 'main.h'), breakpoints: {} })
      fs.writeFileSync(path.join(cppDir, 'main.h'), '#pragma once\n')
      r = await call('dbg:start', { file: path.join(cppDir, 'main.h'), breakpoints: {} })
      check('C/C++: a header cannot be run, and the message says so', r.ok === false && /header/.test(r.error), JSON.stringify(r))
      r = await call('dbg:start', { file: cpp, args: ['x'], breakpoints: { [cpp]: [{ line: 4 }] } })
      check('C/C++: the program is compiled and started under the debugger', r.ok === true, JSON.stringify(r).slice(0, 300))
      let p = r.ok ? await paused('cpp breakpoint') : null
      check('C/C++: it stops at the breakpoint in add', !!p && p.reason === 'breakpoint' && p.frames[0].line === 4 && /add/.test(p.frames[0].name) && same(p.frames[0].file, cpp), JSON.stringify(p && p.frames[0]))
      let scopes = await call('dbg:scopes', 0)
      const names = scopes.flatMap((s) => s.vars).map((v) => v.name + '=' + v.value)
      check('C/C++: local variables are shown', names.includes('a=2') && names.includes('b=3'), names.join())
      check('C/C++: the registers are not listed among the scopes', !scopes.some((s) => /regist/i.test(s.name)), scopes.map((s) => s.name).join())
      let ev = await call('dbg:eval', 'a + b', 0)
      check('C/C++: an expression is evaluated in the stopped frame', ev.ok && ev.value.value === '5', JSON.stringify(ev))
      await call('dbg:stepOver')
      p = await paused('cpp step')
      check('C/C++: step over goes to the next line', p.frames[0].line === 5, JSON.stringify(p.frames[0]))
      await call('dbg:stepOut')
      p = await paused('cpp step out')
      check('C/C++: step out returns to main', /main/.test(p.frames[0].name) && p.frames[0].line >= 8 && p.frames[0].line <= 9, JSON.stringify(p.frames[0]))
      await call('dbg:setBreakpoints', cpp, [{ line: 11 }])
      await call('dbg:continue')
      p = await paused('cpp breakpoint added while stopped')
      check('C/C++: a breakpoint added while stopped is used', p.reason === 'breakpoint' && p.frames[0].line === 11, JSON.stringify([p.reason, p.frames[0].line]))
      scopes = await call('dbg:scopes', 0)
      const vv = scopes.flatMap((s) => s.vars).find((v) => v.name === 'v')
      const kids = vv && vv.objectId ? await call('dbg:props', vv.objectId) : []
      check('C/C++: a vector can be expanded', !!vv && kids.length > 0, JSON.stringify([vv, kids]).slice(0, 300))
      await call('dbg:continue')
      const end = await waitEvent((e) => e.type === 'exited', 'cpp exit')
      const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
      check('C/C++: it finishes with code 0; the argument and the output arrive', end.code === 0 && /cpp result 5 x 3/.test(out), JSON.stringify([end.code, out]))
      events.length = 0
      r = await call('dbg:start', { file: cpp, breakpoints: { [cpp]: [{ line: 4, condition: 'a == 100' }] } })
      const end2 = await waitEvent((e) => e.type === 'exited', 'cpp no stop')
      check('C/C++: a conditional breakpoint whose condition is false does not stop it', r.ok && end2.code === 0 && !events.some((e) => e.type === 'paused'))
      events.length = 0
      r = await call('dbg:start', { file: cpp, breakpoints: { [cpp]: [{ line: 4 }] } })
      await paused('cpp for stop')
      await call('dbg:stop')
      await waitEvent((e) => e.type === 'exited', 'cpp stopped')
      check('C/C++: Stop ends the session', true)
      events.length = 0
      const c = path.join(cppDir, 'plain.c')
      fs.writeFileSync(c, ['#include <stdio.h>', 'int twice(int x) {', '    int y = x * 2;', '    return y;', '}', 'int main(void) {', '    printf("c result %d\\n", twice(21));', '    return 0;', '}', ''].join('\n'))
      r = await call('dbg:start', { file: c, breakpoints: { [c]: [{ line: 3 }] } })
      p = r.ok ? await paused('c breakpoint') : null
      check('C: a .c file is compiled with the C compiler and stops at its breakpoint', !!p && p.frames[0].line === 3 && /twice/.test(p.frames[0].name), JSON.stringify(r.ok ? p && p.frames[0] : r))
      ev = await call('dbg:eval', 'x', 0)
      check('C: a parameter can be read', ev.ok && ev.value.value === '21', JSON.stringify(ev))
      await call('dbg:continue')
      const cend = await waitEvent((e) => e.type === 'exited', 'c exit')
      check('C: it finishes and prints', cend.code === 0 && /c result 42/.test(events.filter((e) => e.type === 'output').map((e) => e.text).join('')))
      events.length = 0
    }
  }

  // --- Java (a JDK; the editor's own debug adapter is built on the JDK's JDI)
  {
    events.length = 0
    const jdir = path.join(dir, 'java app')
    const pdir = path.join(jdir, 'com', 'demo')
    fs.mkdirSync(pdir, { recursive: true })
    const hello = path.join(jdir, 'Hello.java')
    fs.writeFileSync(hello, [
      'import java.util.*;',                                                  // 1
      '',                                                                     // 2
      'public class Hello {',                                                 // 3
      '    static int add(int a, int b) {',                                   // 4
      '        int sum = a + b;',                                             // 5
      '        return sum;',                                                  // 6
      '    }',                                                                // 7
      '    public static void main(String[] args) {',                         // 8
      '        int total = add(2, 3);',                                       // 9
      '        List<Integer> list = new ArrayList<>(List.of(1, 2, 3));',      // 10
      '        String who = args.length > 0 ? args[0] : "-";',                // 11
      '        System.out.println("java result " + total + " " + who + " " + list.size() + " " + System.getenv("MYV"));', // 12
      '        System.err.println("to stderr");',                             // 13
      '    }',                                                                // 14
      '}',                                                                    // 15
      ''
    ].join('\n'))
    let r = await call('dbg:start', { file: hello, breakpoints: {} })
    if (r.ok === false && /^Java debugging needs a JDK/.test(r.error)) {
      console.log('SKIP  Java (no JDK found)')
    } else {
      await waitEvent((e) => e.type === 'exited', 'java run to the end')
      check('Java: a program without breakpoints is compiled and runs to the end', r.ok === true, JSON.stringify(r).slice(0, 300))
      events.length = 0
      const bad = path.join(jdir, 'Bad.java')
      fs.writeFileSync(bad, 'public class Bad { public static void main(String[] a) { int x = "no"; } }\n')
      r = await call('dbg:start', { file: bad, breakpoints: {} })
      check('Java: a program that does not compile reports the compiler error', r.ok === false && /did not compile/.test(r.error) && /incompatible types/.test(r.error), JSON.stringify(r).slice(0, 300))
      const nomain = path.join(jdir, 'Lib.java')
      fs.writeFileSync(nomain, 'public class Lib { static int one() { return 1; } }\n')
      r = await call('dbg:start', { file: nomain, breakpoints: {} })
      check('Java: a file without a main method says so', r.ok === false && /no main method/.test(r.error), JSON.stringify(r))
      r = await call('dbg:start', { file: hello, args: ['x'], env: { MYV: 'hi' }, breakpoints: { [hello]: [{ line: 5 }] } })
      check('Java: the program is compiled and started under the debugger', r.ok === true, JSON.stringify(r).slice(0, 300))
      let p = r.ok ? await paused('java breakpoint') : null
      check('Java: it stops at the breakpoint in add', !!p && p.reason === 'breakpoint' && p.frames[0].line === 5 && /add/.test(p.frames[0].name) && same(p.frames[0].file, hello), JSON.stringify(p && p.frames[0]))
      check('Java: the caller is main, at line 9', !!p && /main/.test(p.frames[1].name) && p.frames[1].line === 9, JSON.stringify(p && p.frames[1]))
      let scopes = await call('dbg:scopes', 0)
      const names = scopes.flatMap((s) => s.vars).map((v) => v.name + '=' + v.value)
      check('Java: local variables are shown', names.includes('a=2') && names.includes('b=3'), names.join())
      let ev = await call('dbg:eval', 'a + b * 2', 0)
      check('Java: an expression is evaluated in the stopped frame', ev.ok && ev.value.value === '8', JSON.stringify(ev))
      ev = await call('dbg:eval', 'Math.max(a, b)', 0)
      check('Java: a static method can be called in an expression', ev.ok && ev.value.value === '3', JSON.stringify(ev))
      ev = await call('dbg:eval', 'nope + 1', 0)
      check('Java: a bad expression reports its error', ev.ok === false && /nope/.test(ev.error), JSON.stringify(ev))
      await call('dbg:stepOver')
      p = await paused('java step')
      check('Java: step over goes to the next line', p.frames[0].line === 6, JSON.stringify(p.frames[0]))
      await call('dbg:stepOut')
      p = await paused('java step out')
      check('Java: step out returns to main', /main/.test(p.frames[0].name) && p.frames[0].line >= 9 && p.frames[0].line <= 10, JSON.stringify(p.frames[0]))
      await call('dbg:setBreakpoints', hello, [{ line: 13 }])
      await call('dbg:continue')
      p = await paused('java breakpoint added while stopped')
      check('Java: a breakpoint added while stopped is used', p.reason === 'breakpoint' && p.frames[0].line === 13, JSON.stringify([p.reason, p.frames[0].line]))
      scopes = await call('dbg:scopes', 0)
      const vars = scopes.flatMap((s) => s.vars)
      check('Java: a list shows its contents, a string its text, a number its value', vars.some((v) => v.name === 'list' && v.value === '[1, 2, 3]') && vars.some((v) => v.name === 'who' && v.value === '"x"') && vars.some((v) => v.name === 'total' && v.value === '5'), JSON.stringify(vars.map((v) => v.name + '=' + v.value)))
      const argsVar = vars.find((v) => v.name === 'args')
      const kids = argsVar && argsVar.objectId ? await call('dbg:props', argsVar.objectId) : []
      check('Java: an array can be expanded', !!argsVar && kids.length === 1 && kids[0].value === '"x"', JSON.stringify([argsVar, kids]))
      ev = await call('dbg:eval', 'list.size() + total', 0)
      check('Java: an instance method can be called in an expression', ev.ok && ev.value.value === '8', JSON.stringify(ev))
      await call('dbg:continue')
      const end = await waitEvent((e) => e.type === 'exited', 'java exit')
      const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
      check('Java: it finishes with code 0; the argument, the environment variable and the output arrive', end.code === 0 && /java result 5 x 3 hi/.test(out) && /to stderr/.test(out), JSON.stringify([end.code, out]))
      check('Java: the debug agent\'s banner is not part of the output', !/Listening for transport/.test(out), out)
      events.length = 0
      r = await call('dbg:start', { file: hello, breakpoints: { [hello]: [{ line: 5, condition: 'a == 100' }] } })
      const end2 = await waitEvent((e) => e.type === 'exited', 'java no stop')
      check('Java: a conditional breakpoint whose condition is false does not stop it', r.ok && end2.code === 0 && !events.some((e) => e.type === 'paused'))
      events.length = 0
      r = await call('dbg:start', { file: hello, breakpoints: { [hello]: [{ line: 5, condition: 'a == 2' }] } })
      p = await paused('java conditional')
      check('Java: and one whose condition is true does', p.reason === 'breakpoint' && p.frames[0].line === 5)
      await call('dbg:stop')
      await waitEvent((e) => e.type === 'exited', 'java stopped')
      check('Java: Stop ends the session', true)
      events.length = 0
      r = await call('dbg:start', { file: hello, stopOnEntry: true, breakpoints: {} })
      p = r.ok ? await paused('java entry') : null
      check('Java: stop on entry stops at the start of main', !!p && /main/.test(p.frames[0].name) && p.frames[0].line >= 8 && p.frames[0].line <= 9, JSON.stringify(p && p.frames[0]))
      await call('dbg:continue'); await waitEvent((e) => e.type === 'exited', 'java entry exit'); events.length = 0
      // a program in a package, using another class of its package; breakpoint in the other file
      const helper = path.join(pdir, 'Greeter.java')
      const mainP = path.join(pdir, 'App.java')
      fs.writeFileSync(helper, ['package com.demo;', '', 'public class Greeter {', '    private final String name;', '    public Greeter(String name) { this.name = name; }', '    public String greet() {', '        String msg = "hello " + name;', '        return msg;', '    }', '}', ''].join('\n'))
      fs.writeFileSync(mainP, ['package com.demo;', '', 'public class App {', '    public static void main(String[] args) {', '        Greeter g = new Greeter("pkg");', '        System.out.println(g.greet());', '        int zero = 0;', '        System.out.println(1 / zero);', '    }', '}', ''].join('\n'))
      r = await call('dbg:start', { file: mainP, breakpoints: { [helper]: [{ line: 7 }] } })
      p = r.ok ? await paused('java package breakpoint') : null
      check('Java: a package program stops at a breakpoint in another file of the package', !!p && /Greeter\.greet/.test(p.frames[0].name) && p.frames[0].line === 7 && same(p.frames[0].file, helper), JSON.stringify(r.ok ? p && p.frames[0] : r))
      scopes = await call('dbg:scopes', 0)
      const tv = scopes.flatMap((s) => s.vars).find((v) => v.name === 'this')
      const tk = tv && tv.objectId ? await call('dbg:props', tv.objectId) : []
      check('Java: this can be expanded to its fields', !!tv && tk.some((k) => k.name === 'name' && k.value === '"pkg"'), JSON.stringify([tv, tk]))
      await call('dbg:continue')
      p = await paused('java exception')
      check('Java: an uncaught exception stops the program where it happened', p.reason === 'exception' && /ArithmeticException/.test(p.exception || '') && p.frames[0].line === 8 && same(p.frames[0].file, mainP), JSON.stringify([p.reason, p.exception, p.frames[0].line]))
      await call('dbg:stop'); await waitEvent((e) => e.type === 'exited', 'java exc stop'); events.length = 0
    }
  }

  // --- attach to a program that is already running
  {
    events.length = 0
    const loop = path.join(dir, 'loop.js')
    fs.writeFileSync(loop, ['let n = 0', 'function tick() {', '  n++', '  return n', '}', 'setInterval(tick, 100)', ''].join('\n'))
    const port = 19339
    const child = require('child_process').spawn('node', [`--inspect=127.0.0.1:${port}`, loop], { stdio: 'ignore', windowsHide: true })
    await sleep(1500)
    let a = await call('dbg:attach', { port: 1 })
    check('attaching where nothing listens gives a clear error', a.ok === false && /Nothing is listening/.test(a.error), JSON.stringify(a))
    a = await call('dbg:attach', { port, breakpoints: { [loop]: [{ line: 3 }] } })
    check('attaches to a running program by its inspector port', a.ok === true, JSON.stringify(a))
    const ap = await paused('attached breakpoint')
    check('a breakpoint set before attaching stops the running program', ap.reason === 'breakpoint' && ap.frames[0].name === 'tick' && ap.frames[0].line === 3 && same(ap.frames[0].file, loop), JSON.stringify(ap.frames[0]))
    a = await call('dbg:attach', { port })
    check('a second attach is refused while one is active', a.ok === false)
    await call('dbg:stop')
    await waitEvent((e) => e.type === 'exited', 'detached')
    await sleep(300)
    check('Stop only disconnects: the program keeps running', child.exitCode === null && child.signalCode === null)
    child.kill()
  }

  // --- attach to a running Python program (python -m debugpy --listen)
  {
    events.length = 0
    const cp = require('child_process')
    const probe = cp.spawnSync('py', ['-3', '-c', 'import debugpy'], { windowsHide: true })
    if (probe.status !== 0) console.log('SKIP  Python attach (py -3 with debugpy not found)')
    else {
      const loop = path.join(dir, 'pyloop.py')
      fs.writeFileSync(loop, ['import time', 'n = 0', 'def tick():', '    global n', '    n += 1', '    return n', 'while True:', '    tick()', '    time.sleep(0.1)', ''].join('\n'))
      const port = 19340
      const child = cp.spawn('py', ['-3', '-m', 'debugpy', '--listen', `127.0.0.1:${port}`, loop], { stdio: 'ignore', windowsHide: true })
      await sleep(2500)
      let a = await call('dbg:attach', { language: 'python', port: 1 })
      check('Python attach: where nothing listens there is a clear error', a.ok === false && /Nothing is listening/.test(a.error), JSON.stringify(a))
      a = await call('dbg:attach', { language: 'python', port, breakpoints: { [loop]: [{ line: 5 }] } })
      check('Python attach: connects to a running program', a.ok === true, JSON.stringify(a))
      let ap = await paused('py attached breakpoint')
      check('Python attach: a breakpoint set before attaching stops the program', ap.reason === 'breakpoint' && ap.frames[0].name === 'tick' && ap.frames[0].line === 5 && same(ap.frames[0].file, loop), JSON.stringify(ap.frames[0]))
      const ev = await call('dbg:eval', 'n', 0)
      check('Python attach: expressions can be evaluated in the stopped program', ev.ok === true && /^\d+$/.test(ev.value.value), JSON.stringify(ev))
      a = await call('dbg:attach', { language: 'python', port })
      check('Python attach: a second attach is refused while one is active', a.ok === false)
      await call('dbg:stepOver')
      ap = await paused('py attached step')
      check('Python attach: stepping works', ap.reason === 'step' && ap.frames[0].line === 6, JSON.stringify([ap.reason, ap.frames[0].line]))
      await call('dbg:setBreakpoints', loop, [])
      await call('dbg:continue')
      await sleep(400)
      await call('dbg:stop')
      await waitEvent((e) => e.type === 'exited', 'py detached')
      await sleep(600)
      check('Python attach: Stop only disconnects, the program keeps running', child.exitCode === null && child.signalCode === null)
      events.length = 0
      a = await call('dbg:attach', { language: 'python', port, breakpoints: { [loop]: [{ line: 5 }] } })
      ap = a.ok ? await paused('py reattached') : null
      check('Python attach: it can be attached to again after letting go', a.ok === true && !!ap && ap.reason === 'breakpoint', JSON.stringify(a))
      await call('dbg:setBreakpoints', loop, []); await call('dbg:continue'); await sleep(300); await call('dbg:stop')
      await waitEvent((e) => e.type === 'exited', 'py detached 2')
      cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      events.length = 0
    }
  }

  // --- attach to a running Go program by process id
  {
    events.length = 0
    const cp = require('child_process')
    const goDir = path.join(dir, 'goloop')
    fs.mkdirSync(goDir, { recursive: true })
    fs.writeFileSync(path.join(goDir, 'go.mod'), 'module goloop\n\ngo 1.20\n')
    const gloop = path.join(goDir, 'main.go')
    fs.writeFileSync(gloop, ['package main', '', 'import "time"', '', 'var n int', '', 'func tick() int {', '	n++', '	return n', '}', '', 'func main() {', '	for {', '		tick()', '		time.Sleep(100 * time.Millisecond)', '	}', '}', ''].join('\n'))
    const exe = path.join(goDir, 'goloop.exe')
    const b = cp.spawnSync('go', ['build', '-gcflags=all=-N -l', '-o', exe, '.'], { cwd: goDir, windowsHide: true })
    const dlvOk = cp.spawnSync('dlv', ['version'], { windowsHide: true }).status === 0
    if (b.status !== 0 || !dlvOk) console.log('SKIP  Go attach (go build or dlv failed)')
    else {
      const child = cp.spawn(exe, [], { stdio: 'ignore', windowsHide: true })
      await sleep(800)
      let a = await call('dbg:attach', { language: 'go', pid: child.pid, breakpoints: { [gloop]: [{ line: 8 }] } })
      check('Go attach: connects to a running program by process id', a.ok === true, JSON.stringify(a))
      let ap = await paused('go attached breakpoint')
      check('Go attach: a breakpoint set before attaching stops the program', ap.reason === 'breakpoint' && /tick/.test(ap.frames[0].name) && ap.frames[0].line === 8 && same(ap.frames[0].file, gloop), JSON.stringify(ap.frames[0]))
      const scopes = await call('dbg:scopes', 0)
      check('Go attach: the stopped program can be inspected', Array.isArray(scopes) && scopes.length > 0, JSON.stringify(scopes).slice(0, 160))
      a = await call('dbg:attach', { language: 'go', pid: child.pid })
      check('Go attach: a second attach is refused while one is active', a.ok === false)
      await call('dbg:setBreakpoints', gloop, [])
      await call('dbg:continue')
      await sleep(400)
      await call('dbg:stop')
      await waitEvent((e) => e.type === 'exited', 'go detached')
      await sleep(800)
      check('Go attach: Stop only disconnects, the program keeps running', child.exitCode === null && child.signalCode === null)
      a = await call('dbg:attach', { language: 'go', pid: 2147483000 })
      check('Go attach: a process that does not exist gives an error', a.ok === false, JSON.stringify(a))
      cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      events.length = 0
    }
  }

  await sleep(800)
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* a debuggee may still be closing; it is only a temp folder */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); process.exit(1) })
