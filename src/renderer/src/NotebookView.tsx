import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { monaco } from './monaco-setup'
import { announce } from './a11y'
import { InputDialog, InputRequest } from './InputDialog'
import { editorOptions, useSettings } from './settings'
import { renderMarkdown } from './miniMarkdown'
import {
  Notebook,
  NbCell,
  NbOutput,
  appendStream,
  bestMime,
  clearOutputs,
  deleteCell,
  insertCell,
  kernelLanguage,
  mergeWithNext,
  moveCell,
  newCell,
  outputText,
  parseNotebook,
  renderStreamText,
  serializeNotebook,
  setCellType,
  stripAnsi,
  updateCell
} from './notebookModel'

import { WIDGET_MIME, WidgetOutput, forgetWidgets, initWidgets, widgetManager } from './widgets'

type KernelInfo = { id: string; label: string; kernelspec?: { name: string; display_name: string; language: string } }

// The kernel a notebook asks for: a Jupyter kernel of that name if one is installed (other than the built-in stand-ins for python3 and javascript), else by language.
function kernelFor(nb: Notebook, kernels: KernelInfo[]): string {
  const name = String(((nb.metadata.kernelspec ?? {}) as { name?: string }).name ?? '')
  if (name && !/^(python3?|javascript|node)$/i.test(name) && kernels.some((k) => k.id === 'jupyter:' + name)) return 'jupyter:' + name
  return kernelLanguage(nb)
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const dirName = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')

// ---- One output ----

function HtmlOutput({ html }: { html: string }): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  // The page is shown in a frame that may not run scripts; the frame is sized to its content once loaded.
  const doc = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px system-ui,sans-serif;color:#222;background:#fff;padding:4px 8px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 8px;text-align:right}th{background:#f2f2f2}img{max-width:100%}</style>${html}`
  return (
    <iframe
      ref={ref}
      className="nb-html"
      title="Output"
      sandbox="allow-same-origin"
      srcDoc={doc}
      onLoad={() => {
        const d = ref.current?.contentDocument
        if (d?.body && ref.current) ref.current.style.height = Math.min(600, d.documentElement.scrollHeight + 4) + 'px'
      }}
    />
  )
}

