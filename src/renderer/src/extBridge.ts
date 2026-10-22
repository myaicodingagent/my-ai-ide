import { monaco } from './monaco-setup'

// What extension code (running in its own process) can see and change in the editor: the open file, diagnostics,
// completion and hover providers. The extension host asks through the main process; App.tsx answers the requests that
// need the app's windows, and the rest is here.

const samePath = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
const modelFor = (path: string): monaco.editor.ITextModel | undefined => monaco.editor.getModels().find((m) => m.uri.scheme === 'file' && samePath(m.uri.fsPath, path))

// ---- the open file, pushed to the host ----

export interface EditorState {
  path: string
  language: string
  text: string
  selections: { anchor: { line: number; character: number }; active: { line: number; character: number } }[]
}

export function editorStateOf(ed: monaco.editor.ICodeEditor | null): EditorState | null {
  const model = ed?.getModel()
  if (!ed || !model || model.uri.scheme !== 'file' || model.getValueLength() > 2_000_000) return null
  const sels = ed.getSelections() ?? []
  return {
    path: model.uri.fsPath,
    language: model.getLanguageId(),
    text: model.getValue(),
    selections: sels.map((s) => ({
      anchor: { line: s.selectionStartLineNumber - 1, character: s.selectionStartColumn - 1 },
      active: { line: s.positionLineNumber - 1, character: s.positionColumn - 1 }
    }))
  }
}

/** Tells the extensions about the editor whenever the file, the selection or the text changes. */
export function attachExtEditorState(ed: monaco.editor.IStandaloneCodeEditor, isActive: () => boolean): monaco.IDisposable {
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = ''
  const push = (): void => {
    if (!isActive()) return
    const st = editorStateOf(ed)
    const key = st ? JSON.stringify(st) : ''
    if (key === last) return
    last = key
    void window.api.extEditorState(st)
  }
  const later = (): void => {
    clearTimeout(timer)
    timer = setTimeout(push, 200)
  }
  const subs = [ed.onDidChangeModel(later), ed.onDidChangeCursorSelection(later), ed.onDidChangeModelContent(later), ed.onDidFocusEditorText(push)]
  later()
  return {
    dispose: () => {
      clearTimeout(timer)
      subs.forEach((s) => s.dispose())
    }
  }
}

// ---- diagnostics ----

interface Diag {
  message: string
  severity: number
  source?: string
  code?: string | number
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}
const diagnostics = new Map<string, Map<string, Diag[]>>() // owner -> path -> diagnostics

const SEVERITY = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint]

function applyMarkers(model: monaco.editor.ITextModel): void {
  if (model.uri.scheme !== 'file') return
  for (const [owner, files] of diagnostics) {
    let list: Diag[] | undefined
    for (const [p, d] of files) if (samePath(p, model.uri.fsPath)) list = d
    monaco.editor.setModelMarkers(
      model,
      'ext:' + owner,
      (list ?? []).map((d) => ({
        severity: SEVERITY[d.severity] ?? monaco.MarkerSeverity.Error,
        message: d.message,
        source: d.source,
        code: d.code === undefined ? undefined : String(d.code),
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1
      }))
    )
  }
}

export function setExtDiagnostics(owner: string, path: string, items: Diag[]): void {
  let files = diagnostics.get(owner)
  if (!files) diagnostics.set(owner, (files = new Map()))
  if (items.length) files.set(path, items)
  else files.delete(path)
  const m = modelFor(path)
  if (m) applyMarkers(m)
}

let wired = false
function wireModels(): void {
  if (wired) return
  wired = true
  monaco.editor.onDidCreateModel(applyMarkers)
}

// ---- providers ----

const registered = new Map<string, monaco.IDisposable[]>()

export interface ProviderRequest {
  id: string
  kind: 'completion' | 'hover'
  languages: string[]
  triggerCharacters: string[]
}

