import { app, ipcMain, safeStorage, BrowserWindow } from 'electron'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import Anthropic from '@anthropic-ai/sdk'
import { loadKey } from './ai'
import * as backend from './backend'
import * as llm from './llm'
import { rulesPrompt } from './rules'
import { formatHits, searchCodebase } from './codeindex'
import { wslCommandArgs, wslLocation } from './shellspec'
import * as ssh from './sshfs'
import { isRemotePath } from './sshfs'

type Param = Anthropic.Beta.Messages.BetaMessageParam
type Tool = Anthropic.Beta.Messages.BetaTool

export interface RunRequest {
  runId: number
  sessionId: string
  model: string
  root: string
  task: string
  // Background runs work in their own copy of the project: edits there are applied without asking, and the
  // result is reviewed as a whole afterwards. Commands are still approved one by one.
  autoApproveEdits?: boolean
  extraSystem?: string // appended to the system prompt
  maxSteps?: number
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; output: string; isError: boolean }
  | { type: 'approval_request'; id: string; tool: string; path: string; before: string; after: string; isNew: boolean }
  | { type: 'command_request'; id: string; command: string; cwd: string }
  | { type: 'tool_output'; id: string; text: string }
  | { type: 'workspace_touched' }
  | { type: 'applied'; changeId: string; path: string; isNew: boolean }
  | { type: 'file_changed'; path: string; content: string | null }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; message: string }

const MAX_STEPS = 25
const IGNORED = new Set(['.git', 'node_modules', 'out', 'dist', 'release'])
const MAX_READ_CHARS = 100_000
const MAX_SEARCH_MATCHES = 100
const MAX_FIND_RESULTS = 200

const MAX_WRITE_CHARS = 1_000_000
const WRITE_TOOLS = new Set(['edit_file', 'write_file'])

interface Change {
  id: string
  rel: string
  abs: string
  before: string | null
  after: string
}

const sessions = new Map<string, Param[]>()
const running = new Map<number, AbortController>()
const changes = new Map<string, Change[]>()
// Things the model should be told at the start of the next turn, e.g. that the user undid a change.
const notes = new Map<string, string[]>()
const pendingApprovals = new Map<string, (ok: boolean) => void>()

// ---- Saved conversations: one per project folder (the session id is the folder path), plain JSON in
// <app data>/agent. <hash>.json holds what the model remembers; <hash>.ui.json what the panel shows. ----
const MAX_SAVED_BYTES = 1_500_000
const MAX_SAVED_CHANGES = 50
const MAX_CHANGE_BYTES = 300_000


// Saved files are encrypted with Windows (safeStorage) when it is available: "AIDE1" + the encrypted bytes.
// Older plain-JSON files are still read, and are encrypted the next time they are saved.
const ENC_MAGIC = Buffer.from('AIDE1')
async function writeSecure(file: string, text: string): Promise<void> {
  const data = safeStorage.isEncryptionAvailable() ? Buffer.concat([ENC_MAGIC, safeStorage.encryptString(text)]) : Buffer.from(text, 'utf-8')
  await fs.writeFile(file, data)
}
async function readSecure(file: string): Promise<string> {
  const raw = await fs.readFile(file)
  if (raw.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) return safeStorage.decryptString(raw.subarray(ENC_MAGIC.length))
  return raw.toString('utf-8')
}

const agentDir = (): string => join(app.getPath('userData'), 'agent')
const agentFile = (sessionId: string, ui = false): string =>
  join(agentDir(), createHash('sha1').update(sessionId.toLowerCase()).digest('hex').slice(0, 16) + (ui ? '.ui' : '') + '.json')

// A "task" is a user message holding text (as opposed to one holding tool results). Saved history must
// start at a task, and is only ever cut at a task, so a tool call is never separated from its result.
const isTaskStart = (m: Param): boolean => m.role === 'user' && typeof m.content === 'string'

function validHistory(v: unknown): v is Param[] {
  return (
    Array.isArray(v) &&
    v.length <= 4000 &&
    v.every((m) => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content))) &&
    (v.length === 0 || isTaskStart(v[0]))
  )
}

function trimHistory(msgs: Param[]): Param[] {
  let from = 0
  while (JSON.stringify(msgs.slice(from)).length > MAX_SAVED_BYTES) {
    const next = msgs.findIndex((m, i) => i > from && isTaskStart(m))
    if (next < 0) return []
    from = next
  }
  return msgs.slice(from)
}

