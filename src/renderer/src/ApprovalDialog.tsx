import { useEffect, useRef } from 'react'
import { monaco } from './monaco-setup'
import { acquireDiffEditor, releaseDiffEditor } from './diffPool'
import { editorOptions } from './settings'

export interface Approval {
  id: string
  tool: string
  path: string
  before: string
  after: string
  isNew: boolean
}

export interface CommandApproval {
  id: string
  command: string
  cwd: string
}

export function CommandDialog({
  request,
  onDecide
}: {
  request: CommandApproval
  onDecide: (ok: boolean) => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDecide(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecide])

  return (
    <div className="qp-backdrop">
      <div className="qp ie">
        <div className="ie-status">The agent wants to run this command in:</div>
        <div className="ie-status cmd-cwd">{request.cwd}</div>
        <pre className="cmd-text">{request.command}</pre>
        <div className="ie-status">
          It runs with your permissions and can change files. Only run it if you understand it.
        </div>
        <div className="ie-actions">
          <button className="primary" onClick={() => onDecide(true)}>
            Run
          </button>
          <button onClick={() => onDecide(false)}>Don&apos;t run</button>
        </div>
      </div>
    </div>
  )
}

export function ApprovalDialog({
  approval,
  unsavedWarning,
  onDecide
}: {
  approval: Approval
  unsavedWarning: boolean
  onDecide: (ok: boolean) => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // A custom scheme keeps these models from clashing with the real file's model.
    const uri = (side: string): monaco.Uri =>
      monaco.Uri.from({ scheme: 'agent-diff', path: `/${side}/${approval.path}` })
    const original = monaco.editor.createModel(approval.before, undefined, uri('before'))
    const modified = monaco.editor.createModel(approval.after, undefined, uri('after'))
    const diff = acquireDiffEditor(host.current!, {
      ...editorOptions(),
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: !approval.isNew,
      minimap: { enabled: false }
    })
    diff.setModel({ original, modified })
    return () => {
      releaseDiffEditor(diff)
      original.dispose()
      modified.dispose()
    }
  }, [approval])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDecide(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecide])

  return (
    <div className="qp-backdrop">
      <div className="qp ie approval">
        <div className="ie-status">
          {approval.isNew ? 'Create' : 'Edit'} <b>{approval.path}</b>
        </div>
        {unsavedWarning && (
          <div className="chat-error ie-status">
            This file has unsaved changes in the editor. Accepting will replace them.
          </div>
        )}
        <div ref={host} className="ie-diff" />
        <div className="ie-actions">
          <button className="primary" onClick={() => onDecide(true)}>
            Accept
          </button>
          <button onClick={() => onDecide(false)}>Reject</button>
        </div>
      </div>
    </div>
  )
}
