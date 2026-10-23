// Runs the real notebook kernels (src/main/notebook.ts): JavaScript always, Python when it is installed.
// `npm run test:notebook`: does not start the app.
const fs = require('fs'), os = require('os'), path = require('path')
const handlers = {}
const events = [] // [session, cell, event]
const exits = []
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f } },
  shell: {}, safeStorage: {}, BrowserWindow: class {},
  app: { getPath: () => path.join(os.tmpdir(), 'nb-test-' + process.pid) }
}
const root = path.join(__dirname, '..')
const stub = path.join(root, 'node_modules', '.cache', 'nb-stub.cjs')
const bundle = path.join(root, 'node_modules', '.cache', 'nb-bundle.cjs')
fs.mkdirSync(path.dirname(stub), { recursive: true })
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/main/notebook.ts')], bundle: true, platform: 'node', format: 'cjs', alias: { electron: stub }, outfile: bundle, logLevel: 'error' })
const mod = require(bundle)
mod.registerNotebookHandlers(() => ({ webContents: { send: (ch, ...a) => { if (ch === 'nb:event') events.push(a); else if (ch === 'nb:exited') exits.push(a) } } }))
const call = (n, ...a) => handlers[n]({}, ...a)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Runs a cell and returns what came back for it.
async function cell(session, id, code, ms = 20000) {
  const from = events.length
  const r = await call('nb:execute', session, id, code)
  if (!r.ok) return { error: r.error, events: [] }
  const t0 = Date.now()
  for (;;) {
    const mine = events.slice(from).filter(([s, c]) => s === session && c === id).map((e) => e[2])
    if (mine.some((e) => e.type === 'done')) {
      return {
        events: mine,
        out: mine.filter((e) => e.type === 'stream' && e.name === 'stdout').map((e) => e.text).join(''),
        err: mine.filter((e) => e.type === 'stream' && e.name === 'stderr').map((e) => e.text).join(''),
        result: mine.find((e) => e.type === 'result')?.data?.['text/plain'],
        display: mine.filter((e) => e.type === 'display').map((e) => e.data),
        error: mine.find((e) => e.type === 'error'),
        ok: mine.find((e) => e.type === 'done').ok
      }
    }
    if (Date.now() - t0 > ms) throw new Error('Timed out running: ' + code.slice(0, 40) + ' (got ' + mine.map((e) => e.type).join(',') + ')')
    await sleep(25)
  }
}

