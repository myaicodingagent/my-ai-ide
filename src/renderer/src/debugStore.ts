import { useSyncExternalStore } from 'react'
import type { DbgBreakpoint, DbgEvent, DbgFrame } from '../../main/debugger'
import { announce } from './a11y'

// State of the debugger (see src/main/debugger.ts): breakpoints (remembered between runs), the current session,
// where it is stopped, watch expressions and the program's output.

export type DebugStatus = 'idle' | 'running' | 'paused' | 'ended'

export interface OutputLine {
  stream: 'stdout' | 'stderr' | 'info'
  text: string
}

interface Snapshot {
  status: DebugStatus
  frames: DbgFrame[]
  frame: number // the selected call frame
  reason: string
  exception?: string
  output: OutputLine[]
  breakpoints: Record<string, { path: string; bps: DbgBreakpoint[] }> // key: normalised path
  watches: string[]
  file: string | null // the program being debugged
  version: number // bumps on every change of the stop position, so views reload variables
}

const BP_KEY = 'debug-breakpoints'
const WATCH_KEY = 'debug-watches'
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
const MAX_OUTPUT = 3000

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not remembered; nothing else is affected.
  }
}

let snap: Snapshot = {
  status: 'idle',
  frames: [],
  frame: 0,
  reason: '',
  output: [],
  breakpoints: {},
  watches: [],
  file: null,
  version: 0
}
const listeners = new Set<() => void>()
const emit = (patch: Partial<Snapshot>): void => {
  snap = { ...snap, ...patch }
  listeners.forEach((cb) => cb())
}

let started = false
let onStop: (frame: DbgFrame) => void = () => undefined

/** Starts listening to the main process (once). `stopped` is called whenever the program stops in a file. */
export function initDebug(stopped: (frame: DbgFrame) => void): void {
  onStop = stopped
  if (started) return
  started = true
  const stored = load<Snapshot['breakpoints']>(BP_KEY, {})
  emit({ breakpoints: stored && typeof stored === 'object' ? stored : {}, watches: load<string[]>(WATCH_KEY, []) })
  window.api.onDbgEvent((e: DbgEvent) => {
    switch (e.type) {
      case 'started':
        emit({ status: 'running' })
        break
      case 'paused': {
        // The frame to show: the first one in a file of the user's (Node's own code has no file).
        const first = Math.max(0, e.frames.findIndex((f) => f.file && !/[\\/]node_modules[\\/]/.test(f.file)))
        emit({ status: 'paused', frames: e.frames, frame: first, reason: e.reason, exception: e.exception, version: snap.version + 1 })
        const f = e.frames[first]
        announce(`Paused${e.reason === 'breakpoint' ? ' on a breakpoint' : e.reason === 'exception' ? ' on an exception' : ''}${f ? ` in ${f.name}, ${(f.file ?? '').split(/[\\/]/).pop()} line ${f.line}` : ''}`)
        if (f?.file) onStop(f)
        break
      }
      case 'resumed':
        emit({ status: snap.status === 'ended' ? 'ended' : 'running', frames: [], version: snap.version + 1 })
        break
      case 'output':
        emit({ output: [...snap.output, { stream: e.stream, text: e.text }].slice(-MAX_OUTPUT) })
        break
      case 'exited':
        announce(`The program ended${e.code === null ? '' : ` with exit code ${e.code}`}`)
        emit({
          status: 'ended',
          frames: [],
          output: [...snap.output, { stream: 'info', text: `\nThe program ended${e.code === null ? '' : ` with exit code ${e.code}`}.\n` }],
          version: snap.version + 1
        })
        break
      case 'error':
        emit({ output: [...snap.output, { stream: 'stderr', text: e.message + '\n' }] })
        break
    }
  })
}

export const getDebug = (): Snapshot => snap
export const subscribeDebug = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export const useDebug = (): Snapshot => useSyncExternalStore(subscribeDebug, getDebug)

export const isActive = (s: Snapshot = snap): boolean => s.status === 'running' || s.status === 'paused'

// ---- breakpoints ----

export const breakpointsOf = (file: string, s: Snapshot = snap): DbgBreakpoint[] => s.breakpoints[norm(file)]?.bps ?? []

function setBreakpoints(file: string, bps: DbgBreakpoint[]): void {
  const next = { ...snap.breakpoints }
  if (bps.length) next[norm(file)] = { path: file, bps: [...bps].sort((a, b) => a.line - b.line) }
  else delete next[norm(file)]
  save(BP_KEY, next)
  emit({ breakpoints: next })
  if (isActive()) void window.api.dbgSetBreakpoints(file, next[norm(file)]?.bps ?? [])
}

export function toggleBreakpoint(file: string, line: number): void {
  const cur = breakpointsOf(file)
  setBreakpoints(file, cur.some((b) => b.line === line) ? cur.filter((b) => b.line !== line) : [...cur, { line }])
}

export function setCondition(file: string, line: number, condition: string): void {
  setBreakpoints(file, breakpointsOf(file).map((b) => (b.line === line ? { line, ...(condition.trim() ? { condition: condition.trim() } : {}) } : b)))
}

export function removeBreakpoint(file: string, line: number): void {
  setBreakpoints(file, breakpointsOf(file).filter((b) => b.line !== line))
}

export function clearBreakpoints(): void {
  save(BP_KEY, {})
  const old = Object.values(snap.breakpoints)
  emit({ breakpoints: {} })
  if (isActive()) for (const o of old) void window.api.dbgSetBreakpoints(o.path, [])
}

// ---- watches ----

export function addWatch(expr: string): void {
  if (!expr.trim() || snap.watches.includes(expr.trim())) return
  const next = [...snap.watches, expr.trim()]
  save(WATCH_KEY, next)
  emit({ watches: next })
}
export function removeWatch(expr: string): void {
  const next = snap.watches.filter((w) => w !== expr)
  save(WATCH_KEY, next)
  emit({ watches: next })
}

// ---- session control ----

export async function startDebugging(
  file: string,
  cwd: string | undefined,
  stopOnEntry = false,
  extra: { args?: string[]; env?: Record<string, string> } = {}
): Promise<string | null> {
  if (isActive()) return 'A debug session is already running.'
  const breakpoints: Record<string, DbgBreakpoint[]> = {}
  for (const v of Object.values(snap.breakpoints)) breakpoints[v.path] = v.bps
  emit({ status: 'running', frames: [], frame: 0, reason: '', exception: undefined, output: [], file, version: snap.version + 1 })
  const r = await window.api.dbgStart({ file, cwd, stopOnEntry, breakpoints, args: extra.args, env: extra.env })
  if (!r.ok) {
    emit({ status: 'idle', output: [{ stream: 'stderr', text: r.error + '\n' }] })
    return r.error
  }
  return null
}

export const stopDebugging = (): Promise<void> => window.api.dbgStop()
export const stepDebug = (kind: 'continue' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause'): Promise<{ ok: boolean; error?: string }> => window.api.dbgStep(kind)

export function selectFrame(i: number): void {
  const f = snap.frames[i]
  emit({ frame: i, version: snap.version + 1 })
  if (f?.file) onStop(f)
}

export function clearOutput(): void {
  emit({ output: [] })
}

export function appendOutput(line: OutputLine): void {
  emit({ output: [...snap.output, line].slice(-MAX_OUTPUT) })
}
