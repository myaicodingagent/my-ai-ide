import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { monaco } from './monaco-setup'
import { announce } from './a11y'
import { appendOutput as appendDebugOutput, clearOutput, isActive, useDebug } from './debugStore'
import { useExtLog } from './extStore'
import { APP_CHANNEL, clearChannel, useChannels } from './outputStore'

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

// ---- Problems: the errors and warnings of every open file, grouped by file ----

export interface Problem {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source: string
}

const markerSub = (cb: () => void): (() => void) => {
  const d = monaco.editor.onDidChangeMarkers(cb)
  return () => d.dispose()
}
let cache: { key: string; list: Problem[] } = { key: '', list: [] }
function readProblems(): Problem[] {
  const ms = monaco.editor.getModelMarkers({}).filter((m) => m.resource.scheme === 'file')
  const key = ms.map((m) => `${m.resource.fsPath}:${m.startLineNumber}:${m.startColumn}:${m.severity}:${m.message}`).join('\n')
  if (key === cache.key) return cache.list // the same list, so React does not redraw
  cache = {
    key,
    list: ms
      .map(
        (m): Problem => ({
          file: m.resource.fsPath,
          line: m.startLineNumber,
          column: m.startColumn,
          severity: m.severity === monaco.MarkerSeverity.Error ? 'error' : m.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info',
          message: m.message.split('\n')[0],
          source: typeof m.source === 'string' ? m.source : ''
        })
      )
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  }
  return cache.list
}
export const useProblems = (): Problem[] => useSyncExternalStore(markerSub, readProblems)

export function ProblemsView({ onOpen }: { onOpen: (file: string, line: number) => void }): JSX.Element {
  const all = useProblems()
  const [filter, setFilter] = useState('')
  const [onlyErrors, setOnlyErrors] = useState(false)
  const shown = all.filter((p) => (!onlyErrors || p.severity === 'error') && (!filter || (p.message + p.file).toLowerCase().includes(filter.toLowerCase())))
  const files = [...new Set(shown.map((p) => p.file))]
  const errors = all.filter((p) => p.severity === 'error').length
  const warnings = all.filter((p) => p.severity === 'warning').length
  return (
    <div className="pv" data-problems-view>
      <div className="pv-bar">
        <input className="pv-filter" placeholder="Filter (text or file name)" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter problems" />
        <label className="pv-check">
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Errors only
        </label>
        <span className="pv-count" data-problems-count>
          {errors} error{errors === 1 ? '' : 's'}, {warnings} warning{warnings === 1 ? '' : 's'}
        </span>
      </div>
      <div className="pv-list" role="list">
        {files.length === 0 && <div className="pv-empty">{all.length === 0 ? 'No problems have been detected in the open files.' : 'No problems match the filter.'}</div>}
        {files.map((f) => (
          <div key={f} role="listitem">
            <div className="pv-file" title={f}>
              {baseName(f)} <span className="pv-dim">{f}</span>
            </div>
            {shown
              .filter((p) => p.file === f)
              .map((p, i) => (
                <div
                  key={i}
                  className={'pv-row pv-' + p.severity}
                  data-problem-row
                  tabIndex={0}
                  onClick={() => onOpen(p.file, p.line)}
                  onKeyDown={(e) => e.key === 'Enter' && onOpen(p.file, p.line)}
                >
                  <span className="pv-icon">{p.severity === 'error' ? '✖' : p.severity === 'warning' ? '⚠' : 'ℹ'}</span>
                  <span className="pv-msg">{p.message}</span>
                  {p.source && <span className="pv-dim">{p.source}</span>}
                  <span className="pv-dim">
                    [{p.line}, {p.column}]
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---- Output: named channels (the app, tasks, and what extensions print) ----

const EXT_CHANNEL = 'Extensions'

export function OutputView(): JSX.Element {
  const channels = useChannels()
  const extLog = useExtLog()
  const names = [...Object.keys(channels), EXT_CHANNEL]
  const [channel, setChannel] = useState(APP_CHANNEL)
  const text = channel === EXT_CHANNEL ? extLog.join('\n') : (channels[channel] ?? '')
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [text, channel])
  return (
    <div className="pv" data-output-view>
      <div className="pv-bar">
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Output channel" data-output-channel>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="pv-spacer" />
        {channel !== EXT_CHANNEL && (
          <button className="term-btn" title="Clear this channel" onClick={() => clearChannel(channel)}>
            Clear
          </button>
        )}
      </div>
      <pre className="pv-output" ref={ref} data-output-text tabIndex={0} aria-label={`Output: ${channel}`}>
        {text || (channel === EXT_CHANNEL ? 'Extensions have not printed anything.' : 'Nothing has been written to this channel yet.')}
      </pre>
    </div>
  )
}

// ---- Debug Console: what the program printed, and a box to evaluate expressions in the stopped frame ----

export function DebugConsoleView(): JSX.Element {
  const d = useDebug()
  const [input, setInput] = useState('')
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [d.output])
  const run = async (): Promise<void> => {
    const expr = input.trim()
    if (!expr) return
    setInput('')
    appendDebugOutput({ stream: 'info', text: '> ' + expr + '\n' })
    if (!isActive(d)) return appendDebugOutput({ stream: 'stderr', text: 'Start debugging to evaluate expressions.\n' })
    try {
      const r = await window.api.dbgEval(expr, d.status === 'paused' ? d.frame : null)
      appendDebugOutput(r.ok ? { stream: 'stdout', text: r.value.value + '\n' } : { stream: 'stderr', text: r.error.split('\n')[0] + '\n' })
    } catch (e) {
      appendDebugOutput({ stream: 'stderr', text: (e instanceof Error ? e.message : String(e)) + '\n' })
    }
    announce('Evaluated')
  }
  return (
    <div className="pv" data-debug-console-view>
      <div className="pv-bar">
        <span className="pv-count">{d.status === 'paused' ? 'Paused' : isActive(d) ? 'Running' : 'Not running'}</span>
        <span className="pv-spacer" />
        <button className="term-btn" title="Clear the console" onClick={clearOutput}>
          Clear
        </button>
      </div>
      <pre className="pv-output" ref={ref} data-debug-console-text tabIndex={0} aria-label="Debug console">
        {d.output.length === 0 ? 'The program\'s output and your expressions appear here.' : d.output.map((l, i) => (
          <span key={i} className={'dbg-out-' + l.stream}>
            {l.text}
          </span>
        ))}
      </pre>
      <input
        className="pv-input"
        data-debug-console-panel-input
        value={input}
        placeholder="Evaluate an expression (Enter)…"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void run()}
        aria-label="Evaluate an expression"
      />
    </div>
  )
}