const isInside = (root: string, p: string): boolean => {
  const rel = relative(root, p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// Undo records come back from disk, so check they are well formed and point inside the project.
const isChange = (c: unknown, root: string): c is Change => {
  const x = c as Change
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.rel === 'string' &&
    typeof x.abs === 'string' &&
    typeof x.after === 'string' &&
    (x.before === null || typeof x.before === 'string') &&
    isInside(root, x.abs)
  )
}

// Brings a saved conversation into memory, once. A missing or damaged file just means starting fresh.
async function loadSession(sessionId: string): Promise<void> {
  if (!sessionId || sessions.has(sessionId)) return
  try {
    const data = JSON.parse(await readSecure(agentFile(sessionId)))
    if (!data || !validHistory(data.messages)) return
    sessions.set(sessionId, data.messages)
    if (Array.isArray(data.changes)) changes.set(sessionId, data.changes.filter((c: unknown) => isChange(c, sessionId)))
    if (Array.isArray(data.notes)) notes.set(sessionId, data.notes.filter((n: unknown) => typeof n === 'string'))
  } catch {
    // Nothing saved yet.
  }
}

async function saveSession(sessionId: string): Promise<void> {
  if (!sessionId) return
  const messages = trimHistory(sessions.get(sessionId) ?? [])
  const kept = (changes.get(sessionId) ?? [])
    .filter((c) => (c.before?.length ?? 0) + c.after.length <= MAX_CHANGE_BYTES)
    .slice(-MAX_SAVED_CHANGES)
  const pending = notes.get(sessionId) ?? []
  try {
    if (!messages.length && !kept.length && !pending.length) {
      await fs.rm(agentFile(sessionId), { force: true })
      return
    }
    await fs.mkdir(agentDir(), { recursive: true })
    await writeSecure(agentFile(sessionId), JSON.stringify({ v: 1, messages, changes: kept, notes: pending }))
  } catch {
    // Saving is best effort; the conversation still works in memory.
  }
}

const TOOLS: Tool[] = [
  {
    name: 'list_dir',
    description: 'List the files and folders in a directory of the project. Folders end with "/".',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory relative to the project root. Use "." for the root.' } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'read_file',
    description:
      'Read a text file. Output has line numbers. Long files are returned in pieces: use start_line and end_line to read other parts.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        start_line: { type: 'integer', description: '1-based first line to return. Use 1 to start at the top.' },
        end_line: { type: 'integer', description: '1-based last line to return. Use 0 for the default window of 2000 lines.' }
      },
      required: ['path', 'start_line', 'end_line'],
      additionalProperties: false
    }
  },
  {
    name: 'search_text',
    description:
      'Search file contents with a JavaScript regular expression. Returns "path:line: text" for up to 100 matches.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regex source, e.g. "function\\\\s+main".' },
        path: { type: 'string', description: 'Directory or file to search, relative to the project root. Use "." for everything.' },
        case_sensitive: { type: 'boolean', description: 'Whether the search is case sensitive.' }
      },
      required: ['pattern', 'path', 'case_sensitive'],
      additionalProperties: false
    }
  },
  {
    name: 'search_codebase',
    description:
      'Search the whole project by meaning. Describe what you are looking for in plain words (for example "where users are authenticated" or "retry logic for failed uploads"); ' +
      'returns the most relevant excerpts as "path:lines" with code. Use it to find where something lives before reading files; use search_text for exact strings.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for, in natural language.' } },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'find_files',
    description:
      'Find files by name. Use a glob such as "**/*.tsx" or "*.json", or plain text to match anywhere in the path. Returns up to 200 paths.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob or substring to match against file paths.' } },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    name: 'edit_file',
    description:
      'Change an existing file by replacing one exact piece of text. old_string must match the file exactly (including indentation) and appear only once; include surrounding lines to make it unique. The user reviews and approves every change.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'The text to put in its place.' }
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false
    }
  },
  {
    name: 'write_file',
    description:
      'Create a new file, or replace a whole file, with the given content. Prefer edit_file for small changes to existing files. The user reviews and approves every change.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        content: { type: 'string', description: 'The complete new content of the file.' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the project folder and return its exit code and output. On Windows it runs in Windows PowerShell 5.1 (chain with ";", not "&&"). It is non-interactive: no input is available. The user sees and must approve every command before it runs.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        timeout_seconds: {
          type: 'integer',
          description: 'Stop the command after this many seconds (1-600). Use 0 for the default of 60.'
        }
      },
      required: ['command', 'timeout_seconds'],
      additionalProperties: false
    }
  }
]

const SYSTEM = (root: string): string =>
  `You are a coding agent inside a desktop code editor. The user's project folder is ${root}. ` +
  'You can explore it with list_dir, read_file, search_text and find_files, and change it with edit_file and write_file. ' +
  'Every change is shown to the user as a diff and applied only if they approve it, so make small, focused changes and read a file before editing it. ' +
  'If the user rejects a change, do not retry it; ask what they want instead. ' +
  (isRemotePath(root)
    ? 'You can run commands with run_command (they run in a POSIX shell on the remote computer, over SSH, in the project folder; commands are non-interactive). '
    : 'You can run commands with run_command (Windows PowerShell 5.1: chain with ";" not "&&"; commands are non-interactive). ') +
  'The user must approve each command, so run only what the task needs, prefer the read-only tools for exploring, and never run destructive commands unless the user asked for them. ' +
  'Explore only as much as you need, then answer clearly and concisely. Refer to files by their project-relative paths.'

// --- tool implementations -------------------------------------------------

