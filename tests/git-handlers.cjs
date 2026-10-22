// Runs the real git handlers (src/main/git.ts) against throwaway repositories, with a stub for Electron.
// `npm run test:git`: needs git on PATH; it does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), { execSync } = require('child_process')
const handlers = {}
const trashed = []
global.__electronStub = {
  ipcMain: { handle: (name, fn) => { handlers[name] = fn }, on: () => {} },
  shell: { trashItem: async (p) => { trashed.push(p); fs.rmSync(p, { force: true, recursive: true }) } },
  app: { getPath: () => os.tmpdir() }, safeStorage: {}, BrowserWindow: class {}
}
// Build src/main/git.ts into a plain Node module (Electron replaced by the stub above) and register its handlers.
const root = path.join(__dirname, '..')
const stubFile = path.join(root, 'node_modules', '.cache', 'git-handlers-electron-stub.cjs')
const bundleFile = path.join(root, 'node_modules', '.cache', 'git-handlers-bundle.cjs')
fs.mkdirSync(path.dirname(stubFile), { recursive: true })
fs.writeFileSync(stubFile, 'module.exports = global.__electronStub')
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'git.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['@anthropic-ai/sdk'], alias: { electron: stubFile }, outfile: bundleFile, logLevel: 'error'
})
require(bundleFile).registerGitHandlers()
const call = (n, ...a) => handlers[n]({}, ...a)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 200) : ''}`) }
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString()
const mk = (name) => { const d = path.join(os.tmpdir(), 'git-test-' + name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d }
const w = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ident = (dir) => { sh('git config user.name "Test User"', dir); sh('git config user.email test@example.com', dir) }
const files = (s) => s.files.map((f) => `${f.index}${f.work} ${f.rel}`).sort()

;(async () => {
  // --- not a repo
  const plain = mk('plain'); w(plain, 'a.txt', 'a\n')
  let st = await call('git:status', plain)
  check('folder that is not a repo is reported as such', st.state === 'norepo', st.state)
  check('git init works', (await call('git:init', plain)).ok === true)
  ident(plain)

  // --- repo with no commits yet
  st = await call('git:status', plain)
  check('repo with no commits: branch name and untracked file', st.state === 'ok' && !!st.branch && st.hasCommits === false && files(st).join() === '?? a.txt', JSON.stringify({ b: st.branch, f: files(st), c: st.hasCommits }))
  check('stage works before the first commit', (await call('git:stage', plain, ['a.txt'])).ok && files(await call('git:status', plain)).join() === 'A  a.txt')
  check('unstage works before the first commit', (await call('git:unstage', plain, ['a.txt'])).ok && files(await call('git:status', plain)).join() === '?? a.txt')
  check('commit with nothing staged is refused with a clear message', /Nothing is staged/.test((await call('git:commit', plain, 'x')).error))
  await call('git:stage', plain, null)
  check('commit with an empty message is refused', /commit message/.test((await call('git:commit', plain, '   ')).error))
  check('commit succeeds (multi-line message kept)', (await call('git:commit', plain, 'First commit\n\nWith a body line.')).ok === true && sh('git log -1 --format=%B', plain).includes('With a body line.'))

  // --- working states
  w(plain, 'a.txt', 'a changed\n'); w(plain, 'new.txt', 'n\n'); w(plain, 'dir/b.txt', 'b\n')
  await call('git:stage', plain, ['dir/b.txt'])
  st = await call('git:status', plain)
  check('status shows modified, untracked and staged', files(st).join() === ' M a.txt|A  dir/b.txt|?? new.txt'.split('|').sort().join(), files(st).join())
  check('paths use forward slashes and absolute paths resolve', st.files.every((f) => !f.rel.includes('\\') && fs.existsSync(f.abs)))
  const d1 = await call('git:diff', plain, 'a.txt', false)
  check('unstaged diff: index version vs working copy', d1.original === 'a\n' && d1.modified === 'a changed\n', JSON.stringify(d1))
  const d2 = await call('git:diff', plain, 'dir/b.txt', true)
  check('staged diff: HEAD (empty for a new file) vs index', d2.original === '' && d2.modified === 'b\n', JSON.stringify(d2))
  const lc = await call('git:lineChanges', plain, 'a.txt')
  check('line changes: one modified line', lc.changes.length === 1 && lc.changes[0].kind === 'modified' && lc.changes[0].start === 1, JSON.stringify(lc))
  check('line changes: untracked file flagged', (await call('git:lineChanges', plain, 'new.txt')).untracked === true)
  w(plain, 'a.txt', 'a\nadded1\nadded2\n'); w(plain, 'del.txt', '1\n2\n3\n4\n'); await call('git:stage', plain, ['del.txt']); await call('git:commit', plain, 'add del'); w(plain, 'del.txt', '1\n4\n')
  const lc2 = await call('git:lineChanges', plain, 'a.txt'); const lc3 = await call('git:lineChanges', plain, 'del.txt')
  check('line changes: added lines', lc2.changes.some((c) => c.kind === 'added' && c.start === 2 && c.end === 3), JSON.stringify(lc2))
  check('line changes: deleted lines marked', lc3.changes.some((c) => c.kind === 'deleted'), JSON.stringify(lc3))

  // --- discard
  const discardOk = (await call('git:discard', plain, ['a.txt'], [])).ok
  const afterDiscard = fs.readFileSync(path.join(plain, 'a.txt'), 'utf8')
  // Git for Windows may write CRLF line endings back (core.autocrlf), so compare without them.
  check('discard restores a tracked file', discardOk && afterDiscard.replace(/\r/g, '') === 'a\n', JSON.stringify(afterDiscard))
  const before = trashed.length
  await call('git:discard', plain, [], ['new.txt'])
  check('discard of an untracked file goes to the Recycle Bin', trashed.length === before + 1 && !fs.existsSync(path.join(plain, 'new.txt')))

  // --- rename and delete
  await call('git:stage', plain, null); await call('git:commit', plain, 'sync')
  sh('git mv a.txt renamed.txt', plain); fs.rmSync(path.join(plain, 'del.txt'))
  st = await call('git:status', plain)
  const ren = st.files.find((f) => f.rel === 'renamed.txt')
  check('rename reported with its old path', !!ren && ren.index === 'R' && ren.orig === 'a.txt', JSON.stringify(ren))
  check('deleted file reported', files(st).includes(' D del.txt'), files(st).join())
  check('stage-all and unstage-all', (await call('git:stage', plain, null)).ok && (await call('git:status', plain)).files.every((f) => f.index !== ' ') && (await call('git:unstage', plain, null)).ok && (await call('git:status', plain)).files.some((f) => f.work !== ' '))
  await call('git:stage', plain, null); await call('git:commit', plain, 'rename and delete')

  // --- branches
  let br = await call('git:branches', plain)
  check('branch list marks the current one', br.ok && br.branches.length === 1 && br.branches[0].current)
  check('create and switch to a branch', (await call('git:checkout', plain, 'feature/x', true)).ok && sh('git branch --show-current', plain).trim() === 'feature/x')
  check('invalid branch names are refused', /not a valid branch name/.test((await call('git:checkout', plain, 'bad name..', true)).error))
  const main = br.branches[0].name
  check('switch back to an existing branch', (await call('git:checkout', plain, main, false)).ok && (await call('git:status', plain)).branch === main)
  w(plain, 'conflict.txt', 'on main\n'); await call('git:stage', plain, null); await call('git:commit', plain, 'main change')
  check('failed checkouts surface git\'s message', !(await call('git:checkout', plain, 'does-not-exist', false)).ok)

  // --- remote: push, pull against a local bare repository
  const bare = mk('bare.git'); sh('git init --bare', bare)
  sh(`git remote add origin "${bare}"`, plain)
  const push1 = await call('git:remote', plain, 'push')
  check('push sets the upstream automatically the first time', push1.ok === true && /--set-upstream|origin/.test(push1.output || '') || push1.ok === true, JSON.stringify(push1))
  st = await call('git:status', plain)
  check('after push: upstream known, nothing ahead', !!st.upstream && st.ahead === 0, JSON.stringify({ u: st.upstream, a: st.ahead }))
  const other = mk('clone'); sh(`git clone "${bare}" .`, other); ident(other); w(other, 'from-other.txt', 'x\n'); sh('git add -A', other); sh('git commit -m other', other); sh('git push', other)
  await call('git:remote', plain, 'fetch')
  st = await call('git:status', plain)
  check('after fetch: behind by one', st.behind === 1, String(st.behind))
  check('pull brings it in', (await call('git:remote', plain, 'pull')).ok && fs.existsSync(path.join(plain, 'from-other.txt')))
  w(plain, 'local.txt', 'l\n'); await call('git:stage', plain, null); await call('git:commit', plain, 'local')
  st = await call('git:status', plain)
  check('ahead count after a local commit', st.ahead === 1, String(st.ahead))

  // --- project folder is a subfolder of the repo
  w(plain, 'sub/inner.txt', 'i\n'); await call('git:stage', plain, null); await call('git:commit', plain, 'sub'); w(plain, 'sub/inner.txt', 'changed\n'); w(plain, 'outside.txt', 'o\n')
  st = await call('git:status', path.join(plain, 'sub'))
  const inner = st.files.find((f) => f.rel === 'inner.txt'); const outside = st.files.find((f) => f.rel === '../outside.txt')
  check('subfolder project: paths are relative to the folder, outside changes marked with ..', !!inner && !!outside, files(st).join())
  check('subfolder project: diff and stage use folder-relative paths', (await call('git:stage', path.join(plain, 'sub'), ['inner.txt'])).ok && (await call('git:status', plain)).files.find((f) => f.rel === 'sub/inner.txt').index === 'M')

  // --- safety
  let threw = false
  try { await call('git:stage', plain, ['../escape.txt']) } catch { threw = true }
  check('paths outside the project are refused', threw)
  check('operations in a non-repo fail cleanly (no crash)', (await call('git:stage', mk('empty'), ['x'])).ok === false)

  for (const d of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('git-test-'))) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true })
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})()
