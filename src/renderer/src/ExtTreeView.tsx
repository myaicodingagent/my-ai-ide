import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Section } from './ExplorerSections'
import { ContextMenu, MenuItem } from './ContextMenu'
import { useExtensions } from './extStore'
import { evalWhen, menuOrder, WhenContext } from './whenClause'
import { WebviewFrame } from './WebviewFrame'
import { useWebviewPanels } from './webviewStore'

// Tree views that extensions add (vscode.window.createTreeView / registerTreeDataProvider, declared under
// "contributes.views"). The extension host answers "what are the children of this node" and "what happens on click".

interface Item {
  handle: number
  label: string
  description?: string
  tooltip?: string
  collapsible: number // 0 none, 1 collapsed, 2 expanded
  codicon?: string
  iconFile?: { light: string; dark: string } // an image file the extension gave, as a data: URL
  resource?: string
  contextValue?: string
  hasCommand: boolean
}

// ---- what the host says about its views ----

const live = new Set<string>()
const changedListeners = new Map<string, Set<(handle: number | null) => void>>()
const liveListeners = new Set<() => void>()
const emitLive = (): void => liveListeners.forEach((l) => l())

export function treeEvent(kind: 'treeView' | 'treeViewGone' | 'treeChanged', viewId: string, handle?: number | null): void {
  if (kind === 'treeView') live.add(viewId)
  else if (kind === 'treeViewGone') live.delete(viewId)
  if (kind === 'treeChanged') changedListeners.get(viewId)?.forEach((cb) => cb(handle ?? null))
  else emitLive()
}

/** A host restart: every view must ask again. */
export function treeReset(): void {
  live.clear()
  emitLive()
}

let liveSnapshot = ''
const subscribeLive = (cb: () => void): (() => void) => {
  liveListeners.add(cb)
  return () => {
    liveListeners.delete(cb)
  }
}
const useLiveKey = (): string =>
  useSyncExternalStore(subscribeLive, () => {
    const k = [...live].sort().join('|')
    if (k !== liveSnapshot) liveSnapshot = k
    return liveSnapshot
  })

// ---- the tree ----

const ROOT = -1

type TreeMenuEntry = { command: string; title: string; when: string; group: string }

/** The menu entries that apply to a node, in menu order (with the group each belongs to). */
function entriesFor(menus: TreeMenuEntry[], viewId: string, it: Item): TreeMenuEntry[] {
  const file = it.resource ?? ''
  const base = file.split(/[\\/]/).pop() ?? ''
  const ctx: WhenContext = {
    view: viewId,
    viewItem: it.contextValue,
    resourcePath: file || undefined,
    resourceFilename: file ? base : undefined,
    resourceExtname: file && base.includes('.') ? base.slice(base.lastIndexOf('.')) : file ? '' : undefined,
    resourceScheme: file ? 'file' : undefined
  }
  return menus
    .filter((m) => evalWhen(m.when, ctx))
    .map((m, i) => ({ m, i, g: menuOrder(m.group) }))
    .sort((a, b) => (a.g.name === 'navigation' ? 0 : 1) - (b.g.name === 'navigation' ? 0 : 1) || a.g.name.localeCompare(b.g.name) || a.g.order - b.g.order || a.i - b.i)
    .map((x) => x.m)
}

const isInline = (m: TreeMenuEntry): boolean => m.group === 'inline' || m.group.startsWith('inline@')

function ItemIcon({ it }: { it: Item }): JSX.Element {
  if (it.iconFile) {
    const light = document.documentElement.dataset.themeType === 'light'
    return <img className="xt-icon xt-img" alt="" src={light ? it.iconFile.light : it.iconFile.dark} />
  }
  if (it.codicon) return <span className={'xt-icon codicon codicon-' + it.codicon} aria-hidden="true" title={it.codicon} />
  return <span className="xt-icon" aria-hidden="true">·</span>
}

function TreeRows({ viewId, items, depth, children: render, expanded, onToggle, onActivate, menus, onMenu, onRun }: {
  viewId: string
  items: Item[]
  depth: number
  children: (item: Item) => Item[] | undefined
  expanded: Set<number>
  onToggle: (item: Item) => void
  onActivate: (item: Item) => void
  menus: TreeMenuEntry[]
  onMenu: (item: Item, x: number, y: number) => void
  onRun: (item: Item, command: string) => void
}): JSX.Element {
  return (
    <>
      {items.map((it) => {
        const open = expanded.has(it.handle)
        const kids = render(it)
        return (
          <div key={it.handle} role="none">
            <div
              role="treeitem"
              aria-expanded={it.collapsible ? open : undefined}
              aria-level={depth + 1}
              tabIndex={0}
              className="xt-row"
              data-xt-label={it.label}
              data-xt-view={viewId}
              title={it.tooltip || it.description || it.label}
              style={{ paddingLeft: 8 + depth * 14 }}
              onContextMenu={(e) => {
                e.preventDefault()
                onMenu(it, e.clientX, e.clientY)
              }}
              onClick={() => {
                if (it.collapsible) onToggle(it)
                onActivate(it)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  onMenu(it, r.left + 24, r.bottom)
                } else if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (it.collapsible) onToggle(it)
                  onActivate(it)
                } else if (e.key === 'ArrowRight' && it.collapsible && !open) onToggle(it)
                else if (e.key === 'ArrowLeft' && it.collapsible && open) onToggle(it)
              }}
            >
              <span className="xt-chev">{it.collapsible ? (open ? '▾' : '▸') : ''}</span>
              <ItemIcon it={it} />
              <span className="xt-label">{it.label}</span>
              {it.description && <span className="xt-desc">{it.description}</span>}
              <span className="xt-inline-actions">
                {entriesFor(menus, viewId, it).filter(isInline).map((m) => (
                  <button
                    key={m.command}
                    className="xt-inline"
                    data-xt-inline={m.command}
                    title={m.title}
                    aria-label={m.title + ', ' + it.label}
                    onClick={(e) => {
                      e.stopPropagation()
                      onRun(it, m.command)
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {m.title}
                  </button>
                ))}
              </span>
            </div>
            {it.collapsible > 0 && open && kids && (
              <TreeRows viewId={viewId} items={kids} depth={depth + 1} expanded={expanded} onToggle={onToggle} onActivate={onActivate} menus={menus} onMenu={onMenu} onRun={onRun}>
                {render}
              </TreeRows>
            )}
          </div>
        )
      })}
    </>
  )
}

