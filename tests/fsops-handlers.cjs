// Runs the real file-operation handlers and watcher (src/main/fsops.ts) on throwaway folders, with a stub for
// Electron. `npm run test:fsops`. It does not start the app.
const fs = require('fs'), os = require('os'), path = require('path')
const handlers = {}
const trashed = []
const sent = []
let clipboardText = ''
global.__electronStub = {
  ipcMain: { handle: (name, fn) => { handlers[name] = fn }, on: () => {} },
  shell: { trashItem: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }) }, showItemInFolder: () => {} },
  clipboard: { writeText: (t) => { clipboardText = t } },
  BrowserWindow: class {}
}
const root = path.join(__dirname, '..')
const stubFile = path.join(root, 'node_modules', '.cache', 'fsops-electron-stub.cjs')
const bundleFile = path.join(root, 'node_modules', '.cache', 'fsops-bundle.cjs')
fs.mkdirSync(path.dirname(stubFile), { recursive: true })
fs.writeFileSync(stubFile, 'module.exports = global.__electronStub')
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src', 'main', 'fsops.ts')], bundle: true, platform: 'node', format: 'cjs', alias: { electron: stubFile }, outfile: bundleFile, logLevel: 'error' })
require(bundleFile).registerFsOps(() => ({ webContents: { send: (channel, payload) => sent.push({ channel, payload }) } }))
const call = (n, ...a) => handlers[n]({}, ...a)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 200) : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const proj = path.join(os.tmpdir(), 'fsops-test-project')
const outside = path.join(os.tmpdir(), 'fsops-test-outside')

