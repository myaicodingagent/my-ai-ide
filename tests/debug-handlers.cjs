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
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'debugger.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['ws', 'esbuild'], alias: { electron: stubFile }, outfile: bundleFile, logLevel: 'error'
})
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

  await sleep(800)
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* a debuggee may still be closing; it is only a temp folder */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); process.exit(1) })
