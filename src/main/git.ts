import { ipcMain, shell } from 'electron'
import { isAbsolute, join, relative, resolve } from 'path'
import { promises as fs, realpathSync } from 'fs'
import { spawn } from 'child_process'
import * as llm from './llm'
import * as host from './hostenv'
import { isRemotePath } from './hostenv'
import { wslLocation } from './shellspec'

// Everything here shells out to the user's own `git`, so it behaves exactly like git in a terminal.

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

const MAX_OUTPUT = 8_000_000
const MAX_DIFF_FILE = 1_000_000

export function runGit(cwd: string, args: string[], opts: { input?: string; timeout?: number } = {}): Promise<GitResult> {
  if (isRemotePath(cwd)) {
    // On the other computer, or in the WSL distribution: the same git, run there (over the SSH connection, or by wsl.exe).
    const inWsl = wslLocation(cwd) !== null
    return host.exec(cwd, ['git', '-c', 'core.quotepath=false', ...args], {
      input: opts.input,
      timeout: opts.timeout,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
    }).then((r) => {
      // A distribution without git: Windows git works on its files too (see "trust" below for repositories of another user).
      if (r.code === 127 && inWsl) return runGitHere(cwd, args, opts)
      return r.code === 127 ? { ...r, stderr: 'git is not installed on the remote computer' } : r
    })
  }
  return runGitHere(cwd, args, opts)
}

