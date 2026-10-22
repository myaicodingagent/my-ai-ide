import { monaco } from './monaco-setup'

// Diff editors are created once and reused, never disposed.
//
// Why: every standalone Monaco editor registers its own services as the owner of one shared, global
// hover-tooltip factory when it is created. When the editor that registered last is disposed, the factory
// is left pointing at a dead service, and the next widget that needs it throws "InstantiationService has
// been disposed" (the Find box, Go to Line, the quick-input boxes). Our diff views, approval dialogs and
// inline-edit previews come and go constantly, so they borrow editors from this pool instead.

type DiffEditor = monaco.editor.IStandaloneDiffEditor

interface Pooled {
  editor: DiffEditor
  element: HTMLDivElement
}

const free: Pooled[] = []
const inUse = new Map<DiffEditor, Pooled>()

/** Borrows a diff editor and shows it inside `host`. Give it back with `releaseDiffEditor`. */
export function acquireDiffEditor(host: HTMLElement, options: monaco.editor.IDiffEditorConstructionOptions): DiffEditor {
  let item = free.pop()
  if (!item) {
    const element = document.createElement('div')
    element.style.cssText = 'width:100%;height:100%'
    // automaticLayout makes it follow whichever element it is in.
    const editor = monaco.editor.createDiffEditor(element, { automaticLayout: true, ...options })
    item = { editor, element }
  }
  item.editor.updateOptions(options)
  host.appendChild(item.element)
  item.editor.layout()
  inUse.set(item.editor, item)
  return item.editor
}

export function releaseDiffEditor(editor: DiffEditor): void {
  const item = inUse.get(editor)
  if (!item) return
  editor.setModel(null) // the caller disposes the models afterwards
  item.element.remove()
  inUse.delete(editor)
  free.push(item)
}
