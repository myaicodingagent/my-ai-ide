// Live Share with the most people it allows: the host side of src/main/liveshare.ts runs in this process (this file plays the host's
// editor too: it keeps the host's copy of the shared document), eight plain WebSocket clients play guests. All of them type into the
// same document at the same time; every copy must end up identical. A ninth guest is refused, and a guest that leaves is told to
// the others. `npm run test:liveshare-many` (no app window, no Docker).
const fs = require('fs'), os = require('os'), path = require('path')
const WebSocket = require('ws')
const Y = require('yjs')
const handlers = {}
const events = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-many-'))
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f }, on: () => {} },
  shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') }
}
const root = path.join(__dirname, '..')
const cache = path.join(root, 'node_modules', '.cache')
const posix = (p) => p.split(path.sep).join('/')
fs.mkdirSync(cache, { recursive: true })
const stub = path.join(cache, 'ls-many-stub.cjs'), bundle = path.join(cache, 'ls-many-bundle.cjs'), entry = path.join(cache, 'ls-many-entry.ts')
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
fs.writeFileSync(entry, `export * as ls from ${JSON.stringify(posix(path.join(root, 'src/main/liveshare.ts')))}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }
const b64 = (u) => Buffer.from(u).toString('base64')
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const GUESTS = 8
const REL = 'shared.txt'

async function join(code, name) {
  const m = /^(.+):(\d+)#([0-9a-f]{32})$/.exec(code)
  const ws = new WebSocket(`ws://${m[1]}:${m[2]}`)
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const g = { name, ws, doc: new Y.Doc(), msgs: [], welcome: null, gone: [] }
  g.text = g.doc.getText('t')
  // what this guest sends goes to the host (and from there to the others)
  g.doc.on('update', (u, origin) => { if (origin === 'local') ws.send(JSON.stringify({ t: 'doc-update', rel: REL, update: b64(u) })) })
  const welcome = new Promise((r) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.t === 'welcome' || msg.t === 'deny') { g.welcome = msg; r(msg) }
    else if (msg.t === 'doc-state' || msg.t === 'doc-update') Y.applyUpdate(g.doc, unb64(msg.update), 'remote')
    else if (msg.t === 'peers') g.peers = msg.peers
    else if (msg.t === 'gone') g.gone.push(msg.id)
  }))
  ws.send(JSON.stringify({ t: 'hello', token: m[3], name, v: 1 }))
  await welcome
  return g
}

;(async () => {
  await require('esbuild').build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['ws', 'esbuild', 'ssh2'], alias: { electron: stub }, outfile: bundle, logLevel: 'error' })
  const { ls } = require(bundle)
  const hostDoc = new Y.Doc(), hostText = hostDoc.getText('t')
  hostDoc.transact(() => hostText.insert(0, 'start\n'), 'init')
  hostDoc.on('update', (u, origin) => { if (origin === 'local') handlers['ls:send']({}, { t: 'doc-update', rel: REL, update: b64(u) }) })
  // the host's editor: answers a guest that opens the document, applies what the guests write
  ls.registerLiveShareHandlers(() => ({
    webContents: {
      send: (ch, e) => {
        events.push(e)
        if (e.type !== 'msg') return
        if (e.msg.t === 'doc-open') handlers['ls:send']({}, { t: 'doc-state', rel: REL, to: e.from, update: b64(Y.encodeStateAsUpdate(hostDoc)) })
        else if (e.msg.t === 'doc-update') Y.applyUpdate(hostDoc, unb64(e.msg.update), 'remote')
      }
    }
  }))
  fs.writeFileSync(path.join(tmp, REL), 'start\n')
  const r = await handlers['ls:host']({}, { root: tmp, name: 'Host', readOnly: false, network: false })
  check('a session is hosted', r.ok === true, JSON.stringify(r))

  const guests = []
  for (let i = 0; i < GUESTS; i++) guests.push(await join(r.join, 'Guest' + (i + 1)))
  check(`${GUESTS} guests get in`, guests.every((g) => g.welcome.t === 'welcome'), guests.map((g) => g.welcome.t).join(','))
  const ninth = await join(r.join, 'Ninth')
  check('a ninth guest is refused because the session is full', ninth.welcome.t === 'deny' && /full/.test(ninth.welcome.reason), JSON.stringify(ninth.welcome))
  await sleep(300)
  check('everybody is told who is in the session', guests.every((g) => g.peers && g.peers.length === GUESTS + 1), guests.map((g) => g.peers && g.peers.length).join(','))

  // everybody opens the document
  for (const g of guests) g.ws.send(JSON.stringify({ t: 'doc-open', rel: REL }))
  await sleep(800)
  check('every guest gets the host\'s text when it opens the document', guests.every((g) => g.text.toString() === 'start\n'), guests.map((g) => JSON.stringify(g.text.toString())).join(' '))

  // everybody types at the same time, at the start, in the middle and at the end, many small edits
  const writers = [{ doc: hostDoc, text: hostText, name: 'Host' }, ...guests]
  await Promise.all(writers.map(async (w, wi) => {
    for (let k = 0; k < 20; k++) {
      const len = w.text.length
      const at = wi % 3 === 0 ? 0 : wi % 3 === 1 ? Math.floor(len / 2) : len
      w.doc.transact(() => w.text.insert(at, `[${w.name}:${k}]`), 'local')
      await sleep(Math.random() * 20)
    }
  }))
  // settle: every copy has to have everything
  const want = writers.length * 20
  let ok = false
  for (let i = 0; i < 100 && !ok; i++) {
    await sleep(100)
    const t0 = hostText.toString()
    ok = (t0.match(/\[/g) || []).length === want && guests.every((g) => g.text.toString() === t0)
  }
  const t0 = hostText.toString()
  check(`all ${writers.length} copies hold all ${want} edits and are identical`, ok, `${(t0.match(/\[/g) || []).length} edits in the host's copy; ${guests.filter((g) => g.text.toString() !== t0).length} guests differ`)
  const order = (name) => [...t0.matchAll(new RegExp(`\\[${name}:(\\d+)\\]`, 'g'))].map((m) => Number(m[1]))
  check('what each person wrote at the end (or the start) of the text kept its order', writers.every((w, wi) => { if (wi % 3 === 1) return true /* the middle moves as others type: no fixed order */; const o = order(w.name); const asc = o.every((v, i) => i === 0 || v > o[i - 1]), desc = o.every((v, i) => i === 0 || v < o[i - 1]); return o.length === 20 && (wi % 3 === 2 ? asc : desc) }))

  // one leaves
  guests[0].ws.close()
  await sleep(500)
  check('the others are told when a guest leaves', guests.slice(1).every((g) => g.peers.length === GUESTS) && guests.slice(1).every((g) => g.gone.length === 1))
  const again = await join(r.join, 'Again')
  check('and the place is free for somebody else', again.welcome.t === 'welcome', JSON.stringify(again.welcome))
  again.ws.close()

  for (const g of guests) g.ws.close()
  await handlers['ls:stop']({})
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* only a temp folder */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
