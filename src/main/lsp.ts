import { BrowserWindow, ipcMain } from 'electron'
import { ChildProcess, spawn } from 'child_process'
import { existsSync, promises as fsp } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { pathToFileURL } from 'url'
import { isRemotePath } from './sshfs'

// Language servers (the Language Server Protocol): one process per language and project folder, spoken to over stdin and
// stdout. This file starts them and carries the JSON messages; the editor side (src/renderer/src/lspClient.ts) turns
// them into completions, hovers, definitions, errors and so on.
//   renderer -> main   lsp:available, lsp:start, lsp:request, lsp:notify, lsp:stop
//   main -> renderer   'lsp:message': { server, method, params } for the server's notifications (diagnostics, log lines)
//                      'lsp:exited': { server, code }

interface Spec {
  language: string
  label: string
  languages: string[] // editor language ids this server handles
  // Programs to try, in order: a name looked for on the PATH (and in the usual install folders), with its arguments.
  candidates: { exe: string; args: string[] }[]
  help: string // how to install it
}

const SPECS: Spec[] = [
  {
    language: 'go',
    label: 'Go (gopls)',
    languages: ['go'],
    candidates: [{ exe: 'gopls', args: [] }],
    help: 'Install gopls: go install golang.org/x/tools/gopls@latest'
  },
  {
    language: 'python',
    label: 'Python',
    languages: ['python'],
    candidates: [
      { exe: 'pylsp', args: [] },
      { exe: 'pyright-langserver', args: ['--stdio'] },
      { exe: 'basedpyright-langserver', args: ['--stdio'] }
    ],
    help: 'Install a Python language server: pip install python-lsp-server  (or: npm install -g pyright)'
  },
  {
    language: 'rust',
    label: 'Rust (rust-analyzer)',
    languages: ['rust'],
    candidates: [{ exe: 'rust-analyzer', args: [] }],
    help: 'Install rust-analyzer: rustup component add rust-analyzer'
  },
  {
    language: 'cpp',
    label: 'C and C++ (clangd)',
    languages: ['c', 'cpp'],
    candidates: [{ exe: 'clangd', args: [] }],
    help: 'Install clangd (part of LLVM): winget install LLVM.LLVM'
  }
]

export const languageOf = (editorLanguage: string): string | null => SPECS.find((s) => s.languages.includes(editorLanguage))?.language ?? null

const EXTRA_DIRS = (): string[] => [join(process.env.GOPATH || join(homedir(), 'go'), 'bin'), join(homedir(), '.cargo', 'bin'), 'C:\\Program Files\\LLVM\\bin']

/** The full path of a program found on the PATH or in a usual install folder, or null. */
function findExe(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = [...(process.env.PATH ?? process.env.Path ?? '').split(delimiter), ...EXTRA_DIRS()]
  for (const d of dirs) {
    if (!d) continue
    for (const e of exts) {
      const f = join(d, name + e)
      if (existsSync(f)) return f
    }
  }
  return null
}

function resolve(language: string): { spec: Spec; file: string; args: string[] } | { spec: Spec; missing: true } | null {
  const spec = SPECS.find((s) => s.language === language)
  if (!spec) return null
  for (const c of spec.candidates) {
    const f = findExe(c.exe)
    if (f) return { spec, file: f, args: c.args }
  }
  return { spec, missing: true }
}

interface Server {
  id: string
  language: string
  root: string
  child: ChildProcess
  buf: Buffer
  seq: number
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>
  ready: Promise<{ capabilities: unknown }>
  dead: boolean
}

const servers = new Map<string, Server>()
let getWinRef: () => BrowserWindow | null = () => null
const toRenderer = (channel: string, payload: unknown): void => getWinRef()?.webContents.send(channel, payload)

function write(s: Server, obj: Record<string, unknown>): void {
  if (s.dead || !s.child.stdin?.writable) return
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...obj }), 'utf-8')
  s.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}

