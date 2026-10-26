import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { subscribeTheme, terminalTheme } from './theme'
import { feedTerminal, getLiveShare, isTerminalShared, resizeSharedTerminal, sendTerminalInput, shareTerminal, SharedTerm, unshareTerminal, useLiveShare, watchSharedTerminal } from './liveshare'
import { fontStack, getSettings, prefersLessMotion, screenReaderOn, subscribeSettings, useSettings } from './settings'

// --- Routing of shell output --------------------------------------------------
// A terminal's id is only known once the create call returns, but a shell can print before that (cmd.exe
// shows its banner at once). Output and exit events for ids nobody has claimed yet are kept until they are.
const sinks = new Map<number, (data: string) => void>()
const exitHandlers = new Map<number, () => void>()
const earlyData = new Map<number, string[]>()
const exitedEarly = new Set<number>()
let wired = false

function wire(): void {
  if (wired) return
  wired = true
  window.api.onTermData((id, data) => {
    feedTerminal(id, data) // a terminal the host shares in a Live Share session
    const sink = sinks.get(id)
    if (sink) sink(data)
    else earlyData.set(id, [...(earlyData.get(id) ?? []), data])
  })
  window.api.onTermExit((id) => {
    const handler = exitHandlers.get(id)
    if (handler) handler()
    else exitedEarly.add(id)
  })
}

function attach(id: number, sink: (data: string) => void, onExit: () => void): void {
  sinks.set(id, sink)
  exitHandlers.set(id, onExit)
  for (const d of earlyData.get(id) ?? []) sink(d)
  earlyData.delete(id)
  if (exitedEarly.delete(id)) onExit()
}

function detach(id: number): void {
  sinks.delete(id)
  exitHandlers.delete(id)
  earlyData.delete(id)
  exitedEarly.delete(id)
}

// What the terminals currently show, for the @terminal mention in chat.
const readers = new Map<number, () => string>()
let activeTerminalKey: number | null = null
const ptys = new Map<number, { id: number; cols: () => number; rows: () => number }>() // tab key -> the shell behind it
const titles = new Map<number, string>()

/** Shares the selected terminal with the guests of the Live Share session. */
export function shareActiveTerminal(write: boolean): string | null {
  const key = activeTerminalKey
  const pty = key !== null ? ptys.get(key) : undefined
  if (key === null || !pty) return 'There is no terminal to share. Open one first.'
  if (isTerminalShared(pty.id)) return 'That terminal is shared already.'
  if (!shareTerminal(pty.id, titles.get(key) ?? 'Terminal', write, pty.cols(), pty.rows(), readers.get(key)?.() ?? '')) return 'Start a Live Share session first.'
  return null
}
/** Stops sharing the selected terminal. */
export function unshareActiveTerminal(): boolean {
  const pty = activeTerminalKey !== null ? ptys.get(activeTerminalKey) : undefined
  if (!pty || !isTerminalShared(pty.id)) return false
  unshareTerminal(pty.id)
  return true
}

/** The last couple of hundred lines on screen and in scrollback of the selected terminal. */
export function readActiveTerminalText(): string {
  return (activeTerminalKey !== null ? readers.get(activeTerminalKey)?.() : '') ?? ''
}

// --- One terminal -------------------------------------------------------------

function TerminalView({
  tabKey,
  shellId,
  cwd,
  command,
  active,
  shared,
  onExit
}: {
  tabKey: number
  shellId: string
  cwd: string | null
  command?: string
  active: boolean // visible and selected: refit and take keyboard focus
  shared?: SharedTerm // the host's terminal in a Live Share session: shown here, not started here
  onExit: () => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const controls = useRef<{ refit: () => void; focus: () => void; resize: (cols: number, rows: number) => void } | null>(null)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal({
      fontFamily: fontStack(),
      fontSize: getSettings().terminalFontSize,
      theme: terminalTheme(),
      cursorBlink: !prefersLessMotion(),
      screenReaderMode: screenReaderOn(),
      disableStdin: !!shared && !shared.write,
      ...(shared ? { cols: shared.cols, rows: shared.rows } : {})
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    // A terminal somebody else runs, that this person may only watch, must not be announced as one to type in.
    if (shared) term.textarea?.setAttribute('aria-label', shared.write ? 'Shared terminal, you can type in it' : 'Shared terminal, read only')

    let id: number | null = null
    let disposed = false

    // A hidden terminal has no size; fitting then would collapse it to nothing.
    const refit = (): void => {
      if (shared) return // it has the size of the host's terminal
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return
      fit.fit()
      if (id !== null) {
        window.api.termResize(id, term.cols, term.rows)
        resizeSharedTerminal(id, term.cols, term.rows)
      }
    }
    controls.current = { refit, focus: () => term.focus(), resize: (c, r) => term.resize(c, r) }
    readers.set(tabKey, () => {
      const buf = term.buffer.active
      const lines: string[] = []
      for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
      return lines.join('\n').trimEnd()
    })
    refit()

    const offTheme = subscribeTheme(() => {
      term.options.theme = terminalTheme()
    })
    // A new font size changes the cell size, so the grid has to be refitted.
    const offSettings = subscribeSettings(() => {
      const s = getSettings()
      term.options.fontFamily = fontStack(s.fontFamily)
      term.options.fontSize = s.terminalFontSize
      term.options.screenReaderMode = screenReaderOn(s)
      term.options.cursorBlink = !prefersLessMotion(s)
      refit()
    })

    let unwatch: (() => void) | null = null
    if (shared) {
      unwatch = watchSharedTerminal(shared.id, (d) => term.write(d))
      term.onData((d) => shared.write && sendTerminalInput(shared.id, d))
    } else {
      wire()
      window.api.termCreate(shellId, cwd, term.cols, term.rows).then((tid) => {
        if (disposed) return window.api.termKill(tid)
        id = tid
        ptys.set(tabKey, { id: tid, cols: () => term.cols, rows: () => term.rows })
        attach(tid, (d) => term.write(d), () => {
          unshareTerminal(tid)
          onExitRef.current()
        })
        refit()
        if (command) window.api.termWrite(tid, command + '\r') // the shell reads it when it is ready
      })
      term.onData((d) => id !== null && window.api.termWrite(id, d))
    }

    const ro = new ResizeObserver(refit)
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      offTheme()
      offSettings()
      readers.delete(tabKey)
      ptys.delete(tabKey)
      titles.delete(tabKey)
      unwatch?.()
      if (id !== null) {
        unshareTerminal(id)
        detach(id)
        window.api.termKill(id)
      }
      term.dispose()
    }
    // A terminal keeps the shell and folder it was created with, so this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (shared) controls.current?.resize(shared.cols, shared.rows)
  }, [shared?.cols, shared?.rows]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      controls.current?.refit()
      controls.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active])

  return <div ref={hostRef} className="terminal" />
}

