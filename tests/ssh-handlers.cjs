// Runs the real SSH file module (src/main/sshfs.ts) against an SSH + SFTP server written with ssh2 that runs in this
// process and serves a temporary folder. `npm run test:ssh`: does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const handlers = {}
const tmp = path.join(os.tmpdir(), 'ssh-test-' + process.pid)
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true })
const remoteRoot = path.join(tmp, 'server-root'); fs.mkdirSync(remoteRoot, { recursive: true })
global.__electronStub = { ipcMain: { handle: (n, f) => { handlers[n] = f } }, shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') } }
const root = path.join(__dirname, '..')
const stub = path.join(root, 'node_modules', '.cache', 'ssh-stub.cjs'), bundle = path.join(root, 'node_modules', '.cache', 'ssh-bundle.cjs')
fs.mkdirSync(path.dirname(stub), { recursive: true })
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/main/sshfs.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['ssh2'], alias: { electron: stub }, outfile: bundle, logLevel: 'error' })
const mod = require(bundle)
mod.registerSshHandlers()
const call = (n, ...a) => handlers[n]({}, ...a)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rejects = async (p) => { try { await p; return null } catch (e) { return e } }


const local = (p) => path.join(remoteRoot, ...String(p).split('/').filter((s) => s && s !== '..'))
const server = require('./sshserver.cjs')(remoteRoot)

