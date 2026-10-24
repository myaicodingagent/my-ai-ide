import { useEffect, useRef, useState } from 'react'
import type { DbgScope, DbgVar } from '../../main/debugger'
import type { LaunchConfig } from '../../main/tasks'
import {
  addWatch,
  appendOutput,
  clearBreakpoints,
  clearOutput,
  isActive,
  removeBreakpoint,
  removeWatch,
  selectFrame,
  setCondition,
  stepDebug,
  stopDebugging,
  useDebug
} from './debugStore'

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

function VarRow({ v, depth }: { v: DbgVar; depth: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [kids, setKids] = useState<DbgVar[] | null>(null)
  const toggle = async (): Promise<void> => {
    if (!v.objectId) return
    if (!open && kids === null) setKids(await window.api.dbgProps(v.objectId))
    setOpen(!open)
  }
  return (
    <div>
      <div className="dbg-var" data-dbg-var={v.name} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => void toggle()}>
        <span className="dbg-chevron">{v.objectId ? (open ? '▾' : '▸') : ''}</span>
        <span className="dbg-var-name">{v.name}</span>
        <span className={'dbg-var-value dbg-t-' + v.type} title={v.value}>
          {v.value}
        </span>
      </div>
      {open && kids?.map((k) => <VarRow key={k.name} v={k} depth={depth + 1} />)}
    </div>
  )
}

function Section({ title, count, children, actions }: { title: string; count?: number; children: React.ReactNode; actions?: React.ReactNode }): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="dbg-section">
      <div className="dbg-section-head" onClick={() => setOpen(!open)}>
        <span>
          {open ? '▾' : '▸'} {title}
          {count !== undefined && count > 0 && <span className="git-count">{count}</span>}
        </span>
        <span onClick={(e) => e.stopPropagation()}>{actions}</span>
      </div>
      {open && children}
    </div>
  )
}

