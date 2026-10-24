// The debugger and background agents against a REAL Linux SSH server (the other SSH tests use a stand-in server).
// `npm run test:ssh-linux`: skipped unless something answers on 127.0.0.1:2222. Start the server with Docker:
//   docker run -d --name sshtest -p 2222:22 ubuntu:24.04 bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && \
//     apt-get install -y -qq openssh-server git nodejs python3 python3-pip tar golang-go && pip3 install --break-system-packages debugpy "python-lsp-server[all]"; \
//     useradd -m -s /bin/bash tester && echo 'tester:secret' | chpasswd; mkdir -p /run/sshd; touch /tmp/ready; exec /usr/sbin/sshd -D -e"
// (wait until `docker exec sshtest ls /tmp/ready` works). Go checks also need Delve in the container; they are skipped without it.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), cp = require('child_process')
const handlers = {}
const events = []
const updates = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-linux-'))
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f }, on: () => {} },
  shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') }
}
const root = path.join(__dirname, '..')
const cache = path.join(root, 'node_modules', '.cache')
const posix = (p) => p.split(path.sep).join('/')
fs.mkdirSync(cache, { recursive: true })
const stub = path.join(cache, 'ssh-linux-stub.cjs'), bundle = path.join(cache, 'ssh-linux-bundle.cjs'), entry = path.join(cache, 'ssh-linux-entry.ts'), agentStub = path.join(cache, 'ssh-linux-agent.ts')
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
fs.writeFileSync(entry, `export * as ssh from ${JSON.stringify(posix(path.join(root, 'src/main/sshfs.ts')))}\nexport * as dbg from ${JSON.stringify(posix(path.join(root, 'src/main/debugger.ts')))}\nexport * as bg from ${JSON.stringify(posix(path.join(root, 'src/main/background.ts')))}\nexport * as lsp from ${JSON.stringify(posix(path.join(root, 'src/main/lsp.ts')))}\n`)
fs.writeFileSync(agentStub, `import * as real from ${JSON.stringify(posix(path.join(root, 'src/main/agent.ts')))}
export type AgentEvent = real.AgentEvent
export const resetSession = real.resetSession
export async function runAgentTask(opts: { root: string }, send: (e: real.AgentEvent) => void): Promise<void> {
  const ctx = { root: opts.root, sessionId: 'bg-linux', toolUseId: 't', send: () => undefined, requestApproval: async () => true }
  const notes = await real.runTool(opts.root, 'find_files', { pattern: 'notes.txt' })
  await real.runWriteTool(ctx, 'write_file', { path: 'bg-created.txt', content: 'made by the agent, notes ' + (/notes/.test(notes) ? 'seen' : 'missing') + '\\n' })
  await real.runWriteTool(ctx, 'edit_file', { path: 'hello.txt', old_string: 'hello', new_string: 'HELLO' })
  send({ type: 'done', stopReason: 'end_turn' })
}
`)
const stubPlugin = { name: 'agent-stub', setup(b) { b.onResolve({ filter: /^\.\/agent$/ }, (a) => (a.importer.endsWith('background.ts') ? { path: agentStub } : undefined)) } }
// (modules import JavaDap.java as text, the way the real build does)
const rawPlugin = { name: 'raw', setup(b) { b.onResolve({ filter: /[?]raw$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.replace(/[?]raw$/, '')), namespace: 'raw' })); b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: fs.readFileSync(a.path, 'utf-8'), loader: 'text' })) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }
async function waitEvent(pred, what, ms = 40000) {
  const t0 = Date.now()
  for (;;) {
    const i = events.findIndex(pred)
    if (i >= 0) return events.splice(i, 1)[0]
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for: ' + what + ' (have: ' + events.map((e) => e.type).join(',') + ')')
    await sleep(40)
  }
}

