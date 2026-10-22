import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useFocusTrap } from './a11y'

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
  const [hi, setHi] = useState(-1) // the item the keyboard is on
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0)
  useFocusTrap(ref)

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
      if (e.key === 'Escape') {
        e.stopPropagation() // not for the editor underneath
        return onClose()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        e.stopPropagation()
        setHi((cur) => {
          if (enabled.length === 0) return -1
          const at = enabled.indexOf(cur)
          if (e.key === 'Home') return enabled[0]
          if (e.key === 'End') return enabled[enabled.length - 1]
          const next = e.key === 'ArrowDown' ? (at + 1) % enabled.length : (at - 1 + enabled.length) % enabled.length
          return enabled[at < 0 ? (e.key === 'ArrowDown' ? 0 : enabled.length - 1) : next]
        })
      } else if ((e.key === 'Enter' || e.key === ' ') && hi >= 0 && items[hi] && !items[hi].disabled) {
        e.preventDefault()
        e.stopPropagation()
        const it = items[hi]
        onClose()
        it.run()
      }
    }
    // Capturing, so the keys reach the menu before the editor that still has focus.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, hi, items])

  return (
    <>
      <div className="ctx-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} data-context-menu role="menu" tabIndex={-1} aria-activedescendant={hi >= 0 ? 'ctx-item-' + hi : undefined}>
        {items.map((it, i) => (
          <div key={i}>
            {it.separator && <div className="ctx-sep" />}
            <div
              id={'ctx-item-' + i}
              role="menuitem"
              aria-disabled={it.disabled ? true : undefined}
              className={'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '') + (i === hi ? ' hi' : '')}
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
