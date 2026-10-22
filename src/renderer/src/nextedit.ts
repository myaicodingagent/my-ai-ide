import { monaco } from './monaco-setup'

// "Next edit" suggestions (like Cursor's Tab): after you change something, Claude Haiku looks at what you just did and
// proposes the edit you are likely to make next, often somewhere else in the file (the same rename on the next line,
// a call site that needs the new argument...). A box under the target lines shows the replacement.
// Tab jumps there, Tab again applies it; Esc dismisses it. Typing anything clears it.

const IDLE_MS = 900
const WINDOW_LINES = 60 // lines shown to the model on each side of the cursor
const MAX_EDITS = 4
const MAX_SPAN = 30 // longest replacement, in lines
let nextId = 3_000_000 // separate id range from chat, inline edit and autocomplete

const SYSTEM =
  'You predict the next edit a programmer will make in a code editor. You are given a file with numbered lines, the caret position, ' +
  'and the programmer\'s most recent edits (oldest first). Predict the single most likely NEXT edit that continues what they are doing: ' +
  'the same change applied to a similar line, a call site or usage that must follow a rename or signature change, a missing piece they have just started. ' +
  'Reply with ONLY a JSON object {"startLine": number, "endLine": number, "newText": string}: lines startLine..endLine (inclusive, numbers as shown) ' +
  'are replaced by newText (no line numbers in it, no trailing newline). Keep it small, at most 12 lines. ' +
  'Do not repeat an edit that was already made and do not propose a change to code that is already correct. ' +
  'If there is no clear next edit, reply with {}. No explanation, no markdown fences.'

interface Edit {
  line: number
  before: string
  after: string
}

export interface Suggestion {
  startLine: number
  endLine: number
  newText: string
}

const clip = (s: string, n = 160): string => (s.length > n ? s.slice(0, n) + '…' : s)

export function parseSuggestion(raw: string, model: monaco.editor.ITextModel): Suggestion | null {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  let o: Partial<Suggestion>
  try {
    o = JSON.parse(m[0])
  } catch {
    return null
  }
  const n = model.getLineCount()
  if (!Number.isInteger(o.startLine) || !Number.isInteger(o.endLine) || typeof o.newText !== 'string') return null
  const startLine = o.startLine as number
  const endLine = o.endLine as number
  if (startLine < 1 || endLine < startLine || endLine > n || endLine - startLine >= MAX_SPAN) return null
  const newText = o.newText.replace(/\r\n/g, '\n').replace(/\n$/, '')
  const current = model.getValueInRange(new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine))).replace(/\r\n/g, '\n')
  if (newText === current) return null // nothing would change
  return { startLine, endLine, newText }
}

