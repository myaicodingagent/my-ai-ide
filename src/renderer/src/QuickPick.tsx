import { useEffect, useMemo, useRef, useState } from 'react'

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
      <div className="qp" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
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
        <div className="qp-list" ref={listRef}>
          {shown.map((it, i) => (
            <div
              key={it.label + (it.detail ?? '')}
              className={'qp-item' + (i === sel ? ' sel' : '')}
              onMouseMove={() => i !== sel && moveTo(i)}
              onClick={() => choose(it)}
            >
              <span className="qp-label">{it.label}</span>
              {it.detail && <span className="qp-detail">{it.detail}</span>}
            </div>
          ))}
          {shown.length === 0 && <div className="qp-item">No results</div>}
        </div>
      </div>
    </div>
  )
}
