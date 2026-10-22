import { useEffect, useRef } from 'react'
import { monaco } from './monaco-setup'
import { acquireDiffEditor, releaseDiffEditor } from './diffPool'
import { editorOptions, useSettings } from './settings'

export interface DiffViewData {
  title: string
  path: string // absolute, so the file can be opened
  original: string
  modified: string
}

// A read-only side-by-side diff that covers the editor area (like VS Code's diff tabs, minus the tab).
export function DiffView({
  data,
  onOpenFile,
  onClose
}: {
  data: DiffViewData
  onOpenFile: () => void
  onClose: () => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const settings = useSettings()

  useEffect(() => {
    // A custom scheme keeps these models from clashing with the real file's model.
    const uri = (side: string): monaco.Uri => monaco.Uri.from({ scheme: 'git-diff', path: `/${side}/${data.path.replace(/\\/g, '/')}` })
    const original = monaco.editor.createModel(data.original, undefined, uri('before'))
    const modified = monaco.editor.createModel(data.modified, undefined, uri('after'))
    const diff = acquireDiffEditor(host.current!, {
      ...editorOptions(settings),
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false
    })
    diff.setModel({ original, modified })
    return () => {
      releaseDiffEditor(diff)
      original.dispose()
      modified.dispose()
    }
    // The editor options are read once; a font change applies the next time a diff is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="diff-view">
      <div className="diff-bar">
        <span className="diff-title">{data.title}</span>
        <span>
          <button onClick={onOpenFile}>Open file</button>
          <button onClick={onClose} title="Close (Esc)">
            Close
          </button>
        </span>
      </div>
      <div ref={host} className="diff-host" />
    </div>
  )
}
