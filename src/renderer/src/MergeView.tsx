import { useEffect, useMemo, useRef, useState } from 'react'
import { monaco } from './monaco-setup'
import { attachConflictDecorations, findConflicts } from './conflicts'
import { conflictSpans, parseMerge, resolveText } from './mergeParse'
import { editorOptions, useSettings } from './settings'

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

let nextView = 1

// A three-way merge editor, like VS Code's: the two versions being merged on top (read-only, with the conflicting
// lines marked) and the result underneath, which is where you work. The result starts as the file with its conflict
// markers; the links above each conflict (and the buttons below) take a side, or you edit the text by hand.
export function MergeView({
  path,
  text,
  onComplete,
  onClose
}: {
  path: string
  text: string // the file with its conflict markers
  onComplete: (resolved: string) => void
  onClose: () => void
}): JSX.Element {
  const settings = useSettings()
  const oursHost = useRef<HTMLDivElement>(null)
  const theirsHost = useRef<HTMLDivElement>(null)
  const resultHost = useRef<HTMLDivElement>(null)
  const resultEd = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const oursEd = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const theirsEd = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const original = useMemo(() => parseMerge(text), [text])
  const [left, setLeft] = useState(original.conflicts.length)
  const [current, setCurrent] = useState(0) // which of the unresolved conflicts is selected (0-based)
  const [note, setNote] = useState<string | null>(null)

  const labels = original.conflicts[0] ?? null

  useEffect(() => {
    const view = nextView++
    const uri = (side: string): monaco.Uri => monaco.Uri.from({ scheme: 'merge-' + side, path: `/${view}/${path.replace(/\\/g, '/')}` })
    const oursText = resolveText(text, 'ours')
    const theirsText = resolveText(text, 'theirs')
    const oursModel = monaco.editor.createModel(oursText, undefined, uri('ours'))
    const theirsModel = monaco.editor.createModel(theirsText, undefined, uri('theirs'))
    const resultModel = monaco.editor.createModel(text, undefined, uri('result'))
    const base = { ...editorOptions(), automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, glyphMargin: false }
    const ours = monaco.editor.create(oursHost.current!, { ...base, model: oursModel, readOnly: true })
    const theirs = monaco.editor.create(theirsHost.current!, { ...base, model: theirsModel, readOnly: true })
    const result = monaco.editor.create(resultHost.current!, { ...base, model: resultModel })
    oursEd.current = ours
    theirsEd.current = theirs
    resultEd.current = result

    // Mark the conflicting lines in the two versions.
    const mark = (ed: monaco.editor.IStandaloneCodeEditor, side: 'ours' | 'theirs'): void => {
      const spans = conflictSpans(text, side)
      ed.createDecorationsCollection(
        spans
          .filter((s) => s.count > 0)
          .map((s) => ({
            range: new monaco.Range(s.start + 1, 1, s.start + s.count, 1),
            options: { isWholeLine: true, className: side === 'ours' ? 'conflict-current' : 'conflict-incoming' }
          }))
      )
    }
    mark(ours, 'ours')
    mark(theirs, 'theirs')
    const decos = attachConflictDecorations(result)

    // The two versions scroll together.
    let syncing = false
    const link = (a: monaco.editor.IStandaloneCodeEditor, b: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable =>
      a.onDidScrollChange((e) => {
        if (syncing || !e.scrollTopChanged) return
        syncing = true
        b.setScrollTop(e.scrollTop)
        syncing = false
      })
    const links = [link(ours, theirs), link(theirs, ours)]

    const recount = (): void => setLeft(findConflicts(resultModel).length)
    const sub = result.onDidChangeModelContent(recount)

    // The cursor in the result tells which conflict is selected.
    const cursorSub = result.onDidChangeCursorPosition((e) => {
      const cs = findConflicts(resultModel)
      const i = cs.findIndex((c) => e.position.lineNumber >= c.start && e.position.lineNumber <= c.end)
      if (i >= 0) setCurrent(i)
    })

    return () => {
      sub.dispose()
      cursorSub.dispose()
      links.forEach((l) => l.dispose())
      decos.dispose()
      for (const e of [ours, theirs, result]) e.dispose()
      for (const m of [oursModel, theirsModel, resultModel]) m.dispose()
      oursEd.current = theirsEd.current = resultEd.current = null
    }
    // The editors are created once per file; the text it started from does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, text])

  useEffect(() => {
    for (const e of [oursEd.current, theirsEd.current, resultEd.current]) e?.updateOptions({ ...editorOptions(settings) })
  }, [settings])

  // Which conflict of the original file the n-th unresolved one is: the unresolved ones are what is left of them, in order.
  const originalIndexOf = (n: number): number => {
    const model = resultEd.current?.getModel()
    if (!model) return n
    const unresolved = findConflicts(model).map((c) => ({
      c,
      ours: model.getLinesContent().slice(c.start, (c.base ?? c.mid) - 1).join('\n')
    }))
    let from = 0
    const map: number[] = []
    for (const u of unresolved) {
      let found = -1
      for (let k = from; k < original.conflicts.length; k++) {
        if (original.conflicts[k].ours.join('\n') === u.ours) {
          found = k
          break
        }
      }
      map.push(found >= 0 ? found : from)
      from = (found >= 0 ? found : from) + 1
    }
    return map[n] ?? n
  }

  const go = (delta: number): void => {
    const model = resultEd.current?.getModel()
    if (!model || !resultEd.current) return
    const cs = findConflicts(model)
    if (cs.length === 0) return
    const n = (current + delta + cs.length) % cs.length
    setCurrent(n)
    const c = cs[n]
    resultEd.current.revealLineInCenter(c.start)
    resultEd.current.setPosition({ lineNumber: c.start, column: 1 })
    const k = originalIndexOf(n)
    const so = conflictSpans(text, 'ours')[k]
    const st = conflictSpans(text, 'theirs')[k]
    if (so) oursEd.current?.revealLineInCenter(so.start + 1)
    if (st) theirsEd.current?.revealLineInCenter(st.start + 1)
  }

  // Takes one side for the selected conflict, or for all of them.
  const accept = (side: 'ours' | 'theirs' | 'both', all: boolean): void => {
    const model = resultEd.current?.getModel()
    if (!model) return
    const cs = findConflicts(model)
    const target = all ? cs : cs[Math.min(current, cs.length - 1)] ? [cs[Math.min(current, cs.length - 1)]] : []
    // Last first, so earlier line numbers stay valid.
    for (const c of [...target].reverse()) {
      const lines = model.getLinesContent()
      // Lines are numbered from 1 in the conflict, the array is from 0.
      const ours = lines.slice(c.start, (c.base ?? c.mid) - 1)
      const theirs = lines.slice(c.mid, c.end - 1)
      const body = side === 'ours' ? ours : side === 'theirs' ? theirs : [...ours, ...theirs]
      const empty = body.length === 0
      const range = empty && c.end < model.getLineCount() ? new monaco.Range(c.start, 1, c.end + 1, 1) : new monaco.Range(c.start, 1, c.end, model.getLineMaxColumn(c.end))
      model.pushEditOperations([], [{ range, text: body.join(model.getEOL()) }], () => null)
    }
  }

  const complete = (): void => {
    const value = resultEd.current?.getModel()?.getValue() ?? ''
    const n = findConflicts(resultEd.current!.getModel()!).length
    if (n > 0 && !window.confirm(`${n} conflict${n > 1 ? 's are' : ' is'} still unresolved: the markers would be saved in the file. Save anyway?`)) return
    onComplete(value)
  }

  const reset = (): void => {
    resultEd.current?.getModel()?.setValue(text)
    setNote(null)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.quick-input-widget:not([style*="display: none"])')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="merge-view" data-merge-view role="dialog" aria-label={`Merge ${baseName(path)}`}>
      <div className="merge-bar">
        <span className="diff-title">Merge: {baseName(path)}</span>
        <span className="merge-count" data-merge-left aria-live="polite">
          {left === 0 ? 'All conflicts resolved' : `${left} conflict${left > 1 ? 's' : ''} left`}
        </span>
        <span className="merge-actions">
          <button data-merge-action="prev" onClick={() => go(-1)} disabled={left === 0} title="Previous conflict">↑</button>
          <button data-merge-action="next" onClick={() => go(1)} disabled={left === 0} title="Next conflict">↓</button>
          <button data-merge-action="ours" onClick={() => accept('ours', false)} disabled={left === 0}>Accept Current</button>
          <button data-merge-action="theirs" onClick={() => accept('theirs', false)} disabled={left === 0}>Accept Incoming</button>
          <button data-merge-action="both" onClick={() => accept('both', false)} disabled={left === 0}>Accept Both</button>
          <button data-merge-action="all-ours" onClick={() => accept('ours', true)} disabled={left === 0} title="Take the current side everywhere">All Current</button>
          <button data-merge-action="all-theirs" onClick={() => accept('theirs', true)} disabled={left === 0} title="Take the incoming side everywhere">All Incoming</button>
          <button data-merge-action="reset" onClick={reset}>Reset</button>
          <button className="primary" data-merge-action="complete" onClick={complete}>Complete Merge</button>
          <button data-merge-action="close" onClick={onClose}>Close</button>
        </span>
      </div>
      {note && <div className="chat-error">{note}</div>}
      <div className="merge-top">
        <div className="merge-pane">
          <div className="merge-label merge-label-ours">Current{labels?.oursLabel ? ` · ${labels.oursLabel}` : ''}</div>
          <div className="merge-editor" ref={oursHost} data-merge-pane="ours" />
        </div>
        <div className="merge-pane">
          <div className="merge-label merge-label-theirs">Incoming{labels?.theirsLabel ? ` · ${labels.theirsLabel}` : ''}</div>
          <div className="merge-editor" ref={theirsHost} data-merge-pane="theirs" />
        </div>
      </div>
      <div className="merge-bottom">
        <div className="merge-label">Result</div>
        <div className="merge-editor" ref={resultHost} data-merge-pane="result" />
      </div>
    </div>
  )
}