const w = (rel, text) => { const f = local(rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }

;(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port
  const addr = `tester@127.0.0.1:${port}`
  w('home/tester/proj/src/app.ts', 'export const a = 1\n'); w('home/tester/proj/readme.md', '# Hi\nneedle here\n'); w('home/tester/proj/node_modules/x/index.js', 'x'); w('home/tester/proj/.git/config', 'g'); w('home/tester/proj/zeta.txt', 'z'); w('home/tester/proj/src/deep/more.ts', 'const needle = 2\n')

  // ---- paths
  check('a remote path is recognised and split into the computer and the path', mod.isRemotePath('\\\\ssh.dev-box\\home\\me') && !mod.isRemotePath('C:\\x') && !mod.isRemotePath('\\\\server\\share') && !mod.isRemotePath('\\\\ssh.bad name\\x') && JSON.stringify(mod.parseRemote('\\\\ssh.Dev-Box\\home\\me\\a b')) === JSON.stringify({ name: 'dev-box', path: '/home/me/a b' }))
  check('the root of a computer, and the way back to a path', mod.parseRemote('\\\\ssh.box').path === '/' && mod.parseRemote('\\\\ssh.box\\').path === '/' && mod.remoteUnc('box', '/home/me') === '\\\\ssh.box\\home\\me' && mod.remoteUnc('box', '/') === '\\\\ssh.box')

  // ---- addresses and the ssh config file
  const cfg = path.join(tmp, 'config')
  fs.writeFileSync(cfg, '# comment\nHost work\n  HostName work.example.com\n  User alice\n  Port 2222\n  IdentityFile ~/.ssh/work_key\n\nHost *.internal other\n  User bob\n')
  const c1 = await mod.readSshConfig('work', cfg)
  check('Host entries of an ssh config file are read (host, user, port, key)', c1.found && c1.host === 'work.example.com' && c1.username === 'alice' && c1.port === 2222 && /work_key$/.test(c1.identityFile), JSON.stringify(c1))
  check('and a name that is not in it is not found', (await mod.readSshConfig('nothere', cfg)).found === false && (await mod.readSshConfig('work', path.join(tmp, 'missing'))).found === false)
  let pa = await mod.parseAddress('bob@host.example.com:2200')
  check('user@host:port is understood', pa.ok && pa.host.username === 'bob' && pa.host.host === 'host.example.com' && pa.host.port === 2200 && pa.host.name === 'host-example-com', JSON.stringify(pa))
  check('an address that could be read as an ssh option, or has odd characters, is refused', ['-oProxyCommand=x', 'a b@host', 'host;rm', 'u@h$(x)', ''].every((a) => true) && (await Promise.all(['-oProxyCommand=x', 'a b@host', 'host;rm', 'u@h$(x)', '', 'x'.repeat(300)].map((a) => mod.parseAddress(a)))).every((r) => r.ok === false))

  // ---- connecting: trust, then the password
  let r = await call('ssh:connect', addr)
  check('the first time, the server\'s identity must be confirmed (its fingerprint is shown)', r.ok === false && r.need === 'trust' && /^SHA256:/.test(r.fingerprint), JSON.stringify(r))
  const fp = r.fingerprint
  r = await call('ssh:connect', addr, { trust: fp })
  check('after trusting it, a password is needed (no key or agent here is accepted)', r.ok === false && r.need === 'password', JSON.stringify(r))
  r = await call('ssh:connect', addr, { trust: fp, password: 'wrong' })
  check('a wrong password is refused with a message', r.ok === false && r.need === 'password' && /not accepted/.test(r.error), JSON.stringify(r))
  r = await call('ssh:connect', addr, { password: 'secret' })
  check('with the right password it connects (the identity is remembered now) and reports the home folder', r.ok === true && r.home === '/home/tester' && r.name === '127-0-0-1', JSON.stringify(r))
  const name = r.name
  const known = JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'ssh', 'known-hosts.json'), 'utf8'))
  check('the server\'s fingerprint was saved', known[`127.0.0.1:${port}`] === fp)
  const conns = await call('ssh:connections')
  check('the connection is listed, and remembered (without any password)', conns.live.length === 1 && conns.live[0].label === 'tester@127.0.0.1' && conns.remembered[0].host === '127.0.0.1' && !JSON.stringify(conns).includes('secret') && !fs.readFileSync(path.join(tmp, 'userData', 'ssh', 'connections.json'), 'utf8').includes('secret'))
  r = await call('ssh:connect', addr)
  check('connecting again to a connected computer just answers', r.ok === true && r.home === '/home/tester')
  const base = mod.remoteUnc(name, '/home/tester/proj')

  // ---- reading
  const list = await mod.readDir(base)
  check('a folder is listed, folders first, without .git and node_modules', JSON.stringify(list.map((e) => (e.isDir ? 'd:' : 'f:') + e.name)) === JSON.stringify(['d:src', 'f:readme.md', 'f:zeta.txt']), JSON.stringify(list.map((e) => e.name)))
  check('entries carry paths in the editor\'s form', list[0].path === base + '\\src' && mod.parseRemote(list[0].path).path === '/home/tester/proj/src')
  check('a file is read as text', (await mod.readFile(base + '\\src\\app.ts')) === 'export const a = 1\n')
  let e = await rejects(mod.readFile(base + '\\nope.txt'))
  check('a missing file is a clear error', !!e && e.code === 'ENOENT' && /no longer exists/.test(e.message), e && e.message)
  check('isDir tells folders from files and missing things', (await mod.isDir(base)) === true && (await mod.isDir(base + '\\zeta.txt')) === false && (await mod.isDir(base + '\\nope')) === false)
  w('home/tester/big.bin', 'x'.repeat(5 * 1024 * 1024 + 10))
  e = await rejects(mod.readFile(mod.remoteUnc(name, '/home/tester/big.bin')))
  check('a file over 5 MB is not opened, and the message says why', !!e && /5 MB/.test(e.message), e && e.message)
  check('the size of a file can be asked', (await mod.statSize(base + '\\zeta.txt')) === 1)

  // ---- writing
  await mod.writeFile(base + '\\src\\app.ts', 'export const a = 2\n')
  check('saving writes the new text to the server (and replaces the old)', fs.readFileSync(local('home/tester/proj/src/app.ts'), 'utf8') === 'export const a = 2\n')
  await mod.writeFile(base + '\\new.txt', 'brand new', true)
  check('a new file can be created', fs.readFileSync(local('home/tester/proj/new.txt'), 'utf8') === 'brand new')
  e = await rejects(mod.writeFile(base + '\\new.txt', 'again', true))
  check('creating a file that exists is refused instead of overwriting it', !!e && e.code === 'EEXIST' && fs.readFileSync(local('home/tester/proj/new.txt'), 'utf8') === 'brand new')
  await mod.writeFile(base + '\\unicode.txt', 'é ü 日本語 🎉\n')
  check('non-English text survives the round trip', (await mod.readFile(base + '\\unicode.txt')) === 'é ü 日本語 🎉\n')
  await mod.mkdir(base + '\\newdir')
  check('a folder can be created', fs.statSync(local('home/tester/proj/newdir')).isDirectory())
  e = await rejects(mod.mkdir(base + '\\newdir'))
  check('and not twice', !!e && e.code === 'EEXIST')
  await mod.rename(base + '\\new.txt', base + '\\renamed.txt')
  check('a file can be renamed', !fs.existsSync(local('home/tester/proj/new.txt')) && fs.existsSync(local('home/tester/proj/renamed.txt')))
  e = await rejects(mod.rename(base + '\\renamed.txt', base + '\\zeta.txt'))
  check('but not onto another file', !!e && e.code === 'EEXIST' && fs.readFileSync(local('home/tester/proj/zeta.txt'), 'utf8') === 'z')
  await mod.rename(base + '\\renamed.txt', base + '\\Renamed.txt')
  check('a rename that only changes the case works', fs.readdirSync(local('home/tester/proj')).includes('Renamed.txt'))
  w('home/tester/proj/tree/a/b/c.txt', 'c'); w('home/tester/proj/tree/d.txt', 'd')
  await mod.remove(base + '\\tree')
  check('a folder is deleted with everything in it', !fs.existsSync(local('home/tester/proj/tree')))
  await mod.remove(base + '\\Renamed.txt')
  check('and a file', !fs.existsSync(local('home/tester/proj/Renamed.txt')))
  e = await rejects(mod.remove(mod.remoteUnc(name, '/')))
  check('the root of the server cannot be deleted', !!e && /root/.test(e.message))

  // ---- finding things
  const files = await mod.listFiles(base)
  check('the files of a folder tree are listed for Quick Open (not .git or node_modules)', files.map((f) => mod.parseRemote(f).path.replace('/home/tester/proj/', '')).sort().join() === 'readme.md,src/app.ts,src/deep/more.ts,unicode.txt,zeta.txt', JSON.stringify(files.map((f) => f.slice(-20))))
  const found = await mod.search(base, 'needle', { caseSensitive: false, regex: false })
  check('text is searched in every file, with the line and a relative path', found.matches.length === 2 && found.matches.some((m) => m.rel === 'readme.md' && m.line === 2) && found.matches.some((m) => m.rel === 'src/deep/more.ts' && m.line === 1), JSON.stringify(found.matches.map((m) => [m.rel, m.line])))
  const rx = await mod.search(base, 'ne+dle$', { caseSensitive: true, regex: true })
  check('a regular expression works too (and case can matter)', rx.matches.length === 0 && (await mod.search(base, 'N[a-z]+LE', { caseSensitive: false, regex: true })).matches.length === 2)
  check('a bad regular expression gives its error', !!(await mod.search(base, '(', { caseSensitive: false, regex: true })).error)

  // ---- choosing a folder
  const b1 = await call('ssh:browse', name, '')
  check('browsing starts at the home folder and lists only its visible folders', b1.ok && b1.path === '/home/tester' && b1.dirs.join() === 'proj' && b1.parent === '/home', JSON.stringify(b1))
  const b2 = await call('ssh:browse', name, '/home/tester/proj')
  check('and goes down and up', b2.dirs.join() === 'newdir,node_modules,src' && b2.parent === '/home/tester')
  check('a folder that does not exist gives an error, not a crash', (await call('ssh:browse', name, '/nope/nothing')).ok === false)
  check('asking about a computer that is not connected fails clearly', (await call('ssh:browse', 'nobody', '/')).ok === false)

  // ---- the identity changing
  mod.disconnectAll()
  e = await rejects(mod.readDir(base))
  check('after disconnecting, files of that computer say that it is not connected', !!e && /Not connected/.test(e.message))
  const fixed = JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'ssh', 'known-hosts.json'), 'utf8'))
  fixed[`127.0.0.1:${port}`] = 'SHA256:somethingelseentirely'
  fs.writeFileSync(path.join(tmp, 'userData', 'ssh', 'known-hosts.json'), JSON.stringify(fixed))
  r = await call('ssh:connect', addr, { password: 'secret', trust: fp })
  check('if the server\'s identity has changed, the connection is refused with a warning (trust cannot override it)', r.ok === false && !r.need && /CHANGED/.test(r.error), JSON.stringify(r))
  fixed[`127.0.0.1:${port}`] = fp
  fs.writeFileSync(path.join(tmp, 'userData', 'ssh', 'known-hosts.json'), JSON.stringify(fixed))
  r = await call('ssh:ensure', base, { password: 'secret' })
  check('a remembered computer can be reconnected from a folder path', r.ok === true, JSON.stringify(r))
  check('an unknown connection name asks to set it up', (await call('ssh:ensure', '\\\\ssh.stranger\\x')).ok === false)
  r = await call('ssh:connect', `other@127.0.0.1:${port}`, { password: 'secret' })
  check('two different logins to the same computer cannot share a name', r.ok === false && /already used/.test(r.error), JSON.stringify(r))
  mod.disconnectAll()
  server.close()
  await sleep(200)
  fs.rmSync(tmp, { recursive: true, force: true })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + (e && e.stack || e)); process.exit(1) })