// File access for the tools below: the same calls for a folder on this PC and for one opened over SSH.
interface DirItem {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}
const rfs = {
  // Symlinks on another computer are not resolved; the path check there is by name only.
  realpath: (p: string): Promise<string> => (isRemotePath(p) ? Promise.resolve(p) : fs.realpath(p)),
  readdir: async (dir: string): Promise<DirItem[]> =>
    isRemotePath(dir)
      ? (await ssh.readDir(dir)).map((e) => ({ name: e.name, isDirectory: () => e.isDir, isFile: () => !e.isDir }))
      : fs.readdir(dir, { withFileTypes: true }),
  readFile: (p: string): Promise<string> => (isRemotePath(p) ? ssh.readFile(p) : fs.readFile(p, 'utf-8')),
  stat: async (p: string): Promise<{ size: number; isDirectory(): boolean }> =>
    isRemotePath(p)
      ? { size: await ssh.statSize(p), isDirectory: () => false }
      : fs.stat(p),
  isDir: (p: string): Promise<boolean> => (isRemotePath(p) ? ssh.isDir(p) : fs.stat(p).then((s) => s.isDirectory(), () => false)),
  exists: (p: string): Promise<boolean> =>
    isRemotePath(p) ? ssh.statSize(p).then(() => true, () => false) : fs.stat(p).then(() => true, () => false),
  writeFile: async (p: string, text: string): Promise<void> => {
    if (!isRemotePath(p)) {
      await fs.mkdir(dirname(p), { recursive: true })
      return fs.writeFile(p, text, 'utf-8')
    }
    await ssh.mkdirp(dirname(p))
    return ssh.writeFile(p, text)
  },
  rm: (p: string): Promise<void> => (isRemotePath(p) ? ssh.remove(p) : fs.rm(p))
}

async function safePath(root: string, p: string): Promise<string> {
  const abs = resolve(root, p)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('That path is outside the project folder.')
  // Resolve symlinks so a link inside the project cannot point outside it.
  const [realRoot, real] = await Promise.all([rfs.realpath(root), rfs.realpath(abs)])
  const realRel = relative(realRoot, real)
  if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error('That path is outside the project folder.')
  return abs
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const d of await rfs.readdir(dir)) {
    if (IGNORED.has(d.name)) continue
    const full = join(dir, d.name)
    if (d.isDirectory()) yield* walk(full)
    else if (d.isFile()) yield full
  }
}

const posix = (root: string, abs: string): string => relative(root, abs).split(sep).join('/')

