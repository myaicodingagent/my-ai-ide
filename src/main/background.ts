import { app, BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { createHash, randomUUID } from 'crypto'
import { runGit } from './git'
import * as host from './hostenv'
import { isRemotePath } from './hostenv'
import { AgentEvent, resetSession, runAgentTask } from './agent'

// Background agents: a task is handed to the agent, which works on its own copy of the project (a git worktree on
// its own branch) while you keep editing. Nothing touches your files until you review the result and apply it.
//   start    git worktree add -b agent/<id> <dir> <snapshot of your files>
//   run      the normal agent loop with edits applied automatically (commands still wait for you)
//   finish   everything it changed is committed on the branch; you see the file list and diffs
//   apply    the branch's changes are applied to your working tree (conflicts show up like any merge conflict)
//   discard  the worktree and the branch are removed

export type BgStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'applied'

export interface BgTask {
  id: string
  task: string
  model: string
  root: string // the project folder the task was started from
  top: string // the top of the repository containing it
  branch: string
  worktree: string
  agentRoot: string // where the agent works (the worktree, or the same sub-folder inside it)
  base: string // the snapshot the branch started from
  status: BgStatus
  summary: string // the agent's latest words
  activity: string // what it is doing now
  steps: number
  error?: string
  started: number
  finished?: number
  runId: number
  waitId?: string // id of the command waiting for approval
  waitCommand?: string
  files: { status: string; rel: string; orig?: string }[]
  committed: boolean
}

const MAX_RUNNING = 3
const BG_STEPS = 40
let nextRunId = 5_000_000

const tasks = new Map<string, BgTask>()
const controllers = new Map<string, AbortController>()
const finishing = new Map<string, Promise<void>>()
let loaded = false
let getWinRef: () => BrowserWindow | null = () => null

const dataDir = (): string => join(app.getPath('userData'), 'background')
const stateFile = (): string => join(dataDir(), 'tasks.json')
const worktreesDir = (): string => join(dataDir(), 'worktrees')

async function load(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const list = JSON.parse(await fs.readFile(stateFile(), 'utf-8')) as BgTask[]
    for (const t of Array.isArray(list) ? list : []) {
      if (!t || typeof t.id !== 'string') continue
      if (t.status === 'running' || t.status === 'waiting') {
        t.status = 'failed'
        t.error = 'The app was closed while this was running. What it had done so far is kept on its branch.'
        t.waitId = undefined
        t.waitCommand = undefined
        t.finished = Date.now()
        tasks.set(t.id, t)
        if (!isRemotePath(t.root)) void commitAndList(t) // save the partial work (a remote one is saved when the connection is back)
      } else tasks.set(t.id, t)
    }
  } catch {
    // No saved tasks yet.
  }
}

let saveTimer: NodeJS.Timeout | null = null
function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    try {
      await fs.mkdir(dataDir(), { recursive: true })
      await fs.writeFile(stateFile(), JSON.stringify([...tasks.values()]), 'utf-8')
    } catch {
      // Best effort.
    }
  }, 300)
}

