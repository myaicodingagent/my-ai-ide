import { useEffect, useRef, useState } from 'react'
import { MODELS } from './models'
import { getSettings, useSettings } from './settings'
import { RulesChip } from './RulesChip'
import { Approval, ApprovalDialog, CommandApproval, CommandDialog } from './ApprovalDialog'

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; output?: string; isError?: boolean; live?: boolean }
  | { kind: 'change'; changeId: string; path: string; isNew: boolean; status: 'applied' | 'undone' | string }
  | { kind: 'error'; text: string }
  | { kind: 'notice'; text: string }

const ITEM_KINDS = ['user', 'assistant', 'tool', 'change', 'error', 'notice']
const MAX_SAVED_OUTPUT = 4000

// Saved conversations come from a file, so only well-formed items are restored.
const isItem = (x: unknown): x is Item =>
  !!x && typeof x === 'object' && ITEM_KINDS.includes((x as { kind?: string }).kind ?? '')

// What gets written to disk: tool outputs and inputs cut down to what the panel can show.
function compact(it: Item): Item {
  if (it.kind !== 'tool') return it
  const i = (it.input ?? {}) as Record<string, unknown>
  const small: Record<string, unknown> = {}
  for (const k of ['path', 'pattern', 'command']) if (typeof i[k] === 'string') small[k] = (i[k] as string).slice(0, 500)
  const out = it.output ?? 'No result (the run was interrupted).'
  return {
    ...it,
    input: small,
    live: false,
    isError: it.output === undefined ? true : it.isError,
    output: it.name === 'run_command' ? out.slice(-MAX_SAVED_OUTPUT) : out.slice(0, MAX_SAVED_OUTPUT)
  }
}

const describe = (name: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'list_dir':
      return `List ${i.path}`
    case 'read_file':
      return `Read ${i.path}`
    case 'search_text':
      return `Search "${i.pattern}" in ${i.path}`
    case 'find_files':
      return `Find ${i.pattern}`
    case 'edit_file':
      return `Edit ${i.path}`
    case 'write_file':
      return `Write ${i.path}`
    case 'run_command':
      return `Run: ${String(i.command).split('\n')[0].slice(0, 80)}`
    default:
      return name
  }
}