function globToRegex(g: string): RegExp {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      re += '.*'
      i++
      if (g[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

async function listDir(root: string, input: { path: string }): Promise<string> {
  const dir = await safePath(root, input.path)
  const entries = (await rfs.readdir(dir))
    .filter((d) => !IGNORED.has(d.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((d) => d.name + (d.isDirectory() ? '/' : ''))
  return entries.length ? entries.join('\n') : '(empty directory)'
}

async function readFile(
  root: string,
  input: { path: string; start_line: number; end_line: number }
): Promise<string> {
  const file = await safePath(root, input.path)
  const content = await rfs.readFile(file)
  if (content.includes('\u0000')) throw new Error('This looks like a binary file.')
  const lines = content.split(/\r?\n/)
  const start = Math.max(1, input.start_line || 1)
  const end = Math.min(lines.length, input.end_line > 0 ? input.end_line : start + 1999)
  if (start > lines.length) return `The file has only ${lines.length} lines.`
  let out = ''
  let last = start - 1
  for (let n = start; n <= end; n++) {
    const next = `${n}\t${lines[n - 1]}\n`
    if (out.length + next.length > MAX_READ_CHARS) break
    out += next
    last = n
  }
  if (last < lines.length) {
    out += `[Showing lines ${start}-${last} of ${lines.length}. Call read_file again with start_line=${last + 1} for more.]`
  }
  return out
}

async function searchText(
  root: string,
  input: { pattern: string; path: string; case_sensitive: boolean }
): Promise<string> {
  const base = await safePath(root, input.path)
  let re: RegExp
  try {
    re = new RegExp(input.pattern, input.case_sensitive ? '' : 'i')
  } catch (e) {
    throw new Error((e as Error).message)
  }
  const isDir = await rfs.isDir(base)
  const files = isDir ? walk(base) : (async function* () { yield base })()
  const matches: string[] = []
  let scanned = 0
  for await (const f of files) {
    if (++scanned > 5000 || matches.length >= MAX_SEARCH_MATCHES) break
    const s = await rfs.stat(f).catch(() => null)
    if (!s || s.size > 1_000_000) continue
    const text = await rfs.readFile(f).catch(() => '')
    if (text.slice(0, 1000).includes('\u0000')) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
      if (re.test(lines[i])) matches.push(`${posix(root, f)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
    }
  }
  if (!matches.length) return 'No matches.'
  const capped = matches.length >= MAX_SEARCH_MATCHES ? `\n[Stopped at ${MAX_SEARCH_MATCHES} matches. Narrow the pattern or path.]` : ''
  return matches.join('\n') + capped
}

async function findFiles(root: string, input: { pattern: string }): Promise<string> {
  const p = input.pattern.trim()
  const isGlob = /[*?]/.test(p)
  const re = isGlob ? globToRegex(p.includes('/') ? p : `**/${p}`) : null
  const results: string[] = []
  for await (const f of walk(root)) {
    const rel = posix(root, f)
    if (re ? re.test(rel) : rel.toLowerCase().includes(p.toLowerCase())) results.push(rel)
    if (results.length >= MAX_FIND_RESULTS) break
  }
  if (!results.length) return 'No files found.'
  const capped = results.length >= MAX_FIND_RESULTS ? `\n[Stopped at ${MAX_FIND_RESULTS} results. Use a more specific pattern.]` : ''
  return results.join('\n') + capped
}

export async function runTool(root: string, name: string, input: unknown): Promise<string> {
  const i = input as Record<string, unknown>
  const str = (k: string): string => {
    if (typeof i?.[k] !== 'string') throw new Error(`Missing or invalid "${k}".`)
    return i[k] as string
  }
  const num = (k: string): number => (typeof i?.[k] === 'number' ? (i[k] as number) : 0)
  switch (name) {
    case 'list_dir':
      return listDir(root, { path: str('path') })
    case 'read_file':
      return readFile(root, { path: str('path'), start_line: num('start_line'), end_line: num('end_line') })
    case 'search_text':
      return searchText(root, { pattern: str('pattern'), path: str('path'), case_sensitive: i.case_sensitive === true })
    case 'find_files':
      return findFiles(root, { pattern: str('pattern') })
    case 'search_codebase': {
      const r = await searchCodebase([root], str('query'), { limit: 8 })
      if (!r.ok) throw new Error(r.error ?? 'The search failed.')
      return formatHits(r.hits, 20_000)
    }
    default:
      throw new Error(`Unknown tool "${name}".`)
  }
}

// --- write tools (always need user approval) --------------------------------

// Like safePath, but the target may not exist yet: the nearest existing ancestor must stay inside the project.
async function safeWritePath(root: string, p: string): Promise<string> {
  const abs = resolve(root, p)
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('That path is outside the project folder.')
  if (rel.split(sep).some((part) => part.toLowerCase() === '.git')) {
    throw new Error('Changing files inside .git is not allowed.')
  }
  const realRoot = await rfs.realpath(root)
  let cur = abs
  for (;;) {
    try {
      const real = await rfs.realpath(cur)
      const realRel = relative(realRoot, real)
      if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error('That path is outside the project folder.')
      return abs
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      const parent = dirname(cur)
      if (parent === cur) throw new Error('That path is outside the project folder.')
      cur = parent
    }
  }
}

interface WriteContext {
  root: string
  sessionId: string
  toolUseId: string
  send: (e: AgentEvent) => void
  requestApproval: (e: Extract<AgentEvent, { type: 'approval_request' }>) => Promise<boolean>
}

export async function runWriteTool(ctx: WriteContext, name: string, input: unknown): Promise<string> {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string => {
    if (typeof i[k] !== 'string') throw new Error(`Missing or invalid "${k}".`)
    return i[k] as string
  }
  const abs = await safeWritePath(ctx.root, str('path'))
  const rel = posix(ctx.root, abs)

  let before: string | null = null
  try {
    before = await rfs.readFile(abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }

  let after: string
  if (name === 'write_file') {
    after = str('content')
  } else {
    if (before === null) throw new Error('That file does not exist. Use write_file to create it.')
    // Match on LF so Windows (CRLF) files work, then convert back.
    const crlf = before.includes('\r\n')
    const text = crlf ? before.replace(/\r\n/g, '\n') : before
    const oldStr = str('old_string').replace(/\r\n/g, '\n')
    const newStr = str('new_string').replace(/\r\n/g, '\n')
    if (!oldStr) throw new Error('old_string must not be empty.')
    if (oldStr === newStr) throw new Error('old_string and new_string are identical.')
    const count = text.split(oldStr).length - 1
    if (count === 0) {
      throw new Error('old_string was not found. Read the file again and copy the text exactly, including indentation.')
    }
    if (count > 1) {
      throw new Error(`old_string matches ${count} places. Include more surrounding lines so it matches exactly once.`)
    }
    const replaced = text.replace(oldStr, () => newStr)
    after = crlf ? replaced.replace(/\n/g, '\r\n') : replaced
  }
  if (after.length > MAX_WRITE_CHARS) throw new Error('The resulting file is too large.')
  if (after === before) throw new Error('No change: the file would be identical.')

  const approved = await ctx.requestApproval({
    type: 'approval_request',
    id: ctx.toolUseId,
    tool: name,
    path: rel,
    before: before ?? '',
    after,
    isNew: before === null
  })
  if (!approved) return 'The user rejected this change. Do not retry it; ask what they would like instead.'

  // The user may have edited the file while the dialog was open.
  const now = await rfs.readFile(abs).catch(() => null)
  if (now !== before) throw new Error('The file changed while waiting for approval. Read it again and retry.')

  await rfs.writeFile(abs, after)
  const change: Change = { id: randomUUID(), rel, abs, before, after }
  changes.set(ctx.sessionId, [...(changes.get(ctx.sessionId) ?? []), change])
  void saveSession(ctx.sessionId)
  ctx.send({ type: 'applied', changeId: change.id, path: rel, isNew: before === null })
  ctx.send({ type: 'file_changed', path: abs, content: after })
  return before === null ? `Created ${rel}.` : `Updated ${rel}.`
}

// --- run_command (always needs user approval) ---------------------------------

const DEFAULT_TIMEOUT_S = 60
const MAX_TIMEOUT_S = 600
const MAX_COMMAND_OUTPUT = 20_000
const MAX_STORED_OUTPUT = 1_000_000

interface CommandContext {
  root: string
  toolUseId: string
  signal: AbortSignal
  send: (e: AgentEvent) => void
  requestApproval: (e: Extract<AgentEvent, { type: 'command_request' }>) => Promise<boolean>
}

// Keeps the start and end of long output, and says how much was left out.
function trimOutput(out: string): string {
  if (out.length <= MAX_COMMAND_OUTPUT) return out
  const half = MAX_COMMAND_OUTPUT / 2
  return `${out.slice(0, half)}\n[... ${out.length - MAX_COMMAND_OUTPUT} characters omitted ...]\n${out.slice(-half)}`
}

// Resolves with the output on success (exit code 0). Rejects with a message that includes the output otherwise.
export async function runCommand(ctx: CommandContext, input: unknown): Promise<string> {
  const i = (input ?? {}) as Record<string, unknown>
  if (typeof i.command !== 'string' || !i.command.trim()) throw new Error('Missing or invalid "command".')
  const command = i.command
  const requested = typeof i.timeout_seconds === 'number' ? i.timeout_seconds : 0
  const timeoutS = requested > 0 ? Math.min(Math.floor(requested), MAX_TIMEOUT_S) : DEFAULT_TIMEOUT_S

  const approved = await ctx.requestApproval({ type: 'command_request', id: ctx.toolUseId, command, cwd: ctx.root })
  if (!approved) return 'The user declined to run this command. Do not retry it; ask what they would like instead.'

  // Commands must not be able to read the API key or run as plain Node.
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ELECTRON_RUN_AS_NODE

  if (isRemotePath(ctx.root)) {
    // On the other computer, through the SSH connection, with its own shell.
    try {
      let streamed = ''
      const r = await ssh.exec(ctx.root, ['sh', '-c', command], {
        timeout: timeoutS * 1000,
        signal: ctx.signal,
        onData: (text) => {
          if (streamed.length < MAX_STORED_OUTPUT) streamed += text
          ctx.send({ type: 'tool_output', id: ctx.toolUseId, text })
        }
      })
      const body = trimOutput(streamed.trim())
      if (ctx.signal.aborted) throw new Error(`Interrupted by the user.
${body}`)
      if (r.code !== 0) throw new Error(`Exit code: ${r.code}
${body}`)
      return `Exit code: 0
${body}`
    } finally {
      ctx.send({ type: 'workspace_touched' })
    }
  }

  const win = process.platform === 'win32'
  // A project inside WSL: the command runs inside that distribution (bash), in that folder.
  const wsl = win ? wslLocation(ctx.root) : null
  const [file, args] = wsl
    ? ['wsl.exe', wslCommandArgs(wsl, command)]
    : win
      ? [
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${command}`]
        ]
      : ['/bin/sh', ['-c', command]]

  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(file, args, { cwd: wsl ? (process.env.USERPROFILE ?? process.cwd()) : ctx.root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      let timedOut = false
      let interrupted = false

      const kill = (): void => {
        if (child.pid === undefined) return
        if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill('SIGKILL')
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutS * 1000)
      const onAbort = (): void => {
        interrupted = true
        kill()
      }
      ctx.signal.addEventListener('abort', onAbort)

      const onData = (buf: Buffer): void => {
        const text = buf.toString('utf-8')
        if (out.length < MAX_STORED_OUTPUT) out += text
        ctx.send({ type: 'tool_output', id: ctx.toolUseId, text })
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)

      const finish = (): void => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
      }
      child.on('error', (e) => {
        finish()
        reject(new Error(`Failed to start the command: ${e.message}`))
      })
      child.on('close', (code) => {
        finish()
        const body = trimOutput(out.trim())
        if (interrupted) return reject(new Error(`Interrupted by the user.\n${body}`))
        if (timedOut) return reject(new Error(`Timed out after ${timeoutS}s and was stopped.\n${body}`))
        if (code !== 0) return reject(new Error(`Exit code: ${code}\n${body}`))
        resolve(`Exit code: 0\n${body}`)
      })
    })
  } finally {
    // The command may have created, changed or deleted files.
    ctx.send({ type: 'workspace_touched' })
  }
}

// --- agent loop -----------------------------------------------------------

async function runAgent(req: RunRequest, send: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  if (!backend.directMode()) return runAgentViaService(req, send, signal)
  const apiKey = await loadKey()
  if (!apiKey) return send({ type: 'error', message: 'No API key set. Add one in the Chat tab.' })

  const client = new Anthropic({ apiKey })
  const rules = await rulesPrompt(req.root) // the project's own instructions (AGENTS.md and friends)
  await loadSession(req.sessionId) // continues the saved conversation for this folder, if there is one
  const history = sessions.get(req.sessionId) ?? []
  const pendingNotes = notes.get(req.sessionId) ?? []
  notes.delete(req.sessionId)
  const task = pendingNotes.length ? `${pendingNotes.join('\n')}\n\n${req.task}` : req.task
  // The history is saved when the run ends, however it ends. It stays valid because an assistant
  // message is only added together with a tool_result for each of its tool calls (see below), and
  // approved edits are already on disk, so the model must remember them.
  const msgs: Param[] = [...history, { role: 'user', content: task }]

  try {
    const maxSteps = req.maxSteps ?? MAX_STEPS
    for (let step = 0; step < maxSteps; step++) {
      const stream = client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: 32000,
          system: SYSTEM(req.root) + rules + (req.extraSystem ?? ''),
          tools: TOOLS,
          messages: msgs,
          cache_control: { type: 'ephemeral' },
          ...(req.model.includes('haiku')
            ? {}
            : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const })
        },
        { signal }
      )
      stream.on('text', (text) => send({ type: 'text', text }))
      const final = await stream.finalMessage()

      if (final.stop_reason === 'refusal') {
        send({ type: 'error', message: 'The model declined this request.' })
        return
      }
      if (final.stop_reason === 'max_tokens') {
        send({ type: 'error', message: 'The response hit the output limit and was cut off.' })
        return
      }

      msgs.push({ role: 'assistant', content: final.content as Anthropic.Beta.Messages.BetaContentBlockParam[] })

      if (final.stop_reason !== 'tool_use') {
        sessions.set(req.sessionId, msgs)
        send({ type: 'done', stopReason: final.stop_reason })
        return
      }

      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = []
      for (const block of final.content) {
        if (block.type !== 'tool_use') continue
        if (signal.aborted) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Interrupted by the user.', is_error: true })
          continue
        }
        send({ type: 'tool_start', id: block.id, name: block.name, input: block.input })
        let output: string
        let isError = false
        try {
          if (WRITE_TOOLS.has(block.name)) {
            output = await runWriteTool(
              {
                root: req.root,
                sessionId: req.sessionId,
                toolUseId: block.id,
                send,
                requestApproval: req.autoApproveEdits ? async () => true : (e) => requestApproval(req.runId, signal, send, e)
              },
              block.name,
              block.input
            )
          } else if (block.name === 'run_command') {
            output = await runCommand(
              {
                root: req.root,
                toolUseId: block.id,
                signal,
                send,
                requestApproval: (e) => requestApproval(req.runId, signal, send, e)
              },
              block.input
            )
          } else {
            output = await runTool(req.root, block.name, block.input)
          }
        } catch (e) {
          output = e instanceof Error ? e.message : String(e)
          isError = true
        }
        send({ type: 'tool_end', id: block.id, output, isError })
        results.push({ type: 'tool_result', tool_use_id: block.id, content: output, is_error: isError })
      }
      msgs.push({ role: 'user', content: results })
      if (signal.aborted) {
        send({ type: 'done', stopReason: 'aborted' })
        return
      }
    }
    send({ type: 'error', message: `Stopped after ${maxSteps} steps. Ask a narrower question or say "continue".` })
  } catch (err) {
    if (signal.aborted) return send({ type: 'done', stopReason: 'aborted' })
    if (err instanceof Anthropic.AuthenticationError) {
      send({ type: 'error', message: 'The API key was rejected. Check it in the Chat tab.' })
    } else if (err instanceof Anthropic.RateLimitError) {
      send({ type: 'error', message: 'Rate limited. Wait a moment and retry.' })
    } else if (err instanceof Anthropic.APIError) {
      send({ type: 'error', message: `API error ${err.status ?? ''}: ${err.message}` })
    } else {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    sessions.set(req.sessionId, msgs)
    await saveSession(req.sessionId)
  }
}

