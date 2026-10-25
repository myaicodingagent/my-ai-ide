// Background agents for a folder in a WSL distribution: the real background and git modules run against a real distribution
// (default Ubuntu-24.04; WSL_TEST_DISTRO to change). Only the model is replaced: the "agent" makes fixed edits through the real
// agent tools. The project is a git repository inside the distribution, addressed as \\wsl.localhost\<distro>\...
// `npm run test:wsl-background`: skipped without the distribution (needs git in it); does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process')
const distro = process.env.WSL_TEST_DISTRO || 'Ubuntu-24.04'
const wsl = (script) => cp.spawnSync('wsl.exe', ['-d', distro, '--user', 'root', '--exec', 'sh', '-c', script], { encoding: 'utf-8', windowsHide: true })
if (wsl('command -v git').status !== 0) { console.log('SKIP  no WSL distribution ' + distro + ' with git'); process.exit(0) }
const handlers = {}
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-bg-')))
global.__electronStub = {
  ipcMain: { handle: (n, f) => { handlers[n] = f }, on: () => {} },
  shell: {}, safeStorage: {}, BrowserWindow: class {}, app: { getPath: () => path.join(tmp, 'userData') }
}
const root = path.join(__dirname, '..')
const cache = path.join(root, 'node_modules', '.cache')
const posix = (p) => p.split(path.sep).join('/')
fs.mkdirSync(cache, { recursive: true })
const stub = path.join(cache, 'wsl-bg-stub.cjs'), bundle = path.join(cache, 'wsl-bg-bundle.cjs'), entry = path.join(cache, 'wsl-bg-entry.ts'), agentStub = path.join(cache, 'wsl-bg-agent.ts')
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
fs.writeFileSync(entry, `export * as bg from ${JSON.stringify(posix(path.join(root, 'src/main/background.ts')))}\n`)
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
  const { bg } = require(bundle)
  bg.registerBackgroundHandlers(() => ({ webContents: { send: () => undefined } }))
  const call = (n, ...a) => handlers[n]({}, ...a)
  const results = []
  const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 260) : ''}`) }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function until(pred, what, ms = 90000) {
    const t0 = Date.now()
    for (;;) {
      const v = await pred()
      if (v) return v
      if (Date.now() - t0 > ms) throw new Error('Timed out: ' + what)
      await sleep(150)
    }
  }
  const base = '/root/wslbg-' + process.pid
  const projN = base + '/proj'
  const unc = (p) => '\\\\wsl.localhost\\' + distro + p.split('/').join('\\')
  const projU = unc(projN)
  const sh = (script) => wsl(`cd ${projN} && ${script}`)
  const git = (args) => sh(`git -c user.name=t -c user.email=t@t ${args}`).stdout
  wsl(`rm -rf ${base} && mkdir -p ${projN}/sub && cd ${projN} && git init -q && printf 'node_modules\\n' > .gitignore && printf 'hello\\n' > hello.txt && printf 'inner\\n' > sub/inner.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm first && printf 'my notes\\n' > notes.txt`)
  const catN = (p) => wsl(`cat "${p}"`).stdout
  const existsN = (p) => wsl(`test -e "${p}"`).status === 0
  const worktrees = () => wsl(`ls ${projN}/.git/my-ai-ide-worktrees 2>/dev/null`).stdout.split('\n').filter(Boolean)
  try {
    let r = await call('bg:start', projU + 'x', 'edit hello', 'm')
    check('a folder that does not exist is refused with a readable message', r.ok === false, JSON.stringify(r))
    r = await call('bg:start', projU, 'edit hello and create a file', 'm')
    check('a background agent starts in a folder in the distribution', r.ok === true, JSON.stringify(r))
    const id = r.task.id
    check('its copy is a worktree below .git in the distribution', /my-ai-ide-worktrees/.test(r.task.worktree) && /^\\\\wsl/i.test(r.task.worktree) && r.task.agentRoot === r.task.worktree, r.task.worktree)
    const done = await until(async () => (await call('bg:list')).find((t) => t.id === id && t.status !== 'running' && t.committed && t.files.length), 'task done')
    check('it finishes', done.status === 'done' && done.steps >= 1 && /Done: created/.test(done.summary), JSON.stringify({ s: done.status, e: done.error, steps: done.steps }))
    const wt = worktrees()
    const wtN = `${projN}/.git/my-ai-ide-worktrees/${wt[0]}`
    check('the copy exists, with your untracked file copied in', wt.length === 1 && catN(wtN + '/notes.txt') === 'my notes\n', JSON.stringify(wt))
    check('the agent worked on the copy (it saw notes.txt) and your own folder is untouched', /seen/.test(catN(wtN + '/bg-created.txt')) && !existsN(projN + '/bg-created.txt') && catN(projN + '/hello.txt') === 'hello\n')
    check('your git status does not list the copy', !/my-ai-ide/.test(git('status --porcelain')), git('status --porcelain'))
    check('the changed files are listed', done.files.map((f) => f.status + f.rel).sort().join() === 'Abg-created.txt,Mhello.txt', JSON.stringify(done.files))
    const d = await call('bg:fileDiff', id, 'hello.txt')
    check('a file\'s diff has both sides, and its address in your folder', d.original === 'hello\n' && d.modified === 'HELLO\n' && d.abs === projU + '\\hello.txt', JSON.stringify(d))
    const ap = await call('bg:apply', id)
    check('apply puts the changes into your folder', ap.ok === true && catN(projN + '/hello.txt') === 'HELLO\n' && existsN(projN + '/bg-created.txt'), JSON.stringify(ap))
    check('and the task is marked applied', (await call('bg:list')).find((t) => t.id === id).status === 'applied')
    git('add -A'); git('commit -qm applied')
    r = await call('bg:start', unc(projN + '/sub'), 'just create', 'm')
    check('an agent can start in a sub-folder', r.ok === true && r.task.agentRoot === r.task.worktree + '\\sub', JSON.stringify(r.task && r.task.agentRoot))
    const id2 = r.task.id
    await until(async () => (await call('bg:list')).find((t) => t.id === id2 && t.status !== 'running' && t.committed && t.files.length), 'task 2 done')
    const before = worktrees().length
    await call('bg:discard', id2)
    check('discard removes the copy and its branch', before === 2 && worktrees().length === 1 && !(await call('bg:list')).some((t) => t.id === id2) && !git('branch --list agent/*').includes(id2), git('branch --list agent/*'))
    check('and your files are as they were', catN(projN + '/hello.txt') === 'HELLO\n')
  } finally {
    wsl(`rm -rf ${base}`)
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* only a temp folder */ }
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + e.message); wsl('rm -rf /root/wslbg-' + process.pid); process.exit(1) })
