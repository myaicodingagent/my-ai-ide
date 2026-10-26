// Live Share hosting a folder that is NOT on this PC: one on a real Linux SSH server (Docker, see tests/ssh-linux.cjs for how to start it)
// and one in a WSL distribution. The host side of src/main/liveshare.ts runs in this process; a plain WebSocket client plays the guest
// with the session code, asks for files the way a guest's editor does, and tries to get out of the shared folder.
// `npm run test:liveshare-remote`: the SSH checks are skipped unless something answers on 127.0.0.1:2222, the WSL checks unless
// a distribution named by LS_WSL_DISTRO (default Ubuntu-24.04) exists.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), cp = require('child_process')
const WebSocket = require('ws')
const BS = String.fromCharCode(92)
const handlers = {}
const sent = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-remote-'))
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f }, on: () => {} },
  shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') }
}
const root = path.join(__dirname, '..')
const cache = path.join(root, 'node_modules', '.cache')
const posix = (p) => p.split(path.sep).join('/')
fs.mkdirSync(cache, { recursive: true })
const stub = path.join(cache, 'ls-remote-stub.cjs'), bundle = path.join(cache, 'ls-remote-bundle.cjs'), entry = path.join(cache, 'ls-remote-entry.ts')
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
fs.writeFileSync(entry, `export * as ssh from ${JSON.stringify(posix(path.join(root, 'src/main/sshfs.ts')))}\nexport * as ls from ${JSON.stringify(posix(path.join(root, 'src/main/liveshare.ts')))}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }

/** A guest: joins with the code and sends file requests. */
async function guest(join) {
  const m = /^(.+):(\d+)#([0-9a-f]{32})$/.exec(join)
  const ws = new WebSocket(`ws://${m[1]}:${m[2]}`)
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const pend = new Map()
  let nextId = 1
  const welcome = new Promise((r) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.t === 'welcome' || msg.t === 'deny') r(msg)
    if (msg.t === 'fs-res') { const p = pend.get(msg.id); pend.delete(msg.id); p && p(msg) }
  }))
  ws.send(JSON.stringify({ t: 'hello', token: m[3], name: 'Tester', v: 1 }))
  const w = await welcome
  const ask = (op, rel, extra = {}) => new Promise((res) => { const id = nextId++; pend.set(id, res); ws.send(JSON.stringify({ t: 'fs', id, op, rel, ...extra })) })
  return { welcome: w, ask, close: () => ws.close() }
}

/** The same checks for any kind of folder. `server` reads and changes the folder from the machine it is on. */
async function exercise(label, rootPath, server, ls, linkError = /outside the shared folder/) {
  const call = (n, ...a) => handlers[n]({}, ...a)
  let r = await call('ls:host', { root: rootPath, name: 'Host', readOnly: false, network: false })
  check(`${label}: a session can be hosted on the folder`, r.ok === true, JSON.stringify(r))
  if (!r.ok) return
  const g = await guest(r.join)
  check(`${label}: a guest gets in`, g.welcome.t === 'welcome', JSON.stringify(g.welcome))
  let a = await g.ask('readDir', '')
  const names = (a.result || []).map((e) => e.name)
  check(`${label}: it lists the folder without .git and node_modules, folders first`, a.ok && names.includes('a.txt') && names.includes('sub') && !names.includes('node_modules') && !names.includes('.git') && a.result.findIndex((e) => !e.isDir) > a.result.map((e) => e.isDir).lastIndexOf(true), JSON.stringify(a))
  a = await g.ask('readFile', 'a.txt')
  check(`${label}: it reads a file`, a.ok && a.result === 'alpha\nbeta\n', JSON.stringify(a))
  a = await g.ask('isDir', 'sub')
  check(`${label}: it can tell a folder`, a.ok && a.result === true)
  a = await g.ask('writeFile', 'sub/new/deep.txt', { content: 'written by the guest\n' })
  check(`${label}: it writes a file in a new folder`, a.ok && (await server.read('sub/new/deep.txt')) === 'written by the guest\n', JSON.stringify(a))
  a = await g.ask('createFile', 'a.txt', { content: 'again' })
  check(`${label}: creating a file that exists is refused`, !a.ok && /exists/.test(a.error || ''), JSON.stringify(a))
  a = await g.ask('listFiles', '')
  check(`${label}: it lists every file below the folder`, a.ok && a.result.includes('a.txt') && a.result.includes('sub/b.js') && a.result.includes('sub/new/deep.txt') && !a.result.some((f) => /node_modules|\.git/.test(f)), JSON.stringify(a).slice(0, 200))
  a = await g.ask('search', '', { query: 'beta', caseSensitive: false, regex: false })
  check(`${label}: it searches the folder`, a.ok && a.result.matches.some((m) => m.rel === 'a.txt' && m.line === 2), JSON.stringify(a).slice(0, 200))
  // getting out
  a = await g.ask('readFile', '../secret.txt')
  check(`${label}: ".." does not lead out of the folder`, !a.ok && /outside the shared folder/.test(a.error || ''), JSON.stringify(a))
  a = await g.ask('readFile', 'sub/../../secret.txt')
  check(`${label}: nor does ".." in the middle`, !a.ok && /outside the shared folder/.test(a.error || ''), JSON.stringify(a))
  a = await g.ask('readFile', 'escape')
  check(`${label}: a link inside the folder that points outside cannot be read`, !a.ok && linkError.test(a.error || ''), JSON.stringify(a))
  a = await g.ask('writeFile', 'escape', { content: 'overwritten' })
  check(`${label}: nor written`, !a.ok && linkError.test(a.error || '') && (await server.read('../secret.txt')) === 'outside\n', JSON.stringify(a))
  a = await g.ask('readDir', 'linkdir')
  check(`${label}: nor can a link to a folder outside be listed`, !a.ok && linkError.test(a.error || ''), JSON.stringify(a))
  a = await g.ask('writeFile', '.git/config', { content: 'x' })
  check(`${label}: git data cannot be changed`, !a.ok && /git data/.test(a.error || ''), JSON.stringify(a))
  a = await g.ask('rm', 'a.txt')
  check(`${label}: other operations do not exist`, !a.ok, JSON.stringify(a))
  g.close()
  await call('ls:stop')
  await sleep(300)
  // read-only
  r = await call('ls:host', { root: rootPath, name: 'Host', readOnly: true, network: false })
  const g2 = await guest(r.join)
  a = await g2.ask('writeFile', 'ro.txt', { content: 'x' })
  check(`${label}: a read-only session refuses writes`, !a.ok && /read-only/.test(a.error || '') && (await server.read('ro.txt')) === null, JSON.stringify(a))
  a = await g2.ask('readFile', 'a.txt')
  check(`${label}: but still reads`, a.ok)
  g2.close()
  await call('ls:stop')
}

