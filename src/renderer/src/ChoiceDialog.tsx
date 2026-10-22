import { useEffect, useRef } from 'react'
import { useFocusTrap } from './a11y'

// A message with buttons, for extensions that ask a question (showInformationMessage("Sure?", "Yes", "No")).
export function ChoiceDialog({
  text,
  kind,
  choices,
  onChoose
}: {
  text: string
  kind: string
  choices: string[]
  onChoose: (choice: string | null) => void
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useFocusTrap(box, '[data-choice]')
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onChoose(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onChoose])
  return (
    <div className="qp-backdrop" onMouseDown={() => onChoose(null)}>
      <div className="qp input-dialog" ref={box} role="alertdialog" aria-modal="true" aria-label={text} data-choice-dialog onMouseDown={(e) => e.stopPropagation()}>
        <div className={'ie-status' + (kind === 'error' ? ' chat-error' : '')} style={{ whiteSpace: 'pre-wrap' }}>
          {text}
        </div>
        <div className="ie-actions">
          {choices.map((c, i) => (
            <button key={c} className={i === 0 ? 'primary' : ''} data-choice={c} onClick={() => onChoose(c)}>
              {c}
            </button>
          ))}
          <button onClick={() => onChoose(null)}>Dismiss</button>
        </div>
      </div>
    </div>
  )
}
