import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { AgentEvent } from '../main/agent'
import type { UpdateState } from '../main/updater'
import type { GitStatus } from '../main/git'

type GitResult = { ok: true } | { ok: false; error: string }

const api = {
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  initialFolder: (): Promise<string | null> => ipcRenderer.invoke('app:initialFolder'),
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
  fsWatch: (root: string | null): Promise<void> => ipcRenderer.invoke('fs:watch', root),
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
  aiComplete: (req: { requestId: number; system: string; prompt: string }): Promise<string | null> =>
    ipcRenderer.invoke('ai:complete', req),
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