export function AgentPanel({
  root,
  onSwitch,
  onOpenFile,
  onRunInBackground,
  isDirty,
  onFileChanged,
  onWorkspaceTouched,
  onNeedsAttention
}: {
  root: string | null
  onSwitch: () => void
  onOpenFile: (path: string) => void
  // Hands the typed task to a background agent instead of running it here.
  onRunInBackground: (task: string) => void
  // A command ran, so files may have changed anywhere in the project.
  onWorkspaceTouched: () => void
  // Called when the agent is waiting for the user, so the panel can be brought to the front.
  onNeedsAttention: () => void
  // True if the file (relative to the project) has unsaved edits in the editor.
  isDirty: (relPath: string) => boolean
  // Called after the agent (or an undo) changed a file on disk. content null means it was deleted.
  onFileChanged: (absPath: string, content: string | null) => void
}): JSX.Element {
  const [pending, setPending] = useState<{ runId: number; approval: Approval } | null>(null)
  const [pendingCmd, setPendingCmd] = useState<{ runId: number; request: CommandApproval } | null>(null)
  const onTouchedRef = useRef(onWorkspaceTouched)
  onTouchedRef.current = onWorkspaceTouched
  const onFileChangedRef = useRef(onFileChanged)
  onFileChangedRef.current = onFileChanged
  const onNeedsAttentionRef = useRef(onNeedsAttention)
  onNeedsAttentionRef.current = onNeedsAttention
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState(getSettings().defaultModel)
  const defaultModel = useSettings().defaultModel
  useEffect(() => setModel(defaultModel), [defaultModel])
  // The agent's conversation belongs to the project folder, so it is the session id: reopening the folder
  // continues it. (Main process: the model's memory. Here: what the panel shows.)
  const sessionId = useRef('')
  sessionId.current = root ?? ''
  const runId = useRef(0)
  const activeRun = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Restore this folder's saved conversation. `loadedRoot` stops us saving (and so wiping) it before it is loaded.
  const loadedRoot = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    loadedRoot.current = null
    setItems([])
    if (!root) return
    void (async () => {
      const saved = (await window.api.agentLoadUi(root)).filter(isItem)
      const remembers = saved.length === 0 || (await window.api.agentHasSession(root))
      if (cancelled) return
      const restored: Item[] = remembers
        ? saved
        : [...saved, { kind: 'notice', text: 'The agent no longer has this earlier conversation in its memory. New requests start fresh.' }]
      setItems((cur) => [...restored, ...cur])
      loadedRoot.current = root
    })()
    return () => {
      cancelled = true
    }
  }, [root])

  // Save once a run has finished, not on every streamed fragment.
  useEffect(() => {
    if (!root || busy || loadedRoot.current !== root) return
    const t = setTimeout(() => void window.api.agentSaveUi(root, items.map(compact)), 500)
    return () => clearTimeout(t)
  }, [items, busy, root])

  useEffect(() => {
    return window.api.onAgentEvent((id, ev) => {
      if (id !== activeRun.current) return
      // Events with side effects are handled here, outside the state updater.
      if (ev.type === 'approval_request') {
        setPending({ runId: id, approval: ev })
        onNeedsAttentionRef.current()
        return
      }
      if (ev.type === 'command_request') {
        setPendingCmd({ runId: id, request: ev })
        onNeedsAttentionRef.current()
        return
      }
      if (ev.type === 'file_changed') {
        onFileChangedRef.current(ev.path, ev.content)
        return
      }
      if (ev.type === 'workspace_touched') {
        onTouchedRef.current()
        return
      }
      if (ev.type === 'done' || ev.type === 'error') {
        setPending(null)
        setPendingCmd(null)
      }
      setItems((prev) => {
        switch (ev.type) {
          case 'text': {
            const last = prev[prev.length - 1]
            if (last?.kind === 'assistant') {
              return [...prev.slice(0, -1), { kind: 'assistant', text: last.text + ev.text }]
            }
            return [...prev, { kind: 'assistant', text: ev.text }]
          }
          case 'tool_start':
            return [...prev, { kind: 'tool', id: ev.id, name: ev.name, input: ev.input }]
          case 'tool_output':
            return prev.map((it) =>
              it.kind === 'tool' && it.id === ev.id ? { ...it, output: (it.output ?? '') + ev.text, live: true } : it
            )
          case 'tool_end':
            return prev.map((it) =>
              it.kind === 'tool' && it.id === ev.id
                ? { ...it, output: ev.output, isError: ev.isError, live: false }
                : it
            )
          case 'applied':
            return [...prev, { kind: 'change', changeId: ev.changeId, path: ev.path, isNew: ev.isNew, status: 'applied' }]
          case 'error':
            return [...prev, { kind: 'error', text: ev.message }]
          default:
            return prev
        }
      })
      if (ev.type === 'done' || ev.type === 'error') {
        activeRun.current = null
        setBusy(false)
      }
    })
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [items])

  const send = (): void => {
    const task = input.trim()
    if (!task || busy || !root) return
    const id = ++runId.current
    activeRun.current = id
    setItems((prev) => [...prev, { kind: 'user', text: task }])
    setInput('')
    setBusy(true)
    window.api.agentRun({ runId: id, sessionId: sessionId.current, model, root, task })
  }

  const decide = (ok: boolean): void => {
    if (!pending) return
    window.api.agentApprove(pending.runId, pending.approval.id, ok)
    setPending(null)
  }

  const decideCommand = (ok: boolean): void => {
    if (!pendingCmd) return
    window.api.agentApprove(pendingCmd.runId, pendingCmd.request.id, ok)
    setPendingCmd(null)
  }

  const undo = async (changeId: string): Promise<void> => {
    const res = await window.api.agentUndo(sessionId.current, changeId)
    if (res.ok && res.path) onFileChanged(res.path, res.content ?? null)
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'change' && it.changeId === changeId
          ? { ...it, status: res.ok ? 'undone' : res.message }
          : it
      )
    )
  }

  const stop = (): void => {
    if (activeRun.current !== null) window.api.agentAbort(activeRun.current)
  }

  const reset = (): void => {
    if (busy) return
    window.api.agentReset(sessionId.current) // forgets the memory and deletes the saved files
    setItems([])
  }

  return (
    <aside className="chat" aria-label="AI agent">
      <div className="chat-header">
        <span>AGENT</span>
        <span>
          <RulesChip root={root} onOpen={onOpenFile} />
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button onClick={onSwitch}>Chat</button>
          <button onClick={reset}>New</button>
        </span>
      </div>
      <div className="chat-list" ref={listRef} role="document" tabIndex={0} aria-label="Agent conversation">
        {!root && <div className="empty">Open a folder to use the agent.</div>}
        {root && items.length === 0 && (
          <div className="empty">
            Ask a question or request a change. The agent can read and search your project, and
            every edit it proposes is shown as a diff for you to accept or reject.
          </div>
        )}
        {items.map((it, i) => {
          if (it.kind === 'user') return <div key={i} className="chat-msg user">{it.text}</div>
          if (it.kind === 'assistant')
            return (
              <div key={i} className="chat-msg assistant" style={{ whiteSpace: 'pre-wrap' }}>
                {it.text}
              </div>
            )
          if (it.kind === 'error') return <div key={i} className="chat-error">{it.text}</div>
          if (it.kind === 'notice') return <div key={i} className="chat-note">{it.text}</div>
          if (it.kind === 'change')
            return (
              <div key={i} className="agent-change">
                <span>
                  {it.isNew ? 'Created' : 'Changed'} <b>{it.path}</b>
                </span>
                {it.status === 'applied' ? (
                  <button onClick={() => void undo(it.changeId)}>Undo</button>
                ) : (
                  <span className="agent-change-status">{it.status === 'undone' ? 'Undone' : it.status}</span>
                )}
              </div>
            )
          return (
            <details key={i} className={'agent-tool' + (it.isError ? ' err' : '')}>
              <summary>
                {describe(it.name, it.input)}
                {it.live ? ' (running…)' : it.output === undefined ? ' …' : it.isError ? ' (failed)' : ''}
              </summary>
              {/* Commands show the end of their output (where errors usually are); other tools show the start. */}
              <pre>
                {it.output === undefined
                  ? ''
                  : it.name === 'run_command'
                    ? it.output.slice(-4000)
                    : it.output.slice(0, 4000)}
              </pre>
            </details>
          )
        })}
        {busy && <div className="chat-note">Working…</div>}
      </div>
      <div className="chat-input">
        <textarea
          rows={3}
          value={input}
          disabled={!root}
          placeholder="Ask the agent about your project... (Enter to send)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {busy ? <button onClick={stop}>Stop</button> : <button onClick={send}>Send</button>}
        <button
          data-agent-background
          title="Run this task in the background, on a separate copy of the project"
          disabled={!input.trim() || !root}
          onClick={() => {
            onRunInBackground(input.trim())
            setInput('')
          }}
        >
          ⤴ Background
        </button>
      </div>
      {pendingCmd && <CommandDialog request={pendingCmd.request} onDecide={decideCommand} />}
      {pending && (
        <ApprovalDialog
          approval={pending.approval}
          unsavedWarning={isDirty(pending.approval.path)}
          onDecide={decide}
        />
      )}
    </aside>
  )
}
