import { useEffect, useState } from 'react'
import type { CommitEntry, CommitFile, GitFile, StashEntry } from '../../main/git'
import { refreshGit, useGit } from './gitStore'
import { Section } from './ExplorerSections'
import { ContextMenu, MenuItem } from './ContextMenu'
import { useExtensions } from './extStore'
import { fileMenuEntries, fileMenuItems, runFileMenuEntry } from './extFileMenus'

type Note = { kind: 'ok' | 'error'; text: string } | null

const isConflict = (f: GitFile): boolean =>
  f.index === 'U' || f.work === 'U' || (f.index === 'A' && f.work === 'A') || (f.index === 'D' && f.work === 'D')

const split = (rel: string): { name: string; dir: string } => {
  const i = rel.lastIndexOf('/')
  return { name: rel.slice(i + 1), dir: i < 0 ? '' : rel.slice(0, i) }
}

const LETTER_TITLES: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Untracked',
  '!': 'Merge conflict'
}

function Row({
  file,
  letter,
  staged,
  onDiff,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  onTake,
  onMerge,
  onMenu
}: {
  file: GitFile
  letter: string
  staged: boolean
  onDiff: () => void
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  onTake?: (side: 'ours' | 'theirs') => void
  onMerge?: () => void
  onMenu?: (x: number, y: number) => void // right-click: the entries extensions add ("scm/resourceState/context")
}): JSX.Element {
  const { name, dir } = split(file.rel)
  return (
    <div
      className="git-row"
      data-git-file={file.rel}
      data-git-staged={staged}
      onClick={onDiff}
      title={file.rel}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault()
              onMenu(e.clientX, e.clientY)
            }
          : undefined
      }
    >
      <span className="git-name">
        {name}
        {dir && <span className="git-dir">{dir}</span>}
      </span>
      <span className="git-actions" onClick={(e) => e.stopPropagation()}>
        <button title="Open file" onClick={onOpen}>
          ↗
        </button>
        {onMerge && (
          <button title="Open the three-way merge editor" data-git-action="merge-editor" onClick={onMerge}>
            ⇄
          </button>
        )}
        {onTake && (
          <>
            <button title="Resolve: keep the current branch version" data-git-action="take-ours" onClick={() => onTake('ours')}>
              ◀
            </button>
            <button title="Resolve: take the incoming version" data-git-action="take-theirs" onClick={() => onTake('theirs')}>
              ▶
            </button>
          </>
        )}
        {!staged && (
          <button title="Discard changes" data-git-action="discard" onClick={onDiscard}>
            ↶
          </button>
        )}
        {staged ? (
          <button title="Unstage" data-git-action="unstage" onClick={onUnstage}>
            −
          </button>
        ) : (
          <button title="Stage" data-git-action="stage" onClick={onStage}>
            +
          </button>
        )}
      </span>
      <span className={`git-letter gs-${letter}`} title={LETTER_TITLES[letter] ?? letter}>
        {letter}
      </span>
    </div>
  )
}

