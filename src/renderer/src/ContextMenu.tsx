import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  run: () => void
  danger?: boolean
  // Draw a divider above this item.
  separator?: boolean
  disabled?: boolean
}

// A right-click menu. It closes on any outside click, Escape, or after an item is chosen.
export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Keep the menu on screen: flip it up or left when it would run past the window edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <>
      <div className="ctx-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} data-context-menu>
        {items.map((it, i) => (
          <div key={i}>
            {it.separator && <div className="ctx-sep" />}
            <div
              className={'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '')}
              onClick={() => {
                if (it.disabled) return
                onClose()
                it.run()
              }}
            >
              {it.label}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
