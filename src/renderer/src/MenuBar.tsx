import { useEffect, useRef, useState } from 'react'

export interface MenuEntry {
  label: string
  run?: () => void
  shortcut?: string
  disabled?: boolean
  // Draw a divider above this entry.
  separator?: boolean
  // A toggle: shows a check mark while it is on.
  checked?: boolean
}

export interface MenuDef {
  label: string
  items: MenuEntry[]
}

// The menu bar across the top: File, Edit, Selection, View, Go, Run, Terminal, Help. A click opens a menu; while one is
// open, moving over another title switches to it. Arrow keys move around, Enter chooses, Escape closes.
export function MenuBar({ menus }: { menus: MenuDef[] }): JSX.Element {
  const [open, setOpen] = useState<number | null>(null)
  const [hi, setHi] = useState(-1)
  const [altHeld, setAltHeld] = useState(false) // the underlined letters show while Alt is down
  const barRef = useRef<HTMLDivElement>(null)

  // While a menu is open, the keys and outside clicks belong to it, wherever the focus happens to be.
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  useEffect(() => {
    if (open === null) return
    const onDown = (e: MouseEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => keysRef.current(e)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // Alt + the underlined letter opens a menu (Alt+F for File...), from anywhere.
  const altRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  useEffect(() => {
    const onAlt = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') setAltHeld(true)
      altRef.current(e)
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') setAltHeld(false)
    }
    const onBlur = (): void => setAltHeld(false)
    window.addEventListener('keydown', onAlt, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onAlt, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  altRef.current = (e: KeyboardEvent): void => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.key.length !== 1) return
    const i = menus.findIndex((m) => m.label[0].toLowerCase() === e.key.toLowerCase())
    if (i < 0) return
    e.preventDefault()
    e.stopPropagation()
    setOpen(i)
    setHi(-1)
  }

  const items = open === null ? [] : menus[open].items
  const enabled = items.map((it, i) => (it.disabled || !it.run ? -1 : i)).filter((i) => i >= 0)

  const choose = (it: MenuEntry): void => {
    if (it.disabled || !it.run) return
    setOpen(null)
    // Let the menu close first: some commands (Monaco's own boxes, dialogs) take focus right away.
    setTimeout(() => it.run?.(), 0)
  }

  keysRef.current = (e: KeyboardEvent): void => {
    if (open === null) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(null)
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      e.stopPropagation()
      setOpen((open + (e.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length)
      setHi(-1)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      if (!enabled.length) return
      const at = enabled.indexOf(hi)
      const next = e.key === 'ArrowDown' ? (at + 1) % enabled.length : (at <= 0 ? enabled.length - 1 : at - 1)
      setHi(enabled[next])
    } else if (e.key === 'Enter' && hi >= 0) {
      e.preventDefault()
      e.stopPropagation()
      choose(items[hi])
    }
  }

  return (
    <div className={'menubar' + (altHeld || open !== null ? ' alt' : '')} role="menubar" aria-label="Application menu" ref={barRef}>
      {menus.map((m, i) => (
        <div key={m.label} className="menu-wrap">
          <button
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            className={'menu-title' + (open === i ? ' open' : '')}
            data-menu={m.label}
            onClick={() => {
              setOpen(open === i ? null : i)
              setHi(-1)
            }}
            onMouseEnter={() => {
              if (open !== null && open !== i) {
                setOpen(i)
                setHi(-1)
              }
            }}
          >
            <u>{m.label[0]}</u>
            {m.label.slice(1)}
          </button>
          {open === i && (
            <div className="menu-drop" role="menu" aria-label={m.label}>
              {m.items.map((it, k) => (
                <div key={k}>
                  {it.separator && <div className="menu-sep" role="separator" />}
                  <div
                    role="menuitem"
                    aria-disabled={it.disabled || !it.run ? true : undefined}
                    aria-checked={it.checked === undefined ? undefined : it.checked}
                    className={'menu-item' + (hi === k ? ' hi' : '') + (it.disabled || !it.run ? ' disabled' : '')}
                    data-menu-item={it.label}
                    onMouseEnter={() => setHi(k)}
                    onClick={() => choose(it)}
                  >
                    <span className="menu-check" aria-hidden="true">{it.checked ? '✓' : ''}</span>
                    <span className="menu-label">{it.label}</span>
                    {it.shortcut && <span className="menu-key">{it.shortcut}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