function request(s: Server, method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolveReq, reject) => {
    if (s.dead) return reject(new Error('The language server is not running.'))
    const id = ++s.seq
    const timer = setTimeout(() => {
      s.pending.delete(id)
      reject(new Error(`The language server did not answer ${method} in time.`))
    }, timeoutMs)
    s.pending.set(id, { resolve: resolveReq, reject, timer })
    write(s, { id, method, params })
  })
}

// Things a server may ask the editor for. Answering them (even with "nothing") keeps servers from waiting.
function answerServerRequest(s: Server, msg: { id: number | string; method: string; params?: { items?: unknown[] } }): void {
  switch (msg.method) {
    case 'workspace/configuration':
      return write(s, { id: msg.id, result: (msg.params?.items ?? []).map(() => null) })
    case 'workspace/workspaceFolders':
      return write(s, { id: msg.id, result: [{ uri: pathToFileURL(s.root).href, name: s.root }] })
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
    case 'workspace/diagnostic/refresh':
    case 'workspace/semanticTokens/refresh':
    case 'workspace/inlayHint/refresh':
    case 'workspace/codeLens/refresh':
      return write(s, { id: msg.id, result: null })
    case 'window/showMessageRequest':
      return write(s, { id: msg.id, result: null })
    default:
      return write(s, { id: msg.id, error: { code: -32601, message: 'Not supported by this editor: ' + msg.method } })
  }
}

function feed(s: Server, chunk: Buffer): void {
  s.buf = Buffer.concat([s.buf, chunk])
  for (;;) {
    const end = s.buf.indexOf('\r\n\r\n')
    if (end < 0) return
    const len = Number(/Content-Length:\s*(\d+)/i.exec(s.buf.subarray(0, end).toString('ascii'))?.[1] ?? NaN)
    if (!Number.isFinite(len)) {
      s.buf = Buffer.alloc(0)
      return
    }
    if (s.buf.length < end + 4 + len) return
    const body = s.buf.subarray(end + 4, end + 4 + len).toString('utf-8')
    s.buf = s.buf.subarray(end + 4 + len)
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(body)
    } catch {
      continue
    }
    if (msg.method && msg.id !== undefined) answerServerRequest(s, msg as Parameters<typeof answerServerRequest>[1])
    else if (msg.method) toRenderer('lsp:message', { server: s.id, method: msg.method, params: msg.params })
    else if (typeof msg.id === 'number') {
      const p = s.pending.get(msg.id)
      if (!p) continue
      s.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'The language server reported an error.'))
      else p.resolve(msg.result ?? null)
    }
  }
}

const CLIENT_CAPABILITIES = {
  workspace: { workspaceFolders: true, configuration: true },
  window: { workDoneProgress: true },
  general: { positionEncodings: ['utf-16'] },
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    completion: {
      completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], insertReplaceSupport: false },
      contextSupport: true
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
    definition: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    rename: { prepareSupport: false },
    publishDiagnostics: { relatedInformation: false }
  }
}

