import { useEffect, useRef, useState } from 'react'
import type { BgTask } from '../../main/background'
import { MODELS } from './models'
import { getSettings, useSettings } from './settings'
import { initBackground, useBgTasks } from './bgStore'

const STATUS_LABEL: Record<BgTask['status'], string> = {
  running: 'Working',
  waiting: 'Needs approval',
  done: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  applied: 'Applied'
}

const LETTER_TITLE: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied' }

function elapsed(t: BgTask): string {
  const s = Math.max(0, Math.round(((t.finished ?? Date.now()) - t.started) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function Card({
  t,
  onOpenDiff,
  onApplied
}: {
  t: BgTask
  onOpenDiff: (title: string, abs: string, original: string, modified: string) => void
  onApplied: () => void
}): JSX.Element {
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    if (t.status !== 'running' && t.status !== 'waiting') return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [t.status])

  const finished = t.status === 'done' || t.status === 'failed' || t.status === 'stopped'
  const apply = async (): Promise<void> => {
    if (!window.confirm(`Apply the agent's changes to ${t.files.length} file(s) in your project?\n\nThey are added to your working tree (not committed) and you can review them in Source Control.`)) return
    const r = await window.api.bgApply(t.id)
    if (!r.ok) return setNote({ kind: 'error', text: r.error })
    setNote({ kind: r.conflicts ? 'error' : 'ok', text: r.conflicts ? 'Applied, but some files conflict with your own changes. Resolve them in Source Control.' : 'Applied to your working tree.' })
    onApplied()
  }
  const discard = async (): Promise<void> => {
    const what = t.status === 'applied' ? 'Remove this task and its separate copy?' : 'Discard this task, its changes and its separate copy of the project? This cannot be undone.'
    if (window.confirm(what)) await window.api.bgDiscard(t.id)
  }
  const openFile = async (f: BgTask['files'][number]): Promise<void> => {
    const r = await window.api.bgFileDiff(t.id, f.rel, f.orig)
    onOpenDiff(`${f.rel.split('/').pop()} (agent)`, r.abs, r.original, r.modified)
  }

  return (
    <div className={'bg-card bg-' + t.status} data-bg-card={t.id} data-bg-status={t.status}>
      <div className="bg-head">
        <span className="bg-pill" data-bg-pill>
          {STATUS_LABEL[t.status]}
        </span>
        <span className="bg-time">{elapsed(t)}</span>
      </div>
      <div className="bg-task" title={t.task}>
        {t.task}
      </div>
      {(t.status === 'running' || t.status === 'waiting') && (
        <div className="bg-activity">
          {t.activity || 'Working…'} · {t.steps} step{t.steps === 1 ? '' : 's'}
        </div>
      )}
      {t.status === 'waiting' && t.waitCommand && t.waitId && (
        <div className="bg-wait" data-bg-wait>
          <div>Wants to run:</div>
          <pre>{t.waitCommand}</pre>
          <div className="bg-actions">
            <button className="primary" data-bg-action="run" onClick={() => window.api.agentApprove(t.runId, t.waitId!, true)}>
              Run
            </button>
            <button data-bg-action="skip" onClick={() => window.api.agentApprove(t.runId, t.waitId!, false)}>
              Skip
            </button>
          </div>
        </div>
      )}
      {t.summary && <div className="bg-summary" data-bg-summary>{t.summary}</div>}
      {t.error && <div className="chat-error">{t.error}</div>}
      {(finished || t.status === 'applied') && t.files.length > 0 && (
        <div className="bg-files">
          <div className="bg-files-title">
            {t.files.length} changed file{t.files.length === 1 ? '' : 's'}
          </div>
          {t.files.map((f) => (
            <div key={f.rel} className="git-row" data-bg-file={f.rel} onClick={() => void openFile(f)} title={f.orig ? `${f.orig} → ${f.rel}` : f.rel}>
              <span className="git-name">{f.rel}</span>
              <span className={`git-letter gs-${f.status}`} title={LETTER_TITLE[f.status] ?? f.status}>
                {f.status}
              </span>
            </div>
          ))}
        </div>
      )}
      {finished && t.files.length === 0 && !t.error && <div className="bg-none">The agent made no changes.</div>}
      {note && (
        <div className={'git-note ' + note.kind} data-bg-note role={note.kind === 'error' ? 'alert' : 'status'}>
          {note.text}
        </div>
      )}
      <div className="bg-actions">
        {(t.status === 'running' || t.status === 'waiting') && (
          <button data-bg-action="stop" onClick={() => void window.api.bgStop(t.id)}>
            Stop
          </button>
        )}
        {finished && t.files.length > 0 && (
          <button className="primary" data-bg-action="apply" onClick={() => void apply()}>
            Apply to my files
          </button>
        )}
        {t.status !== 'running' && t.status !== 'waiting' && (
          <button data-bg-action="discard" onClick={() => void discard()}>
            {t.status === 'applied' ? 'Remove' : 'Discard'}
          </button>
        )}
        <span className="bg-branch" title={`Its work is kept on the git branch ${t.branch}`}>
          {t.branch}
        </span>
      </div>
    </div>
  )
}

export function BackgroundPanel({
  root,
  focusSignal,
  prefill,
  onOpenDiff,
  onApplied
}: {
  root: string | null
  // Changes each time the box should take focus.
  focusSignal: number
  // A task typed elsewhere (e.g. in the agent panel) to start; n changes with every request.
  prefill: { text: string; n: number } | null
  onOpenDiff: (title: string, abs: string, original: string, modified: string) => void
  onApplied: () => void
}): JSX.Element {
  const tasks = useBgTasks()
  const defaultModel = useSettings().defaultModel
  const [text, setText] = useState('')
  const [model, setModel] = useState(getSettings().defaultModel)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => initBackground(), [])
  useEffect(() => setModel(defaultModel), [defaultModel])
  useEffect(() => box.current?.focus(), [focusSignal])

  const start = async (task: string): Promise<void> => {
    if (!root || !task.trim() || starting) return
    setStarting(true)
    setError(null)
    try {
      const r = await window.api.bgStart(root, task, model)
      if (!r.ok) return setError(r.error)
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const lastPrefill = useRef(0)
  useEffect(() => {
    if (!prefill || prefill.n === lastPrefill.current) return
    lastPrefill.current = prefill.n
    void start(prefill.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill])

  // Only tasks of this project.
  const mine = tasks.filter((t) => !root || t.root.replace(/\\/g, '/').toLowerCase() === root.replace(/\\/g, '/').toLowerCase())

  if (!root) return <div className="empty">Open a folder to run background agents.</div>
  return (
    <div className="bg" data-bg-panel>
      <div className="bg-new">
        <textarea
          ref={box}
          rows={4}
          value={text}
          data-bg-input
          placeholder="Describe a task. A background agent works on its own copy of the project while you keep working. (Ctrl+Enter to start)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void start(text)
            }
          }}
        />
        <div className="bg-new-row">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button className="primary" data-bg-start disabled={starting || !text.trim()} onClick={() => void start(text)}>
            {starting ? 'Starting…' : 'Start'}
          </button>
        </div>
        {error && <div className="chat-error" data-bg-error>{error}</div>}
      </div>
      {mine.length === 0 && (
        <div className="empty">
          No background tasks yet. The agent starts from your files as they are now (changes to tracked files included; new untracked files are not).
          Its edits are applied in its own copy; nothing in your project changes until you review the result and click <b>Apply to my files</b>.
        </div>
      )}
      {mine.map((t) => (
        <Card key={t.id} t={t} onOpenDiff={onOpenDiff} onApplied={onApplied} />
      ))}
    </div>
  )
}