function OutputView({ o, session }: { o: NbOutput; session: number | null }): JSX.Element | null {
  if (o.output_type === 'stream') {
    return <pre className={'nb-stream' + (o.name === 'stderr' ? ' err' : '')}>{renderStreamText(outputText(o.text))}</pre>
  }
  if (o.output_type === 'error') {
    const tb = (o.traceback ?? []).map(stripAnsi).join('\n')
    return <pre className="nb-error">{tb || `${o.ename}: ${o.evalue}`}</pre>
  }
  // A widget of a running Jupyter kernel is drawn live; saved without its kernel it falls back to its text.
  const widget = (o.data ?? {})[WIDGET_MIME]
  if (widget && widgetManager(session)) {
    try {
      const id = (typeof widget === 'string' ? JSON.parse(widget) : widget).model_id
      if (typeof id === 'string') return <WidgetOutput session={session} modelId={id} />
    } catch {
      // not a widget description: show what else there is
    }
  }
  const best = bestMime((o.data ?? {}) as Record<string, string | string[]>)
  if (!best) return null
  if (best.mime === 'image/png' || best.mime === 'image/jpeg') return <img className="nb-img" alt="Output" src={`data:${best.mime};base64,${best.value.replace(/\s/g, '')}`} />
  if (best.mime === 'image/svg+xml') return <img className="nb-img" alt="Output" src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(best.value)))}`} />
  if (best.mime === 'text/html') return <HtmlOutput html={best.value} />
  if (best.mime === 'text/markdown') return <div className="nb-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(best.value) }} />
  return <pre className="nb-stream">{best.value}</pre>
}

// ---- A cell's editor: a Monaco editor that grows with its text, created when the cell comes into view ----

function CellEditor({
  value,
  language,
  autoFocus,
  onChange,
  onRun,
  onEscape,
  onFocus
}: {
  value: string
  language: string
  autoFocus: boolean
  onChange: (v: string) => void
  onRun: (advance: boolean) => void
  onEscape: () => void
  onFocus: () => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const settings = useSettings()
  const [visible, setVisible] = useState(false)
  const cb = useRef({ onChange, onRun, onEscape, onFocus })
  cb.current = { onChange, onRun, onEscape, onFocus }

  useEffect(() => {
    const el = host.current
    if (!el) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !host.current) return
    const ed = monaco.editor.create(host.current, {
      ...editorOptions(),
      value,
      language,
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: 'off',
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 4,
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      renderLineHighlight: 'none',
      scrollbar: { vertical: 'hidden', horizontal: 'auto', alwaysConsumeMouseWheel: false },
      padding: { top: 6, bottom: 6 },
      wordWrap: 'on'
    })
    edRef.current = ed
    const fit = (): void => {
      const h = Math.max(32, ed.getContentHeight())
      if (host.current) host.current.style.height = h + 'px'
      ed.layout()
    }
    fit()
    const subs = [
      ed.onDidContentSizeChange(fit),
      ed.onDidChangeModelContent(() => cb.current.onChange(ed.getValue())),
      ed.onDidFocusEditorText(() => cb.current.onFocus())
    ]
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => cb.current.onRun(true))
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => cb.current.onRun(false))
    ed.addCommand(monaco.KeyCode.Escape, () => cb.current.onEscape(), '!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible')
    if (autoFocus) ed.focus()
    return () => {
      subs.forEach((s) => s.dispose())
      const m = ed.getModel()
      ed.dispose() // the editor first: Monaco throws if a model is disposed while an editor still shows it
      m?.dispose()
      edRef.current = null
    }
    // Created once; later changes to the text come from the editor itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  useEffect(() => {
    edRef.current?.updateOptions(editorOptions(settings))
  }, [settings])

  // Text changed from outside (undo of a cell operation, the file reloaded): show it.
  useEffect(() => {
    const ed = edRef.current
    if (ed && ed.getValue() !== value) ed.setValue(value)
  }, [value])

  useEffect(() => {
    if (autoFocus) edRef.current?.focus()
  }, [autoFocus])

  return (
    <div ref={host} className="nb-editor" data-nb-editor>
      {!visible && <pre className="nb-preview">{value}</pre>}
    </div>
  )
}

// ---- The notebook ----

export function NotebookView({
  path,
  model,
  onOpenAsText
}: {
  path: string
  model: monaco.editor.ITextModel
  onOpenAsText: () => void
}): JSX.Element {
  const [nb, setNb] = useState<Notebook | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nbRef = useRef<Notebook | null>(null)
  const [kernels, setKernels] = useState<KernelInfo[]>([])
  const kernelsRef = useRef<KernelInfo[]>([])
  const [kernelId, setKernelId] = useState<KernelInfo['id']>('python')
  const [kernelStatus, setKernelStatus] = useState<'idle' | 'starting' | 'ready' | 'busy' | 'stopped'>('idle')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null) // the cell whose editor has the keyboard (markdown cells show text only otherwise)
  const [mdEdit, setMdEdit] = useState<Set<string>>(new Set())
  const [note, setNote] = useState<string | null>(null)
  const session = useRef<number | null>(null)
  const counter = useRef(0)
  const selfEdit = useRef(false)
  const pending = useRef<Set<string>>(new Set()) // cells sent to the kernel and not finished
  const lastD = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)

  nbRef.current = nb

  // ---- reading and writing the file's text ----
  const load = useCallback(
    (text: string): void => {
      const r = parseNotebook(text)
      if ('error' in r) {
        setError(r.error)
        setNb(null)
        return
      }
      setError(null)
      setNb(r.nb)
      counter.current = Math.max(counter.current, ...r.nb.cells.map((c) => c.execution_count ?? 0))
      setSelected((cur) => (cur && r.nb.cells.some((c) => c.id === cur) ? cur : (r.nb.cells[0]?.id ?? null)))
      setKernelId(kernelFor(r.nb, kernelsRef.current))
    },
    []
  )
  useEffect(() => {
    load(model.getValue())
    const sub = model.onDidChangeContent(() => {
      if (selfEdit.current) return
      load(model.getValue()) // changed on disk, or by Undo in the text view
    })
    return () => sub.dispose()
  }, [model, load])

  // Writes the notebook into the file's text (which marks the tab as modified; Ctrl+S saves).
  const writeNow = useCallback((): void => {
    clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    if (model.isDisposed() || !nbRef.current) return
    const text = serializeNotebook(nbRef.current)
    if (text === model.getValue()) return
    selfEdit.current = true
    try {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
    } finally {
      selfEdit.current = false
    }
  }, [model])
  const commit = useCallback(
    (next: Notebook, immediately = true): void => {
      nbRef.current = next
      setNb(next)
      clearTimeout(saveTimer.current)
      if (immediately) writeNow()
      else saveTimer.current = setTimeout(writeNow, 200)
    },
    [writeNow]
  )
  // Ctrl+S must save what is on screen, including output that arrived a moment ago and is still waiting to be written.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && saveTimer.current !== undefined) writeNow()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [writeNow])
  useEffect(() => () => { if (saveTimer.current !== undefined) writeNow() }, [writeNow]) // switching away must not lose what was about to be written

  // ---- kernels ----
  useEffect(() => {
    initWidgets()
    void window.api.nbKernels().then((list) => {
      kernelsRef.current = list
      setKernels(list)
      const cur = nbRef.current
      if (cur && session.current === null) setKernelId(kernelFor(cur, list)) // the notebook was open before the list arrived
    })
  }, [])

  const stopKernel = useCallback((): void => {
    const s = session.current
    session.current = null
    if (s !== null) void window.api.nbStop(s)
  }, [])
  useEffect(() => stopKernel, [stopKernel])

  const [askInput, setAskInput] = useState<(InputRequest & { onCancel?: () => void }) | null>(null)

  const ensureKernel = useCallback(async (): Promise<number | null> => {
    if (session.current !== null) return session.current
    setKernelStatus('starting')
    const r = await window.api.nbStart(kernelId, dirName(path))
    if (!r.ok) {
      setKernelStatus('stopped')
      setNote(r.error)
      return null
    }
    session.current = r.session
    setKernelStatus('ready')
    setNote(null)
    return r.session
  }, [kernelId, path])

  // What the kernel says, by cell.
  useEffect(() => {
    const offEvent = window.api.onNbEvent((sid, cellId, ev) => {
      if (sid !== session.current) return
      if (!cellId) {
        if (ev.type === 'stream' && ev.name === 'stderr') setNote((n) => ((n ?? '') + ev.text).slice(-1500))
        return
      }
      const cur = nbRef.current
      if (!cur) return
      const cell = cur.cells.find((c) => c.id === cellId)
      if (!cell) return
      let outputs = cell.outputs
      if (ev.type === 'input_request') {
        const answer = (v: string | null): void => void window.api.nbInput(sid, v)
        let answered = false
        setAskInput({
          title: ev.prompt || 'The code is asking for input',
          confirmLabel: 'Send',
          onSubmit: (v) => {
            answered = true
            commit(updateCell(nbRef.current!, cellId, { outputs: appendStream(nbRef.current!.cells.find((c) => c.id === cellId)?.outputs ?? [], 'stdout', `${ev.prompt}${v}