// --- The panel: tabs, shell menu, resize handle ---------------------------------

interface Tab {
  key: number
  shellId: string
  title: string
  cwd: string | null
  command?: string // typed into the shell once it has started (tasks)
  sharedId?: number // the host's terminal this one shows (Live Share guest)
}

const MIN_HEIGHT = 120

export type PanelTab = 'problems' | 'output' | 'debug' | 'terminal'
const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: 'problems', label: 'Problems' },
  { id: 'output', label: 'Output' },
  { id: 'debug', label: 'Debug Console' },
  { id: 'terminal', label: 'Terminal' }
]

// The bottom panel: Problems, Output, Debug Console and Terminal. The terminals stay mounted (and running) whichever
// tab is showing; the other tabs' contents come in as children.
export function TerminalPanel({
  cwd,
  visible,
  panelTab,
  onPanelTab,
  problemCount,
  children,
  newTabSignal,
  newTabShell,
  newTabExtra,
  onEmpty,
  onHide
}: {
  cwd: string | null
  visible: boolean
  panelTab: PanelTab
  onPanelTab: (tab: PanelTab) => void
  problemCount: number
  children?: React.ReactNode
  // Changes when something asks for one more terminal (Ctrl+Shift+`, palette).
  newTabSignal: number
  // Which shell the requested terminal uses (a shell id, or ssh:user@host); the default one if null.
  newTabShell: string | null
  // A terminal that starts with a command (a task): its title, the command and the folder.
  newTabExtra: { title: string; command: string; cwd: string | null } | null
  // Every tab was closed.
  onEmpty: () => void
  onHide: () => void
}): JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<number | null>(null)
  const [shells, setShells] = useState<{ id: string; label: string }[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [height, setHeight] = useState(260)
  const defaultShell = useSettings().terminalShell
  const nextKey = useRef(1)
  const counts = useRef(new Map<string, number>())
  const creating = useRef(false)
  const lastSignal = useRef(newTabSignal)
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  useEffect(() => {
    void window.api.termShells().then(setShells)
  }, [])

  const addTab = useCallback(async (shellId?: string, extra?: { title: string; command: string; cwd: string | null } | null): Promise<void> => {
    const list = await window.api.termShells()
    const id = shellId ?? getSettings().terminalShell
    const label = id.startsWith('ssh:') ? 'SSH: ' + id.slice(4) : (list.find((s) => s.id === id)?.label ?? list[0]?.label ?? 'Terminal')
    const n = (counts.current.get(id) ?? 0) + 1
    counts.current.set(id, n)
    const key = nextKey.current++
    const title = extra ? extra.title : n === 1 ? label : `${label} ${n}`
    titles.set(key, title)
    setTabs((t) => [...t, { key, shellId: id, title, cwd: extra ? extra.cwd : cwdRef.current, command: extra?.command }])
    setActive(key)
  }, [])

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // Showing the panel while it has no terminals starts one. This only reacts to the panel being shown:
  // closing the last tab must not start a new terminal while the panel is still on its way to hiding.
  useEffect(() => {
    if (!visible || panelTab !== 'terminal' || tabsRef.current.length > 0 || creating.current) return
    if (getLiveShare().role === 'guest' && getLiveShare().terms.length) return // the host's terminals are about to appear
    creating.current = true
    // If the panel was opened by a request for a particular shell (an SSH session), that is the one to start.
    void addTab(newTabShell ?? undefined, newTabExtra).finally(() => {
      creating.current = false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, panelTab, addTab])

  // A request for one more terminal (shortcut or palette).
  useEffect(() => {
    if (newTabSignal === lastSignal.current) return
    lastSignal.current = newTabSignal
    if (creating.current) return // the panel was just opened and is starting this very terminal
    void addTab(newTabShell ?? undefined, newTabExtra)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newTabSignal, addTab])

  // The host's shared terminals show up as tabs for a guest, and go when the host stops sharing.
  const live = useLiveShare()
  useEffect(() => {
    const wanted = live.role === 'guest' ? live.terms : []
    setTabs((prev) => {
      const kept = prev.filter((t) => t.sharedId === undefined || wanted.some((w) => w.id === t.sharedId))
      const added = wanted.filter((w) => !kept.some((t) => t.sharedId === w.id)).map((w) => ({ key: nextKey.current++, shellId: '', title: `${w.title} (shared)`, cwd: null, sharedId: w.id }))
      return added.length || kept.length !== prev.length ? [...kept, ...added] : prev
    })
  }, [live.role, live.terms])

  const closeTab = useCallback((key: number): void => {
    setTabs((prev) => prev.filter((t) => t.key !== key))
  }, [])

  useEffect(() => {
    activeTerminalKey = active
  }, [active])

  // Keep a valid tab selected, and tell the app when the last one is gone.
  const prevCount = useRef(0)
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((t) => t.key === active)) setActive(tabs[tabs.length - 1].key)
    if (tabs.length === 0) setActive(null)
    if (prevCount.current > 0 && tabs.length === 0) onEmpty()
    prevCount.current = tabs.length
  }, [tabs, active, onEmpty])

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const move = (ev: MouseEvent): void =>
      setHeight(Math.round(Math.min(window.innerHeight * 0.75, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)))))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="terminal-panel" role="region" aria-label="Terminal" style={{ display: visible ? 'flex' : 'none', height }}>
      <div className="term-resize" onMouseDown={startDrag} title="Drag to resize" />
      <div className="term-tabs">
        <div className="panel-tabs" role="tablist" aria-label="Panel">
          {PANEL_TABS.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={panelTab === p.id}
              className={'panel-tab' + (panelTab === p.id ? ' on' : '')}
              data-panel-tab={p.id}
              onClick={() => onPanelTab(p.id)}
            >
              {p.label}
              {p.id === 'problems' && problemCount > 0 && <span className="badge">{problemCount}</span>}
            </button>
          ))}
        </div>
        <div className="term-tablist" role="tablist" aria-label="Terminals" style={{ display: panelTab === 'terminal' ? 'flex' : 'none' }}>
        {tabs.map((t) => (
          <div
            key={t.key}
            className={'term-tab' + (t.key === active ? ' active' : '')}
            role="tab"
            aria-selected={t.key === active}
            tabIndex={t.key === active ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), setActive(t.key))
              else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const i = tabs.findIndex((x) => x.key === t.key)
                const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
                if (n) setActive(n.key)
              }
            }}
            onClick={() => setActive(t.key)}
          >
            <span className="term-tab-name">{t.title}</span>
            <span
              className="close"
              title="Close terminal"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.key)
              }}
            >
              ×
            </span>
          </div>
        ))}
        <button className="term-btn term-add" title="New terminal (Ctrl+Shift+`)" onClick={() => void addTab()}>
          +
        </button>
        <button className="term-btn term-shells" title="Choose a shell" onClick={() => setMenuOpen((v) => !v)}>
          ▾
        </button>
        </div>
        {menuOpen && (
          <>
            <div className="term-menu-backdrop" onMouseDown={() => setMenuOpen(false)} />
            <div className="term-menu">
              {shells.map((s) => (
                <div
                  key={s.id}
                  className="term-menu-item"
                  data-shell={s.id}
                  onClick={() => {
                    setMenuOpen(false)
                    void addTab(s.id)
                  }}
                >
                  {s.label}
                  {s.id === defaultShell && <span className="qp-detail">default</span>}
                </div>
              ))}
            </div>
          </>
        )}
        <span className="term-spacer" />
        <button className="term-btn" title="Hide the panel (Ctrl+`)" onClick={onHide}>
          Hide
        </button>
      </div>
      {panelTab !== 'terminal' && <div className="panel-body">{children}</div>}
      <div className="term-views" style={{ display: panelTab === 'terminal' ? undefined : 'none' }}>
        {tabs.map((t) => (
          <div key={t.key} className="term-view" style={{ display: t.key === active ? 'block' : 'none' }}>
            <TerminalView
              tabKey={t.key}
              shellId={t.shellId}
              cwd={t.cwd}
              command={t.command}
              active={visible && panelTab === 'terminal' && t.key === active}
              shared={t.sharedId !== undefined ? live.terms.find((w) => w.id === t.sharedId) : undefined}
              onExit={() => closeTab(t.key)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