export function attachNextEdit(ed: monaco.editor.IStandaloneCodeEditor, isEnabled: () => boolean): monaco.IDisposable {
  const visible = ed.createContextKey<boolean>('myaiideNextEditVisible', false)
  const decorations = ed.createDecorationsCollection()
  let zoneId: string | null = null
  let suggestion: Suggestion | null = null
  let armed = false // the caret has been taken to the suggestion; the next Tab applies it
  let timer: ReturnType<typeof setTimeout> | undefined
  let requestId = 0
  let applying = false
  const edits: Edit[] = []
  let prevText = ''

  const clear = (): void => {
    suggestion = null
    armed = false
    visible.set(false)
    decorations.clear()
    if (zoneId !== null) {
      const id = zoneId
      zoneId = null
      ed.changeViewZones((acc) => acc.removeZone(id))
    }
    if (requestId) {
      window.api.aiAbort(requestId)
      requestId = 0
    }
  }

  const show = (s: Suggestion): void => {
    clear()
    suggestion = s
    visible.set(true)
    decorations.set([{ range: new monaco.Range(s.startLine, 1, s.endLine, 1), options: { isWholeLine: true, className: 'next-edit-target' } }])
    const dom = document.createElement('div')
    dom.className = 'next-edit-zone'
    dom.setAttribute('data-next-edit', '')
    const label = document.createElement('div')
    label.className = 'next-edit-label'
    label.textContent = `Next edit (lines ${s.startLine}${s.endLine > s.startLine ? '-' + s.endLine : ''}) · Tab to jump, Tab again to apply · Esc to dismiss`
    const code = document.createElement('pre')
    code.className = 'next-edit-code'
    code.textContent = s.newText
    dom.append(label, code)
    ed.changeViewZones((acc) => {
      zoneId = acc.addZone({ afterLineNumber: s.endLine, heightInLines: 1 + Math.max(1, s.newText.split('\n').length), domNode: dom, suppressMouseDown: true })
    })
  }

  const apply = (): void => {
    const model = ed.getModel()
    const s = suggestion
    if (!model || !s) return
    applying = true
    try {
      const range = new monaco.Range(s.startLine, 1, s.endLine, model.getLineMaxColumn(s.endLine))
      ed.executeEdits('next-edit', [{ range, text: s.newText, forceMoveMarkers: true }])
      const lines = s.newText.split('\n')
      const endLine = s.startLine + lines.length - 1
      ed.setPosition({ lineNumber: endLine, column: lines[lines.length - 1].length + 1 })
      ed.revealLineInCenterIfOutsideViewport(endLine)
    } finally {
      applying = false
    }
    clear()
    edits.length = 0 // the programmer has just taken the suggestion; start fresh
    prevText = model.getValue()
  }

  const accept = (): void => {
    const s = suggestion
    const pos = ed.getPosition()
    if (!s || !pos) return
    const inside = pos.lineNumber >= s.startLine && pos.lineNumber <= s.endLine
    if (inside || armed) return apply()
    // First Tab: take the caret to the suggestion so the programmer sees where it applies.
    armed = true
    ed.setPosition({ lineNumber: s.startLine, column: 1 })
    ed.revealLineInCenter(s.startLine)
  }

  const request = async (): Promise<void> => {
    const model = ed.getModel()
    const pos = ed.getPosition()
    if (!model || !pos || !isEnabled() || edits.length === 0 || !ed.hasTextFocus()) return
    if (model.uri.scheme !== 'file' || model.getValueLength() > 120_000) return
    const first = Math.max(1, pos.lineNumber - WINDOW_LINES)
    const last = Math.min(model.getLineCount(), pos.lineNumber + WINDOW_LINES)
    const numbered: string[] = []
    for (let i = first; i <= last; i++) numbered.push(`${i}| ${model.getLineContent(i)}`)
    const history = edits.map((e) => `line ${e.line}: ${JSON.stringify(clip(e.before))} -> ${JSON.stringify(clip(e.after))}`).join('\n')
    const id = ++nextId
    requestId = id
    const version = model.getVersionId()
    const raw = await window.api.aiComplete({
      requestId: id,
      system: SYSTEM,
      prompt:
        `File: ${model.uri.path.split('/').pop()} (${model.getLanguageId()})\nCaret: line ${pos.lineNumber}, column ${pos.column}\n\n` +
        `Recent edits:\n${history}\n\nFile (lines ${first}-${last} of ${model.getLineCount()}):\n${numbered.join('\n')}`,
      maxTokens: 700
    })
    if (requestId !== id) return
    requestId = 0
    // The programmer kept typing while we waited: the answer is about a file that no longer exists.
    if (!raw || model.isDisposed() || model.getVersionId() !== version || ed.getModel() !== model) return
    const s = parseSuggestion(raw, model)
    if (s) show(s)
  }

  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => void request(), IDLE_MS)
  }

  prevText = ed.getModel()?.getValue() ?? ''
  const subs: monaco.IDisposable[] = []
  subs.push(
    ed.onDidChangeModel(() => {
      clear()
      edits.length = 0
      clearTimeout(timer)
      prevText = ed.getModel()?.getValue() ?? ''
    }),
    ed.onDidChangeModelContent((e) => {
      const model = ed.getModel()
      if (!model) return
      const old = prevText
      prevText = model.getValue()
      if (applying) return
      clear()
      if (e.isFlush || e.isUndoing || e.isRedoing) {
        edits.length = 0
        return
      }
      if (!ed.hasTextFocus() || e.changes.length > 3) return
      for (const c of e.changes) {
        const line = c.range.startLineNumber
        // Consecutive keystrokes on the same line are one edit: the line as it was, and as it is now.
        const last = edits[edits.length - 1]
        if (last && last.line === line) {
          last.after = model.getLineContent(line)
          continue
        }
        const from = old.lastIndexOf('\n', c.rangeOffset - 1) + 1
        const to = old.indexOf('\n', c.rangeOffset + c.rangeLength)
        edits.push({ line, before: old.slice(from, to < 0 ? undefined : to).replace(/\r$/, ''), after: model.getLineContent(line) })
        if (edits.length > MAX_EDITS) edits.shift()
      }
      schedule()
    }),
    // Moving the caret away from the line being edited (other than by our own jump) drops the suggestion.
    ed.onDidChangeCursorSelection((e) => {
      if (suggestion && !armed && e.source === 'mouse') clear()
    }),
    ed.onDidBlurEditorText(() => clearTimeout(timer))
  )
  ed.addCommand(
    monaco.KeyCode.Tab,
    () => accept(),
    'myaiideNextEditVisible && !suggestWidgetVisible && !inlineSuggestionVisible && !editorHasSelection'
  )
  ed.addCommand(monaco.KeyCode.Escape, () => clear(), 'myaiideNextEditVisible && !suggestWidgetVisible && !findWidgetVisible')
  return {
    dispose: () => {
      clearTimeout(timer)
      clear()
      subs.forEach((s) => {
        try {
          s.dispose()
        } catch {
          // already gone
        }
      })
    }
  }
}
