import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from './a11y'

export interface InputRequest {
  title: string
  value?: string
  placeholder?: string
  // Hide what is typed (passwords and passphrases).
  secret?: boolean
  confirmLabel?: string
  // Part of `value` to pre-select, e.g. the file name without its extension when renaming.
  selectEnd?: number
  // Return an error message to block submitting, or null if the text is fine.
  validate?: (value: string) => string | null
  onSubmit: (value: string) => void
}

// Electron has no window.prompt(), so asking for a line of text needs a dialog of our own.
export function InputDialog({ request, onClose }: { request: InputRequest; onClose: () => void }): JSX.Element {
  const [value, setValue] = useState(request.value ?? '')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useFocusTrap(boxRef)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(0, request.selectEnd ?? el.value.length)
  }, [request.selectEnd])

  const submit = (): void => {
    const problem = request.validate?.(value) ?? null
    if (problem) return setError(problem)
    onClose()
    request.onSubmit(value)
  }

  return (
    <div className="qp-backdrop" onMouseDown={onClose}>
      <div className="qp input-dialog" ref={boxRef} role="dialog" aria-modal="true" aria-label={request.title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ie-status">{request.title}</div>
        <input
          ref={inputRef}
          value={value}
          placeholder={request.placeholder}
          type={request.secret ? 'password' : 'text'}
          autoComplete="off"
          data-input-dialog
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') onClose()
          }}
        />
        {error && <div className="chat-error ie-status">{error}</div>}
        <div className="ie-actions">
          <button className="primary" data-input-ok onClick={submit}>
            {request.confirmLabel ?? 'OK'}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
