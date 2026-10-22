import { useState } from 'react'
import type { GitFile } from '../../main/git'
import { refreshGit, useGit } from './gitStore'

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
  onDiscard
}: {
  file: GitFile
  letter: string
  staged: boolean
  onDiff: () => void
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
}): JSX.Element {
  const { name, dir } = split(file.rel)
  return (
    <div className="git-row" data-git-file={file.rel} data-git-staged={staged} onClick={onDiff} title={file.rel}>
      <span className="git-name">
        {name}
        {dir && <span className="git-dir">{dir}</span>}
      </span>
      <span className="git-actions" onClick={(e) => e.stopPropagation()}>
        <button title="Open file" onClick={onOpen}>
          ↗
        </button>
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
  root,
  onOpenDiff,
  onOpenFile,
  onChanged
}: {
  root: string | null
  onOpenDiff: (file: GitFile, staged: boolean) => void
  onOpenFile: (abs: string) => void
  // Called after anything that may have changed files on disk (discard, branch switch, pull).
  onChanged: () => void
}): JSX.Element {
  const { status } = useGit()
  const [message, setMessage] = useState('')
  const [note, setNote] = useState<Note>(null)
  const [busy, setBusy] = useState<string | null>(null)

  if (!root) return <div className="empty">Open a folder to use source control.</div>
  if (status.state === 'nogit') {
    return (
      <div className="empty">
        <p>Git was not found on this PC.</p>
        <p>Install Git for Windows (git-scm.com), then restart the app.</p>
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

  return (
    <div className="git">
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
          <div className={'git-note ' + note.kind} data-git-note>
            {note.text}
          </div>
        )}
      </div>

      <div className="git-group">
        <span>Staged Changes {staged.length > 0 && <span className="git-count">{staged.length}</span>}</span>
        {staged.length > 0 && (
          <button title="Unstage all" data-git-action="unstage-all" onClick={() => void run('unstage', () => window.api.gitUnstage(root, null))}>
            −
          </button>
        )}
      </div>
      {staged.map((f) => (
        <Row
          key={'s' + f.rel}
          file={f}
          letter={f.index}
          staged
          onDiff={() => onOpenDiff(f, true)}
          onOpen={() => onOpenFile(f.abs)}
          onStage={() => undefined}
          onUnstage={() => void run('unstage', () => window.api.gitUnstage(root, [f.rel]))}
          onDiscard={() => undefined}
        />
      ))}

      <div className="git-group">
        <span>Changes {changes.length > 0 && <span className="git-count">{changes.length}</span>}</span>
        {changes.length > 0 && (
          <button title="Stage all" data-git-action="stage-all" onClick={() => void run('stage', () => window.api.gitStage(root, null))}>
            +
          </button>
        )}
      </div>
      {changes.map((f) => (
        <Row
          key={'c' + f.rel}
          file={f}
          letter={isConflict(f) ? '!' : f.work === '?' ? 'U' : f.work}
          staged={false}
          onDiff={() => onOpenDiff(f, false)}
          onOpen={() => onOpenFile(f.abs)}
          onStage={() => void run('stage', () => window.api.gitStage(root, [f.rel]))}
          onUnstage={() => undefined}
          onDiscard={() => void discard(f)}
        />
      ))}
      {staged.length === 0 && changes.length === 0 && <div className="empty">No changes. The working tree is clean.</div>}
    </div>
  )
}