// --- the same loop, with the model turns made by our service ---------------
// The service owns the model call, the system prompt and the tool list; the tools themselves still run here, on this PC, with the same
// approvals. It names its tools differently from the ones used with a developer's own key, so each call is mapped to the local tool.

type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string }

const SERVICE_TOOL_NAMES = new Set(['list_files', 'search_code', 'read_file', 'edit_file', 'create_file', 'delegate', 'update_plan', 'run_command'])
const SERVICE_NOTE_LIMIT = 6000

function toLocalCall(name: string, input: unknown): { name: string; input: Record<string, unknown> } | { error: string } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  switch (name) {
    case 'list_files': {
      const dir = typeof i.directory === 'string' && i.directory.trim() && i.directory.trim() !== '.' ? i.directory.trim().replace(/[\\/]+$/, '') : ''
      return { name: 'find_files', input: { pattern: dir ? dir + '/**/*' : '**/*' } }
    }
    case 'search_code':
      return { name: 'search_codebase', input: { query: String(i.query ?? '') } }
    case 'read_file':
      return { name: 'read_file', input: { path: String(i.path ?? ''), start_line: Number(i.start_line ?? 1) || 1, end_line: Number(i.end_line ?? 0) || 0 } }
    case 'edit_file':
      return { name: 'edit_file', input: { path: String(i.path ?? ''), old_string: String(i.old_text ?? ''), new_string: String(i.new_text ?? '') } }
    case 'create_file':
      return { name: 'write_file', input: { path: String(i.path ?? ''), content: String(i.content ?? '') } }
    case 'run_command':
      return { name: 'run_command', input: { command: String(i.command ?? ''), timeout_seconds: 0 } }
    default:
      return { error: `The tool "${name}" is not available here.` }
  }
}

