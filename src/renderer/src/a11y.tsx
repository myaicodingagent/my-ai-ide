import { RefObject, useEffect, useState } from 'react'

// Things for keyboard and screen reader users: spoken announcements for events that otherwise only change the picture,
// and a focus trap for dialogs.

type Politeness = 'polite' | 'assertive'
const listeners = new Set<(text: string, p: Politeness) => void>()

/** Has screen readers say `text`. `assertive` interrupts what is being read (for errors). */
export function announce(text: string, politeness: Politeness = 'polite'): void {
  listeners.forEach((cb) => cb(text, politeness))
}

// Two always-present regions: screen readers pick up changes made to their text.
export function LiveRegions(): JSX.Element {
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState('')
  useEffect(() => {
    let n = 0
    const cb = (text: string, p: Politeness): void => {
      // The same sentence twice in a row must still be read, so a changing invisible suffix is added.
      const value = text + (n++ % 2 ? '​' : '')
      if (p === 'assertive') setAssertive(value)
      else setPolite(value)
    }
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  }, [])
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-live-polite>
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-live-assertive>
        {assertive}
      </div>
    </>
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keeps Tab and Shift+Tab inside `ref` while it is shown, and gives focus back to what had it before when it closes.
 * (The element that should start with focus focuses itself.)
 */
export function useFocusTrap(ref: RefObject<HTMLElement>, initial?: string): void {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    // Start with focus inside the dialog: on the element asked for, or the first control.
    const start = (initial ? ref.current?.querySelector<HTMLElement>(initial) : null) ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE)
    if (start && !ref.current?.contains(document.activeElement)) start.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !ref.current) return
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const at = document.activeElement
      if (e.shiftKey && (at === first || !ref.current.contains(at))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (at === last || !ref.current.contains(at))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      // Only if focus was not moved somewhere meaningful in the meantime.
      if (before && document.contains(before) && (document.activeElement === document.body || !document.activeElement)) before.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref])
}
