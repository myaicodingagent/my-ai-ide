import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from './a11y'
import { monaco } from './monaco-setup'
import { acquireDiffEditor, releaseDiffEditor } from './diffPool'
import { MODELS } from './models'
import { editorOptions, getSettings } from './settings'

export interface InlineTarget {
  model: monaco.editor.ITextModel
  range: monaco.IRange
  original: string
  fileName: string
  language: string
  fileText: string
  root: string | null // the project folder, for its AI rules
}

// Chat panel ids start at 1; keep inline-edit ids in a separate range so events never cross.
let nextId = 1_000_000
const MAX_CONTEXT_CHARS = 400_000

function buildSystem(t: InlineTarget): string {
  let s =
    'You are a code editing engine inside a code editor. The user selects a region of a file and gives an instruction. ' +
    'Reply with ONLY the full replacement for the selected region, in a single fenced code block, with no explanation before or after. ' +
    'Preserve the surrounding indentation and style. If the instruction cannot be done, return the selection unchanged.'
  if (t.fileText.length <= MAX_CONTEXT_CHARS) {
    s += `\n\nFile ${t.fileName} (${t.language}) for context:\n\`\`\`${t.language}\n${t.fileText}\n\`\`\``
  }
  return s
}

function extractCode(text: string, original: string): string {
  const m = /```[\w+-]*\n([\s\S]*?)```/.exec(text)
  let code = m ? m[1] : text
  code = code.replace(/\n$/, '')
  if (original.endsWith('\n') && !code.endsWith('\n')) code += '\n'
  return code
}

export function InlineEdit({
  target,
  onClose
}: {
  target: InlineTarget
  onClose: () => void
}): JSX.Element {
  const [instruction, setInstruction] = useState('')
  const [model, setModel] = useState(getSettings().defaultModel)
  const [phase, setPhase] = useState<'prompt' | 'working' | 'review'>('prompt')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState('')
  const reqRef = useRef<number | null>(null)
  const bufRef = useRef('')
  const diffHost = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useFocusTrap(boxRef)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    return window.api.onAiEvent({
      delta: (id, text) => {
        if (id === reqRef.current) bufRef.current += text
      },
      done: (id, stop) => {
        if (id !== reqRef.current) return
        reqRef.current = null
        if (stop === 'aborted') return
        if (stop === 'refusal') {
          setError('The model declined this request.')
          setPhase('prompt')
        } else if (stop === 'max_tokens') {
          setError('The response was cut off, so the edit is incomplete. Try a smaller selection.')
          setPhase('prompt')
        } else {
          setResult(extractCode(bufRef.current, target.original))
          setPhase('review')
        }
      },
      error: (id, message) => {
        if (id !== reqRef.current) return
        reqRef.current = null
        setError(message)
        setPhase('prompt')
      }
    })
  }, [target.original])

  // Diff view for review.
  useEffect(() => {
    if (phase !== 'review' || !diffHost.current) return
    const orig = monaco.editor.createModel(target.original, target.language)
    const mod = monaco.editor.createModel(result, target.language)
    const diff = acquireDiffEditor(diffHost.current, {
      ...editorOptions(),
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: false,
      minimap: { enabled: false }
    })
    diff.setModel({ original: orig, modified: mod })
    return () => {
      releaseDiffEditor(diff)
      orig.dispose()
      mod.dispose()
    }
  }, [phase, result, target.original, target.language])

  const run = async (): Promise<void> => {
    const text = instruction.trim()
    if (!text) return
    const id = ++nextId
    reqRef.current = id
    bufRef.current = ''
    setError(null)
    setPhase('working')
    // The project's own rules (indentation, naming...) matter most for edits.
    const rules = target.root ? await window.api.rulesPrompt(target.root) : ''
    window.api.aiChat({
      requestId: id,
      model,
      system: buildSystem(target) + rules,
      messages: [
        {
          role: 'user',
          content: `Selected region:\n\`\`\`${target.language}\n${target.original}\n\`\`\`\n\nInstruction: ${text}`
        }
      ]
    })
  }

  const cancel = (): void => {
    if (reqRef.current !== null) window.api.aiAbort(reqRef.current)
    reqRef.current = null
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const accept = (): void => {
    if (target.model.isDisposed()) return onClose()
    if (target.model.getValueInRange(target.range) !== target.original) {
      setError('The file changed since you started, so the edit was not applied.')
      setPhase('prompt')
      return
    }
    target.model.pushEditOperations([], [{ range: target.range, text: result }], () => null)
    onClose()
  }

  return (
    <div className="qp-backdrop" onMouseDown={cancel}>
      <div className="qp ie" ref={boxRef} role="dialog" aria-modal="true" aria-label="Edit the selection with Claude" onMouseDown={(e) => e.stopPropagation()}>
        {phase !== 'review' && (
          <div className="ie-bar">
            <input
              ref={inputRef}
              value={instruction}
              disabled={phase === 'working'}
              placeholder={`Edit ${target.fileName}: describe the change...`}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run()
              }}
            />
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={phase === 'working'}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {phase === 'working' && <div className="ie-status">Generating edit… (Esc to cancel)</div>}
        {error && <div className="chat-error ie-status">{error}</div>}
        {phase === 'review' && (
          <>
            <div ref={diffHost} className="ie-diff" />
            <div className="ie-actions">
              <button className="primary" onClick={accept}>
                Accept
              </button>
              <button onClick={cancel}>Reject</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