;(async () => {
  await require('esbuild').build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['ssh2', 'ws', 'esbuild'], alias: { electron: stub }, outfile: bundle, logLevel: 'error' })
  const { ssh, ls } = require(bundle)
  ls.registerLiveShareHandlers(() => ({ webContents: { send: (ch, e) => sent.push(e) } }))

  // ---- SSH
  const up = await new Promise((res) => { const s = net.connect(2222, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
  if (!up) console.log('SKIP  no SSH server on 127.0.0.1:2222')
  else {
    let c = await ssh.connect('tester@127.0.0.1:2222', { password: 'secret' })
    if (c.need === 'trust') c = await ssh.connect('tester@127.0.0.1:2222', { password: 'secret', trust: c.fingerprint })
    check('SSH: connects to the Linux server', c.ok === true, JSON.stringify(c))
    const home = ssh.remoteUnc(c.name, '/home/tester')
    const sh = (line) => ssh.exec(home, ['sh', '-c', line], { timeout: 60000 })
    const set = await sh('rm -rf lsproj secret.txt; mkdir -p lsproj/sub lsproj/node_modules lsproj/.git && printf "alpha\\nbeta\\n" > lsproj/a.txt && echo "const b = 1" > lsproj/sub/b.js && echo x > lsproj/node_modules/x.js && echo "[core]" > lsproj/.git/config && echo outside > secret.txt && ln -s ../secret.txt lsproj/escape && ln -s /home/tester/.. lsproj/linkdir')
    check('SSH: the folder was made on the server', set.code === 0, set.stderr)
    const server = { read: async (rel) => { const r = await sh('cat ' + JSON.stringify('lsproj/' + rel) + ' 2>/dev/null'); return r.code === 0 ? r.stdout : null } }
    await exercise('SSH', ssh.remoteUnc(c.name, '/home/tester/lsproj'), server, ls)
    await sh('rm -rf lsproj secret.txt')
    // a session on a folder of a server that is not connected
    const r = await handlers['ls:host']({}, { root: ssh.remoteUnc('nowhere', '/x'), name: 'H' })
    check('SSH: a folder of a computer that is not connected is refused with a message', r.ok === false && typeof r.error === 'string', JSON.stringify(r))
  }

  // ---- WSL
  const distro = process.env.LS_WSL_DISTRO || 'Ubuntu-24.04'
  const list = process.platform === 'win32' ? cp.spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le' }).stdout || '' : ''
  if (!list.split(/\r?\n/).map((x) => x.trim()).includes(distro)) console.log('SKIP  no WSL distribution ' + distro)
  else {
    const wsl = (line) => cp.spawnSync('wsl', ['-d', distro, '--', 'sh', '-c', line], { encoding: 'utf-8' })
    const home = wsl('echo $HOME').stdout.trim()
    const set = wsl('rm -rf $HOME/lsproj $HOME/secret.txt; mkdir -p $HOME/lsproj/sub $HOME/lsproj/node_modules $HOME/lsproj/.git && printf "alpha\\nbeta\\n" > $HOME/lsproj/a.txt && echo "const b = 1" > $HOME/lsproj/sub/b.js && echo x > $HOME/lsproj/node_modules/x.js && echo "[core]" > $HOME/lsproj/.git/config && echo outside > $HOME/secret.txt && ln -s ../secret.txt $HOME/lsproj/escape && ln -s .. $HOME/lsproj/linkdir')
    check('WSL: the folder was made in the distribution', set.status === 0, set.stderr)
    const unc = BS + BS + 'wsl.localhost' + BS + distro + home.replace(/\//g, BS)
    const server = { read: async (rel) => { const r = wsl('cat "$HOME/lsproj/' + rel + '" 2>/dev/null'); return r.status === 0 ? r.stdout : null } }
    await exercise('WSL', unc + BS + 'lsproj', server, ls, /outside the shared folder|ENOENT/)
    wsl('rm -rf $HOME/lsproj $HOME/secret.txt')
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* only a temp folder */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