async function runAgentViaService(req: RunRequest, send: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  if (!(await llm.ready())) return send({ type: 'error', message: llm.notReady })
  const rules = await rulesPrompt(req.root)
  await loadSession(req.sessionId)
  let history = sessions.get(req.sessionId) ?? []
  // A conversation saved with a developer's own key uses other tool names, which the service would refuse: start fresh then.
  const foreign = history.some((m) => Array.isArray(m.content) && (m.content as Block[]).some((b) => b.type === 'tool_use' && !SERVICE_TOOL_NAMES.has(b.name ?? '')))
  if (foreign) history = []
  const pendingNotes = notes.get(req.sessionId) ?? []
  notes.delete(req.sessionId)
  // The service's own instructions are fixed, so the project's rules travel with the task.
  const extra = (rules + (req.extraSystem ?? '')).trim()
  const task =
    (extra ? `Project instructions:\n${extra.slice(0, SERVICE_NOTE_LIMIT)}\n\n` : '') + (pendingNotes.length ? `${pendingNotes.join('\n')}\n\n` : '') + req.task
  const msgs: Param[] = [...history, { role: 'user', content: task }]
  let taskToken: string | undefined

  try {
    const maxSteps = req.maxSteps ?? MAX_STEPS
    for (let step = 0; step < maxSteps; step++) {
      const res = await backend.agentStep(msgs, taskToken, !req.model.includes('haiku'), signal)
      taskToken = res.taskToken ?? taskToken
      const content = (res.content ?? []) as Block[]
      for (const b of content) if (b.type === 'text' && b.text) send({ type: 'text', text: b.text })
      msgs.push({ role: 'assistant', content: content as unknown as Anthropic.Beta.Messages.BetaContentBlockParam[] })

      const calls = content.filter((b) => b.type === 'tool_use')
      if (res.stopReason !== 'tool_use' || calls.length === 0) {
        sessions.set(req.sessionId, msgs)
        send({ type: 'done', stopReason: res.stopReason })
        return
      }

      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = []
      for (const block of calls) {
        const id = block.id as string
        const serviceName = block.name as string
        if (signal.aborted) {
          results.push({ type: 'tool_result', tool_use_id: id, content: 'Interrupted by the user.', is_error: true })
          continue
        }
        let output: string
        let isError = false
        const mapped = toLocalCall(serviceName, block.input)
        send({ type: 'tool_start', id, name: 'error' in mapped ? serviceName : mapped.name, input: 'error' in mapped ? block.input : mapped.input })
        try {
          if (serviceName === 'update_plan') {
            output = 'Plan updated.'
          } else if (serviceName === 'delegate') {
            output = 'Delegating is not available here. Do the research yourself with the other tools.'
            isError = true
          } else if ('error' in mapped) {
            throw new Error(mapped.error)
          } else if (WRITE_TOOLS.has(mapped.name)) {
            if (mapped.name === 'write_file' && serviceName === 'create_file') {
              const target = resolve(req.root, String(mapped.input.path))
              if (await rfs.exists(target)) throw new Error('That file already exists. Use edit_file to change it.')
            }
            output = await runWriteTool(
              {
                root: req.root,
                sessionId: req.sessionId,
                toolUseId: id,
                send,
                requestApproval: req.autoApproveEdits ? async () => true : (e) => requestApproval(req.runId, signal, send, e)
              },
              mapped.name,
              mapped.input
            )
          } else if (mapped.name === 'run_command') {
            output = await runCommand(
              { root: req.root, toolUseId: id, signal, send, requestApproval: (e) => requestApproval(req.runId, signal, send, e) },
              mapped.input
            )
          } else {
            output = await runTool(req.root, mapped.name, mapped.input)
          }
        } catch (e) {
          output = e instanceof Error ? e.message : String(e)
          isError = true
        }
        send({ type: 'tool_end', id, output, isError })
        results.push({ type: 'tool_result', tool_use_id: id, content: output, is_error: isError })
      }
      msgs.push({ role: 'user', content: results })
      if (signal.aborted) {
        send({ type: 'done', stopReason: 'aborted' })
        return
      }
    }
    send({ type: 'error', message: `Stopped after ${maxSteps} steps. Ask a narrower question or say "continue".` })
  } catch (err) {
    if (signal.aborted) return send({ type: 'done', stopReason: 'aborted' })
    send({ type: 'error', message: backend.explain(err) })
  } finally {
    sessions.set(req.sessionId, msgs)
    await saveSession(req.sessionId)
  }
}

