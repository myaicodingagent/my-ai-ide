// Background agents for a folder on another computer, over SSH: the real background module (src/main/background.ts), git
// and SSH modules run against the test SSH server (tests/sshserver.cjs). Only the model is replaced: the "agent" makes
// fixed edits through the real agent tools (the model loop itself is covered by the e2e test). The project lives at a path
// written as a Windows server writes it (/C:/Users/...), so the server's paths are real paths here.
// `npm run test:ssh-background`: needs git; does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const handlers = {}
const updates = []
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-bg-')))
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f }, on: () => {} },
  shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') }
}
const root = path.join(__dirname, '..')
const cache = path.join(root, 'node_modules', '.cache')
const posix = (p) => p.split(path.sep).join('/')
fs.mkdirSync(cache, { recursive: true })
const stub = path.join(cache, 'ssh-bg-stub.cjs'), bundle = path.join(cache, 'ssh-bg-bundle.cjs'), entry = path.join(cache, 'ssh-bg-entry.ts'), agentStub = path.join(cache, 'ssh-bg-agent.ts')
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
fs.writeFileSync(entry, `export * as ssh from ${JSON.stringify(posix(path.join(root, 'src/main/sshfs.ts')))}\nexport * as bg from ${JSON.stringify(posix(path.join(root, 'src/main/background.ts')))}\n`)
// The model is replaced by a script that edits through the real agent tools.
fs.writeFileSync(agentStub, `import * as real from ${JSON.stringify(posix(path.join(root, 'src/main/agent.ts')))}
export type AgentEvent = real.AgentEvent
export const resetSession = real.resetSession
export async function runAgentTask(opts: { root: string; task: string }, send: (e: real.AgentEvent) => void, signal: AbortSignal): Promise<void> {
  const ctx = { root: opts.root, sessionId: 'bg-test', toolUseId: 't', send: () => undefined, requestApproval: async () => true }
  send({ type: 'tool_start', id: 't1', name: 'read_file', input: { path: 'notes.txt' } } as never)
  const notes = await real.runTool(opts.root, 'find_files', { pattern: 'notes.txt' }).catch((e: Error) => 'ERR ' + e.message)
  await real.runWriteTool(ctx, 'write_file', { path: 'bg-created.txt', content: 'made by the agent. notes: ' + (/notes\\.txt/.test(notes) ? 'seen' : 'missing') + '\\n' })
  if (opts.task.includes('edit')) await real.runWriteTool(ctx, 'edit_file', { path: 'hello.txt', old_string: 'hello', new_string: 'HELLO' })
  send({ type: 'text', text: 'Done: created bg-created.txt.' } as never)
  send({ type: 'done', stopReason: 'end_turn' })
}
`)
const stubPlugin = { name: 'agent-stub', setup(b) { b.onResolve({ filter: /^\.\/agent$/ }, (a) => (a.importer.endsWith('background.ts') ? { path: agentStub } : undefined)) } }

