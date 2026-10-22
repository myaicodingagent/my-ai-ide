import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { announce, useFocusTrap } from './a11y'

export interface PickItem {
  label: string
  detail?: string
  run: () => void
  // Called while the row is highlighted (e.g. to preview a theme).
  preview?: () => void
}

// Subsequence match; lower score is better, -1 means no match.
const score = (q: string, text: string): number => {
  let i = 0
  let s = 0
  const t = text.toLowerCase()
  for (const ch of q.toLowerCase()) {
    const j = t.indexOf(ch, i)
    if (j < 0) return -1
    s += j - i
    i = j + 1
  }
  return s
}

export function QuickPick({
  items,
  placeholder,
  initialIndex = 0,
  onClose,
  onCancel
}: {
  items: PickItem[]
  placeholder: string
  // Row highlighted when the list opens (no preview is triggered for it).
  initialIndex?: number
  onClose: () => void
  // Called when dismissed without choosing (Esc or clicking outside), so previews can be undone.
  onCancel?: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(initialIndex)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const uid = useId()
  useFocusTrap(boxRef)
  useEffect(() => inputRef.current?.focus(), [])

  const shown = useMemo(() => {
    if (!query) return items.slice(0, 50)
    return items
      .map((it) => ({ it, s: score(query, it.label + ' ' + (it.detail ?? '')) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .slice(0, 50)
      .map((x) => x.it)
  }, [items, query])

  // Keep the highlighted row in view when moving with the keyboard.
  useEffect(() => {
    listRef.current?.querySelector('.qp-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel, shown])

  // Say how many choices match, a moment after the typing stops.
  useEffect(() => {
    if (!query) return
    const t = setTimeout(() => announce(shown.length === 0 ? 'No results' : `${shown.length} result${shown.length > 1 ? 's' : ''}`), 400)
    return () => clearTimeout(t)
  }, [query, shown.length])

  const moveTo = (i: number): void => {
    setSel(i)
    shown[i]?.preview?.()
  }

  const cancel = (): void => {
    onCancel?.()
    onClose()
  }

  const choose = (it?: PickItem): void => {
    if (!it) return
    onClose()
    it.run()
  }

  return (
    <div className="qp-backdrop" onMouseDown={cancel}>
      <div className="qp" ref={boxRef} role="dialog" aria-modal="true" aria-label={placeholder} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          role="combobox"
          aria-label={placeholder}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={uid + '-list'}
          aria-activedescendant={shown[sel] ? uid + '-opt-' + sel : undefined}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              moveTo(Math.min(sel + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              moveTo(Math.max(sel - 1, 0))
            } else if (e.key === 'Enter') choose(shown[sel])
          }}
        />
        <div className="qp-list" ref={listRef} id={uid + '-list'} role="listbox" aria-label="Choices">
          {shown.map((it, i) => (
            <div
              key={it.label + (it.detail ?? '')}
              id={uid + '-opt-' + i}
              role="option"
              aria-selected={i === sel}
              className={'qp-item' + (i === sel ? ' sel' : '')}
              onMouseMove={() => i !== sel && moveTo(i)}
              onClick={() => choose(it)}
            >
              <span className="qp-label">{it.label}</span>
              {it.detail && <span className="qp-detail">{it.detail}</span>}
            </div>
          ))}
          {shown.length === 0 && <div className="qp-item" role="option" aria-selected="false">No results</div>}
        </div>
      </div>
    </div>
  )
}
