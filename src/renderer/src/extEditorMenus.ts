import { monaco } from './monaco-setup'
import { getExtensions } from './extStore'
import { evalWhen, menuOrder, WhenContext } from './whenClause'

// The entries that extensions add to the editor's right-click menu (contributes.menus["editor/context"]). Each entry is an editor
// action whose visibility follows a context key that is re-evaluated from its `when` clause whenever the file, its language or the
// selection changes; choosing it runs the extension's command with the file.

type Entry = { extId: string; command: string; title: string; when: string; group: string }

const entries = (): Entry[] =>
  getExtensions()
    .filter((e) => e.enabled && (e.vscode || e.native))
    .flatMap((e) => (e.editorMenus ?? []).map((m) => ({ ...m, extId: e.id })))

function contextOf(ed: monaco.editor.IStandaloneCodeEditor): WhenContext {
  const model = ed.getModel()
  const file = model && model.uri.scheme === 'file' ? model.uri.fsPath : ''
  const base = file.split(/[\\/]/).pop() ?? ''
  const sel = ed.getSelection()
  return {
    editorLangId: model?.getLanguageId(),
    resourceLangId: model?.getLanguageId(),
    resourceScheme: model?.uri.scheme,
    resourcePath: file || undefined,
    resourceFilename: file ? base : undefined,
    resourceExtname: file && base.includes('.') ? base.slice(base.lastIndexOf('.')) : file ? '' : undefined,
    editorHasSelection: !!sel && !sel.isEmpty(),
    editorReadonly: ed.getOption(monaco.editor.EditorOption.readOnly),
    editorTextFocus: ed.hasTextFocus()
  }
}

/** Adds the extensions' entries to this editor's context menu, and keeps them in step with the installed extensions. */
export function attachExtEditorMenus(ed: monaco.editor.IStandaloneCodeEditor, onChange: (cb: () => void) => () => void): monaco.IDisposable {
  let disposables: monaco.IDisposable[] = []
  let update: () => void = () => undefined

  const build = (): void => {
    for (const d of disposables) d.dispose()
    disposables = []
    const list = entries()
    const keys = list.map((m, i) => ed.createContextKey<boolean>('extMenu' + i, false))
    list.forEach((m, i) => {
      const g = menuOrder(m.group)
      disposables.push(
        ed.addAction({
          id: `ext.${m.extId}.${m.command}.${i}`,
          label: m.title,
          precondition: 'extMenu' + i,
          contextMenuGroupId: g.name === 'navigation' ? 'navigation' : g.name || '9_ext',
          contextMenuOrder: 100 + g.order + i / 100,
          run: (editor) => {
            const model = editor.getModel()
            const file = model && model.uri.scheme === 'file' ? model.uri.fsPath : undefined
            void window.api.extRun(m.extId, m.command, file ? [{ $uri: file }] : [])
          }
        })
      )
    })
    update = (): void => {
      const ctx = contextOf(ed)
      list.forEach((m, i) => keys[i].set(evalWhen(m.when, ctx)))
    }
    update()
  }

  build()
  const subs = [
    ed.onDidChangeModel(() => update()),
    ed.onDidChangeModelLanguage(() => update()),
    ed.onDidChangeCursorSelection(() => update()),
    ed.onContextMenu(() => update()),
    { dispose: onChange(build) }
  ]
  return {
    dispose: () => {
      for (const s of subs) s.dispose()
      for (const d of disposables) d.dispose()
    }
  }
}