const pushTimers = new Map<string, NodeJS.Timeout>()
function push(t: BgTask, immediately = false): void {
  save()
  const send = (): void => {
    pushTimers.delete(t.id)
    getWinRef()?.webContents.send('bg:update', t)
  }
  if (immediately) {
    const old = pushTimers.get(t.id)
    if (old) clearTimeout(old)
    return send()
  }
  if (!pushTimers.has(t.id)) pushTimers.set(t.id, setTimeout(send, 150))
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'task'

async function ownsIdentity(cwd: string): Promise<boolean> {
  const n = await runGit(cwd, ['config', 'user.name'])
  const e = await runGit(cwd, ['config', 'user.email'])
  return n.code === 0 && n.stdout.trim() !== '' && e.code === 0 && e.stdout.trim() !== ''
}

// Commits whatever the agent changed on the task's branch and lists the files that differ from the start.
async function commitAndList(t: BgTask): Promise<void> {
  try {
    const dir = t.agentRoot
    await runGit(t.worktree, ['add', '-A'])
    const pending = await runGit(t.worktree, ['diff', '--cached', '--quiet'])
    if (pending.code !== 0) {
      const identity = (await ownsIdentity(t.worktree)) ? [] : ['-c', 'user.name=My AI IDE Agent', '-c', 'user.email=agent@my-ai-ide.local']
      await runGit(t.worktree, [...identity, 'commit', '-q', '-m', `Agent: ${t.task.split('\n')[0].slice(0, 100)}`])
    }
    t.committed = true
    const r = await runGit(dir, ['diff', '--name-status', '-z', '-M', '--relative', t.base, 'HEAD'])
    const parts = r.stdout.split('\0').filter((s, i, a) => s !== '' || i < a.length - 1)
    const files: BgTask['files'] = []
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++]
      if (!status) continue
      if (status[0] === 'R' || status[0] === 'C') {
        const orig = parts[i++]
        files.push({ status: status[0], rel: parts[i++], orig })
      } else files.push({ status: status[0], rel: parts[i++] })
    }
    t.files = files
  } catch {
    // Listing is a convenience; the branch still holds the work.
  }
  push(t, true)
}

const MAX_SEED_FILES = 2000
const MAX_SEED_BYTES = 5_000_000