export function GitPanel({
  root: primary,
  roots,
  onOpenDiff,
  onOpenFile,
  onChanged,
  onOpenCommitDiff,
  onOpenMerge,
  historyFor
}: {
  root: string | null
  // All workspace folders; with more than one, a picker chooses which repository the panel shows.
  roots: string[]
  onOpenCommitDiff: (hash: string, short: string, file: CommitFile, repo: string) => void
  // Opens the merge editor for a conflicted file (absolute path) of the given repository.
  onOpenMerge: (abs: string, repo: string) => void
  // Asks the panel to show the history of one file (path relative to `repo`, or absolute); n changes on every request.
  historyFor: { abs: string; n: number } | null
  onOpenDiff: (file: GitFile, staged: boolean, repo: string) => void
  onOpenFile: (abs: string) => void
  // Called after anything that may have changed files on disk (discard, branch switch, pull).
  onChanged: () => void
}): JSX.Element {
  const g = useGit()
  useExtensions() // the menus follow the installed extensions
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const { version } = g
  const [picked, setPicked] = useState<string | null>(null)
  // The folder whose repository is shown: the picked one while it is still in the workspace, else the main one.
  const root = picked && roots.includes(picked) ? picked : primary
  const status = (root && g.byRoot[root]) || g.status
  const [message, setMessage] = useState('')
  const [note, setNote] = useState<Note>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [stashes, setStashes] = useState<StashEntry[]>([])
  const [stashMsg, setStashMsg] = useState('')
  const [merging, setMerging] = useState(false)
  const [commits, setCommits] = useState<CommitEntry[]>([])
  const [more, setMore] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)
  const [open, setOpen] = useState<{ hash: string; files: CommitFile[] } | null>(null)

  const ok = status.state === 'ok'
  // Stashes and the merge state live in git, not in the status output, so look them up when the status refreshes.
  useEffect(() => {
    if (!root || !ok) {
      setStashes([])
      setMerging(false)
      return
    }
    let cancelled = false
    void Promise.all([window.api.gitStashList(root), window.api.gitMergeState(root)]).then(([s, m]) => {
      if (cancelled) return
      setStashes(s.stashes)
      setMerging(m.merging)
    })
    return () => {
      cancelled = true
    }
  }, [root, ok, version])

  const loadHistory = async (reset: boolean): Promise<void> => {
    if (!root) return
    const r = await window.api.gitLog(root, filter, reset ? 0 : commits.length, 50)
    if (!r.ok) return setNote({ kind: 'error', text: r.error ?? 'Could not read the history.' })
    setCommits((cur) => (reset ? r.commits : [...cur, ...r.commits]))
    setMore(r.commits.length === 50)
  }
  useEffect(() => {
    if (view === 'history' && ok) void loadHistory(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, filter, root, ok, version])
  useEffect(() => {
    if (historyFor) {
      const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/$/, '')
      const abs = norm(historyFor.abs)
      const owner = roots.find((r) => abs.toLowerCase().startsWith(norm(r).toLowerCase() + '/'))
      if (owner) {
        setPicked(owner)
        setFilter(abs.slice(norm(owner).length + 1))
      }
      setView('history')
      setOpen(null)
    }
  }, [historyFor])
  useEffect(() => setOpen(null), [root, filter])

  const toggleCommit = async (c: CommitEntry): Promise<void> => {
    if (open?.hash === c.hash) return setOpen(null)
    if (!root) return
    const r = await window.api.gitCommitFiles(root, c.hash)
    setOpen({ hash: c.hash, files: r.files })
  }

  if (!root) return <div className="empty">Open a folder to use source control.</div>
  if (status.state === 'remote') return <div className="empty">Source control could not reach git on the remote computer.</div>
  if (status.state === 'nogit') {
    return (
      <div className="empty">
        <p>Git was not found on this PC.</p>
        <p>Install Git for Windows (git-scm.com), then restart the app.</p>
      </div>
    )
  }
  if (status.state === 'norepo' && status.unsafe) {
    return (
      <div className="empty" data-git-unsafe>
        <p>Git will not use this folder because it belongs to another user (this is usual for folders inside WSL).</p>
        <p>You can tell Git that it is safe. This adds one line to your global Git settings:</p>
        <p><code>safe.directory = {status.unsafe}</code></p>
        <button
          className="primary"
          data-git-action="trust"
          onClick={async () => {
            const r = await window.api.gitTrust(root)
            if (!r.ok) setNote({ kind: 'error', text: r.error })
            await refreshGit(primary)
          }}
        >
          Trust this folder
        </button>
        {note && <div className={'git-note ' + note.kind}>{note.text}</div>}
      </div>
    )
  }
  if (status.state === 'norepo') {
    return (
      <div className="empty">
        <p>This folder is not a Git repository.</p>
        <button
          className="primary"
          data-git-action="init"
          onClick={async () => {
            const r = await window.api.gitInit(root)
            if (!r.ok) setNote({ kind: 'error', text: r.error })
            await refreshGit(root)
          }}
        >
          Initialize Repository
        </button>
        {note && <div className={'git-note ' + note.kind}>{note.text}</div>}
      </div>
    )
  }

  const staged = status.files.filter((f) => f.index !== ' ' && f.index !== '?' && !isConflict(f))
  const changes = status.files.filter((f) => (f.work !== ' ' || f.index === '?' || isConflict(f)))

  // Runs one git operation, shows its failure (or a short success note) and refreshes everything.
  const run = async (label: string, op: () => Promise<{ ok: boolean; error?: string; output?: string }>, okText?: string): Promise<boolean> => {
    setBusy(label)
    setNote(null)
    try {
      const r = await op()
      if (!r.ok) setNote({ kind: 'error', text: r.error ?? 'The command failed.' })
      else if (okText || r.output) setNote({ kind: 'ok', text: okText ?? (r.output ?? '').split('\n').slice(-1)[0] })
      await refreshGit(root)
      onChanged()
      return r.ok
    } finally {
      setBusy(null)
    }
  }

  // The right-click menu of a changed file holds only what extensions add (the row's own buttons do the rest).
  const openFileMenu = (x: number, y: number, f: GitFile, scmGroup: 'index' | 'workingTree' | 'merge' | 'untracked'): void => {
    const items = fileMenuItems('scmResourceMenus', f.abs, { scmGroup }, { resourceUri: { $uri: f.abs } })
    if (items.length) setFileMenu({ x, y, items: items.map((it, i) => (i === 0 ? { ...it, separator: false } : it)) })
  }

  // Right-click on the header of Staged Changes / Changes: what extensions add ("scm/resourceGroup/context"); the command gets the group.
  const openGroupMenu = (x: number, y: number, scmGroup: 'index' | 'workingTree', label: string, files: GitFile[]): void => {
    const arg = { id: scmGroup, label, resourceStates: files.map((f) => ({ resourceUri: { $uri: f.abs } })) }
    const items = fileMenuItems('scmGroupMenus', root, { scmGroup, isDir: true }, arg)
    if (items.length) setFileMenu({ x, y, items: items.map((it, i) => (i === 0 ? { ...it, separator: false } : it)) })
  }

  const commit = async (): Promise<void> => {
    if (await run('commit', () => window.api.gitCommit(root, message), 'Committed.')) setMessage('')
  }

  const generate = async (): Promise<void> => {
    setBusy('generate')
    setNote(null)
    const r = await window.api.gitGenerateMessage(root)
    setBusy(null)
    if (r.ok) setMessage(r.message)
    else setNote({ kind: 'error', text: r.error })
  }

  const discard = async (f: GitFile): Promise<void> => {
    const untracked = f.index === '?'
    const ask = untracked ? `Move ${f.rel} to the Recycle Bin?` : `Discard all changes to ${f.rel}? This cannot be undone.`
    if (!window.confirm(ask)) return
    await run('discard', () => window.api.gitDiscard(root, untracked ? [] : [f.rel], untracked ? [f.rel] : []))
  }

  const ahead = status.ahead ?? 0
  const behind = status.behind ?? 0

  const conflicts = status.files.filter(isConflict)
  const when = (ms: number): string => {
    const d = Date.now() - ms
    if (d < 60_000) return 'just now'
    if (d < 3_600_000) return Math.floor(d / 60_000) + ' min ago'
    if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' h ago'
    if (d < 30 * 86_400_000) return Math.floor(d / 86_400_000) + ' d ago'
    return new Date(ms).toLocaleDateString()
  }

  const stash = async (): Promise<void> => {
    if (await run('stash', () => window.api.gitStashPush(root, stashMsg, true), 'Changes stashed.')) setStashMsg('')
  }

  const history = (
    <div className="git-history" data-git-history>
      {filter && (
        <div className="git-filter">
          <span title={filter}>History of {split(filter).name}</span>
          <button data-git-action="clear-filter" onClick={() => setFilter(null)}>
            Show all
          </button>
        </div>
      )}
      {commits.length === 0 && <div className="empty">{status.hasCommits === false ? 'No commits yet.' : 'No commits.'}</div>}
      {commits.map((c) => (
        <div key={c.hash}>
          <div className={'git-commit-item' + (open?.hash === c.hash ? ' open' : '')} data-git-commit={c.hash} onClick={() => void toggleCommit(c)} title={c.hash}>
            <span className="git-subject">{c.subject}</span>
            <span className="git-meta">
              {c.refs.map((r) => (
                <span key={r} className="git-ref">
                  {r.replace('HEAD -> ', '')}
                </span>
              ))}
              {c.short} · {c.author} · {when(c.date)}
            </span>
          </div>
          {open?.hash === c.hash &&
            open.files.map((f) => (
              <div key={f.rel} className="git-row git-commit-file" data-git-commit-file={f.rel} onClick={() => onOpenCommitDiff(c.hash, c.short, f, root)} title={f.orig ? `${f.orig} → ${f.rel}` : f.rel}>
                <span className="git-name">
                  {split(f.rel).name}
                  {split(f.rel).dir && <span className="git-dir">{split(f.rel).dir}</span>}
                </span>
                <span className={`git-letter gs-${f.status}`} title={LETTER_TITLES[f.status] ?? f.status}>
                  {f.status}
                </span>
              </div>
            ))}
        </div>
      ))}
      {more && (
        <button className="git-more" data-git-action="load-more" onClick={() => void loadHistory(false)}>
          Load more
        </button>
      )}
    </div>
  )

  return (
    <div className="git">
      {roots.length > 1 && (
        <select className="git-repo" data-git-repo value={root} onChange={(e) => setPicked(e.target.value)}>
          {roots.map((r) => (
            <option key={r} value={r}>
              {r.split(/[\\/]/).filter(Boolean).pop()}
            </option>
          ))}
        </select>
      )}
      <div className="git-views">
        <button className={view === 'changes' ? 'on' : ''} data-git-view="changes" onClick={() => setView('changes')}>
          Changes
        </button>
        <button className={view === 'history' ? 'on' : ''} data-git-view="history" onClick={() => setView('history')}>
          History
        </button>
      </div>
      {merging && (
        <div className="git-merge" data-git-merge>
          <span>
            Merge in progress{conflicts.length > 0 ? `: ${conflicts.length} conflicted file${conflicts.length > 1 ? 's' : ''}` : '. Commit to finish.'}
          </span>
          <button
            data-git-action="merge-abort"
            disabled={!!busy}
            onClick={() => {
              if (window.confirm('Abort the merge and go back to how things were before it?')) void run('abort', () => window.api.gitMergeAbort(root), 'Merge aborted.')
            }}
          >
            Abort
          </button>
        </div>
      )}
      {view === 'history' ? (
        history
      ) : (
        <>
      <div className="git-head">
        <span className="git-branch" data-git-branch title={status.upstream ? `Tracking ${status.upstream}` : 'No upstream branch'}>
          ⎇ {status.branch ?? '…'}
          {(ahead > 0 || behind > 0) && (
            <span className="git-sync">
              {ahead > 0 && ` ↑${ahead}`}
              {behind > 0 && ` ↓${behind}`}
            </span>
          )}
        </span>
        <span className="git-head-actions">
          <button title="Fetch" data-git-action="fetch" disabled={!!busy} onClick={() => void run('fetch', () => window.api.gitRemote(root, 'fetch'), 'Fetched.')}>
            Fetch
          </button>
          <button title="Pull" data-git-action="pull" disabled={!!busy} onClick={() => void run('pull', () => window.api.gitRemote(root, 'pull'), 'Pulled.')}>
            Pull
          </button>
          <button title="Push" data-git-action="push" disabled={!!busy} onClick={() => void run('push', () => window.api.gitRemote(root, 'push'), 'Pushed.')}>
            Push
          </button>
          <button title="Refresh" data-git-action="refresh" onClick={() => void refreshGit(root)}>
            ⟳
          </button>
          {fileMenuEntries('scmTitleMenus', root).map((m) => (
            <button key={m.extId + m.command} title={m.title} data-ext-scm-title={m.command} onClick={() => runFileMenuEntry(m, root, { rootUri: { $uri: root }, id: 'git', label: 'Git' })}>
              {m.title}
            </button>
          ))}
        </span>
      </div>

      <div className="git-commit">
        <textarea
          rows={3}
          value={message}
          data-git-message
          placeholder="Message (Ctrl+Enter to commit)"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void commit()
            }
          }}
        />
        <div className="git-commit-row">
          <button
            title="Write a commit message from the staged changes with Claude"
            data-git-action="generate"
            disabled={!!busy || staged.length === 0}
            onClick={() => void generate()}
          >
            {busy === 'generate' ? 'Writing…' : '✦ Generate message'}
          </button>
          <button
            className="primary"
            data-git-action="commit"
            disabled={!!busy || staged.length === 0 || !message.trim()}
            onClick={() => void commit()}
          >
            Commit
          </button>
        </div>
        {note && (
          <div className={'git-note ' + note.kind} data-git-note role={note.kind === 'error' ? 'alert' : 'status'}>
            {note.text}
          </div>
        )}
      </div>

      <Section
        id="git-staged"
        title="Staged Changes"
        onMenu={(x, y) => openGroupMenu(x, y, 'index', 'Staged Changes', staged)}
        count={staged.length > 0 ? staged.length : undefined}
        actions={
          staged.length > 0 ? (
            <button title="Unstage all" aria-label="Unstage all" data-git-action="unstage-all" onClick={() => void run('unstage', () => window.api.gitUnstage(root, null))}>
              −
            </button>
          ) : undefined
        }
      >
      {staged.map((f) => (
        <Row
          key={'s' + f.rel}
          file={f}
          letter={f.index}
          staged
          onDiff={() => onOpenDiff(f, true, root)}
          onOpen={() => onOpenFile(f.abs)}
          onStage={() => undefined}
          onUnstage={() => void run('unstage', () => window.api.gitUnstage(root, [f.rel]))}
          onDiscard={() => undefined}
          onMenu={(x, y) => openFileMenu(x, y, f, 'index')}
        />
      ))}
      </Section>

      <Section
        id="git-changes"
        title="Changes"
        onMenu={(x, y) => openGroupMenu(x, y, 'workingTree', 'Changes', changes)}
        count={changes.length > 0 ? changes.length : undefined}
        actions={
          changes.length > 0 ? (
            <button title="Stage all" aria-label="Stage all" data-git-action="stage-all" onClick={() => void run('stage', () => window.api.gitStage(root, null))}>
              +
            </button>
          ) : undefined
        }
      >
      {changes.map((f) => (
        <Row
          key={'c' + f.rel}
          file={f}
          letter={isConflict(f) ? '!' : f.work === '?' ? 'U' : f.work}
          staged={false}
          onDiff={() => onOpenDiff(f, false, root)}
          onOpen={() => onOpenFile(f.abs)}
          onStage={() => void run('stage', () => window.api.gitStage(root, [f.rel]))}
          onUnstage={() => undefined}
          onDiscard={() => void discard(f)}
          onMenu={(x, y) => openFileMenu(x, y, f, isConflict(f) ? 'merge' : f.work === '?' ? 'untracked' : 'workingTree')}
          onMerge={isConflict(f) ? () => onOpenMerge(f.abs, root) : undefined}
          onTake={isConflict(f) ? (side) => void run('take', () => window.api.gitTake(root, f.rel, side), side === 'ours' ? 'Kept the current version.' : 'Took the incoming version.') : undefined}
        />
      ))}
      {staged.length === 0 && changes.length === 0 && <div className="empty">No changes. The working tree is clean.</div>}
      </Section>

      <Section id="git-stashes" title="Stashes" count={stashes.length > 0 ? stashes.length : undefined}>
      <div className="git-stash-new">
        <input
          value={stashMsg}
          data-git-stash-message
          placeholder="Stash message (optional)"
          onChange={(e) => setStashMsg(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void stash()}
        />
        <button data-git-action="stash" title="Set aside all changes, including new files" disabled={!!busy || (staged.length === 0 && changes.length === 0)} onClick={() => void stash()}>
          Stash
        </button>
      </div>
      {stashes.map((s) => (
        <div key={s.index} className="git-row git-stash" data-git-stash={s.index} title={new Date(s.date).toLocaleString()}>
          <span className="git-name">
            {s.message.replace(/^(On|WIP on) [^:]+: /, '')}
            <span className="git-dir">{when(s.date)}</span>
          </span>
          <span className="git-actions">
            <button title="Apply and keep the stash" data-git-action="stash-apply" onClick={() => void run('stash', () => window.api.gitStashApply(root, s.index, false), 'Stash applied.')}>
              ↷
            </button>
            <button title="Pop: apply and delete the stash" data-git-action="stash-pop" onClick={() => void run('stash', () => window.api.gitStashApply(root, s.index, true), 'Stash applied and removed.')}>
              ⤓
            </button>
            <button
              title="Delete the stash"
              data-git-action="stash-drop"
              onClick={() => window.confirm('Delete this stash? This cannot be undone.') && void run('stash', () => window.api.gitStashDrop(root, s.index))}
            >
              ✕
            </button>
          </span>
        </div>
      ))}
      </Section>
        </>
      )}
      {fileMenu && <ContextMenu x={fileMenu.x} y={fileMenu.y} items={fileMenu.items} onClose={() => setFileMenu(null)} />}
    </div>
  )
}