async function start(language: string, appRoot: string): Promise<{ ok: true; server: string; capabilities: unknown; label: string; realRoot: string } | { ok: false; error: string }> {
  // Servers insist on the folder's real spelling (long names, true capitals), which the editor's path may not have.
  const root = await fsp.realpath(appRoot).catch(() => appRoot)
  const key = language + '|' + root.toLowerCase()
  const existing = servers.get(key)
  if (existing && !existing.dead) {
    const r = await existing.ready.catch(() => null)
    if (r) return { ok: true, server: existing.id, capabilities: r.capabilities, label: SPECS.find((s) => s.language === language)?.label ?? language, realRoot: root }
  }
  if (isRemotePath(appRoot)) return { ok: false, error: 'Language servers do not run for folders opened over SSH yet.' }
  const found = resolve(language)
  if (!found) return { ok: false, error: 'No language server is known for ' + language }
  if ('missing' in found) return { ok: false, error: found.spec.help }
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ELECTRON_RUN_AS_NODE
  let child: ChildProcess
  try {
    child = spawn(found.file, found.args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: /\.(cmd|bat)$/i.test(found.file) })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const s: Server = { id: key, language, root, child, buf: Buffer.alloc(0), seq: 0, pending: new Map(), dead: false, ready: Promise.resolve({ capabilities: null }) }
  servers.set(key, s)
  let stderrTail = ''
  child.stdout?.on('data', (b: Buffer) => feed(s, b))
  child.stderr?.on('data', (b: Buffer) => {
    stderrTail = (stderrTail + b.toString('utf-8')).slice(-3000)
    toRenderer('lsp:message', { server: s.id, method: 'window/logMessage', params: { type: 4, message: b.toString('utf-8').trimEnd() } })
  })
  const die = (code: number | null): void => {
    if (s.dead) return
    s.dead = true
    for (const p of s.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('The language server stopped.'))
    }
    s.pending.clear()
    if (servers.get(key) === s) servers.delete(key)
    toRenderer('lsp:exited', { server: s.id, code })
  }
  child.on('close', die)
  child.on('error', () => die(null))
  s.ready = request(s, 'initialize', {
    processId: process.pid,
    clientInfo: { name: 'My AI IDE' },
    rootUri: pathToFileURL(root).href,
    rootPath: root,
    workspaceFolders: [{ uri: pathToFileURL(root).href, name: root.split(/[\\/]/).pop() ?? root }],
    capabilities: CLIENT_CAPABILITIES
  }, 60_000).then((r) => {
    write(s, { method: 'initialized', params: {} })
    return { capabilities: (r as { capabilities?: unknown })?.capabilities ?? {} }
  })
  try {
    const r = await s.ready
    return { ok: true, server: s.id, capabilities: r.capabilities, label: found.spec.label, realRoot: root }
  } catch (e) {
    try {
      child.kill()
    } catch {
      // gone
    }
    die(null)
    return { ok: false, error: `${found.spec.label} did not start: ${e instanceof Error ? e.message : String(e)}${stderrTail ? '\n' + stderrTail.trim() : ''}` }
  }
}

function stopServer(s: Server): void {
  if (s.dead) return
  void request(s, 'shutdown', null, 2000)
    .then(() => write(s, { method: 'exit' }))
    .catch(() => undefined)
    .finally(() => {
      setTimeout(() => {
        try {
          s.child.kill()
        } catch {
          // gone
        }
        if (process.platform === 'win32' && s.child.pid) spawn('taskkill', ['/pid', String(s.child.pid), '/T', '/F'], { windowsHide: true })
      }, 300)
    })
}

export function stopAllLanguageServers(): void {
  for (const s of servers.values()) {
    s.dead = true
    try {
      s.child.kill()
    } catch {
      // gone
    }
    if (process.platform === 'win32' && s.child.pid) spawn('taskkill', ['/pid', String(s.child.pid), '/T', '/F'], { windowsHide: true })
  }
  servers.clear()
}

export function registerLspHandlers(getWin: () => BrowserWindow | null): void {
  getWinRef = getWin
  ipcMain.handle('lsp:languages', () => SPECS.map((s) => ({ language: s.language, languages: s.languages, label: s.label })))
  ipcMain.handle('lsp:available', (_e, language: string) => {
    const r = resolve(String(language))
    if (!r) return { ok: false as const, error: 'No language server is known for ' + language }
    return 'missing' in r ? { ok: false as const, error: r.spec.help } : { ok: true as const, label: r.spec.label }
  })
  ipcMain.handle('lsp:start', (_e, language: string, root: string) => start(String(language), String(root)))
  ipcMain.handle('lsp:request', async (_e, server: string, method: string, params: unknown) => {
    const s = servers.get(String(server))
    if (!s || s.dead) return { ok: false as const, error: 'The language server is not running.' }
    try {
      await s.ready
      return { ok: true as const, result: await request(s, String(method), params) }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('lsp:notify', async (_e, server: string, method: string, params: unknown) => {
    const s = servers.get(String(server))
    if (!s || s.dead) return
    await s.ready.catch(() => undefined)
    write(s, { method: String(method), params })
  })
  ipcMain.handle('lsp:stop', (_e, server: string) => {
    const s = servers.get(String(server))
    if (s) stopServer(s)
  })
}