export function DebugPanel({
  root,
  activeFile,
  onStart,
  configs,
  selected,
  onSelect,
  onEditConfigs,
  problems,
  onOpenFile
}: {
  root: string | null
  // The file open in the editor (what Start debugs), if it can be run by Node.
  activeFile: string | null
  // Saves the file if needed and starts debugging it; resolves to an error message, or null.
  onStart: () => Promise<string | null>
  // Launch configurations from launch.json, which one is chosen ('' = the open file), and problems found in the files.
  configs: LaunchConfig[]
  selected: string
  onSelect: (name: string) => void
  onEditConfigs: () => void
  problems: string[]
  onOpenFile: (path: string, line: number) => void
}): JSX.Element {
  const d = useDebug()
  const [scopes, setScopes] = useState<DbgScope[]>([])
  const [watchValues, setWatchValues] = useState<Record<string, { ok: boolean; text: string; v?: DbgVar }>>({})
  const [watchInput, setWatchInput] = useState('')
  const [consoleInput, setConsoleInput] = useState('')
  const [startError, setStartError] = useState<string | null>(null)
  const outRef = useRef<HTMLPreElement>(null)

  const usingConfig = configs.some((c) => c.name === selected)
  const runnable = usingConfig || (!!activeFile && /\.((c|m)?(j|t)sx?|pyw?|go)$/i.test(activeFile))
  const active = isActive(d)

  // Variables and watches follow the stop position.
  useEffect(() => {
    if (d.status !== 'paused') {
      setScopes([])
      setWatchValues({})
      return
    }
    let cancelled = false
    void window.api.dbgScopes(d.frame).then((s) => !cancelled && setScopes(s)).catch(() => !cancelled && setScopes([]))
    void Promise.all(d.watches.map((w) => window.api.dbgEval(w, d.frame).then((r) => [w, r] as const))).then((rs) => {
      if (cancelled) return
      const next: Record<string, { ok: boolean; text: string; v?: DbgVar }> = {}
      for (const [w, r] of rs) next[w] = r.ok ? { ok: true, text: r.value.value, v: r.value } : { ok: false, text: r.error.split('\n')[0] }
      setWatchValues(next)
    })
    return () => {
      cancelled = true
    }
  }, [d.version, d.status, d.frame, d.watches])

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight })
  }, [d.output])

  const start = async (): Promise<void> => {
    setStartError(null)
    const err = await onStart()
    if (err) setStartError(err)
  }

  const evalConsole = async (): Promise<void> => {
    const expr = consoleInput.trim()
    if (!expr) return
    setConsoleInput('')
    appendOutput({ stream: 'info', text: '> ' + expr + '\n' })
    if (!active) return appendOutput({ stream: 'stderr', text: 'Start debugging to evaluate expressions.\n' })
    try {
      const r = await window.api.dbgEval(expr, d.status === 'paused' ? d.frame : null)
      appendOutput(r.ok ? { stream: 'stdout', text: r.value.value + '\n' } : { stream: 'stderr', text: r.error.split('\n')[0] + '\n' })
    } catch (e) {
      appendOutput({ stream: 'stderr', text: (e instanceof Error ? e.message : String(e)) + '\n' })
    }
  }

  const status =
    d.status === 'paused'
      ? `Paused${d.reason === 'breakpoint' ? ' on a breakpoint' : d.reason === 'exception' ? ' on an exception' : d.reason === 'step' ? '' : ' (' + d.reason + ')'}${d.exception ? ': ' + d.exception : ''}`
      : d.status === 'running'
        ? 'Running…'
        : d.status === 'ended'
          ? 'The program ended'
          : 'Not running'
  const bps = Object.values(d.breakpoints).flatMap((b) => b.bps.map((bp) => ({ path: b.path, ...bp })))

  return (
    <div className="dbg" data-dbg-panel>
      <div className="dbg-config">
        <select data-dbg-config value={selected} disabled={active} onChange={(e) => onSelect(e.target.value)} title="What F5 starts">
          <option value="">Current file</option>
          {configs.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <button data-dbg-edit-configs title="Edit launch.json" onClick={onEditConfigs}>⚙</button>
      </div>
      {problems.length > 0 && <div className="chat-error" data-dbg-problems>{problems.join(' ')}</div>}
      <div className="dbg-bar">
        {!active ? (
          <button className="primary" data-dbg-action="start" disabled={!runnable} title={runnable ? 'Run the open file with the debugger (F5)' : 'Open a .js, .ts, .py, .go, .cs, .c or .cpp file to debug it'} onClick={() => void start()}>
            ▶ Start Debugging
          </button>
        ) : (
          <>
            <button data-dbg-action="continue" title="Continue (F5)" disabled={d.status !== 'paused'} onClick={() => void stepDebug('continue')}>▶</button>
            <button data-dbg-action="stepOver" title="Step Over (F10)" disabled={d.status !== 'paused'} onClick={() => void stepDebug('stepOver')}>⤼</button>
            <button data-dbg-action="stepInto" title="Step Into (F11)" disabled={d.status !== 'paused'} onClick={() => void stepDebug('stepInto')}>↓</button>
            <button data-dbg-action="stepOut" title="Step Out (Shift+F11)" disabled={d.status !== 'paused'} onClick={() => void stepDebug('stepOut')}>↑</button>
            <button data-dbg-action="pause" title="Pause" disabled={d.status !== 'running'} onClick={() => void stepDebug('pause')}>⏸</button>
            <button data-dbg-action="stop" title="Stop (Shift+F5)" onClick={() => void stopDebugging()}>■</button>
          </>
        )}
      </div>
      <div className="dbg-status" data-dbg-status={d.status}>
        {status}
        {d.file && active && <span className="dbg-file"> · {baseName(d.file)}</span>}
      </div>
      {startError && <div className="chat-error" data-dbg-error>{startError}</div>}
      {!root && <div className="empty">Open a folder to debug.</div>}

      <Section title="Variables">
        {d.status !== 'paused' && <div className="dbg-empty">Variables appear when the program is stopped.</div>}
        {scopes.map((s) => (
          <div key={s.name} data-dbg-scope={s.name}>
            <div className="dbg-scope-name">{s.name}</div>
            {s.vars.map((v) => (
              <VarRow key={s.name + v.name} v={v} depth={0} />
            ))}
          </div>
        ))}
      </Section>

      <Section title="Watch" count={d.watches.length}>
        {d.watches.map((w) => {
          const val = watchValues[w]
          return (
            <div key={w} className="dbg-var dbg-watch" data-dbg-watch={w}>
              <span className="dbg-var-name">{w}</span>
              <span className={'dbg-var-value' + (val && !val.ok ? ' dbg-err' : '')} title={val?.text}>
                {d.status === 'paused' ? (val ? val.text : '…') : ''}
              </span>
              <button className="dbg-x" title="Remove" onClick={() => removeWatch(w)}>×</button>
            </div>
          )
        })}
        <input
          className="dbg-input"
          data-dbg-watch-input
          value={watchInput}
          placeholder="Add expression to watch…"
          onChange={(e) => setWatchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              addWatch(watchInput)
              setWatchInput('')
            }
          }}
        />
      </Section>

      <Section title="Call Stack" count={d.frames.length}>
        {d.frames.map((f) => (
          <div
            key={f.index}
            className={'dbg-frame' + (f.index === d.frame ? ' sel' : '') + (f.file ? '' : ' dim')}
            data-dbg-frame={f.index}
            onClick={() => (f.file ? selectFrame(f.index) : undefined)}
            title={f.file ?? f.url}
          >
            <span>{f.name}</span>
            <span className="dbg-frame-loc">{f.file ? `${baseName(f.file)}:${f.line}` : 'internal'}</span>
          </div>
        ))}
        {d.frames.length === 0 && <div className="dbg-empty">Not stopped.</div>}
      </Section>

      <Section
        title="Breakpoints"
        count={bps.length}
        actions={bps.length > 0 && <button className="dbg-x" data-dbg-action="clear-breakpoints" title="Remove all breakpoints" onClick={clearBreakpoints}>⌫</button>}
      >
        {bps.length === 0 && <div className="dbg-empty">Click in the margin next to a line number, or press F9, to set one.</div>}
        {bps.map((b) => (
          <div key={b.path + ':' + b.line} className="dbg-bp" data-dbg-bp={`${baseName(b.path)}:${b.line}`}>
            <span className="dbg-bp-dot" />
            <span className="dbg-bp-loc" onClick={() => onOpenFile(b.path, b.line)} title={b.path}>
              {baseName(b.path)}:{b.line}
            </span>
            <input
              className="dbg-input dbg-cond"
              data-dbg-condition
              defaultValue={b.condition ?? ''}
              placeholder="condition"
              title="Only stop when this expression is true"
              onBlur={(e) => e.target.value.trim() !== (b.condition ?? '') && setCondition(b.path, b.line, e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const v = (e.target as HTMLInputElement).value
                if (v.trim() !== (b.condition ?? '')) setCondition(b.path, b.line, v)
              }}
            />
            <button className="dbg-x" title="Remove" onClick={() => removeBreakpoint(b.path, b.line)}>×</button>
          </div>
        ))}
      </Section>

      <Section title="Debug Console" actions={<button className="dbg-x" title="Clear" onClick={clearOutput}>⌫</button>}>
        <pre className="dbg-output" data-dbg-output ref={outRef}>
          {d.output.map((l, i) => (
            <span key={i} className={'dbg-out-' + l.stream}>
              {l.text}
            </span>
          ))}
        </pre>
        <input
          className="dbg-input"
          data-dbg-console-input
          value={consoleInput}
          placeholder="Evaluate an expression…"
          onChange={(e) => setConsoleInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void evalConsole()}
        />
      </Section>
    </div>
  )
}
