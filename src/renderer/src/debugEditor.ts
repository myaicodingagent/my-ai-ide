import { monaco } from './monaco-setup'
import { breakpointsOf, getDebug, subscribeDebug, toggleBreakpoint } from './debugStore'
import { sharedStopLine, subscribeLiveShare } from './liveshare'

// Shows the debugger in an editor: a red dot in the margin for each breakpoint (click the margin, or F9, to toggle
// one) and an arrow plus a highlighted line where the program is stopped.

const samePath = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

export function attachDebugEditor(ed: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const collection = ed.createDecorationsCollection()
  const update = (): void => {
    const model = ed.getModel()
    if (!model || model.isDisposed() || model.uri.scheme !== 'file') return void collection.clear()
    const file = model.uri.fsPath
    const s = getDebug()
    const decos: monaco.editor.IModelDeltaDecoration[] = []
    const lines = model.getLineCount()
    for (const bp of breakpointsOf(file, s)) {
      if (bp.line > lines) continue
      decos.push({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          glyphMarginClassName: bp.condition ? 'debug-bp debug-bp-cond' : 'debug-bp',
          glyphMarginHoverMessage: { value: bp.condition ? `Breakpoint (stops when ${bp.condition})` : 'Breakpoint' },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        }
      })
    }
    const f = s.status === 'paused' ? s.frames[s.frame] : undefined
    if (f?.file && samePath(f.file, file) && f.line <= lines) {
      decos.push({
        range: new monaco.Range(f.line, 1, f.line, 1),
        options: { isWholeLine: true, className: 'debug-current-line', glyphMarginClassName: 'debug-arrow' }
      })
    }
    // In a Live Share session the guest sees where the host's program is stopped in the shared files.
    const shared = sharedStopLine(file)
    if (shared !== null && shared <= lines) {
      decos.push({ range: new monaco.Range(shared, 1, shared, 1), options: { isWholeLine: true, className: 'debug-current-line', glyphMarginClassName: 'debug-arrow' } })
    }
    collection.set(decos)
  }
  const subs = [
    subscribeDebug(update),
    subscribeLiveShare(update),
    ed.onDidChangeModel(update),
    ed.onMouseDown((e) => {
      const model = ed.getModel()
      if (!model || model.uri.scheme !== 'file') return
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        toggleBreakpoint(model.uri.fsPath, e.target.position.lineNumber)
      }
    })
  ]
  update()
  return {
    dispose: () => {
      for (const s of subs) typeof s === 'function' ? s() : s.dispose()
      collection.clear()
    }
  }
}

/** F9: toggles a breakpoint on the line the caret is on. */
export function toggleBreakpointAtCaret(ed: monaco.editor.IStandaloneCodeEditor | null): void {
  const model = ed?.getModel()
  const pos = ed?.getPosition()
  if (model && pos && model.uri.scheme === 'file') toggleBreakpoint(model.uri.fsPath, pos.lineNumber)
}