// Waits for the user to accept or reject a proposed change. Aborting the run counts as a rejection.
function requestApproval(
  runId: number,
  signal: AbortSignal,
  send: (e: AgentEvent) => void,
  e: Extract<AgentEvent, { type: 'approval_request' | 'command_request' }>
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const key = `${runId}:${e.id}`
    const onAbort = (): void => finish(false)
    const finish = (ok: boolean): void => {
      pendingApprovals.delete(key)
      signal.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    pendingApprovals.set(key, finish)
    signal.addEventListener('abort', onAbort)
    send(e)
  })
}

/** Runs the agent for a background task (see background.ts), which supplies its own event sink. */
export function runAgentTask(req: RunRequest, send: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  return runAgent(req, send, signal)
}

/** Forgets one conversation, in memory and on disk. */
export function resetSession(sessionId: string): void {
  sessions.delete(sessionId)
  changes.delete(sessionId)
  notes.delete(sessionId)
  void fs.rm(agentFile(sessionId), { force: true })
  void fs.rm(agentFile(sessionId, true), { force: true })
}

export function registerAgentHandlers(getWin: () => BrowserWindow | null): void {
  ipcMain.on('agent:approve', (_e, runId: number, id: string, ok: boolean) => {
    pendingApprovals.get(`${runId}:${id}`)?.(ok === true)
  })

  ipcMain.handle('agent:undo', async (_e, sessionId: string, changeId: string) => {
    await loadSession(sessionId) // undo can be the first thing done after a restart
    const list = changes.get(sessionId) ?? []
    const c = list.find((x) => x.id === changeId)
    if (!c) return { ok: false, message: 'That change is no longer tracked.' }
    const current = await rfs.readFile(c.abs).catch(() => null)
    if (current !== c.after) {
      return { ok: false, message: 'The file has changed since, so it was not reverted.' }
    }
    if (c.before === null) await rfs.rm(c.abs)
    else await rfs.writeFile(c.abs, c.before)
    changes.set(sessionId, list.filter((x) => x !== c))
    notes.set(sessionId, [...(notes.get(sessionId) ?? []), `[Note: the user undid your change to ${c.rel}.]`])
    void saveSession(sessionId)
    return { ok: true, message: 'Reverted.', path: c.abs, content: c.before }
  })

  // What the panel shows (messages, tool lines, change markers), saved by the UI after each run.
  ipcMain.handle('agent:loadUi', async (_e, sessionId: string) => {
    try {
      const data = JSON.parse(await readSecure(agentFile(sessionId, true)))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  })

  ipcMain.handle('agent:saveUi', async (_e, sessionId: string, items: unknown) => {
    if (!sessionId || !Array.isArray(items)) return
    // Keep recent items only, starting at one of the user's messages.
    let list = items.slice(-400) as { kind?: string }[]
    const first = list.findIndex((i) => i && i.kind === 'user')
    list = first < 0 ? [] : list.slice(first)
    while (list.length && JSON.stringify(list).length > 2_000_000) {
      const next = list.findIndex((i, k) => k > 0 && i && i.kind === 'user')
      list = next < 0 ? [] : list.slice(next)
    }
    try {
      if (!list.length) return void (await fs.rm(agentFile(sessionId, true), { force: true }))
      await fs.mkdir(agentDir(), { recursive: true })
      await writeSecure(agentFile(sessionId, true), JSON.stringify(list))
    } catch {
      // Best effort.
    }
  })

  // Does the model still remember this folder's conversation? (The panel can show it without the model having it.)
  ipcMain.handle('agent:hasSession', async (_e, sessionId: string) => {
    await loadSession(sessionId)
    return (sessions.get(sessionId)?.length ?? 0) > 0
  })

  ipcMain.on('agent:run', async (_e, req: RunRequest) => {
    const send = (e: AgentEvent): void => getWin()?.webContents.send('agent:event', req.runId, e)
    const controller = new AbortController()
    running.set(req.runId, controller)
    try {
      await runAgent(req, send, controller.signal)
    } finally {
      running.delete(req.runId)
    }
  })
  ipcMain.on('agent:abort', (_e, runId: number) => running.get(runId)?.abort())
  ipcMain.on('agent:reset', (_e, sessionId: string) => resetSession(sessionId))
}