;(async () => {
  for (const d of [proj, outside]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }) }
  fs.mkdirSync(path.join(proj, 'src'))
  fs.writeFileSync(path.join(proj, 'a.txt'), 'a')

  // --- create
  check('create a file', (await call('fs:createFile', proj, path.join(proj, 'new.txt'))).ok && fs.existsSync(path.join(proj, 'new.txt')))
  check('create in a subfolder', (await call('fs:createFile', proj, path.join(proj, 'src', 'x.ts'))).ok)
  const dup = await call('fs:createFile', proj, path.join(proj, 'a.txt'))
  check('creating over an existing file is refused and the file is untouched', !dup.ok && /already exists/.test(dup.error) && fs.readFileSync(path.join(proj, 'a.txt'), 'utf8') === 'a', dup.error)
  check('create a folder', (await call('fs:createDir', proj, path.join(proj, 'docs'))).ok && fs.statSync(path.join(proj, 'docs')).isDirectory())
  check('creating a folder that exists is refused', !(await call('fs:createDir', proj, path.join(proj, 'docs'))).ok)
  for (const bad of ['a:b.txt', 'what?.txt', 'x*.txt', 'pipe|.txt', 'trailing.', 'trailing ', 'q"uote.txt']) {
    const r = await call('fs:createFile', proj, path.join(proj, bad))
    check(`invalid name refused: ${JSON.stringify(bad)}`, !r.ok && /not a valid name/.test(r.error), r.error)
  }
  check('".." as a name is refused', !(await call('fs:createFile', proj, path.join(proj, 'src', '..'))).ok)
  const esc1 = await call('fs:createFile', proj, path.join(proj, '..', 'fsops-test-outside', 'evil.txt'))
  check('a path that climbs out of the project is refused', !esc1.ok && !fs.existsSync(path.join(outside, 'evil.txt')), esc1.error)
  const esc2 = await call('fs:createFile', proj, path.join(outside, 'evil2.txt'))
  check('an absolute path elsewhere is refused', !esc2.ok && !fs.existsSync(path.join(outside, 'evil2.txt')))
  const noParent = await call('fs:createFile', proj, path.join(proj, 'missing', 'x.txt'))
  check('a missing parent folder gives a clear error', !noParent.ok && /no longer exists|outside/.test(noParent.error), noParent.error)

  // --- rename / move
  check('rename a file', (await call('fs:rename', proj, path.join(proj, 'new.txt'), path.join(proj, 'renamed.txt'))).ok && fs.existsSync(path.join(proj, 'renamed.txt')) && !fs.existsSync(path.join(proj, 'new.txt')))
  const over = await call('fs:rename', proj, path.join(proj, 'renamed.txt'), path.join(proj, 'a.txt'))
  check('renaming onto an existing file is refused (nothing overwritten)', !over.ok && fs.readFileSync(path.join(proj, 'a.txt'), 'utf8') === 'a' && fs.existsSync(path.join(proj, 'renamed.txt')), over.error)
  check('a rename that only changes the case works', (await call('fs:rename', proj, path.join(proj, 'renamed.txt'), path.join(proj, 'Renamed.txt'))).ok && fs.readdirSync(proj).includes('Renamed.txt'))
  check('move into another folder inside the project', (await call('fs:rename', proj, path.join(proj, 'Renamed.txt'), path.join(proj, 'docs', 'Renamed.txt'))).ok && fs.existsSync(path.join(proj, 'docs', 'Renamed.txt')))
  check('rename a folder', (await call('fs:rename', proj, path.join(proj, 'docs'), path.join(proj, 'documents'))).ok && fs.existsSync(path.join(proj, 'documents', 'Renamed.txt')))
  const mvOut = await call('fs:rename', proj, path.join(proj, 'a.txt'), path.join(outside, 'a.txt'))
  check('moving a file out of the project is refused', !mvOut.ok && fs.existsSync(path.join(proj, 'a.txt')), mvOut.error)
  fs.writeFileSync(path.join(outside, 'o.txt'), 'o')
  check('renaming something outside the project is refused', !(await call('fs:rename', proj, path.join(outside, 'o.txt'), path.join(proj, 'o.txt'))).ok && fs.existsSync(path.join(outside, 'o.txt')))
  check('renaming to an invalid name is refused', !(await call('fs:rename', proj, path.join(proj, 'a.txt'), path.join(proj, 'a?.txt'))).ok)

  // --- delete (Recycle Bin)
  const before = trashed.length
  check('delete sends the item to the Recycle Bin', (await call('fs:trash', proj, path.join(proj, 'a.txt'))).ok && trashed.length === before + 1 && !fs.existsSync(path.join(proj, 'a.txt')))
  check('a folder can be deleted too', (await call('fs:trash', proj, path.join(proj, 'documents'))).ok && !fs.existsSync(path.join(proj, 'documents')))
  check('deleting outside the project is refused', !(await call('fs:trash', proj, path.join(outside, 'o.txt'))).ok && fs.existsSync(path.join(outside, 'o.txt')))
  check('deleting the project folder itself is refused', !(await call('fs:trash', proj, proj)).ok && fs.existsSync(proj))

  // --- replace in files
  const rp = path.join(os.tmpdir(), 'fsops-replace-project'); fs.rmSync(rp, { recursive: true, force: true }); fs.mkdirSync(rp, { recursive: true })
  const wr = (n, t) => fs.writeFileSync(path.join(rp, n), t)
  const rd = (n) => fs.readFileSync(path.join(rp, n), 'utf8')
  const rep = (q, r, o, t) => call('fs:replace', rp, q, r, { caseSensitive: false, regex: false, ...o }, t)
  wr('a.txt', 'foo bar foo\nFOO line\nnothing\n'); wr('b.txt', 'one foo\r\ntwo\r\nfoo three\r\n')
  let r1 = await rep('foo', 'baz', {}, [{ path: path.join(rp, 'a.txt') }, { path: path.join(rp, 'b.txt') }])
  check('replace all in two files: counts every match (case-insensitive by default)', r1.ok && r1.replaced === 5 && r1.files === 2 && rd('a.txt') === 'baz bar baz\nbaz line\nnothing\n', JSON.stringify(r1) + JSON.stringify(rd('a.txt')))
  check('Windows line endings (CRLF) are preserved', rd('b.txt') === 'one baz\r\ntwo\r\nbaz three\r\n', JSON.stringify(rd('b.txt')))
  wr('c.txt', 'Foo foo FOO\n')
  const r2 = await rep('foo', 'x', { caseSensitive: true }, [{ path: path.join(rp, 'c.txt') }])
  check('match case: only the exact-case occurrence changes', r2.replaced === 1 && rd('c.txt') === 'Foo x FOO\n', rd('c.txt'))
  wr('d.txt', 'cost: 5\n')
  await rep('cost', '$1 and $& and $$', {}, [{ path: path.join(rp, 'd.txt') }])
  check('plain-text mode inserts the replacement exactly as typed ($ is not special)', rd('d.txt') === '$1 and $& and $$: 5\n', rd('d.txt'))
  wr('e.txt', 'name: Ada\nname: Bob\n')
  const r3 = await rep('name: (\\w+)', '$1 is the name ($& / $$ / $9)', { regex: true }, [{ path: path.join(rp, 'e.txt') }])
  check('regex mode: $1, $& and $$ work; a group that does not exist stays literal', r3.replaced === 2 && rd('e.txt') === 'Ada is the name (name: Ada / $ / $9)\nBob is the name (name: Bob / $ / $9)\n', JSON.stringify(rd('e.txt')))
  wr('f.txt', 'key=value\n')
  await rep('(?<k>\\w+)=(?<v>\\w+)', '$<v>=$<k>', { regex: true }, [{ path: path.join(rp, 'f.txt') }])
  check('regex mode: named groups', rd('f.txt') === 'value=key\n', rd('f.txt'))
  wr('g.txt', 'a\nb\n')
  await rep('^', '> ', { regex: true }, [{ path: path.join(rp, 'g.txt') }])
  check('an empty match (^) prefixes every line without hanging', rd('g.txt') === '> a\n> b\n', JSON.stringify(rd('g.txt')))
  wr('h.txt', 'x\nx\nx\n')
  const r4 = await rep('x', 'y', {}, [{ path: path.join(rp, 'h.txt'), lines: [2] }])
  check('limiting to a line number changes only that line', r4.replaced === 1 && rd('h.txt') === 'x\ny\nx\n', rd('h.txt'))
  wr('i.txt', 'untouched\n'); const mtime = fs.statSync(path.join(rp, 'i.txt')).mtimeMs; await sleep(30)
  const r5 = await rep('zzz', 'q', {}, [{ path: path.join(rp, 'i.txt') }])
  check('a file with no matches is not rewritten', r5.ok && r5.replaced === 0 && r5.files === 0 && fs.statSync(path.join(rp, 'i.txt')).mtimeMs === mtime)
  const bad = await rep('(', 'x', { regex: true }, [{ path: path.join(rp, 'i.txt') }])
  check('an invalid regular expression is reported, nothing changes', !bad.ok && rd('i.txt') === 'untouched\n', bad.error)
  check('an empty search is refused', !(await rep('', 'x', {}, [{ path: path.join(rp, 'i.txt') }])).ok)
  fs.writeFileSync(path.join(rp, 'bin.dat'), Buffer.from([102, 111, 111, 0, 102, 111, 111]))
  fs.writeFileSync(path.join(rp, 'big.txt'), 'foo '.repeat(300000))
  const r6 = await rep('foo', 'bar', {}, [{ path: path.join(rp, 'bin.dat') }, { path: path.join(rp, 'big.txt') }, { path: path.join(outside, 'o.txt') }, { path: path.join(rp, 'missing.txt') }])
  check('binary, oversized, outside-the-project and missing files are skipped with a reason', r6.ok && r6.replaced === 0 && r6.skipped.length === 4 && fs.readFileSync(path.join(outside, 'o.txt'), 'utf8') === 'o', JSON.stringify(r6.skipped))
  wr('bom.txt', '﻿foo é ✓\n')
  await rep('foo', 'bar', {}, [{ path: path.join(rp, 'bom.txt') }])
  check('a byte-order mark and non-ASCII text survive', rd('bom.txt') === '﻿bar é ✓\n', JSON.stringify(rd('bom.txt')))
  fs.rmSync(rp, { recursive: true, force: true })

  // --- clipboard
  await call('app:copyText', 'C:\\some\\path.txt')
  check('copy text goes to the clipboard', clipboardText === 'C:\\some\\path.txt')

  // --- watcher
  sent.length = 0
  fs.mkdirSync(path.join(proj, 'node_modules')); fs.mkdirSync(path.join(proj, '.git'))
  await call('fs:watch', proj)
  await sleep(300)
  fs.writeFileSync(path.join(proj, 'w1.txt'), '1'); fs.writeFileSync(path.join(proj, 'src', 'w2.ts'), '2'); fs.writeFileSync(path.join(proj, 'w1.txt'), '1b')
  await sleep(900)
  const ev1 = sent.filter((s) => s.channel === 'fs:changed')
  check('a burst of changes arrives as ONE batched event with every path', ev1.length === 1 && ev1[0].payload.paths.some((p) => p.endsWith('w1.txt')) && ev1[0].payload.paths.some((p) => p.endsWith('w2.ts')) && ev1[0].payload.git === false, JSON.stringify(ev1.map((e) => e.payload)).slice(0, 200))
  sent.length = 0
  fs.writeFileSync(path.join(proj, 'node_modules', 'ignored.js'), 'x')
  await sleep(700)
  check('changes inside node_modules are ignored', sent.length === 0, JSON.stringify(sent))
  fs.writeFileSync(path.join(proj, '.git', 'config-noise'), 'x')
  await sleep(700)
  check('noise inside .git is ignored', sent.length === 0, JSON.stringify(sent))
  fs.writeFileSync(path.join(proj, '.git', 'index'), 'x')
  await sleep(700)
  const ev3 = sent.filter((s) => s.channel === 'fs:changed')
  check('a change to .git/index is reported as a git change', ev3.length === 1 && ev3[0].payload.git === true, JSON.stringify(ev3.map((e) => e.payload)))
  await call('fs:watch', null)
  sent.length = 0
  fs.writeFileSync(path.join(proj, 'after-stop.txt'), 'x')
  await sleep(600)
  check('stopping the watcher stops the events', sent.length === 0)

  for (const d of [proj, outside]) fs.rmSync(d, { recursive: true, force: true })
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})()
