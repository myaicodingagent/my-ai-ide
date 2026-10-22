import { useEffect, useRef } from 'react'
import { monaco } from './monaco-setup'
import { attachConflictDecorations } from './conflicts'
import { attachNextEdit } from './nextedit'
import { attachDebugEditor } from './debugEditor'
import { attachExtEditorState } from './extBridge'
import { editorOptions, getSettings, useSettings } from './settings'

export interface SplitTab {
  path: string
  model: monaco.editor.ITextModel
  dirty: boolean
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

// The second editor group: its own tabs and its own editor, sharing the text models of the main group
// (so an edit made in one group shows in the other at once, and there is only one "unsaved" state per file).
export function SplitPane({
  tabs,
  paths,
  active,
  onActivate,
  onCloseTab,
  onClose,
  onFocus,
  onEditor,
  onCursor,
  onStartInline
}: {
  tabs: SplitTab[]
  paths: string[]
  active: string | null
  onActivate: (path: string) => void
  onCloseTab: (path: string) => void
  onClose: () => void
  onFocus: () => void
  onEditor: (ed: monaco.editor.IStandaloneCodeEditor | null) => void
  onCursor: (pos: { line: number; col: number }) => void
  onStartInline: () => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const settings = useSettings()
  const cb = useRef({ onFocus, onEditor, onCursor, onStartInline })
  cb.current = { onFocus, onEditor, onCursor, onStartInline }

  useEffect(() => {
    const ed = monaco.editor.create(host.current!, {
      automaticLayout: true,
      model: null,
      glyphMargin: true,
      ...editorOptions(),
      padding: { top: 12, bottom: 12 },
      minimap: { enabled: getSettings().minimap, renderCharacters: false },
      wordWrap: getSettings().wordWrap ? 'on' : 'off',
      scrollBeyondLastLine: false,
      cursorBlinking: getSettings().reduceMotion ? 'solid' : 'smooth',
      bracketPairColorization: { enabled: true },
      renderLineHighlight: 'all',
      guides: { bracketPairs: true, indentation: true }
    })
    ed.onDidFocusEditorText(() => cb.current.onFocus())
    ed.onDidChangeCursorPosition((e) => cb.current.onCursor({ line: e.position.lineNumber, col: e.position.column }))
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => cb.current.onStartInline())
    const decos = attachConflictDecorations(ed)
    const nextEdit = attachNextEdit(ed, () => getSettings().nextEdit)
    const debugDecos = attachDebugEditor(ed)
    const extState = attachExtEditorState(ed, () => ed.hasTextFocus())
    edRef.current = ed
    cb.current.onEditor(ed)
    return () => {
      extState.dispose()
      debugDecos.dispose()
      nextEdit.dispose()
      decos.dispose()
      cb.current.onEditor(null)
      edRef.current = null
      ed.dispose()
    }
  }, [])

  useEffect(() => {
    edRef.current?.updateOptions({
      ...editorOptions(settings),
      minimap: { enabled: settings.minimap, renderCharacters: false },
      wordWrap: settings.wordWrap ? 'on' : 'off'
    })
  }, [settings])

  useEffect(() => {
    const model = tabs.find((t) => t.path === active)?.model ?? null
    if (edRef.current && edRef.current.getModel() !== model) edRef.current.setModel(model)
    edRef.current?.updateOptions({ ariaLabel: model ? `Second editor, ${baseName(model.uri.fsPath || model.uri.path)}` : 'Second editor' })
  }, [active, tabs])

  const shown = paths.map((p) => tabs.find((t) => t.path === p)).filter((t): t is SplitTab => !!t)

  return (
    <div className="split-pane" data-split-pane onMouseDownCapture={onFocus}>
      <div className="split-tabs" role="tablist" aria-label="Open files in the second group">
        {shown.map((t) => (
          <div
            key={t.path}
            className={'stab' + (t.path === active ? ' active' : '')}
            data-split-tab={t.path}
            title={t.path}
            role="tab"
            aria-selected={t.path === active}
            tabIndex={t.path === active ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), onActivate(t.path))
              else if (e.key === 'Delete') (e.preventDefault(), onCloseTab(t.path))
              else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const i = shown.findIndex((x) => x.path === t.path)
                const n = shown[(i + (e.key === 'ArrowRight' ? 1 : -1) + shown.length) % shown.length]
                if (n) {
                  onActivate(n.path)
                  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-split-tab="${CSS.escape(n.path)}"]`)?.focus())
                }
              }
            }}
            onClick={() => onActivate(t.path)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onCloseTab(t.path)
              }
            }}
          >
            <span className="tab-name">{baseName(t.path)}</span>
            {t.dirty && <span className="tab-dot" title="Unsaved changes" />}
            <span
              className="close"
              title="Close in this group"
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(t.path)
              }}
            >
              ×
            </span>
          </div>
        ))}
        <button className="split-close" data-split-close title="Close split editor" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="split-editor" ref={host} aria-label="Second editor group" />
    </div>
  )
}
