import { monaco } from './monaco-setup'

// Merge conflicts inside a file: git leaves <<<<<<< / ======= / >>>>>>> markers. Like VS Code, each conflict gets
// coloured sides and "Accept Current / Incoming / Both" links above it.

export interface Conflict {
  start: number // line of <<<<<<<
  base?: number // line of ||||||| (diff3 style)
  mid: number // line of =======
  end: number // line of >>>>>>>
}

export function findConflicts(model: monaco.editor.ITextModel): Conflict[] {
  const out: Conflict[] = []
  const n = model.getLineCount()
  let cur: Partial<Conflict> | null = null
  for (let i = 1; i <= n; i++) {
    const line = model.getLineContent(i)
    if (line.startsWith('<<<<<<< ') || line === '<<<<<<<') cur = { start: i }
    else if (cur && cur.mid === undefined && cur.base === undefined && line.startsWith('|||||||')) cur.base = i
    else if (cur && cur.mid === undefined && line === '=======') cur.mid = i
    else if (cur && cur.mid !== undefined && (line.startsWith('>>>>>>> ') || line === '>>>>>>>')) {
      out.push({ start: cur.start!, base: cur.base, mid: cur.mid, end: i })
      cur = null
    }
  }
  return out
}

export type Choice = 'current' | 'incoming' | 'both'

// The text to put in place of the whole conflict block (markers included) for each choice.
function chosenText(model: monaco.editor.ITextModel, c: Conflict, choice: Choice): string {
  const lines = (a: number, b: number): string[] => {
    const r: string[] = []
    for (let i = a; i <= b; i++) r.push(model.getLineContent(i))
    return r
  }
  const currentEnd = (c.base ?? c.mid) - 1
  const current = lines(c.start + 1, currentEnd)
  const incoming = lines(c.mid + 1, c.end - 1)
  const picked = choice === 'current' ? current : choice === 'incoming' ? incoming : [...current, ...incoming]
  return picked.join(model.getEOL())
}

export function resolveConflict(model: monaco.editor.ITextModel, startLine: number, choice: Choice): boolean {
  const c = findConflicts(model).find((x) => x.start === startLine)
  if (!c) return false
  const text = chosenText(model, c, choice)
  const empty = text === '' // remove the block's lines entirely, including their line break
  const range = empty
    ? c.end < model.getLineCount()
      ? new monaco.Range(c.start, 1, c.end + 1, 1)
      : new monaco.Range(Math.max(1, c.start - 1), c.start > 1 ? model.getLineMaxColumn(c.start - 1) : 1, c.end, model.getLineMaxColumn(c.end))
    : new monaco.Range(c.start, 1, c.end, model.getLineMaxColumn(c.end))
  model.pushEditOperations([], [{ range, text }], () => null)
  return true
}

let registered = false

/** Registers the "Accept ..." links once for all editors. */
export function registerConflictLenses(): void {
  if (registered) return
  registered = true
  const commandId = 'myaiide.resolveConflict'
  monaco.editor.registerCommand(commandId, (_accessor, uri: string, line: number, choice: Choice) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri))
    if (model) resolveConflict(model, line, choice)
  })
  // "Open Merge Editor" asks the app (which owns the files) to show the three-way view for this model.
  monaco.editor.registerCommand('myaiide.openMerge', (_accessor, uri: string) => {
    window.dispatchEvent(new CustomEvent('myaiide-open-merge', { detail: uri }))
  })
  monaco.languages.registerCodeLensProvider('*', {
    provideCodeLenses(model) {
      const lenses: monaco.languages.CodeLens[] = []
      for (const c of findConflicts(model)) {
        const range = new monaco.Range(c.start, 1, c.start, 1)
        const mk = (title: string, choice: Choice): monaco.languages.CodeLens => ({
          range,
          command: { id: commandId, title, arguments: [model.uri.toString(), c.start, choice] }
        })
        lenses.push(mk('Accept Current Change', 'current'), mk('Accept Incoming Change', 'incoming'), mk('Accept Both Changes', 'both'))
        lenses.push({ range, command: { id: 'myaiide.openMerge', title: 'Open Merge Editor', arguments: [model.uri.toString()] } })
      }
      return { lenses, dispose: () => undefined }
    }
  })
}

/** Colours the two sides of every conflict in the editor's current file, and keeps them up to date. */
export function attachConflictDecorations(ed: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const collection = ed.createDecorationsCollection()
  const update = (): void => {
    const model = ed.getModel()
    if (!model || model.isDisposed()) return void collection.clear()
    const decos: monaco.editor.IModelDeltaDecoration[] = []
    for (const c of findConflicts(model)) {
      const whole = (a: number, b: number, cls: string): monaco.editor.IModelDeltaDecoration => ({
        range: new monaco.Range(a, 1, b, 1),
        options: { isWholeLine: true, className: cls }
      })
      decos.push(whole(c.start, c.start, 'conflict-marker-current'))
      decos.push(whole(c.start + 1, (c.base ?? c.mid) - 1, 'conflict-current'))
      if (c.base) decos.push(whole(c.base, c.mid - 1, 'conflict-base'))
      decos.push(whole(c.mid, c.mid, 'conflict-marker'))
      decos.push(whole(c.mid + 1, c.end - 1, 'conflict-incoming'))
      decos.push(whole(c.end, c.end, 'conflict-marker-incoming'))
    }
    collection.set(decos)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(update, 120)
  }
  const subs = [ed.onDidChangeModel(update), ed.onDidChangeModelContent(schedule)]
  update()
  return {
    dispose: () => {
      clearTimeout(timer)
      subs.forEach((s) => s.dispose())
      collection.clear()
    }
  }
}