`) }), false)
            answer(v)
          },
          onCancel: () => {
            if (!answered) answer(null)
          }
        })
        return
      }
      if (ev.type === 'stream') outputs = appendStream(outputs, ev.name, ev.text)
      else if (ev.type === 'result') outputs = [...outputs, { output_type: 'execute_result', data: ev.data, metadata: {}, execution_count: cell.execution_count }]
      else if (ev.type === 'display') outputs = [...outputs, { output_type: 'display_data', data: ev.data, metadata: {} }]
      else if (ev.type === 'error') outputs = [...outputs, { output_type: 'error', ename: ev.ename, evalue: ev.evalue, traceback: ev.traceback }]
      else if (ev.type === 'done') {
        pending.current.delete(cellId)
        setKernelStatus(pending.current.size ? 'busy' : 'ready')
        if (!ev.ok) announce(`Cell failed`, 'assertive')
        else if (pending.current.size === 0) announce('Finished running')
      }
      if (ev.type !== 'done') commit(updateCell(cur, cellId, { outputs }), false)
      else commit(cur, false)
    })
    const offExit = window.api.onNbExited((sid, code, err) => {
      forgetWidgets(sid)
      if (sid !== session.current) return
      session.current = null
      const hadWork = pending.current.size > 0
      pending.current.clear()
      setKernelStatus('stopped')
      setNote(hadWork ? 'The kernel stopped, so the running cells were interrupted. Run a cell to start it again (variables are lost).' : err && code ? `The kernel stopped (code ${code}).\n${err.slice(-600)}` : 'The kernel is stopped. Run a cell to start it again.')
      // Cells that were still waiting get a note instead of waiting forever.
      const cur = nbRef.current
      if (cur && hadWork) commit(cur, false)
    })
    return () => {
      offEvent()
      offExit()
    }
  }, [commit])

  const runCells = useCallback(
    async (ids: string[]): Promise<void> => {
      const cur = nbRef.current
      if (!cur || ids.length === 0) return
      const codeIds = ids.filter((id) => cur.cells.find((c) => c.id === id)?.cell_type === 'code')
      if (codeIds.length === 0) return
      const s = await ensureKernel()
      if (s === null) return
      let next = nbRef.current!
      const jobs: { id: string; code: string }[] = []
      for (const id of codeIds) {
        const cell = next.cells.find((c) => c.id === id)
        if (!cell) continue
        counter.current += 1
        next = updateCell(next, id, { outputs: [], execution_count: counter.current })
        jobs.push({ id, code: cell.source })
      }
      commit(next)
      setKernelStatus('busy')
      for (const j of jobs) {
        pending.current.add(j.id)
        void window.api.nbExecute(s, j.id, j.code)
      }
    },
    [commit, ensureKernel]
  )

  const restartKernel = (): void => {
    // A Jupyter kernel running a cell is interrupted and keeps its variables; otherwise the kernel is stopped.
    if (kernelId.startsWith('jupyter:') && session.current !== null && pending.current.size > 0) {
      void window.api.nbInterrupt(session.current)
      announce('Interrupting')
      return
    }
    stopKernel()
    pending.current.clear()
    setKernelStatus('stopped')
    setNote('The kernel was stopped. Run a cell to start a new one.')
  }

  const changeKernel = (id: KernelInfo['id']): void => {
    stopKernel()
    setKernelId(id)
    const cur = nbRef.current
    if (cur) {
      const picked = kernelsRef.current.find((k) => k.id === id)?.kernelspec
      const spec = picked ?? (id === 'python' ? { display_name: 'Python 3', language: 'python', name: 'python3' } : { display_name: 'JavaScript (Node)', language: 'javascript', name: 'javascript' })
      commit({ ...cur, metadata: { ...cur.metadata, kernelspec: spec, language_info: { name: spec.language } } })
    }
    setKernelStatus('stopped')
    setNote(null)
  }

  // ---- cell operations ----
  const add = (type: 'code' | 'markdown', at: 'above' | 'below' | 'end', id?: string): void => {
    const cur = nbRef.current
    if (!cur) return
    const i = id ? cur.cells.findIndex((c) => c.id === id) : cur.cells.length
    const index = at === 'above' ? i : at === 'below' ? i + 1 : cur.cells.length
    const cell = newCell(type)
    commit(insertCell(cur, index, cell))
    setSelected(cell.id)
    setEditing(cell.id)
    if (type === 'markdown') setMdEdit((s) => new Set(s).add(cell.id))
    announce(`Added a ${type} cell`)
  }
  const remove = (id: string): void => {
    const cur = nbRef.current
    if (!cur) return
    const i = cur.cells.findIndex((c) => c.id === id)
    const next = deleteCell(cur, id)
    commit(next)
    setSelected(next.cells[Math.min(i, next.cells.length - 1)]?.id ?? null)
    setEditing(null)
    announce('Cell deleted')
  }
  const select = (id: string): void => {
    setSelected(id)
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-nb-cell="${id}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  const runAndAdvance = (id: string, advance: boolean): void => {
    const cur = nbRef.current
    if (!cur) return
    const cell = cur.cells.find((c) => c.id === id)
    if (!cell) return
    if (cell.cell_type === 'markdown') setMdEdit((s) => (s.delete(id), new Set(s)))
    else void runCells([id])
    if (advance) {
      const i = cur.cells.findIndex((c) => c.id === id)
      const next = cur.cells[i + 1]
      if (next) {
        select(next.id)
        setEditing(null)
        requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-nb-cell="${next.id}"]`)?.focus())
      } else {
        add('code', 'end')
      }
    }
  }

  // Command mode: the cell itself has focus (Esc from its editor).
  const onCellKey = (e: React.KeyboardEvent, c: NbCell): void => {
    if ((e.target as HTMLElement).closest('.nb-editor')) return
    const cur = nbRef.current
    if (!cur) return
    const i = cur.cells.findIndex((x) => x.id === c.id)
    const focusCell = (id: string): void => {
      select(id)
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-nb-cell="${id}"]`)?.focus())
    }
    if (e.shiftKey && e.key === 'Enter') (e.preventDefault(), runAndAdvance(c.id, true))
    else if (e.ctrlKey && e.key === 'Enter') (e.preventDefault(), runAndAdvance(c.id, false))
    else if (e.key === 'Enter') {
      e.preventDefault()
      setEditing(c.id)
      if (c.cell_type === 'markdown') setMdEdit((s) => new Set(s).add(c.id))
    } else if (e.key === 'ArrowDown' || e.key === 'j') (e.preventDefault(), cur.cells[i + 1] && focusCell(cur.cells[i + 1].id))
    else if (e.key === 'ArrowUp' || e.key === 'k') (e.preventDefault(), cur.cells[i - 1] && focusCell(cur.cells[i - 1].id))
    else if (e.key === 'a') (e.preventDefault(), add('code', 'above', c.id))
    else if (e.key === 'b') (e.preventDefault(), add('code', 'below', c.id))
    else if (e.key === 'm') (e.preventDefault(), commit(setCellType(cur, c.id, 'markdown')))
    else if (e.key === 'y') (e.preventDefault(), commit(setCellType(cur, c.id, 'code')))
    else if (e.key === 'd') {
      e.preventDefault()
      const now = Date.now()
      if (now - lastD.current < 600) (remove(c.id), (lastD.current = 0))
      else lastD.current = now
    } else if (e.key === 'Delete') (e.preventDefault(), remove(c.id))
  }

  const lang = nb ? kernelLanguage(nb) : 'python'
  const editorLanguage = kernelId === 'javascript' ? 'javascript' : kernelId === 'python' ? 'python' : (kernels.find((k) => k.id === kernelId)?.kernelspec?.language || 'python')
  const statusText = kernelStatus === 'busy' ? 'Running…' : kernelStatus === 'starting' ? 'Starting the kernel…' : kernelStatus === 'ready' ? 'Kernel ready' : kernelStatus === 'stopped' ? 'Kernel stopped' : 'Kernel not started'
  void lang
  const cells = useMemo(() => nb?.cells ?? [], [nb])

  if (error) {
    return (
      <div className="notebook" data-notebook ref={rootRef}>
        <div className="nb-toolbar">
          <span className="diff-title">{baseName(path)}</span>
          <button onClick={onOpenAsText}>Open as text</button>
        </div>
        <div className="chat-error" data-nb-error>
          {error}
        </div>
      </div>
    )
  }
  if (!nb) return <div className="notebook" data-notebook />

  return (
    <div className="notebook" data-notebook ref={rootRef} role="region" aria-label={`Notebook ${baseName(path)}`}>
      {askInput && (
        <InputDialog
          request={askInput}
          onClose={() => {
            // Submitting closes the dialog first and then sends the answer, so judge "cancelled" after that.
            const cancel = askInput.onCancel
            setTimeout(() => cancel?.(), 0)
            setAskInput(null)
          }}
        />
      )}
      <div className="nb-toolbar">
        <span className="diff-title">{baseName(path)}</span>
        <button data-nb-action="run-all" onClick={() => void runCells(nb.cells.map((c) => c.id))} title="Run every code cell, top to bottom">
          ▶▶ Run All
        </button>
        <button data-nb-action="run" onClick={() => selected && runAndAdvance(selected, false)} disabled={!selected} title="Run the selected cell (Ctrl+Enter)">
          ▶ Run
        </button>
        <button data-nb-action="stop" onClick={restartKernel} title="Stop the running cell of a Jupyter kernel (it keeps its variables), or stop the kernel (on Windows this also forgets the variables)">
          ■ Stop
        </button>
        <button data-nb-action="add-code" onClick={() => add('code', selected ? 'below' : 'end', selected ?? undefined)}>
          + Code
        </button>
        <button data-nb-action="add-markdown" onClick={() => add('markdown', selected ? 'below' : 'end', selected ?? undefined)}>
          + Text
        </button>
        <button data-nb-action="clear" onClick={() => commit(clearOutputs(nb))}>
          Clear Outputs
        </button>
        <span className="nb-spacer" />
        <select data-nb-kernel value={kernelId} onChange={(e) => changeKernel(e.target.value)} aria-label="Kernel">
          {(kernels.length ? kernels : [{ id: 'python', label: 'Python 3' }, { id: 'javascript', label: 'JavaScript (Node)' }]).map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <span className="nb-status" data-nb-status={kernelStatus} aria-live="off">
          {statusText}
        </span>
        <button onClick={onOpenAsText} title="Show the notebook's JSON">
          {'{ }'}
        </button>
      </div>
      {note && (
        <div className="nb-note" data-nb-note role="status">
          {note}
          <button className="dbg-x" onClick={() => setNote(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <div className="nb-cells" role="list">
        {cells.length === 0 && (
          <div className="empty">
            This notebook is empty.{' '}
            <button className="primary" onClick={() => add('code', 'end')}>
              Add a code cell
            </button>
          </div>
        )}
        {cells.map((c, idx) => {
          const running = pending.current.has(c.id)
          const isMd = c.cell_type === 'markdown'
          const showEditor = !isMd || mdEdit.has(c.id)
          return (
            <div
              key={c.id}
              role="listitem"
              tabIndex={selected === c.id ? 0 : -1}
              className={'nb-cell' + (selected === c.id ? ' sel' : '') + (running ? ' running' : '')}
              data-nb-cell={c.id}
              data-nb-type={c.cell_type}
              aria-label={`${c.cell_type} cell ${idx + 1}`}
              onFocus={() => setSelected(c.id)}
              onClick={() => setSelected(c.id)}
              onKeyDown={(e) => onCellKey(e, c)}
            >
              <div className="nb-gutter">
                {c.cell_type === 'code' ? (
                  <>
                    <button className="nb-run" data-nb-run title="Run this cell (Shift+Enter)" aria-label="Run cell" onClick={() => runAndAdvance(c.id, false)}>
                      {running ? '…' : '▶'}
                    </button>
                    <span className="nb-count" data-nb-count>
                      {running ? '[*]' : `[${c.execution_count ?? ' '}]`}
                    </span>
                  </>
                ) : (
                  <span className="nb-count">{isMd ? 'Text' : 'Raw'}</span>
                )}
              </div>
              <div className="nb-body">
                {showEditor ? (
                  <CellEditor
                    value={c.source}
                    language={isMd ? 'markdown' : c.cell_type === 'raw' ? 'plaintext' : editorLanguage}
                    autoFocus={editing === c.id}
                    onChange={(v) => {
                      const cur = nbRef.current
                      if (cur) commit(updateCell(cur, c.id, { source: v }), false)
                    }}
                    onRun={(advance) => runAndAdvance(c.id, advance)}
                    onEscape={() => {
                      setEditing(null)
                      rootRef.current?.querySelector<HTMLElement>(`[data-nb-cell="${c.id}"]`)?.focus()
                    }}
                    onFocus={() => {
                      setSelected(c.id)
                      setEditing(c.id)
                    }}
                  />
                ) : (
                  <div
                    className="nb-md"
                    data-nb-md
                    onDoubleClick={() => (setMdEdit((s) => new Set(s).add(c.id)), setEditing(c.id))}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(c.source) || '<p class="nb-empty">Empty text cell. Double-click to edit.</p>' }}
                  />
                )}
                {c.cell_type === 'code' && c.outputs.length > 0 && (
                  <div className="nb-outputs" data-nb-outputs role="region" aria-label={`Output of cell ${idx + 1}`}>
                    {c.outputs.map((o, i) => (
                      <OutputView key={i} o={o} session={session.current} />
                    ))}
                  </div>
                )}
              </div>
              <div className="nb-tools" role="toolbar" aria-label="Cell actions">
                <button title="Move up" aria-label="Move cell up" disabled={idx === 0} onClick={() => commit(moveCell(nb, c.id, -1))}>
                  ↑
                </button>
                <button title="Move down" aria-label="Move cell down" disabled={idx === cells.length - 1} onClick={() => commit(moveCell(nb, c.id, 1))}>
                  ↓
                </button>
                <button title="Add a code cell below" aria-label="Add a code cell below" onClick={() => add('code', 'below', c.id)}>
                  +
                </button>
                <button
                  title={isMd ? 'Change to code' : 'Change to text'}
                  aria-label={isMd ? 'Change to code' : 'Change to text'}
                  data-nb-toggle-type
                  onClick={() => commit(setCellType(nb, c.id, isMd ? 'code' : 'markdown'))}
                >
                  {isMd ? '</>' : 'Aa'}
                </button>
                <button title="Join with the next cell" aria-label="Join with the next cell" disabled={idx === cells.length - 1} onClick={() => commit(mergeWithNext(nb, c.id))}>
                  ⤵
                </button>
                <button title="Delete this cell" aria-label="Delete cell" data-nb-delete onClick={() => remove(c.id)}>
                  ×
                </button>
              </div>
            </div>
          )
        })}
        {cells.length > 0 && (
          <div className="nb-add-end">
            <button onClick={() => add('code', 'end')}>+ Code</button>
            <button onClick={() => add('markdown', 'end')}>+ Text</button>
          </div>
        )}
      </div>
    </div>
  )
}
