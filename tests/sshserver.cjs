// A small SSH + SFTP server over a local folder, written with ssh2, for the tests (user "tester", password "secret").
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { Server, utils } = require('ssh2')

module.exports = function createSshServer(remoteRoot) {
// ---------------- a small SFTP server over a local folder ----------------
const { OPEN_MODE, STATUS_CODE, flagsToString } = utils.sftp
const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey
const local = (p) => path.join(remoteRoot, ...String(p).split('/').filter((s) => s && s !== '..'))
const attrsOf = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) })
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => { if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'secret') ctx.accept(); else ctx.reject(['password']) })
  client.on('error', () => undefined)
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      // exec: the command the app sends is "cd '<remote path>' && ENV=.. 'git' ..."; run it with bash in the matching local folder.
      session.on('exec', (accept2, _reject, info) => {
        const stream = accept2()
        const m = /^cd '([^']*)' && ([\s\S]*)$/.exec(info.command)
        if (!m) { stream.stderr.write('bad command'); stream.exit(2); return stream.end() }
        const cwd = local(m[1])
        const child = require('child_process').spawn('bash', ['-c', m[2]], { cwd })
        const roots = [remoteRoot, fs.realpathSync.native(remoteRoot)].map((r) => r.split(require('path').sep).join('/'))
        const fix = (d) => Buffer.from(roots.reduce((s, r) => s.split(r).join(''), d.toString('utf-8')))
        child.stdout.on('data', (d) => stream.write(fix(d)))
        child.stderr.on('data', (d) => stream.stderr.write(fix(d)))
        child.on('close', (code) => { stream.exit(code ?? 1); stream.end() })
        stream.pipe(child.stdin)
      })
      session.on('sftp', (accept2) => {
        const sftp = accept2()
        const open = new Map(); let next = 1
        const handle = (obj) => { const b = Buffer.alloc(4); b.writeUInt32BE(next, 0); open.set(next++, obj); return b }
        const get = (h) => open.get(h.readUInt32BE(0))
        const fail = (id, e) => sftp.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : e && (e.code === 'EACCES' || e.code === 'EPERM') ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE)
        sftp.on('REALPATH', (id, p) => { const parts = []; for (const s of String(p).split('/')) { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s) } const abs = '/' + parts.join('/'); sftp.name(id, [{ filename: p === '.' ? '/home/tester' : abs, longname: abs, attrs: {} }]) })
        const doStat = (id, p) => { try { sftp.attrs(id, attrsOf(fs.statSync(local(p)))) } catch (e) { fail(id, e) } }
        sftp.on('STAT', doStat); sftp.on('LSTAT', doStat)
        sftp.on('FSTAT', (id, h) => { const o = get(h); try { sftp.attrs(id, attrsOf(fs.fstatSync(o.fd))) } catch (e) { fail(id, e) } })
        sftp.on('OPENDIR', (id, p) => { try { sftp.handle(id, handle({ dir: true, entries: fs.readdirSync(local(p)).map((n) => ({ n, st: fs.lstatSync(path.join(local(p), n)) })), done: false })) } catch (e) { fail(id, e) } })
        sftp.on('READDIR', (id, h) => { const o = get(h); if (o.done || o.entries.length === 0) return sftp.status(id, STATUS_CODE.EOF); o.done = true; sftp.name(id, o.entries.map(({ n, st }) => ({ filename: n, longname: n, attrs: attrsOf(st) }))) })
        sftp.on('OPEN', (id, p, flags) => { try { const fd = fs.openSync(local(p), flagsToString(flags) || 'r'); sftp.handle(id, handle({ fd })) } catch (e) { fail(id, e) } })
        sftp.on('READ', (id, h, offset, length) => { const o = get(h); const buf = Buffer.alloc(length); try { const n = fs.readSync(o.fd, buf, 0, length, offset); if (n === 0) sftp.status(id, STATUS_CODE.EOF); else sftp.data(id, buf.slice(0, n)) } catch (e) { fail(id, e) } })
        sftp.on('WRITE', (id, h, offset, data) => { const o = get(h); try { fs.writeSync(o.fd, data, 0, data.length, offset); sftp.status(id, STATUS_CODE.OK) } catch (e) { fail(id, e) } })
        sftp.on('CLOSE', (id, h) => { const o = get(h); if (o && o.fd !== undefined) try { fs.closeSync(o.fd) } catch { /* closed */ } open.delete(h.readUInt32BE(0)); sftp.status(id, STATUS_CODE.OK) })
        sftp.on('MKDIR', (id, p) => { try { fs.mkdirSync(local(p)); sftp.status(id, STATUS_CODE.OK) } catch (e) { fail(id, e) } })
        sftp.on('RMDIR', (id, p) => { try { fs.rmdirSync(local(p)); sftp.status(id, STATUS_CODE.OK) } catch (e) { fail(id, e) } })
        sftp.on('REMOVE', (id, p) => { try { fs.unlinkSync(local(p)); sftp.status(id, STATUS_CODE.OK) } catch (e) { fail(id, e) } })
        sftp.on('RENAME', (id, a, b) => { try { fs.renameSync(local(a), local(b)); sftp.status(id, STATUS_CODE.OK) } catch (e) { fail(id, e) } })
        sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK)); sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK))
      })
    })
  })
})

  return server
}