// Makes the copy match your folder: untracked files are copied in and committed as the starting point, and an
// ignored node_modules is linked (a junction, no admin rights needed) instead of reinstalled.
async function seedWorktree(top: string, worktree: string, base: string): Promise<{ ok: true; base: string } | { ok: false; error: string }> {
  try {
    const remote = isRemotePath(top)
    const list = await runGit(top, ['ls-files', '--others', '--exclude-standard', '-z'])
    const rels = list.stdout.split('\0').filter(Boolean).slice(0, MAX_SEED_FILES)
    let copied = 0
    if (remote) {
      // Over SSH: the files are copied on the other computer, with tar, once their sizes are known to be small enough.
      const keep: string[] = []
      for (let i = 0; i < rels.length; i += 25) {
        const sizes = await Promise.all(rels.slice(i, i + 25).map((rel) => host.statSize(remoteChild(top, rel)).catch(() => -1)))
        sizes.forEach((size, k) => {
          if (size >= 0 && size <= MAX_SEED_BYTES) keep.push(rels[i + k])
        })
      }
      if (keep.length) {
        const r = await host.exec(top, ['sh', '-c', 'tar --null -T - -cf - | (cd "$1" && tar xf -)', 'sh', host.nativePath(worktree) as string], { input: keep.join('\0') + '\0', timeout: 120_000 })
        if (r.code !== 0) throw new Error('Could not copy your untracked files: ' + (r.stderr || r.stdout).trim())
        copied = keep.length
      }
    } else {
      for (const rel of rels) {
        const from = join(top, rel)
        const st = await fs.stat(from).catch(() => null)
        if (!st || !st.isFile() || st.size > MAX_SEED_BYTES) continue
        const to = join(worktree, rel)
        await fs.mkdir(dirname(to), { recursive: true })
        await fs.copyFile(from, to)
        copied++
      }
    }
    let start = base
    if (copied) {
      await runGit(worktree, ['add', '-A'])
      const identity = (await ownsIdentity(worktree)) ? [] : ['-c', 'user.name=My AI IDE Agent', '-c', 'user.email=agent@my-ai-ide.local']
      const c = await runGit(worktree, [...identity, 'commit', '-q', '-m', 'Your untracked files'])
      const head = await runGit(worktree, ['rev-parse', 'HEAD'])
      if (c.code === 0 && head.code === 0) start = head.stdout.trim()
    }
    const ignored = await runGit(top, ['check-ignore', '-q', 'node_modules'])
    if (remote) {
      if (ignored.code === 0) await host.exec(top, ['sh', '-c', '[ -d node_modules ] && ln -s "$PWD/node_modules" "$1/node_modules"; true', 'sh', host.nativePath(worktree) as string])
    } else {
      const nm = join(top, 'node_modules')
      if (ignored.code === 0 && (await fs.stat(nm).catch(() => null))?.isDirectory()) {
        await fs.symlink(nm, join(worktree, 'node_modules'), 'junction').catch(() => undefined)
      }
    }
    return { ok: true, base: start }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** A path below a folder on the other computer, in the editor's form. */
const remoteChild = (dirUnc: string, rel: string): string => dirUnc.replace(/\\+$/, '') + '\\' + rel.replace(/\//g, '\\')

async function start(root: string, taskText: string, model: string): Promise<{ ok: true; task: BgTask } | { ok: false; error: string }> {
  await load()
  const remote = isRemotePath(root) ? (host.parseRemote(root)?.name as string) : null
  const running = [...tasks.values()].filter((t) => t.status === 'running' || t.status === 'waiting').length
  if (running >= MAX_RUNNING) return { ok: false, error: `${MAX_RUNNING} background agents are already working. Wait for one to finish or stop it.` }
  if (!taskText.trim()) return { ok: false, error: 'Describe the task first.' }

  const top = await runGit(root, ['rev-parse', '--show-toplevel'])
  if (top.code === -1 && remote) return { ok: false, error: top.stderr.trim() || 'Could not reach the other computer.' }
  if (top.code !== 0) return { ok: false, error: 'Background agents need the project to be a git repository (they work on a separate branch).' }
  const head = await runGit(root, ['rev-parse', 'HEAD'])
  if (head.code !== 0) return { ok: false, error: 'Make a first commit in this repository before starting a background agent.' }
  const topDir = remote ? host.fromNativePath(remote, top.stdout.trim()) : resolve(top.stdout.trim())

  // Start from your files as they are now (changes to tracked files included), not just from the last commit.
  const snap = await runGit(topDir, ['stash', 'create'])
  const base = snap.code === 0 && snap.stdout.trim() ? snap.stdout.trim() : head.stdout.trim()

  const id = randomUUID().slice(0, 8)
  const branch = `agent/${id}-${slug(taskText)}`
  const repoKey = createHash('sha1').update(topDir.toLowerCase()).digest('hex').slice(0, 8)
  let worktree: string
  if (remote) {
    // On the other computer the copy lives inside the repository's own .git folder: always writable, never listed by git status.
    const gd = await runGit(topDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const common = gd.code === 0 && gd.stdout.trim() ? gd.stdout.trim() : (host.nativePath(topDir) as string) + '/.git'
    worktree = host.fromNativePath(remote, common + '/my-ai-ide-worktrees/' + id)
  } else {
    worktree = join(worktreesDir(), repoKey, id)
    await fs.mkdir(join(worktreesDir(), repoKey), { recursive: true })
  }
  const add = await runGit(topDir, ['worktree', 'add', '-q', '-b', branch, remote ? (host.nativePath(worktree) as string) : worktree, base], { timeout: 120_000 })
  if (add.code !== 0) return { ok: false, error: (add.stderr || add.stdout).trim() || 'Could not create the working copy.' }

  const seeded = await seedWorktree(topDir, worktree, base)
  if (!seeded.ok) {
    await runGit(topDir, ['worktree', 'remove', '--force', remote ? (host.nativePath(worktree) as string) : worktree])
    await runGit(topDir, ['branch', '-D', branch])
    return { ok: false, error: seeded.error }
  }

  let agentRoot = worktree
  if (remote) {
    // The same sub-folder inside the copy (both paths are as the other computer writes them).
    const rootNative = host.nativePath(root) as string
    const topNative = top.stdout.trim().replace(/\/+$/, '')
    if (rootNative.startsWith(topNative + '/')) agentRoot = remoteChild(worktree, rootNative.slice(topNative.length + 1))
  } else {
    let realTop = topDir
    try {
      realTop = (await fs.realpath(topDir)) || topDir
    } catch {
      // keep as given
    }
    const sub = relative(realTop, await fs.realpath(root).catch(() => root))
    if (sub && !sub.startsWith('..')) agentRoot = join(worktree, sub)
  }

  const t: BgTask = {
    id, task: taskText.trim(), model, root, top: topDir, branch, worktree, agentRoot, base: seeded.base,
    status: 'running', summary: '', activity: 'Starting…', steps: 0, started: Date.now(), runId: ++nextRunId, files: [], committed: false
  }
  tasks.set(id, t)
  push(t, true)
  void run(t)
  return { ok: true, task: t }
}

async function run(t: BgTask): Promise<void> {
  const controller = new AbortController()
  controllers.set(t.id, controller)
  let current = ''
  let outcome: { kind: 'done' | 'error' | 'aborted'; message?: string } = { kind: 'done' }
  const send = (e: AgentEvent): void => {
    getWinRef()?.webContents.send('agent:event', t.runId, e)
    switch (e.type) {
      case 'text':
        current += e.text
        t.summary = current.slice(-1200)
        break
      case 'tool_start':
        t.steps++
        current = ''
        t.activity = describe(e.name, e.input)
        if (t.status === 'waiting') t.status = 'running'
        break
      case 'command_request':
        t.status = 'waiting'
        t.waitId = e.id
        t.waitCommand = e.command
        break
      case 'tool_end':
        t.status = 'running'
        t.waitId = undefined
        t.waitCommand = undefined
        break
      case 'done':
        outcome = { kind: e.stopReason === 'aborted' ? 'aborted' : 'done' }
        break
      case 'error':
        outcome = { kind: 'error', message: e.message }
        break
      default:
        return
    }
    push(t, e.type === 'command_request' || e.type === 'tool_end')
  }
  try {
    await runAgentTask(
      {
        runId: t.runId,
        sessionId: 'bg-' + t.id,
        model: t.model,
        root: t.agentRoot,
        task: t.task,
        autoApproveEdits: true,
        maxSteps: BG_STEPS,
        extraSystem:
          '\n\nThis is a background task. You are working in an isolated copy of the project (a git worktree on its own branch), so your edits are applied immediately and the user reviews the whole result afterwards. ' +
          'Nobody is watching: do not ask questions, make reasonable assumptions and say which you made. Untracked files were copied in, and node_modules (if the project has one) is linked to the original, so do not reinstall or modify packages. ' +
          'Finish with a short summary of what you changed and anything the user should check.'
      },
      send,
      controller.signal
    )
  } catch (e) {
    outcome = { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  controllers.delete(t.id)
  t.finished = Date.now()
  t.waitId = undefined
  t.waitCommand = undefined
  t.activity = ''
  if (outcome.kind === 'error') {
    t.status = 'failed'
    t.error = outcome.message
  } else t.status = outcome.kind === 'aborted' ? 'stopped' : 'done'
  const p = commitAndList(t).finally(() => finishing.delete(t.id))
  finishing.set(t.id, p)
  await p
}

function describe(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const p = typeof i.path === 'string' ? i.path : ''
  switch (name) {
    case 'read_file': return `Reading ${p}`
    case 'list_dir': return `Listing ${p}`
    case 'edit_file': return `Editing ${p}`
    case 'write_file': return `Writing ${p}`
    case 'search_text': return `Searching for ${String(i.pattern ?? '')}`
    case 'search_codebase': return `Searching the code: ${String(i.query ?? '')}`
    case 'find_files': return `Finding ${String(i.pattern ?? '')}`
    case 'run_command': return `Running ${String(i.command ?? '').split('\n')[0].slice(0, 60)}`
    default: return name
  }
}

const getTask = (id: string): BgTask => {
  const t = tasks.get(id)
  if (!t) throw new Error('That task no longer exists.')
  return t
}

async function fileAt(cwd: string, spec: string): Promise<string> {
  const r = await runGit(cwd, ['show', spec])
  return r.code === 0 ? r.stdout : ''
}

async function apply(t: BgTask): Promise<{ ok: true; conflicts: boolean; output: string } | { ok: false; error: string }> {
  if (t.status === 'running' || t.status === 'waiting') return { ok: false, error: 'Wait for the task to finish (or stop it) first.' }
  if (t.status === 'applied') return { ok: false, error: 'This task was already applied.' }
  await finishing.get(t.id)
  if (!t.files.length) return { ok: false, error: 'The agent made no changes.' }
  const patch = await runGit(t.worktree, ['diff', '--binary', t.base, 'HEAD'])
  if (patch.code !== 0 || !patch.stdout.trim()) return { ok: false, error: (patch.stderr || 'Could not read the changes.').trim() }
  // --3way merges into files you have changed too, and leaves conflict markers where they overlap.
  let r = await runGit(t.top, ['apply', '--3way', '--whitespace=nowarn'], { input: patch.stdout, timeout: 60_000 })
  let out = (r.stdout + r.stderr).trim()
  if (r.code !== 0 && !/with conflicts/i.test(out)) {
    // A plain apply as a second chance (a 3-way merge needs the original file versions in this repository).
    const plain = await runGit(t.top, ['apply', '--whitespace=nowarn'], { input: patch.stdout, timeout: 60_000 })
    if (plain.code !== 0) {
      return { ok: false, error: `Your files differ from where the agent started in a way that does not combine cleanly:
${out || (plain.stderr || plain.stdout).trim()}

Commit or stash your own changes to those files and try again.` }
    }
    r = plain
    out = (plain.stdout + plain.stderr).trim()
  }
  t.status = 'applied'
  push(t, true)
  return { ok: true, conflicts: /with conflicts/i.test(out), output: out }
}

async function discard(t: BgTask): Promise<void> {
  controllers.get(t.id)?.abort()
  await finishing.get(t.id)
  const cwd = t.top
  // Remove the node_modules link first so removing the copy can never reach into the real folder.
  if (isRemotePath(t.worktree)) {
    await host.exec(t.worktree, ['sh', '-c', '[ -L node_modules ] && rm node_modules; true']).catch(() => undefined)
    await runGit(cwd, ['worktree', 'remove', '--force', host.nativePath(t.worktree) as string], { timeout: 60_000 })
  } else {
    await fs.rm(join(t.worktree, 'node_modules'), { force: true, recursive: false }).catch(() => undefined)
    await runGit(cwd, ['worktree', 'remove', '--force', t.worktree], { timeout: 60_000 })
    await fs.rm(t.worktree, { recursive: true, force: true }).catch(() => undefined)
  }
  await runGit(cwd, ['worktree', 'prune'])
  await runGit(cwd, ['branch', '-D', t.branch])
  resetSession('bg-' + t.id)
  tasks.delete(t.id)
  save()
  getWinRef()?.webContents.send('bg:removed', t.id)
}

export function registerBackgroundHandlers(getWin: () => BrowserWindow | null): void {
  getWinRef = getWin
  ipcMain.handle('bg:list', async () => {
    await load()
    const live = new Set(host.connected().map((c) => c.name))
    for (const t of tasks.values()) {
      const name = isRemotePath(t.root) ? host.parseRemote(t.root)?.name : undefined
      if (name && live.has(name) && !t.committed && t.status === 'failed') void commitAndList(t)
    }
    return [...tasks.values()].sort((a, b) => b.started - a.started)
  })
  ipcMain.handle('bg:start', (_e, root: string, task: string, model: string) => start(root, String(task ?? ''), String(model ?? '')))
  ipcMain.handle('bg:stop', (_e, id: string) => {
    controllers.get(id)?.abort()
  })
  ipcMain.handle('bg:fileDiff', async (_e, id: string, rel: string, orig?: string) => {
    const t = getTask(id)
    await finishing.get(id)
    const [original, modified] = await Promise.all([fileAt(t.agentRoot, `${t.base}:./${orig ?? rel}`), fileAt(t.agentRoot, `HEAD:./${rel}`)])
    return { original, modified, abs: isRemotePath(t.root) ? remoteChild(t.root, rel) : join(t.root, rel) }
  })
  ipcMain.handle('bg:apply', (_e, id: string) => apply(getTask(id)))
  ipcMain.handle('bg:discard', async (_e, id: string) => {
    await discard(getTask(id))
  })
}

/** Called when the app is closing: running tasks are stopped (their work so far is saved by the next start). */
export function stopAllBackground(): void {
  for (const c of controllers.values()) c.abort()
}