;(async () => {
  const kernels = await call('nb:kernels')
  check('the JavaScript kernel is always offered', kernels.some((k) => k.id === 'javascript'), JSON.stringify(kernels))
  const cwd = path.join(os.tmpdir(), 'nb-cwd-' + process.pid); fs.mkdirSync(cwd, { recursive: true })

  // ---------------- JavaScript
  let r = await call('nb:start', 'javascript', cwd)
  check('a JavaScript kernel starts', r.ok === true, JSON.stringify(r))
  const js = r.session
  let x = await cell(js, 'a', '1 + 1')
  check('the value of the last expression is the result', x.ok && x.result === '2', JSON.stringify(x.result))
  x = await cell(js, 'b', 'const total = 40; let name = "kernel"; console.log("hello", name); console.error("careful")')
  check('console output arrives as streams (stdout and stderr apart)', x.out === 'hello kernel\n' && x.err === 'careful\n' && x.result === undefined, JSON.stringify([x.out, x.err]))
  x = await cell(js, 'c', 'total + 2')
  check('variables stay between cells', x.result === '42', JSON.stringify(x.result))
  x = await cell(js, 'd', 'function double(n) { return n * 2 }\ndouble(total)')
  check('a multi-line cell gives the value of its last statement', x.result === '80')
  x = await cell(js, 'e', 'new Promise((res) => setTimeout(() => res("later"), 150))')
  check('a promise is awaited', x.ok && x.result === "'later'", JSON.stringify(x.result))
  x = await cell(js, 'f', 'null.boom')
  check('an error is reported with its name, message and a traceback; the kernel lives on', !x.ok && x.error.ename === 'TypeError' && /null/.test(x.error.evalue) && x.error.traceback.length > 0, JSON.stringify(x.error))
  x = await cell(js, 'g', 'total')
  check('still has its variables after an error', x.result === '40')
  x = await cell(js, 'h', 'let = = 1')
  check('a syntax error is an error too, not a crash', !x.ok && x.error.ename === 'SyntaxError')
  x = await cell(js, 'i', 'display({ a: 1, b: [2, 3] }); 5')
  check('display() shows an object in the output, then the result follows', x.display.length === 1 && /a: 1/.test(x.display[0]['text/plain']) && x.result === '5', JSON.stringify(x.display))
  x = await cell(js, 'j', "require('path').basename(process.cwd())")
  check('the kernel runs in the notebook\'s folder and can require modules', x.result === `'${path.basename(cwd)}'`, x.result)
  x = await cell(js, 'k', 'await 1')
  check('top-level await is not supported (it is an error with a clear name)', !x.ok && x.error.ename === 'SyntaxError')
  // Cells sent together run one after another
  const from = events.length
  await call('nb:execute', js, 'q1', 'console.log("one"); new Promise((r) => setTimeout(r, 200))')
  await call('nb:execute', js, 'q2', 'console.log("two")')
  const t0 = Date.now()
  while (events.slice(from).filter((e) => e[2].type === 'done').length < 2 && Date.now() - t0 < 10000) await sleep(25)
  const order = events.slice(from).filter((e) => e[2].type === 'stream').map((e) => e[2].text.trim())
  check('cells sent together are run in order', order.join() === 'one,two', order.join())
  x = await cell(js, 'l', 'for (let i = 0; i < 3; i++) console.log("line " + i)')
  check('several outputs arrive in order', x.out === 'line 0\nline 1\nline 2\n')
  await call('nb:stop', js)
  const t1 = Date.now()
  while (exits.length === 0 && Date.now() - t1 < 8000) await sleep(50)
  check('stopping the kernel ends its process (and the editor is told)', exits.length === 1 && exits[0][0] === js, JSON.stringify(exits))
  const dead = await call('nb:execute', js, 'z', '1')
  check('running a cell on a stopped kernel says so', dead.ok === false && /not running/.test(dead.error))
  r = await call('nb:start', 'javascript', cwd)
  x = await cell(r.session, 'm', 'typeof total')
  check('a restarted kernel starts clean', x.result === "'undefined'")
  await call('nb:stop', r.session)
  check('an unknown kernel is refused', (await call('nb:start', 'ruby', cwd)).ok === false)

  // ---------------- Python
  if (kernels.some((k) => k.id === 'python')) {
    r = await call('nb:start', 'python', cwd)
    check('a Python kernel starts', r.ok === true, JSON.stringify(r))
    const py = r.session
    x = await cell(py, 'p1', '1 + 1')
    check('Python: the value of the last expression is the result', x.ok && x.result === '2', JSON.stringify(x))
    x = await cell(py, 'p2', 'name = "kernel"\nprint("hello", name)\nimport sys\nprint("careful", file=sys.stderr)')
    check('Python: print goes to stdout and stderr to stderr', x.out === 'hello kernel\n' && x.err === 'careful\n' && x.result === undefined, JSON.stringify([x.out, x.err]))
    x = await cell(py, 'p3', 'def f(n):\n    return n * 3\nf(14)')
    check('Python: a function defined in a cell, and the value of the last line', x.result === '42')
    x = await cell(py, 'p4', 'f(2) + len(name)')
    check('Python: variables and functions stay between cells', x.result === '12')
    x = await cell(py, 'p5', '1 / 0')
    check('Python: an error has its name, message and traceback', !x.ok && x.error.ename === 'ZeroDivisionError' && /division/.test(x.error.evalue) && x.error.traceback.some((l) => /ZeroDivisionError/.test(l)) && x.error.traceback.some((l) => /<cell>/.test(l)), JSON.stringify(x.error))
    check('Python: the driver\'s own frames are left out of the traceback', !x.error.traceback.some((l) => /_run|driver/.test(l)), JSON.stringify(x.error.traceback))
    x = await cell(py, 'p6', 'name')
    check('Python: still alive after an error', x.result === "'kernel'")
    x = await cell(py, 'p7', 'class Box:\n    def _repr_html_(self):\n        return "<b>boxed</b>"\n    def __repr__(self):\n        return "Box()"\nBox()')
    check('Python: an object with _repr_html_ gives both an HTML and a plain-text result', x.events.some((e) => e.type === 'result' && e.data['text/html'] === '<b>boxed</b>' && e.data['text/plain'] === 'Box()'), JSON.stringify(x.events.filter((e) => e.type === 'result')))
    x = await cell(py, 'p8', 'display("shown")\n"after"')
    check('Python: display() and the final result', x.display.length === 1 && x.display[0]['text/plain'] === "'shown'" && x.result === "'after'")
    // input(): the kernel asks, the answer is sent back, and a cancelled prompt ends the cell with an error.
    const answerWith = (id, value) => {
      let sent = false
      const t = setInterval(() => {
        if (!sent && events.some(([s, c, ev]) => s === py && c === id && ev.type === 'input_request')) { sent = true; clearInterval(t); call('nb:input', py, value) }
      }, 20)
    }
    answerWith('p9', 'Ada')
    x = await cell(py, 'p9', 'input("name? ")')
    check('Python: input() asks, and the answer is the result', x.ok && x.result === "'Ada'" && x.events.some((e) => e.type === 'input_request' && e.prompt === 'name? '), JSON.stringify(x.events))
    answerWith('p9b', null)
    x = await cell(py, 'p9b', 'input()')
    check('Python: a cancelled input() ends the cell with an error', !x.ok, JSON.stringify(x.error))
    x = await cell(py, 'p10', 'import os\nos.system("echo from-a-child-process")\n"done"')
    check('Python: output of a child process cannot break the notebook', x.ok && x.result === "'done'")
    x = await cell(py, 'p11', 'x = 5\nx')
    check('Python: assignment then expression', x.result === '5')
    x = await cell(py, 'p12', 'x = 6')
    check('Python: a cell that ends in an assignment has no result', x.ok && x.result === undefined)
    x = await cell(py, 'p13', 'print("é ü 日本語")')
    check('Python: non-English text survives', x.out === 'é ü 日本語\n', JSON.stringify(x.out))
    x = await cell(py, 'p14', 'import os\nos.path.basename(os.getcwd())')
    check('Python: runs in the notebook\'s folder', x.result === `'${path.basename(cwd)}'`, x.result)
    x = await cell(py, 'p15', 'def broken(:\n    pass')
    check('Python: a syntax error is an error, not a crash', !x.ok && x.error.ename === 'SyntaxError')
    x = await cell(py, 'p16', 'import time\nfor i in range(3):\n    print(i, flush=True)\n    time.sleep(0.05)')
    check('Python: output arrives while the cell runs', x.out === '0\n1\n2\n')
    await call('nb:stop', py)
  } else {
    console.log('SKIP  Python is not installed here: the Python kernel was not tested')
  }

  fs.rmSync(cwd, { recursive: true, force: true })
  fs.rmSync(path.join(os.tmpdir(), 'nb-test-' + process.pid), { recursive: true, force: true })
  const failed = results.filter((v) => !v).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + (e && e.stack || e)); process.exit(1) })
