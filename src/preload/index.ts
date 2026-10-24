import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { AgentEvent } from '../main/agent'
import type { UpdateState } from '../main/updater'
import type { CommitEntry, CommitFile, GitStatus, StashEntry } from '../main/git'
import type { BgTask } from '../main/background'
import type { DbgBreakpoint, DbgEvent, DbgScope, DbgVar } from '../main/debugger'
import type { ExtRecord, RegistryResult, SnippetSet } from '../main/extensions'
import type { TasksInfo } from '../main/tasks'
import type { KernelInfo, NbEvent } from '../main/notebook'
import type { ConnectResult } from '../main/sshfs'
import type { AuthState, Me } from '../main/backend'

type GitResult = { ok: true } | { ok: false; error: string }

const api = {
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  openWorkspaceFile: (): Promise<{ file: string; folders: string[] } | { error: string } | null> => ipcRenderer.invoke('workspace:open'),
  saveWorkspaceFile: (folders: string[]): Promise<string | null> => ipcRenderer.invoke('workspace:save', folders),
  initialFolder: (): Promise<string | null> => ipcRenderer.invoke('app:initialFolder'),
  setTitleBar: (color: string, symbolColor: string): Promise<void> => ipcRenderer.invoke('app:setTitleBar', color, symbolColor),
  platform: process.platform,
  setNativeTheme: (type: 'light' | 'dark'): Promise<void> => ipcRenderer.invoke('app:setNativeTheme', type),
  themesList: (): Promise<{ file: string; text: string }[]> => ipcRenderer.invoke('themes:list'),
  themesOpenFolder: (): Promise<string | null> => ipcRenderer.invoke('themes:openFolder'),
  themesImport: (): Promise<{ ok: true; file: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('themes:import'),
  themesSave: (name: string, text: string): Promise<string> => ipcRenderer.invoke('themes:save', name, text),
  fsReplace: (
    root: string,
    query: string,
    replacement: string,
    opts: { caseSensitive: boolean; regex: boolean },
    targets: { path: string; lines?: number[] }[]
  ): Promise<{ ok: true; replaced: number; files: number; skipped: string[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:replace', root, query, replacement, opts, targets),
  rulesLoad: (root: string): Promise<{ files: { name: string; path: string }[]; chars: number }> =>
    ipcRenderer.invoke('rules:load', root),
  rulesPrompt: (root: string): Promise<string> => ipcRenderer.invoke('rules:prompt', root),
  rulesCreate: (root: string): Promise<{ path: string; created: boolean }> => ipcRenderer.invoke('rules:create', root),
  fsIsDir: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:isDir', p),
  toggleDevTools: (): Promise<void> => ipcRenderer.invoke('app:toggleDevTools'),
  fsCreateFile: (root: string, target: string): Promise<GitResult> => ipcRenderer.invoke('fs:createFile', root, target),
  fsCreateDir: (root: string, target: string): Promise<GitResult> => ipcRenderer.invoke('fs:createDir', root, target),
  fsRename: (root: string, from: string, to: string): Promise<GitResult> => ipcRenderer.invoke('fs:rename', root, from, to),
  fsTrash: (root: string, target: string): Promise<GitResult> => ipcRenderer.invoke('fs:trash', root, target),
  fsReveal: (target: string): Promise<void> => ipcRenderer.invoke('fs:reveal', target),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('app:copyText', text),
  readText: (): Promise<string> => ipcRenderer.invoke('app:readText'),
  fsWatch: (folders: string | string[] | null): Promise<void> => ipcRenderer.invoke('fs:watch', folders),
  onFsChanged: (cb: (e: { paths: string[]; git: boolean }) => void): (() => void) => {
    const h = (_e: unknown, e: { paths: string[]; git: boolean }): void => cb(e)
    ipcRenderer.on('fs:changed', h)
    return () => ipcRenderer.removeListener('fs:changed', h)
  },
  gitStatus: (root: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', root),
  gitLineChanges: (
    root: string,
    rel: string
  ): Promise<{ changes: { start: number; end: number; kind: 'added' | 'modified' | 'deleted' }[]; untracked?: boolean }> =>
    ipcRenderer.invoke('git:lineChanges', root, rel),
  gitDiff: (
    root: string,
    rel: string,
    staged: boolean
  ): Promise<{ original: string; modified: string } | { error: string }> => ipcRenderer.invoke('git:diff', root, rel, staged),
  gitInit: (root: string): Promise<GitResult> => ipcRenderer.invoke('git:init', root),
  gitTrust: (root: string): Promise<GitResult> => ipcRenderer.invoke('git:trust', root),
  gitStage: (root: string, rels: string[] | null): Promise<GitResult> => ipcRenderer.invoke('git:stage', root, rels),
  gitUnstage: (root: string, rels: string[] | null): Promise<GitResult> => ipcRenderer.invoke('git:unstage', root, rels),
  gitDiscard: (root: string, tracked: string[], untracked: string[]): Promise<GitResult> =>
    ipcRenderer.invoke('git:discard', root, tracked, untracked),
  gitCommit: (root: string, message: string): Promise<GitResult> => ipcRenderer.invoke('git:commit', root, message),
  gitBranches: (root: string): Promise<{ ok: boolean; error?: string; branches: { name: string; current: boolean }[] }> =>
    ipcRenderer.invoke('git:branches', root),
  gitCheckout: (root: string, name: string, create: boolean): Promise<GitResult> =>
    ipcRenderer.invoke('git:checkout', root, name, create),
  gitRemote: (root: string, op: 'push' | 'pull' | 'fetch'): Promise<GitResult & { output?: string }> =>
    ipcRenderer.invoke('git:remote', root, op),
  gitGenerateMessage: (root: string): Promise<{ ok: true; message: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('git:generateMessage', root),
  gitStashList: (root: string): Promise<{ ok: boolean; error?: string; stashes: StashEntry[] }> => ipcRenderer.invoke('git:stashList', root),
  gitStashPush: (root: string, message: string, includeUntracked: boolean): Promise<GitResult> =>
    ipcRenderer.invoke('git:stashPush', root, message, includeUntracked),
  gitStashApply: (root: string, n: number, pop: boolean): Promise<GitResult & { output?: string }> =>
    ipcRenderer.invoke('git:stashApply', root, n, pop),
  gitStashDrop: (root: string, n: number): Promise<GitResult> => ipcRenderer.invoke('git:stashDrop', root, n),
  gitLog: (root: string, rel: string | null, skip: number, limit: number): Promise<{ ok: boolean; error?: string; commits: CommitEntry[] }> =>
    ipcRenderer.invoke('git:log', root, rel, skip, limit),
  gitCommitFiles: (root: string, hash: string): Promise<{ ok: boolean; error?: string; files: CommitFile[] }> =>
    ipcRenderer.invoke('git:commitFiles', root, hash),
  gitCommitDiff: (root: string, hash: string, rel: string, orig?: string): Promise<{ original: string; modified: string }> =>
    ipcRenderer.invoke('git:commitDiff', root, hash, rel, orig),
  gitMergeState: (root: string): Promise<{ merging: boolean }> => ipcRenderer.invoke('git:mergeState', root),
  gitMergeAbort: (root: string): Promise<GitResult> => ipcRenderer.invoke('git:mergeAbort', root),
  gitTake: (root: string, rel: string, side: 'ours' | 'theirs'): Promise<GitResult> => ipcRenderer.invoke('git:take', root, rel, side),
  indexSearch: (
    roots: string[],
    query: string,
    opts?: { limit?: number; ai?: boolean; embed?: boolean }
  ): Promise<{
    ok: boolean
    error?: string
    semantic?: { used: boolean; model: { state: 'idle' | 'loading' | 'ready' | 'error'; error?: string }; done: number; total: number; error?: string }
    hits: { root: string; rel: string; abs: string; start: number; end: number; score: number; text: string }[]
    indexed: { files: number; chunks: number }
    expanded: string[] | null
    reranked: boolean
  }> => ipcRenderer.invoke('index:search', roots, query, opts),
  indexReset: (root: string): Promise<void> => ipcRenderer.invoke('index:reset', root),
  indexEmbeddings: (on: boolean): Promise<void> => ipcRenderer.invoke('index:embeddings', on),
  dbgStart: (opts: {
    file: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    stopOnEntry?: boolean
    breakpoints: Record<string, DbgBreakpoint[]>
  }): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('dbg:start', opts),
  dbgAttach: (opts: {
    language?: 'node' | 'python' | 'go' | 'java' | 'cpp' | 'csharp'
    roots?: string[]
    host?: string
    port?: number
    pid?: number
    breakpoints: Record<string, DbgBreakpoint[]>
  }): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('dbg:attach', opts),
  dbgInstallCsharp: (): Promise<{ ok: true; path: string; version: string } | { ok: false; error: string }> => ipcRenderer.invoke('dbg:installCsharp'),
  dbgStop: (): Promise<void> => ipcRenderer.invoke('dbg:stop'),
  dbgStep: (kind: 'continue' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dbg:' + kind),
  dbgSetBreakpoints: (file: string, bps: DbgBreakpoint[]): Promise<void> => ipcRenderer.invoke('dbg:setBreakpoints', file, bps),
  dbgScopes: (frame: number): Promise<DbgScope[]> => ipcRenderer.invoke('dbg:scopes', frame),
  dbgProps: (objectId: string): Promise<DbgVar[]> => ipcRenderer.invoke('dbg:props', objectId),
  dbgEval: (expression: string, frame: number | null): Promise<{ ok: true; value: DbgVar } | { ok: false; error: string }> =>
    ipcRenderer.invoke('dbg:eval', expression, frame),
  onDbgEvent: (cb: (e: DbgEvent) => void): (() => void) => {
    const h = (_e: unknown, ev: DbgEvent): void => cb(ev)
    ipcRenderer.on('dbg:event', h)
    return () => ipcRenderer.removeListener('dbg:event', h)
  },
  nbHtmlPage: (html: string): Promise<string | null> => ipcRenderer.invoke('nb:htmlPage', html),
  nbKernels: (): Promise<KernelInfo[]> => ipcRenderer.invoke('nb:kernels'),
  sshConnect: (address: string, secrets?: { password?: string; passphrase?: string; trust?: string }): Promise<ConnectResult> => ipcRenderer.invoke('ssh:connect', address, secrets),
  sshEnsure: (unc: string, secrets?: { password?: string; passphrase?: string; trust?: string }): Promise<ConnectResult> => ipcRenderer.invoke('ssh:ensure', unc, secrets),
  sshDisconnect: (name: string): Promise<void> => ipcRenderer.invoke('ssh:disconnect', name),
  sshBrowse: (name: string, p: string): Promise<{ ok: true; path: string; parent: string | null; dirs: string[] } | { ok: false; error: string }> => ipcRenderer.invoke('ssh:browse', name, p),
  sshToUnc: (name: string, p: string): Promise<string> => ipcRenderer.invoke('ssh:toUnc', name, p),
  sshConnections: (): Promise<{ live: string[]; remembered: unknown[] }> => ipcRenderer.invoke('ssh:connections'),
  nbStart: (kernel: string, cwd: string): Promise<{ ok: true; session: number } | { ok: false; error: string }> => ipcRenderer.invoke('nb:start', kernel, cwd),
  nbExecute: (session: number, cellId: string, code: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('nb:execute', session, cellId, code),
  lspLanguages: (): Promise<{ language: string; languages: string[]; label: string }[]> => ipcRenderer.invoke('lsp:languages'),
  lspAvailable: (language: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> => ipcRenderer.invoke('lsp:available', language),
  lspStart: (language: string, root: string): Promise<{ ok: true; server: string; capabilities: Record<string, unknown>; label: string; realRoot: string } | { ok: false; error: string }> => ipcRenderer.invoke('lsp:start', language, root),
  lspRequest: (server: string, method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> => ipcRenderer.invoke('lsp:request', server, method, params),
  lspNotify: (server: string, method: string, params: unknown): Promise<void> => ipcRenderer.invoke('lsp:notify', server, method, params),
  lspStop: (server: string): Promise<void> => ipcRenderer.invoke('lsp:stop', server),
  onLspMessage: (cb: (m: { server: string; method: string; params: unknown }) => void): (() => void) => {
    const h = (_e: unknown, m: { server: string; method: string; params: unknown }): void => cb(m)
    ipcRenderer.on('lsp:message', h)
    return () => ipcRenderer.removeListener('lsp:message', h)
  },
  onLspExited: (cb: (m: { server: string; code: number | null }) => void): (() => void) => {
    const h = (_e: unknown, m: { server: string; code: number | null }): void => cb(m)
    ipcRenderer.on('lsp:exited', h)
    return () => ipcRenderer.removeListener('lsp:exited', h)
  },
  nbStop: (session: number): Promise<void> => ipcRenderer.invoke('nb:stop', session),
  nbComm: (session: number, type: string, content: Record<string, unknown>, buffers: Uint8Array[]): Promise<string | null> => ipcRenderer.invoke('nb:comm', session, type, content, buffers),
  onNbComm: (cb: (session: number, type: string, content: Record<string, any>, buffers: Uint8Array[], parent?: string, metadata?: Record<string, unknown>) => void): (() => void) => {
    const h = (_e: unknown, session: number, type: string, content: Record<string, any>, buffers: Uint8Array[], parent?: string, metadata?: Record<string, unknown>): void => cb(session, type, content, buffers, parent, metadata)
    ipcRenderer.on('nb:comm', h)
    return () => ipcRenderer.removeListener('nb:comm', h)
  },
  nbInterrupt: (session: number): Promise<void> => ipcRenderer.invoke('nb:interrupt', session),
  nbInput: (session: number, value: string | null): Promise<void> => ipcRenderer.invoke('nb:input', session, value),
  onNbEvent: (cb: (session: number, cell: string | null, ev: NbEvent) => void): (() => void) => {
    const h = (_e: unknown, s: number, c: string | null, ev: NbEvent): void => cb(s, c, ev)
    ipcRenderer.on('nb:event', h)
    return () => ipcRenderer.removeListener('nb:event', h)
  },
  onNbExited: (cb: (session: number, code: number | null, err: string) => void): (() => void) => {
    const h = (_e: unknown, s: number, code: number | null, err: string): void => cb(s, code, err)
    ipcRenderer.on('nb:exited', h)
    return () => ipcRenderer.removeListener('nb:exited', h)
  },
  tasksLoad: (root: string): Promise<TasksInfo> => ipcRenderer.invoke('tasks:load', root),
  tasksEnsure: (root: string, kind: 'tasks' | 'launch'): Promise<string> => ipcRenderer.invoke('tasks:ensure', root, kind),
  extList: (): Promise<ExtRecord[]> => ipcRenderer.invoke('ext:list'),
  extSetRoot: (root: string | null): Promise<void> => ipcRenderer.invoke('ext:setRoot', root),
  extInstallVsix: (file?: string): Promise<{ ok: true; ext: ExtRecord } | { ok: false; error: string }> => ipcRenderer.invoke('ext:installVsix', file),
  extInstallFolder: (): Promise<{ ok: true; ext: ExtRecord } | { ok: false; error: string }> => ipcRenderer.invoke('ext:installFolder'),
  extSearch: (query: string): Promise<{ ok: boolean; error?: string; results: RegistryResult[] }> => ipcRenderer.invoke('ext:search', query),
  extInstallRegistry: (r: RegistryResult): Promise<{ ok: true; ext: ExtRecord } | { ok: false; error: string }> => ipcRenderer.invoke('ext:installRegistry', r),
  extSetEnabled: (id: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('ext:setEnabled', id, enabled),
  extUninstall: (id: string): Promise<void> => ipcRenderer.invoke('ext:uninstall', id),
  extSnippets: (): Promise<SnippetSet[]> => ipcRenderer.invoke('ext:snippets'),
  extRun: (extId: string, command: string, args?: unknown[]): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('ext:run', extId, command, args),
  extLog: (): Promise<string[]> => ipcRenderer.invoke('ext:log'),
  extOpenFolder: (): Promise<string | null> => ipcRenderer.invoke('ext:openFolder'),
  extWebviewState: (id: string, state: unknown): Promise<void> => ipcRenderer.invoke('ext:webviewState', id, state),
  extEditorState: (state: unknown): Promise<void> => ipcRenderer.invoke('ext:editorState', state),
  extProvide: (providerId: string, kind: string, params: unknown): Promise<unknown> => ipcRenderer.invoke('ext:provide', providerId, kind, params),
  extRespond: (reqId: number, r: { result?: unknown; error?: string }): Promise<void> => ipcRenderer.invoke('ext:respond', reqId, r),
  onExtRequest: (cb: (req: { reqId: number; method: string; params: any }) => void): (() => void) => {
    const h = (_e: unknown, req: { reqId: number; method: string; params: any }): void => cb(req)
    ipcRenderer.on('ext:request', h)
    return () => ipcRenderer.removeListener('ext:request', h)
  },
  onExtChanged: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('ext:changed', h)
    return () => ipcRenderer.removeListener('ext:changed', h)
  },
  onExtLog: (cb: (lines: string[]) => void): (() => void) => {
    const h = (_e: unknown, lines: string[]): void => cb(lines)
    ipcRenderer.on('ext:log', h)
    return () => ipcRenderer.removeListener('ext:log', h)
  },
  bgList: (): Promise<BgTask[]> => ipcRenderer.invoke('bg:list'),
  bgStart: (root: string, task: string, model: string): Promise<{ ok: true; task: BgTask } | { ok: false; error: string }> =>
    ipcRenderer.invoke('bg:start', root, task, model),
  bgStop: (id: string): Promise<void> => ipcRenderer.invoke('bg:stop', id),
  bgFileDiff: (id: string, rel: string, orig?: string): Promise<{ original: string; modified: string; abs: string }> =>
    ipcRenderer.invoke('bg:fileDiff', id, rel, orig),
  bgApply: (id: string): Promise<{ ok: true; conflicts: boolean; output: string } | { ok: false; error: string }> => ipcRenderer.invoke('bg:apply', id),
  bgDiscard: (id: string): Promise<void> => ipcRenderer.invoke('bg:discard', id),
  onBgUpdate: (cb: (t: BgTask) => void): (() => void) => {
    const h = (_e: unknown, t: BgTask): void => cb(t)
    ipcRenderer.on('bg:update', h)
    return () => ipcRenderer.removeListener('bg:update', h)
  },
  onBgRemoved: (cb: (id: string) => void): (() => void) => {
    const h = (_e: unknown, id: string): void => cb(id)
    ipcRenderer.on('bg:removed', h)
    return () => ipcRenderer.removeListener('bg:removed', h)
  },
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  updateCheck: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  updateDownload: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),
  updateInstall: (): void => ipcRenderer.send('update:install'),
  onUpdateState: (cb: (s: UpdateState) => void): (() => void) => {
    const h = (_e: unknown, s: UpdateState): void => cb(s)
    ipcRenderer.on('update:state', h)
    return () => ipcRenderer.removeListener('update:state', h)
  },
  // Zooms the whole UI (1 = 100%).
  setZoom: (factor: number): void => webFrame.setZoomFactor(factor),
  readDir: (dir: string) => ipcRenderer.invoke('fs:readDir', dir),
  readFile: (file: string): Promise<string> => ipcRenderer.invoke('fs:readFile', file),
  writeFile: (file: string, content: string): Promise<void> =>
    ipcRenderer.invoke('fs:writeFile', file, content),
  listFiles: (root: string): Promise<string[]> => ipcRenderer.invoke('fs:listFiles', root),
  searchText: (
    root: string,
    query: string,
    opts: { caseSensitive: boolean; regex: boolean }
  ): Promise<{
    matches: { path: string; rel: string; line: number; text: string }[]
    truncated: boolean
    error?: string
  }> => ipcRenderer.invoke('fs:search', root, query, opts),
  termShells: (): Promise<{ id: string; label: string }[]> => ipcRenderer.invoke('term:shells'),
  termCreate: (shellId: string, cwd: string | null, cols: number, rows: number): Promise<number> =>
    ipcRenderer.invoke('term:create', shellId, cwd, cols, rows),
  onTermExit: (cb: (id: number) => void): (() => void) => {
    const h = (_e: unknown, id: number): void => cb(id)
    ipcRenderer.on('term:exit', h)
    return () => ipcRenderer.removeListener('term:exit', h)
  },
  termWrite: (id: number, data: string): void => ipcRenderer.send('term:write', id, data),
  termResize: (id: number, cols: number, rows: number): void =>
    ipcRenderer.send('term:resize', id, cols, rows),
  termKill: (id: number): void => ipcRenderer.send('term:kill', id),
  onTermData: (cb: (id: number, data: string) => void): (() => void) => {
    const h = (_e: unknown, id: number, data: string): void => cb(id, data)
    ipcRenderer.on('term:data', h)
    return () => ipcRenderer.removeListener('term:data', h)
  },
  agentRun: (req: {
    runId: number
    sessionId: string
    model: string
    root: string
    task: string
  }): void => ipcRenderer.send('agent:run', req),
  agentAbort: (runId: number): void => ipcRenderer.send('agent:abort', runId),
  agentApprove: (runId: number, id: string, ok: boolean): void =>
    ipcRenderer.send('agent:approve', runId, id, ok),
  agentUndo: (
    sessionId: string,
    changeId: string
  ): Promise<{ ok: boolean; message: string; path?: string; content?: string | null }> =>
    ipcRenderer.invoke('agent:undo', sessionId, changeId),
  agentReset: (sessionId: string): void => ipcRenderer.send('agent:reset', sessionId),
  agentLoadUi: (sessionId: string): Promise<unknown[]> => ipcRenderer.invoke('agent:loadUi', sessionId),
  agentSaveUi: (sessionId: string, items: unknown[]): Promise<void> =>
    ipcRenderer.invoke('agent:saveUi', sessionId, items),
  agentHasSession: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('agent:hasSession', sessionId),
  onAgentEvent: (cb: (runId: number, event: AgentEvent) => void): (() => void) => {
    const h = (_e: unknown, runId: number, event: AgentEvent): void => cb(runId, event)
    ipcRenderer.on('agent:event', h)
    return () => ipcRenderer.removeListener('agent:event', h)
  },
  chatLoad: (
    root: string
  ): Promise<{ role: 'user' | 'assistant'; content: string; error?: string; note?: string }[]> =>
    ipcRenderer.invoke('chat:load', root),
  chatSave: (
    root: string,
    msgs: { role: 'user' | 'assistant'; content: string; error?: string; note?: string }[]
  ): Promise<void> => ipcRenderer.invoke('chat:save', root, msgs),
  aiHasKey: (): Promise<boolean> => ipcRenderer.invoke('ai:hasKey'),
  aiSetKey: (key: string): Promise<void> => ipcRenderer.invoke('ai:setKey', key),
  aiClearKey: (): Promise<void> => ipcRenderer.invoke('ai:clearKey'),
  aiChat: (req: {
    requestId: number
    model: string
    system: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    images?: { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string }[]
  }): void => ipcRenderer.send('ai:chat', req),
  aiApply: (req: {
    fileName: string
    language: string
    original: string
    snippet: string
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }> => ipcRenderer.invoke('ai:apply', req),
  gitDiffText: (root: string): Promise<string> => ipcRenderer.invoke('git:diffText', root),
  aiAbort: (requestId: number): void => ipcRenderer.send('ai:abort', requestId),
  aiComplete: (req: { requestId: number; system: string; prompt: string; maxTokens?: number; inline?: { language: string; prefix: string; suffix: string } }): Promise<string | null> =>
    ipcRenderer.invoke('ai:complete', req),
  authState: (): Promise<AuthState> => ipcRenderer.invoke('auth:state'),
  authMode: (): Promise<{ direct: boolean }> => ipcRenderer.invoke('auth:mode'),
  authStart: (): Promise<{ ok: true; state: AuthState } | { ok: false; error: string }> => ipcRenderer.invoke('auth:start'),
  authCancel: (): Promise<void> => ipcRenderer.invoke('auth:cancel'),
  authSignOut: (): Promise<void> => ipcRenderer.invoke('auth:signOut'),
  authMe: (): Promise<Me | null> => ipcRenderer.invoke('auth:me'),
  authGetUrl: (): Promise<string> => ipcRenderer.invoke('auth:getUrl'),
  authSetUrl: (url: string): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('auth:setUrl', url),
  onAuthState: (cb: (s: AuthState) => void): (() => void) => {
    const h = (_e: unknown, s: AuthState): void => cb(s)
    ipcRenderer.on('auth:state', h)
    return () => ipcRenderer.removeListener('auth:state', h)
  },
  onAiEvent: (handlers: {
    delta: (id: number, text: string) => void
    done: (id: number, stopReason: string | null, inTok: number, outTok: number) => void
    error: (id: number, message: string) => void
  }): (() => void) => {
    const d = (_e: unknown, id: number, t: string): void => handlers.delta(id, t)
    const n = (_e: unknown, id: number, s: string | null, i: number, o: number): void =>
      handlers.done(id, s, i, o)
    const r = (_e: unknown, id: number, m: string): void => handlers.error(id, m)
    ipcRenderer.on('ai:delta', d)
    ipcRenderer.on('ai:done', n)
    ipcRenderer.on('ai:error', r)
    return () => {
      ipcRenderer.removeListener('ai:delta', d)
      ipcRenderer.removeListener('ai:done', n)
      ipcRenderer.removeListener('ai:error', r)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
