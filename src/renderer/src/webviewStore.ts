import { useSyncExternalStore } from 'react'

// Web pages that extensions open as tabs (vscode.window.createWebviewPanel): which panels exist, which one is showing, and
// the messages the extension sent that the page has not been given yet.

export interface WebviewPanelInfo {
  id: string
  title: string
  viewType: string
  extId: string
  version: number // changes when the extension sets new HTML, which reloads the page
  view: boolean // the page fills a side bar view instead of being a tab
}

let panels: WebviewPanelInfo[] = []
let activeId: string | null = null
const listeners = new Set<() => void>()
const emit = (): void => {
  panels = [...panels]
  listeners.forEach((l) => l())
}
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export const useWebviewPanels = (): WebviewPanelInfo[] => useSyncExternalStore(subscribe, () => panels)
export const useActiveWebview = (): string | null => useSyncExternalStore(subscribe, () => activeId)
export const getActiveWebview = (): string | null => activeId

export function setActiveWebview(id: string | null): void {
  if (activeId === id) return
  activeId = id
  emit()
}

const postTargets = new Map<string, (m: unknown) => void>()
const queued = new Map<string, unknown[]>()

/** The frame says it can take messages for this panel; anything that arrived early is delivered now. */
export function onWebviewPost(id: string, cb: (m: unknown) => void): () => void {
  postTargets.set(id, cb)
  for (const m of queued.get(id) ?? []) cb(m)
  queued.delete(id)
  return () => {
    if (postTargets.get(id) === cb) postTargets.delete(id)
  }
}

export function closeWebview(id: string): void {
  void window.api.extProvide(id, 'webviewClosed', { id })
  removePanel(id)
}

function removePanel(id: string): void {
  panels = panels.filter((p) => p.id !== id)
  postTargets.delete(id)
  queued.delete(id)
  if (activeId === id) activeId = null
  emit()
}

export function webviewReset(): void {
  panels = []
  activeId = null
  postTargets.clear()
  queued.clear()
  emit()
}

export function webviewEvent(method: string, p: Record<string, unknown>): void {
  const id = String(p.id)
  switch (method) {
    case 'webviewCreate':
      panels = [...panels, { id, title: String(p.title ?? ''), viewType: String(p.viewType ?? ''), extId: String(p.extId ?? ''), version: 0, view: p.view === true }]
      if (p.view !== true) activeId = id
      return emit()
    case 'webviewHtml':
      panels = panels.map((x) => (x.id === id ? { ...x, version: x.version + 1 } : x))
      return emit()
    case 'webviewTitle':
      panels = panels.map((x) => (x.id === id ? { ...x, title: String(p.title ?? '') } : x))
      return emit()
    case 'webviewReveal':
      activeId = id
      return emit()
    case 'webviewDispose':
      return removePanel(id)
    case 'webviewPost': {
      const target = postTargets.get(id)
      if (target) target(p.message)
      else queued.set(id, [...(queued.get(id) ?? []), p.message])
    }
  }
}