/** An extension's web page filling a side bar view (registerWebviewViewProvider). */
export function ExtWebviewView({ viewId, name }: { viewId: string; name: string }): JSX.Element {
  const ready = useLiveKey().split('|').includes(viewId)
  const [panelId, setPanelId] = useState<string | null>(null)
  const panel = useWebviewPanels().find((p) => p.id === panelId)
  useEffect(() => {
    setPanelId(null)
    if (!ready) return
    let cancelled = false
    void window.api.extProvide(viewId, 'webviewViewResolve', { viewId }).then((id) => !cancelled && typeof id === 'string' && setPanelId(id)).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [ready, viewId])
  return (
    <Section id={'wv-' + viewId} title={name}>
      <div className="webview-view" data-ext-webview-view={viewId}>
        {panel ? <WebviewFrame panel={panel} visible /> : <div className="ex-empty">{ready ? 'Loading…' : 'Waiting for the extension…'}</div>}
      </div>
    </Section>
  )
}

export function ExtTreeView({ viewId, name, onOpenFile }: { viewId: string; name: string; onOpenFile: (path: string) => void }): JSX.Element {
  const liveKey = useLiveKey()
  const ready = liveKey.split('|').includes(viewId)
  const [nodes, setNodes] = useState<Map<number, Item[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [note, setNote] = useState('Loading…')
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  // What the extensions put in a node's menu.
  const menus = useExtensions().filter((e) => e.enabled && e.views.some((v) => v.id === viewId)).flatMap((e) => e.treeMenus ?? [])
  const [menu, setMenu] = useState<{ x: number; y: number; item: Item } | null>(null)

  const load = useCallback(
    async (handle: number): Promise<void> => {
      const res = (await window.api.extProvide(viewId, 'treeChildren', { viewId, handle: handle === ROOT ? null : handle }).catch(() => null)) as Item[] | null
      if (!res) return
      setNodes((cur) => new Map(cur).set(handle, res))
      if (handle === ROOT) setNote(res.length ? '' : 'There is nothing to show.')
    },
    [viewId]
  )

  // First load, and again whenever the extension registers (or re-registers) the view.
  useEffect(() => {
    setNodes(new Map())
    setExpanded(new Set())
    if (ready) void load(ROOT)
    else setNote('Waiting for the extension…')
  }, [ready, load])

  // The extension says something changed.
  useEffect(() => {
    let set = changedListeners.get(viewId)
    if (!set) changedListeners.set(viewId, (set = new Set()))
    const cb = (handle: number | null): void => {
      if (handle === null) {
        void load(ROOT)
        for (const h of expandedRef.current) void load(h)
      } else void load(handle)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
    }
  }, [viewId, load])

  const toggle = (it: Item): void => {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(it.handle)) next.delete(it.handle)
      else {
        next.add(it.handle)
        if (!nodes.has(it.handle)) void load(it.handle)
      }
      return next
    })
  }
  const activate = (it: Item): void => {
    if (it.hasCommand) void window.api.extProvide(viewId, 'treeAction', { viewId, handle: it.handle })
    else if (it.resource && !it.collapsible) onOpenFile(it.resource)
  }

  const run = (it: Item, command: string): void => void window.api.extProvide(viewId, 'treeCommand', { viewId, handle: it.handle, command })
  const menuItems = (it: Item): MenuItem[] => {
    const entries = entriesFor(menus, viewId, it).filter((m) => !isInline(m))
    return entries.map((m, i) => ({ label: m.title, run: () => run(it, m.command), separator: i > 0 && menuOrder(m.group).name !== menuOrder(entries[i - 1].group).name }))
  }

  const root = nodes.get(ROOT) ?? []
  return (
    <Section id={'xt-' + viewId} title={name}>
      <div role="tree" aria-label={name} data-ext-tree={viewId}>
        <TreeRows viewId={viewId} items={root} depth={0} expanded={expanded} onToggle={toggle} onActivate={activate} menus={menus} onMenu={(item, x, y) => entriesFor(menus, viewId, item).some((m) => !isInline(m)) && setMenu({ x, y, item })} onRun={run}>
          {(it) => nodes.get(it.handle)}
        </TreeRows>
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.item)} onClose={() => setMenu(null)} />}
        {note && !root.length && <div className="ex-empty">{note}</div>}
      </div>
    </Section>
  )
}