export function registerExtProvider(req: ProviderRequest): void {
  wireModels()
  const langs = req.languages.includes('*') ? ['*'] : req.languages
  const disposables: monaco.IDisposable[] = []
  const rangeOf = (r: { start: { line: number; character: number }; end: { line: number; character: number } }): monaco.Range =>
    new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1)
  for (const language of langs) {
    if (req.kind === 'completion') {
      disposables.push(
        monaco.languages.registerCompletionItemProvider(language, {
          triggerCharacters: req.triggerCharacters,
          async provideCompletionItems(model, position, context) {
            if (model.uri.scheme !== 'file') return { suggestions: [] }
            const items = (await window.api.extProvide(req.id, 'completion', {
              path: model.uri.fsPath,
              language: model.getLanguageId(),
              text: model.getValue(),
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              triggerCharacter: context.triggerCharacter
            })) as
              | { label: string; kind: number; detail?: string; documentation?: string; insertText: string; isSnippet: boolean; filterText?: string; sortText?: string; range?: Parameters<typeof rangeOf>[0] }[]
              | null
            const word = model.getWordUntilPosition(position)
            const dflt = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
            return {
              suggestions: (items ?? []).map((it) => ({
                label: it.label,
                // Monaco's kinds are numbered like VS Code's, apart from a few; the common ones line up by name.
                kind: kindOf(it.kind),
                detail: it.detail,
                documentation: it.documentation ? { value: it.documentation } : undefined,
                insertText: it.insertText,
                insertTextRules: it.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                filterText: it.filterText,
                sortText: it.sortText,
                range: it.range ? rangeOf(it.range) : dflt
              }))
            }
          }
        })
      )
    } else {
      disposables.push(
        monaco.languages.registerHoverProvider(language, {
          async provideHover(model, position) {
            if (model.uri.scheme !== 'file') return null
            const h = (await window.api.extProvide(req.id, 'hover', {
              path: model.uri.fsPath,
              language: model.getLanguageId(),
              text: model.getValue(),
              position: { line: position.lineNumber - 1, character: position.column - 1 }
            })) as { contents: string[]; range?: Parameters<typeof rangeOf>[0] } | null
            return h ? { contents: h.contents.map((value) => ({ value })), range: h.range ? rangeOf(h.range) : undefined } : null
          }
        })
      )
    }
  }
  registered.set(req.id, disposables)
}

export function unregisterExtProvider(id: string): void {
  registered.get(id)?.forEach((d) => d.dispose())
  registered.delete(id)
}

/** Forgets everything extensions added (the host restarted, so they will add it again). */
export function clearExtProviders(): void {
  for (const id of [...registered.keys()]) unregisterExtProvider(id)
  for (const [owner, files] of diagnostics) {
    for (const p of files.keys()) {
      const m = modelFor(p)
      if (m) monaco.editor.setModelMarkers(m, 'ext:' + owner, [])
    }
  }
  diagnostics.clear()
}

// VS Code's CompletionItemKind numbers (0-based) to Monaco's names.
function kindOf(k: number): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind
  const map = [K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter]
  return map[k] ?? K.Text
}

// ---- edits ----

export interface ExtEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  text: string
}

/** Applies edits an extension made to a file that is open in the editor; false if it is not open. */
export function applyExtEdits(path: string, edits: ExtEdit[], snippet: boolean, ed: monaco.editor.IStandaloneCodeEditor | null): boolean {
  const model = modelFor(path)
  if (!model) return false
  const ops = edits.map((e) => ({
    range: new monaco.Range(e.range.start.line + 1, e.range.start.character + 1, e.range.end.line + 1, e.range.end.character + 1),
    text: e.text,
    forceMoveMarkers: true
  }))
  if (snippet && ed && ed.getModel() === model && ops.length === 1) {
    ed.setSelection(ops[0].range)
    const ctrl = ed.getContribution('snippetController2') as { insert?: (t: string) => void } | null
    if (ctrl?.insert) return void ctrl.insert(ops[0].text), true
  }
  model.pushStackElement()
  model.pushEditOperations([], ops, () => null)
  model.pushStackElement()
  return true
}