;(async () => {
  const up = await new Promise((res) => { const s = net.connect(2222, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
  if (!up) { console.log('SKIP  no SSH server on 127.0.0.1:2222 (see the top of this file)'); process.exit(0) }
  await require('esbuild').build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['ssh2', 'ws', 'esbuild', '@anthropic-ai/sdk'], alias: { electron: stub }, plugins: [stubPlugin, rawPlugin], outfile: bundle, logLevel: 'error' })
  const { ssh, dbg, bg, lsp } = require(bundle)
  ssh.registerSshHandlers()
  const lspMessages = []
  lsp.registerLspHandlers(() => ({ webContents: { send: (ch, m) => lspMessages.push({ ch, m }) } }))
  dbg.registerDebugHandlers(() => ({ webContents: { send: (_ch, e) => events.push(e) } }))
  bg.registerBackgroundHandlers(() => ({ webContents: { send: (ch, t) => { if (ch === 'bg:update') updates.push(t) } } }))
  const call = (n, ...a) => handlers[n]({}, ...a)
  let c = await ssh.connect('tester@127.0.0.1:2222', { password: 'secret' })
  if (c.need === 'trust') c = await ssh.connect('tester@127.0.0.1:2222', { password: 'secret', trust: c.fingerprint })
  check('connects to the Linux server', c.ok === true, JSON.stringify(c))
  const sh = async (dir, line) => ssh.exec(dir, ['sh', '-c', line], { timeout: 60000 })
  const home = ssh.remoteUnc(c.name, '/home/tester')
  const P = (rel) => ssh.remoteUnc(c.name, '/home/tester/' + rel)
  await sh(home, 'rm -rf proj; mkdir -p proj/sub')
  const proj = P('proj')
  await ssh.writeFile(P('proj/prog.js'), ['function add(a, b) {', '  const sum = a + b', '  return sum', '}', 'console.log("linux result", add(2, 3), process.env.MYVAR)', 'if (process.argv[2]) setInterval(() => {}, 1000)', ''].join('\n'))
  await ssh.writeFile(P('proj/prog.py'), ['def add(a, b):', '    s = a + b', '    return s', 'print("py linux", add(2, 3))', ''].join('\n'))
  await ssh.writeFile(P('proj/hello.txt'), 'hello\n')
  await ssh.writeFile(P('proj/.gitignore'), 'node_modules\n')
  const g = await sh(proj, 'git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm first && echo notes > notes.txt && mkdir node_modules && echo x > node_modules/m.txt')
  check('a repository was made on the server', g.code === 0, g.stderr)

  // ---- Node
  const prog = P('proj/prog.js')
  let r = await call('dbg:start', { file: prog, env: { MYVAR: 'hello' }, breakpoints: { [prog]: [{ line: 2 }] } })
  check('Node: a program on the Linux server starts under the debugger', r.ok === true, JSON.stringify(r))
  let p = await waitEvent((e) => e.type === 'paused', 'node bp')
  check('Node: it stops at the breakpoint, in the editor\'s address of the file', p.reason === 'breakpoint' && p.frames[0].name === 'add' && p.frames[0].line === 2 && p.frames[0].file === prog, JSON.stringify(p.frames[0]))
  let ev = await call('dbg:eval', 'a + b', 0)
  check('Node: expressions are evaluated there', ev.ok && ev.value.value === '5', JSON.stringify(ev))
  await call('dbg:setBreakpoints', prog, [])
  await call('dbg:continue')
  let end = await waitEvent((e) => e.type === 'exited', 'node exit')
  const out = events.filter((e) => e.type === 'output').map((e) => e.text).join('')
  check('Node: it finishes with its output', end.code === 0 && /linux result 5 hello/.test(out), JSON.stringify([end.code, out]))
  events.length = 0
  r = await call('dbg:start', { file: prog, args: ['wait'], breakpoints: { [prog]: [{ line: 6 }] } })
  await waitEvent((e) => e.type === 'paused', 'node stop test')
  await sleep(300)
  const before = (await sh(home, 'pgrep -f "[n]ode .*prog.js" | wc -l')).stdout.trim()
  await call('dbg:stop')
  await waitEvent((e) => e.type === 'exited', 'node stopped')
  let after = ''
  for (let i = 0; i < 40; i++) { after = (await sh(home, 'pgrep -f "[n]ode .*prog.js" | wc -l')).stdout.trim(); if (after === '0') break; await sleep(250) }
  check('Node: Stop ends the program on the server', Number(before) >= 1 && after === '0', `before ${before}, after ${after}`)
  events.length = 0

  // ---- Python
  const py = P('proj/prog.py')
  r = await call('dbg:start', { file: py, breakpoints: { [py]: [{ line: 2 }] } })
  check('Python: a program on the Linux server starts under debugpy', r.ok === true, JSON.stringify(r))
  if (r.ok) {
    p = await waitEvent((e) => e.type === 'paused', 'py bp')
    check('Python: it stops at the breakpoint', p.reason === 'breakpoint' && p.frames[0].line === 2 && p.frames[0].file === py, JSON.stringify(p.frames[0]))
    ev = await call('dbg:eval', 'a + b', 0)
    check('Python: expressions are evaluated there', ev.ok && ev.value.value === '5', JSON.stringify(ev))
    await call('dbg:continue')
    end = await waitEvent((e) => e.type === 'exited', 'py exit')
    check('Python: it finishes with its output and exit code 0', end.code === 0 && /py linux 5/.test(events.filter((e) => e.type === 'output').map((e) => e.text).join('')), JSON.stringify([end.code]))
  }
  events.length = 0

  // ---- Go (only if Delve is installed in the container)
  const dlv = await sh(home, 'PATH="$PATH:$HOME/go/bin:/usr/local/go/bin:/usr/local/bin"; command -v dlv')
  if (dlv.code !== 0) console.log('SKIP  Go (no dlv in the container)')
  else {
    await sh(home, 'mkdir -p proj/gopkg')
    await ssh.writeFile(P('proj/gopkg/go.mod'), 'module gopkg\n\ngo 1.20\n')
    await ssh.writeFile(P('proj/gopkg/main.go'), ['package main', '', 'import "fmt"', '', 'func add(a, b int) int {', '\ts := a + b', '\treturn s', '}', '', 'func main() {', '\tfmt.Println("go linux", add(2, 3))', '}', ''].join('\n'))
    const gf = P('proj/gopkg/main.go')
    r = await call('dbg:start', { file: gf, breakpoints: { [gf]: [{ line: 6 }] } })
    check('Go: a program on the Linux server starts under Delve', r.ok === true, JSON.stringify(r))
    if (r.ok) {
      p = await waitEvent((e) => e.type === 'paused', 'go bp')
      check('Go: it stops at the breakpoint', p.reason === 'breakpoint' && p.frames[0].line === 6 && p.frames[0].file === gf, JSON.stringify(p.frames[0]))
      await call('dbg:setBreakpoints', gf, []); await call('dbg:continue')
      end = await waitEvent((e) => e.type === 'exited', 'go exit')
      check('Go: it finishes with its output', /go linux 5/.test(events.filter((e) => e.type === 'output').map((e) => e.text).join('')), JSON.stringify([end.code]))
    }
    events.length = 0
  }

  // ---- a language server on the Linux server (pylsp), spoken to through the SSH connection
  {
    const have = await sh(home, 'PATH="$PATH:$HOME/.local/bin:/usr/local/bin"; command -v pylsp')
    if (have.code !== 0) console.log('SKIP  language server (pylsp is not installed in the container)')
    else {
      await sh(home, 'mkdir -p proj/lspdir')
      await ssh.writeFile(P('proj/lspdir/app.py'), ['import os', '', 'def greet(name):', '    """Say hi to someone."""', '    return "hi " + name', '', 'x = greet("a")', 'print(undefined_name)', ''].join('\n'))
      const lroot = P('proj/lspdir')
      const r = await call('lsp:start', 'python', lroot)
      check('LSP: a Python language server is started on the server', r.ok === true && /Python/.test(r.label) && r.realRoot === '/home/tester/proj/lspdir', JSON.stringify(r))
      if (r.ok) {
        const uri = 'file://' + r.realRoot + '/app.py'
        await call('lsp:notify', r.server, 'textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text: await ssh.readFile(P('proj/lspdir/app.py')) } })
        const diag = async () => { for (let i = 0; i < 60; i++) { const m = lspMessages.find((x) => x.ch === 'lsp:message' && x.m.method === 'textDocument/publishDiagnostics' && x.m.params.uri === uri && x.m.params.diagnostics.length); if (m) return m.m.params.diagnostics; await sleep(500) } return [] }
        const d = await diag()
        check('LSP: it reports the undefined name, at the right line', d.some((x) => /undefined_name/.test(x.message) && x.range.start.line === 7), JSON.stringify(d).slice(0, 200))
        const hov = await call('lsp:request', r.server, 'textDocument/hover', { textDocument: { uri }, position: { line: 6, character: 5 } })
        check('LSP: hover shows the function\'s documentation', hov.ok && /Say hi to someone/.test(JSON.stringify(hov.result)), JSON.stringify(hov).slice(0, 200))
        const def = await call('lsp:request', r.server, 'textDocument/definition', { textDocument: { uri }, position: { line: 6, character: 5 } })
        check('LSP: go to definition answers with the file on the server, line 3', def.ok && JSON.stringify(def.result).includes('app.py') && JSON.stringify(def.result).includes('"line":2'), JSON.stringify(def).slice(0, 220))
        const again = await call('lsp:start', 'python', lroot)
        check('LSP: starting it again shares the running server', again.ok === true && again.server === r.server)
        const before = (await sh(home, 'pgrep -f "[p]ylsp" | wc -l')).stdout.trim()
        await call('lsp:stop', r.server)
        let after = ''
        for (let i = 0; i < 30; i++) { after = (await sh(home, 'pgrep -f "[p]ylsp" | wc -l')).stdout.trim(); if (after === '0') break; await sleep(300) }
        check('LSP: stopping it ends the process on the server', Number(before) >= 1 && after === '0', `before ${before}, after ${after}`)
      }
      const none = await call('lsp:start', 'rust', lroot)
      check('LSP: a server that is not installed there says how to install it', none.ok === false && /rust-analyzer/.test(none.error) && /other computer/.test(none.error), JSON.stringify(none))
    }
  }

  // ---- background agents
  r = await call('bg:start', proj, 'edit hello and create a file', 'm')
  check('a background agent starts on the Linux server', r.ok === true, JSON.stringify(r))
  if (r.ok) {
    const id = r.task.id
    let t
    for (let i = 0; i < 300; i++) { t = (await call('bg:list')).find((x) => x.id === id); if (t && t.status !== 'running' && t.committed && t.files.length) break; await sleep(200) }
    check('it finishes and lists its changes', t.status === 'done' && t.files.map((f) => f.status + f.rel).sort().join() === 'Abg-created.txt,Mhello.txt', JSON.stringify({ s: t.status, e: t.error, f: t.files }))
    const created = await sh(home, 'cat proj/.git/my-ai-ide-worktrees/*/bg-created.txt; ls -la proj/.git/my-ai-ide-worktrees/*/node_modules | head -2; cat proj/hello.txt; git -C proj status --porcelain')
    check('the copy has the agent\'s file (it saw notes.txt), node_modules is linked, and your folder is untouched', /seen/.test(created.stdout) && /node_modules ->/.test(created.stdout) && /^hello$/m.test(created.stdout) && !/bg-created/.test(created.stdout.split('hello')[1] || ''), created.stdout)
    const ap = await call('bg:apply', id)
    const after = await sh(home, 'cat proj/hello.txt proj/bg-created.txt')
    check('apply puts the changes into your folder', ap.ok === true && /HELLO/.test(after.stdout) && /made by the agent/.test(after.stdout), JSON.stringify(ap) + after.stdout)
    await sh(proj, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm applied')
    r = await call('bg:start', proj, 'second', 'm')
    for (let i = 0; i < 300; i++) { t = (await call('bg:list')).find((x) => x.id === r.task.id); if (t && t.status !== 'running' && t.committed) break; await sleep(200) }
    await call('bg:discard', r.task.id)
    const left = await sh(home, 'ls proj/.git/my-ai-ide-worktrees | wc -l; ls proj/node_modules; git -C proj branch --list "agent/*" | wc -l')
    check('discard removes the second copy and its branch, and leaves your node_modules alone', left.stdout.split('\n')[0].trim() === '1' && /m\.txt/.test(left.stdout) && left.stdout.trim().split('\n').pop().trim() === '1', left.stdout)
  }

  await sh(home, 'rm -rf proj')
  ssh.disconnectAll()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* temp */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); process.exit(1) })
