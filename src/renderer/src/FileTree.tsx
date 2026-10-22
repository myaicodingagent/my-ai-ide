import { useEffect, useState } from 'react'

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface GitInfo {
  // Status letter per file (keys are lower-case paths with forward slashes), and folders containing changes.
  letters: Map<string, string>
  dirtyDirs: Set<string>
}

const key = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

// A folder can vanish between the moment we decide to read it and the read (deleted, moved, or removed by
// another program), so a failed read means "nothing there" rather than an error.
const readDir = (dir: string): Promise<DirEntry[]> => window.api.readDir(dir).catch(() => [])

// Brand-ish colours per file type; they read well on both light and dark themes.
const EXT_COLORS: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', js: '#d4b106', jsx: '#d4b106', mjs: '#d4b106', cjs: '#d4b106',
  json: '#c9a227', css: '#a371f7', scss: '#cd6799', html: '#e44d26', md: '#519aba', py: '#4b8bbe',
  go: '#00add8', rs: '#dea584', java: '#e76f00', c: '#6295cb', cpp: '#6295cb', cs: '#68217a',
  yml: '#cb171e', yaml: '#cb171e', sh: '#4eaa25', ps1: '#5391fe', svg: '#ffb13b', png: '#26a69a', jpg: '#26a69a'
}
const fileColor = (name: string): string => EXT_COLORS[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'var(--muted)'

function FolderIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg className="tree-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        d={open ? 'M1.5 4.5v8h11l2-6h-9l-1-2h-3z' : 'M1.5 3.5h4l1.5 1.5h7.5v7.5h-13z'}
        fill="var(--accent)"
        fillOpacity={open ? 0.55 : 0.8}
      />
    </svg>
  )
}

function FileIcon({ color }: { color: string }): JSX.Element {
  return (
    <svg className="tree-icon" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.5 1.5v3h3" fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

interface TreeProps {
  version: number
  selected: string | null
  // Ask to open the folder chain down to this path (after creating or revealing something).
  reveal: { path: string; n: number } | null
  git: GitInfo
  onOpen: (path: string) => void
  onSelect: (entry: DirEntry) => void
  onMenu: (entry: DirEntry, x: number, y: number) => void
}

function Node({ entry, depth, tabStop, ...tree }: { entry: DirEntry; depth: number; tabStop?: boolean } & TreeProps): JSX.Element {
  const { version, selected, reveal, git, onOpen, onSelect, onMenu } = tree
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)

  // When files change on disk (version bumps), reload an open folder and forget a closed one's cache.
  useEffect(() => {
    if (!entry.isDir) return
    if (open) void readDir(entry.path).then(setChildren)
    else setChildren(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  // Open this folder if the revealed path is inside it (reading it fresh, since it may have just changed).
  useEffect(() => {
    if (!reveal || !entry.isDir) return
    const target = key(reveal.path)
    const here = key(entry.path)
    if (target === here || target.startsWith(here + '/')) {
      void readDir(entry.path).then((c) => {
        setChildren(c)
        setOpen(true)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.n])

  const toggle = async (): Promise<void> => {
    onSelect(entry)
    if (!entry.isDir) return onOpen(entry.path)
    if (!open && children === null) setChildren(await readDir(entry.path))
    setOpen(!open)
  }

  const letter = git.letters.get(key(entry.path))
  const dirty = entry.isDir && git.dirtyDirs.has(key(entry.path))

  return (
    <div>
      <div
        className={'tree-row' + (selected !== null && key(selected) === key(entry.path) ? ' selected' : '')}
        style={{ paddingLeft: 10 + depth * 14 }}
        data-tree-path={entry.path}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={entry.isDir ? open : undefined}
        aria-selected={selected !== null && key(selected) === key(entry.path)}
        tabIndex={tabStop || (selected !== null && key(selected) === key(entry.path)) ? 0 : -1}
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onSelect(entry)
          onMenu(entry, e.clientX, e.clientY)
        }}
        title={entry.path}
      >
        <svg className={'tree-chevron' + (open ? ' open' : '')} viewBox="0 0 16 16" aria-hidden>
          {entry.isDir && <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />}
        </svg>
        {entry.isDir ? <FolderIcon open={open} /> : <FileIcon color={fileColor(entry.name)} />}
        <span className={'tree-name' + (letter ? ` gc-${letter}` : '')}>{entry.name}</span>
        {letter && <span className={`tree-git gs-${letter}`}>{letter}</span>}
        {dirty && !open && <span className="tree-dot" />}
      </div>
      {open && (
        <div role="group">
          {children?.map((c) => (
            <Node key={c.path} entry={c} depth={depth + 1} {...tree} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Keys for the explorer, put on the element that contains the rows: arrows move (Left/Right also fold and unfold
 * folders), Home/End jump, Enter or Space opens, Shift+F10 or the menu key opens the context menu.
 */
export function treeKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  const target = e.target as HTMLElement
  const row = target.closest<HTMLElement>('.tree-row')
  if (!row || !e.currentTarget.contains(row)) return
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.tree-row')]
  const at = rows.indexOf(row)
  const go = (i: number): void => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, i))]
    next?.focus()
    next?.scrollIntoView({ block: 'nearest' })
  }
  const level = Number(row.getAttribute('aria-level') ?? '1')
  const expanded = row.getAttribute('aria-expanded')
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      return go(at + 1)
    case 'ArrowUp':
      e.preventDefault()
      return go(at - 1)
    case 'Home':
      e.preventDefault()
      return go(0)
    case 'End':
      e.preventDefault()
      return go(rows.length - 1)
    case 'ArrowRight':
      e.preventDefault()
      if (expanded === 'false') row.click()
      else if (expanded === 'true') go(at + 1)
      return
    case 'ArrowLeft':
      e.preventDefault()
      if (expanded === 'true') row.click()
      else {
        // the folder this row is in: the nearest row above with a smaller level
        for (let i = at - 1; i >= 0; i--) {
          if (Number(rows[i].getAttribute('aria-level') ?? '1') < level) return go(i)
        }
      }
      return
    case 'Enter':
    case ' ':
      e.preventDefault()
      row.click()
      return
    case 'ContextMenu':
    case 'F10': {
      if (e.key === 'F10' && !e.shiftKey) return
      e.preventDefault()
      const r = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.bottom }))
      return
    }
  }
}

export function FileTree({ root, ...tree }: { root: string } & TreeProps): JSX.Element {
  const [entries, setEntries] = useState<DirEntry[]>([])
  useEffect(() => {
    void readDir(root).then(setEntries)
  }, [root, tree.version])
  return (
    <>
      {entries.map((e, i) => (
        <Node key={e.path} entry={e} depth={0} tabStop={i === 0} {...tree} />
      ))}
    </>
  )
}