function runGitHere(cwd: string, args: string[], opts: { input?: string; timeout?: number }): Promise<GitResult> {
  return new Promise((resolveResult) => {
    let child
    try {
      child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
        cwd,
        windowsHide: true,
        // Never wait for a keyboard prompt or an editor: there is no terminal here.
        // GIT_OPTIONAL_LOCKS=0: reading the status must not rewrite .git/index, or the file watcher would see it and refresh again, forever.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
      })
    } catch (e) {
      return resolveResult({ code: -1, stdout: '', stderr: String(e) })
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), opts.timeout ?? 30_000)
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf-8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf-8')
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolveResult({ code: -1, stdout, stderr: e.code === 'ENOENT' ? 'git is not installed or not on PATH' : String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveResult({ code: code ?? -1, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

// Paths from the UI are relative to the project folder; refuse anything that points outside it.
function safeRels(root: string, rels: string[]): string[] {
  for (const r of rels) {
    const abs = resolve(root, r)
    const rel = relative(root, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path is outside the project: ${r}`)
  }
  return rels
}

export interface GitFile {
  abs: string
  rel: string // relative to the project folder (may start with .. if the repo is bigger than the folder)
  index: string // X of `git status`: state in the index (staged), ' ' for none
  work: string // Y: state in the working tree
  orig?: string // old path for renames
}

export interface StashEntry {
  index: number
  date: number
  message: string
}

export interface CommitEntry {
  hash: string
  short: string
  author: string
  date: number
  subject: string
  refs: string[]
}

export interface CommitFile {
  status: string // A, M, D, R, C...
  rel: string
  orig?: string
}

export interface GitStatus {
  state: 'nogit' | 'norepo' | 'ok' | 'remote'
  error?: string
  // Git refused to work in this repository because it belongs to another user (typical for folders inside WSL):
  // the repository path git named. `git:trust` can mark it safe.
  unsafe?: string
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  hasCommits?: boolean
  files: GitFile[]
}

async function topLevel(root: string): Promise<{ top: string } | { error: string; nogit: boolean }> {
  const r = await runGit(root, ['rev-parse', '--show-toplevel'])
  if (r.code === 0) {
    const top = r.stdout.trim()
    const remote = host.parseRemote(root)
    return { top: remote ? host.remoteUnc(remote.name, top) : resolve(top) }
  }
  if (r.code === -1) return { error: r.stderr, nogit: true }
  return { error: r.stderr.trim(), nogit: false }
}

async function status(root: string): Promise<GitStatus> {
  const t = await topLevel(root)
  if ('error' in t) {
    const unsafe = /dubious ownership in repository at '([^']+)'/.exec(t.error)?.[1]
    return { state: t.nogit ? 'nogit' : 'norepo', error: t.error, unsafe, files: [] }
  }
  const r = await runGit(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
  if (r.code !== 0) return { state: 'ok', error: r.stderr.trim(), files: [] }

  const records = r.stdout.split('\0')
  const out: GitStatus = { state: 'ok', files: [] }
  const head = records.shift() ?? ''
  const m = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head)
  if (m) {
    out.branch = m[1].startsWith('HEAD (no branch)') ? 'HEAD (detached)' : m[1]
    out.upstream = m[2]
    const ahead = /ahead (\d+)/.exec(m[3] ?? '')
    const behind = /behind (\d+)/.exec(m[3] ?? '')
    out.ahead = ahead ? Number(ahead[1]) : 0
    out.behind = behind ? Number(behind[1]) : 0
  }
  out.hasCommits = !/No commits yet|Initial commit/.test(head)

  // git reports real, long-form paths; the folder we were given may be in short (8.3) form or differ in
  // case, so compare against its real path, but hand back paths built from the folder as given.
  let realRoot = root
  try {
    if (!isRemotePath(root)) realRoot = realpathSync.native(root)
  } catch {
    // Fall back to the path as given.
  }
  const relOf = (p: string): string => relative(realRoot, join(t.top, p)).replace(/\\/g, '/')

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec.length < 4) continue
    const index = rec[0]
    const work = rec[1]
    let orig: string | undefined
    if (index === 'R' || index === 'C' || work === 'R' || work === 'C') orig = records[++i] // renames carry the old path next
    const rel = relOf(rec.slice(3))
    out.files.push({ abs: resolve(root, rel), rel, index, work, orig: orig === undefined ? undefined : relOf(orig) })
  }
  return out
}

interface LineChange {
  start: number
  end: number
  kind: 'added' | 'modified' | 'deleted'
}

// Which lines of a saved file differ from HEAD (for the colored bars in the editor margin).
async function lineChanges(root: string, rel: string): Promise<{ changes: LineChange[]; untracked?: boolean }> {
  safeRels(root, [rel])
  const st = await runGit(root, ['status', '--porcelain=v1', '--', rel])
  if (st.stdout.startsWith('??')) return { changes: [], untracked: true }
  let r = await runGit(root, ['diff', '-U0', '--no-color', 'HEAD', '--', rel])
  if (r.code !== 0) r = await runGit(root, ['diff', '-U0', '--no-color', '--', rel]) // no commits yet
  const changes: LineChange[] = []
  for (const m of r.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = m[2] === undefined ? 1 : Number(m[2])
    const start = Number(m[3])
    const newCount = m[4] === undefined ? 1 : Number(m[4])
    if (newCount === 0) changes.push({ start: Math.max(1, start), end: Math.max(1, start), kind: 'deleted' })
    else changes.push({ start, end: start + newCount - 1, kind: oldCount === 0 ? 'added' : 'modified' })
  }
  return { changes }
}

async function fileAt(root: string, spec: string): Promise<string> {
  const r = await runGit(root, ['show', spec])
  return r.code === 0 ? r.stdout : ''
}

async function diffSides(
  root: string,
  rel: string,
  staged: boolean
): Promise<{ original: string; modified: string } | { error: string }> {
  safeRels(root, [rel])
  const abs = resolve(root, rel)
  if (staged) {
    const [original, modified] = await Promise.all([fileAt(root, `HEAD:${rel}`), fileAt(root, `:${rel}`)])
    return { original, modified }
  }
  const original = await fileAt(root, `:${rel}`) // index; empty for a new file
  const remote = isRemotePath(root)
  const size = remote ? await host.statSize(abs).catch(() => null) : (await fs.stat(abs).catch(() => null))?.size ?? null
  if (size === null) return { original, modified: '' } // deleted in the working tree
  if (size > MAX_DIFF_FILE) return { error: 'This file is too large to show a diff.' }
  const modified = remote ? await host.readFile(abs) : await fs.readFile(abs, 'utf-8')
  if (modified.slice(0, 1000).includes('\u0000')) return { error: 'This is a binary file.' }
  return { original, modified }
}

const fail = (r: GitResult): { ok: false; error: string } => ({ ok: false, error: (r.stderr || r.stdout).trim() || `git exited with code ${r.code}` })

export function registerGitHandlers(): void {
  ipcMain.handle('git:status', (_e, root: string) => status(root))

  // The changes in the working tree as text, for the @git mention in chat.
  ipcMain.handle('git:diffText', async (_e, root: string): Promise<string> => {
    let diff = await runGit(root, ['diff', '--no-color', 'HEAD'])
    if (diff.code !== 0) diff = await runGit(root, ['diff', '--no-color']) // no commits yet
    const untracked = await runGit(root, ['ls-files', '--others', '--exclude-standard'])
    const MAX = 40_000
    const body = diff.stdout.length > MAX ? diff.stdout.slice(0, MAX) + '\n[diff truncated]' : diff.stdout
    const list = untracked.stdout.trim().split('\n').slice(0, 50).join('\n')
    const extra = list ? `\nNew files not yet tracked:\n${list}` : ''
    return (body + extra).trim() || 'No changes.'
  })
  ipcMain.handle('git:lineChanges', (_e, root: string, rel: string) => lineChanges(root, rel))
  ipcMain.handle('git:diff', (_e, root: string, rel: string, staged: boolean) => diffSides(root, rel, staged))

  // Marks a repository that git calls unsafe as safe (a line in the user's global git config), but only the one git named.
  ipcMain.handle('git:trust', async (_e, root: string) => {
    const probe = await runGit(root, ['rev-parse', '--show-toplevel'])
    const path = /dubious ownership in repository at '([^']+)'/.exec(probe.stderr)?.[1]
    if (!path) return { ok: false as const, error: 'Git does not object to this folder.' }
    const r = await runGit(root, ['config', '--global', '--add', 'safe.directory', path])
    return r.code === 0 ? { ok: true as const } : fail(r)
  })

  ipcMain.handle('git:init', async (_e, root: string) => {
    const r = await runGit(root, ['init'])
    return r.code === 0 ? { ok: true as const } : fail(r)
  })

  ipcMain.handle('git:stage', async (_e, root: string, rels: string[] | null) => {
    const r = await runGit(root, rels ? ['add', '-A', '--', ...safeRels(root, rels)] : ['add', '-A'])
    return r.code === 0 ? { ok: true as const } : fail(r)
  })

  ipcMain.handle('git:unstage', async (_e, root: string, rels: string[] | null) => {
    const paths = rels ? ['--', ...safeRels(root, rels)] : ['--', '.']
    let r = await runGit(root, ['restore', '--staged', ...paths])
    if (r.code !== 0) r = await runGit(root, ['rm', '--cached', '-r', '-q', ...paths]) // repository without commits
    return r.code === 0 ? { ok: true as const } : fail(r)
  })

  // Throws away working-tree changes. Untracked files go to the Recycle Bin so they can be recovered.
  ipcMain.handle('git:discard', async (_e, root: string, tracked: string[], untracked: string[]) => {
    if (tracked.length) {
      const r = await runGit(root, ['restore', '--', ...safeRels(root, tracked)])
      if (r.code !== 0) return fail(r)
    }
    for (const rel of safeRels(root, untracked)) {
      const abs = resolve(root, rel)
      if (isRemotePath(abs)) await host.remove(abs).catch(() => undefined) // a server has no Recycle Bin
      else if (process.env.MY_AI_IDE_NO_TRASH) await fs.rm(abs, { recursive: true, force: true }) // tests only
      else await shell.trashItem(abs).catch(() => undefined)
    }
    return { ok: true as const }
  })

  ipcMain.handle('git:commit', async (_e, root: string, message: string) => {
    if (!message.trim()) return { ok: false as const, error: 'Write a commit message first.' }
    const staged = await runGit(root, ['diff', '--cached', '--quiet'])
    if (staged.code === 0) return { ok: false as const, error: 'Nothing is staged. Stage some changes first.' }
    const r = await runGit(root, ['commit', '-F', '-'], { input: message })
    return r.code === 0 ? { ok: true as const } : fail(r)
  })

  ipcMain.handle('git:branches', async (_e, root: string) => {
    const r = await runGit(root, ['branch', '--format=%(HEAD)|%(refname:short)'])
    if (r.code !== 0) return { ok: false as const, error: r.stderr.trim(), branches: [] as { name: string; current: boolean }[] }
    const branches = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ current: l.startsWith('*'), name: l.slice(2) }))
      .filter((b) => !b.name.startsWith('('))
    return { ok: true as const, branches }
  })

  ipcMain.handle('git:checkout', async (_e, root: string, name: string, create: boolean) => {
    const valid = await runGit(root, ['check-ref-format', '--branch', name])
    if (valid.code !== 0) return { ok: false as const, error: `"${name}" is not a valid branch name.` }
    const r = await runGit(root, create ? ['checkout', '-b', name] : ['checkout', name])
    return r.code === 0 ? { ok: true as const } : fail(r)
  })

  ipcMain.handle('git:remote', async (_e, root: string, op: 'push' | 'pull' | 'fetch') => {
    const opts = { timeout: 120_000 }
    let r = await runGit(root, op === 'pull' ? ['pull', '--no-edit'] : [op], opts)
    if (op === 'push' && r.code !== 0 && /no upstream branch/i.test(r.stderr)) {
      r = await runGit(root, ['push', '--set-upstream', 'origin', 'HEAD'], opts)
    }
    return r.code === 0 ? { ok: true as const, output: (r.stdout + r.stderr).trim() } : fail(r)
  })

  // ---- Stash ----
  const stashRef = (n: unknown): string => {
    if (!Number.isInteger(n) || (n as number) < 0) throw new Error('Bad stash number.')
    return `stash@{${n}}`
  }

  ipcMain.handle('git:stashList', async (_e, root: string) => {
    const r = await runGit(root, ['stash', 'list', '--format=%gd%x1f%ct%x1f%s'])
    if (r.code !== 0) return { ok: false as const, error: (r.stderr || r.stdout).trim(), stashes: [] as StashEntry[] }
    const stashes: StashEntry[] = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, ct, subject] = l.split('\x1f')
        return { index: Number(/\{(\d+)\}/.exec(ref)?.[1] ?? 0), date: Number(ct) * 1000, message: subject }
      })
    return { ok: true as const, stashes }
  })

  ipcMain.handle('git:stashPush', async (_e, root: string, message: string, includeUntracked: boolean) => {
    const args = ['stash', 'push']
    if (includeUntracked) args.push('--include-untracked')
    if (message.trim()) args.push('-m', message.trim())
    const r = await runGit(root, args)
    if (r.code !== 0) return fail(r)
    if (/No local changes to save/i.test(r.stdout + r.stderr)) return { ok: false as const, error: 'There are no changes to stash.' }
    return { ok: true as const }
  })

  // apply keeps the stash; pop removes it once it applied cleanly (git itself keeps it when there are conflicts).
  ipcMain.handle('git:stashApply', async (_e, root: string, n: number, pop: boolean) => {
    const r = await runGit(root, ['stash', pop ? 'pop' : 'apply', stashRef(n)])
    const out = (r.stdout + r.stderr).trim()
    if (r.code === 0) return { ok: true as const, output: out }
    return { ok: false as const, error: /CONFLICT/.test(out) ? 'Applied with merge conflicts. Resolve them in the files marked !; the stash was kept.' : out || `git exited with code ${r.code}` }
  })

  ipcMain.handle('git:stashDrop', async (_e, root: string, n: number) => {
    const r = await runGit(root, ['stash', 'drop', stashRef(n)])
    return r.code === 0 ? { ok: true as const } : fail(r)
  })

  // ---- History ----
  const HASH = /^[0-9a-f]{7,40}$/
  const goodHash = (h: string): string => {
    if (!HASH.test(h)) throw new Error('Bad commit id.')
    return h
  }

  // Commits of the current branch, newest first; `rel` limits it to one file (following renames).
  ipcMain.handle('git:log', async (_e, root: string, rel: string | null, skip: number, limit: number) => {
    const args = ['log', '--format=%H%x1f%an%x1f%ct%x1f%s%x1f%D%x1e', `--skip=${Math.max(0, skip | 0)}`, `-n${Math.min(200, Math.max(1, limit | 0))}`]
    if (rel) args.push('--follow', '--', ...safeRels(root, [rel]))
    const r = await runGit(root, args)
    if (r.code !== 0) {
      if (/does not have any commits|unknown revision|bad default revision/i.test(r.stderr)) return { ok: true as const, commits: [] as CommitEntry[] }
      return { ok: false as const, error: r.stderr.trim(), commits: [] as CommitEntry[] }
    }
    const commits: CommitEntry[] = r.stdout
      .split('\x1e')
      .map((s) => s.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec) => {
        const [hash, author, ct, subject, refs] = rec.split('\x1f')
        return { hash, short: hash.slice(0, 7), author, date: Number(ct) * 1000, subject, refs: refs ? refs.split(', ').filter(Boolean) : [] }
      })
    return { ok: true as const, commits }
  })

  ipcMain.handle('git:commitFiles', async (_e, root: string, hash: string) => {
    const r = await runGit(root, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M', '--root', '-m', '--first-parent', '--relative', goodHash(hash)])
    if (r.code !== 0) return { ok: false as const, error: r.stderr.trim(), files: [] as CommitFile[] }
    const parts = r.stdout.split('\0').filter((s, i, a) => s !== '' || i < a.length - 1)
    const files: CommitFile[] = []
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++]
      if (!status) continue
      if (status[0] === 'R' || status[0] === 'C') {
        const orig = parts[i++]
        files.push({ status: status[0], rel: parts[i++], orig })
      } else files.push({ status: status[0], rel: parts[i++] })
    }
    return { ok: true as const, files }
  })

  // Before and after text of one file in one commit (for the diff view).
  ipcMain.handle('git:commitDiff', async (_e, root: string, hash: string, rel: string, orig?: string) => {
    goodHash(hash)
    safeRels(root, orig ? [rel, orig] : [rel])
    const [original, modified] = await Promise.all([fileAt(root, `${hash}^:./${orig ?? rel}`), fileAt(root, `${hash}:./${rel}`)])
    return { original, modified }
  })

  // ---- Merge conflicts ----
  ipcMain.handle('git:mergeState', async (_e, root: string) => {
    const merge = await runGit(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
    return { merging: merge.code === 0 }
  })

  ipcMain.handle('git:mergeAbort', async (_e, root: string) => {
    const r = await runGit(root, ['merge', '--abort'])
    return r.code === 0 ? { ok: true as const } : fail(r)
  })

  // Resolves a whole conflicted file in favour of one side and stages it.
  ipcMain.handle('git:take', async (_e, root: string, rel: string, side: 'ours' | 'theirs') => {
    safeRels(root, [rel])
    if (side !== 'ours' && side !== 'theirs') return { ok: false as const, error: 'Bad side.' }
    const r = await runGit(root, ['checkout', `--${side}`, '--', rel])
    if (r.code !== 0) return fail(r)
    const a = await runGit(root, ['add', '--', rel])
    return a.code === 0 ? { ok: true as const } : fail(a)
  })

  // A commit message for what is staged, written by Claude (Haiku: this should be quick and cheap).
  ipcMain.handle('git:generateMessage', async (_e, root: string) => {
    const [diff, stat] = await Promise.all([
      runGit(root, ['diff', '--cached', '--no-color']),
      runGit(root, ['diff', '--cached', '--stat', '--no-color'])
    ])
    if (!diff.stdout.trim()) return { ok: false as const, error: 'Nothing is staged, so there is nothing to describe.' }
    if (!(await llm.ready())) return { ok: false as const, error: llm.notReady }
    const MAX = 14_000 // the service takes one question of about 20,000 characters
    const body = diff.stdout.length > MAX ? diff.stdout.slice(0, MAX) + '\n[diff truncated]' : diff.stdout
    try {
      const raw = await llm.text({
        maxTokens: 400,
        system:
          'You write git commit messages. Reply with ONLY the message: a subject line in the imperative mood of at most 72 characters, ' +
          'then, only if the change really needs it, a blank line and a short body. No quotes, no markdown fences, no preamble. ' +
          'Do not include internal or system XML tags in your response.',
        prompt: `Files changed:\n${stat.stdout}\nDiff:\n${body}`
      })
      const text = raw.replace(/^```\w*\n?|\n?```$/g, '').trim()
      return text ? { ok: true as const, message: text } : { ok: false as const, error: 'The model returned nothing.' }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

}