;(async () => {
  await require('esbuild').build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['ssh2', 'ws', 'esbuild', '@anthropic-ai/sdk'], alias: { electron: stub }, plugins: [stubPlugin], outfile: bundle, logLevel: 'error' })
  const { ssh, bg } = require(bundle)
  ssh.registerSshHandlers()
  bg.registerBackgroundHandlers(() => ({ webContents: { send: (ch, t) => { if (ch === 'bg:update') updates.push(t) } } }))
  const call = (n, ...a) => handlers[n]({}, ...a)
  const results = []
  const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }
  const rd = (...p) => fs.readFileSync(path.join(...p), "utf-8").split(String.fromCharCode(13)).join("")
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const git = (cwd, ...a) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf-8' })
  async function until(pred, what, ms = 60000) {
    const t0 = Date.now()
    for (;;) {
      const v = await pred()
      if (v) return v
      if (Date.now() - t0 > ms) throw new Error('Timed out: ' + what)
      await sleep(100)
    }
  }
  const server = require('./sshserver.cjs')(path.join(tmp, 'server-root'))
  fs.mkdirSync(path.join(tmp, 'server-root'), { recursive: true })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))

  const proj = path.join(tmp, 'proj'); fs.mkdirSync(path.join(proj, 'sub'), { recursive: true })
  git(proj, 'init', '-q')
  fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules\n')
  fs.writeFileSync(path.join(proj, 'hello.txt'), 'hello\n'); fs.writeFileSync(path.join(proj, 'sub', 'inner.txt'), 'inner\n')
  git(proj, 'add', '-A'); git(proj, 'commit', '-qm', 'first')
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'my notes\n') // untracked
  const addr = `tester@127.0.0.1:${server.address().port}`
  let c = await ssh.connect(addr, { password: 'secret' })
  if (c.need === 'trust') c = await ssh.connect(addr, { password: 'secret', trust: c.fingerprint })
  check('connects to the test server', c.ok === true, JSON.stringify(c))
  const unc = (p) => ssh.remoteUnc(c.name, '/' + posix(p))
  const projU = unc(proj)

  // ---- an agent works on a copy on the other computer
  let r = await call('bg:start', projU + 'x', 'edit hello', 'm')
  check('a folder that does not exist is refused with a readable message', r.ok === false, JSON.stringify(r))
  r = await call('bg:start', projU, 'edit hello and create a file', 'm')
  check('a background agent starts in a folder on the other computer', r.ok === true, JSON.stringify(r))
  const id = r.task.id
  check('its copy is a worktree below .git on that computer', /my-ai-ide-worktrees/.test(r.task.worktree) && r.task.worktree.startsWith('\\\\ssh.') && r.task.agentRoot === r.task.worktree, r.task.worktree)
  const done = await until(async () => (await call('bg:list')).find((t) => t.id === id && t.status !== 'running' && t.committed && t.files.length), 'task done')
  check('it finishes', done.status === 'done' && done.steps >= 1 && /Done: created/.test(done.summary), JSON.stringify({ s: done.status, e: done.error, steps: done.steps }))
  const wt = fs.readdirSync(path.join(proj, '.git', 'my-ai-ide-worktrees'))
  check('the copy exists on the server, with your untracked file copied in', wt.length === 1 && fs.readFileSync(path.join(proj, '.git', 'my-ai-ide-worktrees', wt[0], 'notes.txt'), 'utf-8') === 'my notes\n')
  check('the agent worked on the copy (it saw notes.txt) and your own folder is untouched', fs.existsSync(path.join(proj, '.git', 'my-ai-ide-worktrees', wt[0], 'bg-created.txt')) && /seen/.test(fs.readFileSync(path.join(proj, '.git', 'my-ai-ide-worktrees', wt[0], 'bg-created.txt'), 'utf-8')) && !fs.existsSync(path.join(proj, 'bg-created.txt')) && rd(proj, 'hello.txt') === 'hello\n')
  check('your git status does not list the copy', !/my-ai-ide/.test(git(proj, 'status', '--porcelain')), git(proj, 'status', '--porcelain'))
  check('the changed files are listed', done.files.map((f) => f.status + f.rel).sort().join() === 'Abg-created.txt,Mhello.txt', JSON.stringify(done.files))
  const d = await call('bg:fileDiff', id, 'hello.txt')
  check('a file\'s diff has both sides, and its address in your folder', d.original === 'hello\n' && d.modified === 'HELLO\n' && d.abs === projU + '\\hello.txt', JSON.stringify(d))

  // ---- apply
  const ap = await call('bg:apply', id)
  check('apply puts the changes into your folder on the server', ap.ok === true && rd(proj, 'hello.txt') === 'HELLO\n' && fs.existsSync(path.join(proj, 'bg-created.txt')), JSON.stringify(ap))
  check('and the task is marked applied', (await call('bg:list')).find((t) => t.id === id).status === 'applied')
  git(proj, 'add', '-A'); git(proj, 'commit', '-qm', 'applied')

  // ---- started from a sub-folder; discarded
  r = await call('bg:start', unc(path.join(proj, 'sub')), 'just create', 'm')
  check('an agent can start in a sub-folder', r.ok === true && r.task.agentRoot === r.task.worktree + '\\sub', JSON.stringify(r.task && r.task.agentRoot))
  const id2 = r.task.id
  await until(async () => (await call('bg:list')).find((t) => t.id === id2 && t.status !== 'running' && t.committed && t.files.length), 'task 2 done')
  const wt2 = fs.readdirSync(path.join(proj, '.git', 'my-ai-ide-worktrees')).length
  await call('bg:discard', id2)
  const left = fs.readdirSync(path.join(proj, '.git', 'my-ai-ide-worktrees'))
  check('discard removes the copy and its branch on the server', wt2 === 2 && left.length === 1 && !(await call('bg:list')).some((t) => t.id === id2) && !git(proj, 'branch', '--list', 'agent/*').includes(id2), git(proj, 'branch', '--list', 'agent/*'))
  check('and your files are as they were', rd(proj, 'hello.txt') === 'HELLO\n')

  // ---- connection lost
  ssh.disconnect(c.name)
  r = await call('bg:start', projU, 'edit again', 'm')
  check('without a connection there is a clear error', r.ok === false && /Not connected/.test(r.error), JSON.stringify(r))

  await sleep(300)
  server.close()
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); process.exit(1) })
