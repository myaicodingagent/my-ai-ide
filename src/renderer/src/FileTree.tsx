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

function Node({ entry, depth, ...tree }: { entry: DirEntry; depth: number } & TreeProps): JSX.Element {
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
      {open && children?.map((c) => <Node key={c.path} entry={c} depth={depth + 1} {...tree} />)}
    </div>
  )
}

export function FileTree({ root, ...tree }: { root: string } & TreeProps): JSX.Element {
  const [entries, setEntries] = useState<DirEntry[]>([])
  useEffect(() => {
    void readDir(root).then(setEntries)
  }, [root, tree.version])
  return (
    <>
      {entries.map((e) => (
        <Node key={e.path} entry={e} depth={0} {...tree} />
      ))}
    </>
  )
}
