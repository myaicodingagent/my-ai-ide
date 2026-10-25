// Git in a folder inside a WSL distribution: the real git module runs git INSIDE the distribution (so a repository of another
// user is no problem and worktrees stay readable there). Default Ubuntu-24.04, WSL_TEST_DISTRO to change.
// `npm run test:wsl-git`: skipped without the distribution (needs git in it); does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const distro = process.env.WSL_TEST_DISTRO || 'Ubuntu-24.04'
const wsl = (script) => cp.spawnSync('wsl.exe', ['-d', distro, '--user', 'root', '--exec', 'sh', '-c', script], { encoding: 'utf-8', windowsHide: true })
if (wsl('command -v git').status !== 0) { console.log('SKIP  no WSL distribution ' + distro + ' with git'); process.exit(0) }
const handlers = {}
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-git-')))
global.__electronStub = { ipcMain: { handle: (n, f) => { handlers[n] = f } }, shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') } }
const root = path.join(__dirname, '..')
const stub = path.join(root, 'node_modules', '.cache', 'wsl-git-stub.cjs'), bundle = path.join(root, 'node_modules', '.cache', 'wsl-git-bundle.cjs'), entry = path.join(root, 'node_modules', '.cache', 'wsl-git-entry.ts')
fs.mkdirSync(path.dirname(stub), { recursive: true })
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
fs.writeFileSync(entry, `export * as git from ${JSON.stringify(path.join(root, 'src/main/git.ts').split(path.sep).join('/'))}\n`)
require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['ssh2', '@anthropic-ai/sdk'], alias: { electron: stub }, outfile: bundle, logLevel: 'error' })
const { git } = require(bundle)
git.registerGitHandlers()
const call = (n, ...a) => handlers[n]({}, ...a)
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }

;(async () => {
  const base = '/root/wslgit-' + process.pid
  const unc = '\\\\wsl.localhost\\' + distro + base.split('/').join('\\')
  const inDir = (script) => wsl(`cd ${base} && ${script}`)
  const g = (args) => inDir(`git -c user.name=t -c user.email=t@t ${args}`).stdout
  wsl(`rm -rf ${base} && mkdir -p ${base} && cd ${base} && git init -q && printf 'one\\n' > a.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm first`)
  try {
    let st = await call('git:status', unc)
    check('status works in a repository owned by another user (git runs inside the distribution): repository found, branch known, clean', st.state === 'ok' && !!st.branch && st.files.length === 0 && !st.unsafe, JSON.stringify(st))
    fs.writeFileSync(unc + '\\a.txt', 'one\ntwo\n'); fs.writeFileSync(unc + '\\b.txt', 'new\n')
    st = await call('git:status', unc)
    check('changed and new files are listed with paths relative to the folder', st.files.map((f) => f.rel).sort().join() === 'a.txt,b.txt', JSON.stringify(st.files))
    const d = await call('git:diff', unc, 'a.txt', false)
    check('the diff has both sides', d.original === 'one\n' && d.modified === 'one\ntwo\n', JSON.stringify(d))
    let r = await call('git:stage', unc, null)
    check('stage all', r.ok === true, JSON.stringify(r))
    r = await call('git:commit', unc, 'second: two files\n\nbody')
    check('commit sends the message through stdin', r.ok === true && g('log -1 --format=%B').startsWith('second: two files'), JSON.stringify(r))
    r = await call('git:checkout', unc, 'feature-x', true)
    check('create and switch branch', r.ok === true && g('branch --show-current').trim() === 'feature-x', JSON.stringify(r))
    check('status then shows the new branch', (await call('git:status', unc)).branch === 'feature-x')
  } finally {
    wsl(`rm -rf ${base}`)
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); wsl('rm -rf /root/wslgit-' + process.pid); process.exit(1) })
