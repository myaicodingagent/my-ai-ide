import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MODELS } from './models'
import { getSettings, useSettings } from './settings'
import { SignInCard } from './AccountCard'
import { useAuth } from './authStore'
import { ChatImage, toChatImage } from './imageUtil'
import { RulesChip } from './RulesChip'

export interface EditorContext {
  path: string
  language: string
  text: string
  selection: string
}

interface Msg {
  role: 'user' | 'assistant'
  content: string
  error?: string
  note?: string
  usage?: { input: number; output: number } // tokens, shown under the reply
  images?: number // how many pictures were attached (the pictures themselves are not kept)
}

// Extra things the user can attach with @, besides files and folders.
const SPECIAL_MENTIONS = [
  { token: 'codebase', detail: 'Search the whole project for code relevant to your question' },
  { token: 'git', detail: 'The current changes (diff)' },
  { token: 'problems', detail: 'Errors and warnings in open files' },
  { token: 'terminal', detail: 'What the selected terminal shows' }
]

interface Suggestion {
  value: string // what goes into the message after the @
  label: string
  detail: string
}

// A block of context gathered from an @ mention.
interface Extra {
  title: string
  body: string
  note: string
}

// Larger files are not sent, rather than being silently cut off.
const MAX_CONTEXT_CHARS = 400_000

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

interface RefFile {
  path: string
  text: string
}

// Limits for @-mentioned files; anything over is skipped and reported, never cut off.
const MAX_REF_CHARS = 100_000
const MAX_REF_TOTAL = 300_000

function buildSystem(
  ctx: EditorContext | null,
  include: boolean,
  refs: RefFile[],
  skipped: string[],
  extras: Extra[],
  rules: string
): { system: string; note?: string } {
  let system =
    'You are an AI coding assistant built into a desktop code editor. Answer concisely. ' +
    'When you propose code, put it in fenced code blocks with a language tag so the user can insert it into the editor.' +
    rules
  if (refs.length) {
    system += '\n\nFiles the user referenced with @:'
    for (const r of refs) system += `\n\n### ${r.path}\n\`\`\`\n${r.text}\n\`\`\``
  }
  for (const e of extras) system += `\n\n${e.title}:\n${e.body}`
  const refNote = [
    ...refs.map((r) => `@${r.path}`),
    ...extras.map((e) => e.note),
    ...skipped.map((s) => `@${s} (not sent: binary, too large or unreadable)`)
  ].join(', ')
  if (!include || !ctx) return { system, note: refNote || undefined }
  if (ctx.text.length > MAX_CONTEXT_CHARS) {
    return {
      system,
      note: [`${baseName(ctx.path)} is too large to send as context.`, refNote]
        .filter(Boolean)
        .join(' · ')
    }
  }
  system += `\n\nThe user has this file open: ${baseName(ctx.path)} (${ctx.language}).`
  if (ctx.selection) {
    system += `\n\nSelected text:\n\`\`\`\n${ctx.selection}\n\`\`\``
  }
  system += `\n\nFull file contents:\n\`\`\`${ctx.language}\n${ctx.text}\n\`\`\``
  return {
    system,
    note: [`Context: ${baseName(ctx.path)}${ctx.selection ? ' (selection)' : ''}`, refNote]
      .filter(Boolean)
      .join(' · ')
  }
}

// Subsequence match over a path; lower is better, -1 means no match.
function matchScore(q: string, path: string): number {
  const t = path.toLowerCase()
  let i = 0
  let s = 0
  for (const ch of q.toLowerCase()) {
    const j = t.indexOf(ch, i)
    if (j < 0) return -1
    s += j - i
    i = j + 1
  }
  // Prefer matches in the file name over matches in the directory part.
  return s + (t.slice(t.lastIndexOf('/') + 1).includes(q.toLowerCase()) ? 0 : 20)
}

type Segment = { kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string }

function parse(content: string): Segment[] {
  const out: Segment[] = []
  const re = /```([\w+-]*)\n([\s\S]*?)(?:```|$)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: content.slice(last, m.index) })
    out.push({ kind: 'code', lang: m[1], code: m[2].replace(/\n$/, '') })
    last = re.lastIndex
    if (m[0].length === 0) re.lastIndex++
  }
  if (last < content.length) out.push({ kind: 'text', text: content.slice(last) })
  return out
}

function CodeBlock({
  lang,
  code,
  canApply,
  onInsert,
  onApply
}: {
  lang: string
  code: string
  canApply: boolean
  onInsert: (code: string) => void
  onApply: (code: string, lang: string) => void
}): JSX.Element {
  return (
    <div className="chat-code">
      <div className="chat-code-bar">
        <span>{lang || 'code'}</span>
        <span>
          <button onClick={() => void window.api.copyText(code)}>Copy</button>
          <button onClick={() => onInsert(code)} title="Put the code at the cursor">
            Insert
          </button>
          {canApply && (
            <button
              data-chat-apply
              onClick={() => onApply(code, lang)}
              title="Have Claude merge this change into the open file, then review it as a diff"
            >
              Apply
            </button>
          )}
        </span>
      </div>
      <pre>{code}</pre>
    </div>
  )
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

export function ChatPanel({
  root,
  getContext,
  getProblemsText,
  getTerminalText,
  onInsert,
  onApply,
  onOpenFile,
  onSwitch
}: {
  onSwitch: () => void
  root: string | null
  getContext: () => EditorContext | null
  getProblemsText: () => string
  getTerminalText: () => string
  onInsert: (code: string) => void
  onApply: (code: string, lang: string) => void
  onOpenFile: (path: string) => void
}): JSX.Element {
  // Workspace files as forward-slash relative paths, loaded the first time "@" is typed.
  const [files, setFiles] = useState<string[] | null>(null)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mentionSel, setMentionSel] = useState(0)
  const [images, setImages] = useState<ChatImage[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setFiles(null), [root])

  // Conversations are saved per project folder. `loadedRoot` stops us saving (and so wiping) a
  // folder's history before it has been loaded.
  const loadedRoot = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    loadedRoot.current = null
    setMsgs([])
    if (!root) return
    void window.api.chatLoad(root).then((saved) => {
      if (cancelled) return
      // Saved messages are older than anything typed while they were loading, so they go first.
      setMsgs((cur) => [...saved, ...cur])
      loadedRoot.current = root
    })
    return () => {
      cancelled = true
    }
  }, [root])
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const auth = useAuth()
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [model, setModel] = useState(getSettings().defaultModel)
  // Changing the default model in Settings switches this panel too.
  const defaultModel = useSettings().defaultModel
  useEffect(() => setModel(defaultModel), [defaultModel])
  const [includeCtx, setIncludeCtx] = useState(true)
  const reqId = useRef(0)
  const activeReq = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.aiHasKey().then(setHasKey)
  }, [auth.state.state])

  useEffect(() => {
    const patchLast = (fn: (m: Msg) => Msg): void =>
      setMsgs((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)))
    return window.api.onAiEvent({
      delta: (id, text) => {
        if (id === activeReq.current) patchLast((m) => ({ ...m, content: m.content + text }))
      },
      done: (id, stop, inTok, outTok) => {
        if (id !== activeReq.current) return
        activeReq.current = null
        setBusy(false)
        if (inTok + outTok > 0) patchLast((m) => ({ ...m, usage: { input: inTok, output: outTok } }))
        if (stop === 'refusal') {
          patchLast((m) => ({ ...m, error: 'The model declined this request.' }))
        } else if (stop === 'max_tokens') {
          patchLast((m) => ({ ...m, error: 'The response was cut off at the output limit.' }))
        }
      },
      error: (id, message) => {
        if (id !== activeReq.current) return
        activeReq.current = null
        setBusy(false)
        patchLast((m) => ({ ...m, error: message }))
      }
    })
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [msgs])

  // Save once a reply has finished, not on every streamed fragment.
  useEffect(() => {
    if (!root || busy || loadedRoot.current !== root) return
    const t = setTimeout(() => void window.api.chatSave(root, msgs), 400)
    return () => clearTimeout(t)
  }, [msgs, busy, root])

  const filesPromise = useRef<Promise<string[]> | null>(null)
  useEffect(() => {
    filesPromise.current = null
  }, [root])

  const loadFiles = useCallback((): Promise<string[]> => {
    if (!root) return Promise.resolve([])
    if (!filesPromise.current) {
      filesPromise.current = window.api
        .listFiles(root)
        .then((abs) => abs.map((f) => f.slice(root.length + 1).replace(/\\/g, '/')))
        .then((rel) => {
          setFiles(rel)
          return rel
        })
    }
    return filesPromise.current
  }, [root])

  // Folders (with a trailing slash) are derived from the file list.
  const folders = useMemo(() => {
    const set = new Set<string>()
    for (const f of files ?? []) {
      const parts = f.split('/')
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/') + '/')
    }
    return [...set]
  }, [files])

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!mention || !files) return []
    const q = mention.query
    const rank = (list: string[]): string[] =>
      q
        ? list
            .map((f) => ({ f, s: matchScore(q, f) }))
            .filter((x) => x.s >= 0)
            .sort((a, b) => a.s - b.s)
            .map((x) => x.f)
        : list
    const specials = SPECIAL_MENTIONS.filter((s) => !q || s.token.startsWith(q.toLowerCase())).map((s) => ({
      value: s.token,
      label: '@' + s.token,
      detail: s.detail
    }))
    const dirs = rank(folders).slice(0, 3).map((f) => ({ value: f, label: baseName(f.slice(0, -1)) + '/', detail: 'folder · ' + f }))
    const fileItems = rank(files).slice(0, 8).map((f) => ({ value: f, label: baseName(f), detail: f }))
    return [...specials, ...dirs, ...fileItems].slice(0, 9)
  }, [mention, files, folders])

  // Pictures can be pasted into the box or dropped on it; they are scaled down before they are kept.
  const addImages = async (list: File[]): Promise<boolean> => {
    const pictures = list.filter((f) => f.type.startsWith('image/'))
    if (pictures.length === 0) return false
    setImageError(null)
    for (const f of pictures) {
      try {
        const img = await toChatImage(f)
        setImages((cur) => (cur.length >= 5 ? cur : [...cur, img]))
      } catch (e) {
        setImageError((e as Error).message)
      }
    }
    return true
  }

  const updateMention = (value: string, caret: number): void => {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret))
    if (!m || !root) return setMention(null)
    setMention({ start: caret - m[1].length - 1, query: m[1] })
    setMentionSel(0)
    void loadFiles()
  }

  const pickMention = (path: string): void => {
    if (!mention) return
    const end = mention.start + 1 + mention.query.length
    const next = input.slice(0, mention.start) + '@' + path + ' ' + input.slice(end)
    const caret = mention.start + path.length + 2
    setInput(next)
    setMention(null)
    setTimeout(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(caret, caret)
    })
  }

  const send = useCallback(async () => {
    const text = input.trim() || (images.length ? 'What do you see in this image?' : '')
    if (!text || busy) return
    setBusy(true)
    setMention(null)

    // Read every file the message references with @path, and gather @git, @problems, @terminal and @folder.
    const refs: RefFile[] = []
    const skipped: string[] = []
    const extras: Extra[] = []
    if (root) {
      const knownList = await loadFiles()
      const known = new Set(knownList)
      const folderSet = new Set<string>()
      for (const f of knownList) {
        const parts = f.split('/')
        for (let i = 1; i < parts.length; i++) folderSet.add(parts.slice(0, i).join('/') + '/')
      }
      const wanted = new Set<string>()
      const tokens = new Set([...text.matchAll(/(?:^|\s)@(\S+)/g)].map((m) => m[1].replace(/[.,;:!?)]+$/, '')))
      for (const t of tokens) {
        if (t === 'codebase') {
          const question = text.replace(/(?:^|\s)@codebase\b/g, ' ').trim() || text
          const found = await window.api.indexSearch([root], question, { limit: 8 })
          const body = found.ok
            ? found.hits.map((h) => h.rel + ':' + h.start + '-' + h.end + '\n```\n' + h.text + '\n```').join('\n\n') || 'Nothing relevant was found.'
            : 'The search failed: ' + (found.error ?? 'unknown error')
          extras.push({ title: 'Code found by searching the whole project for this question', body, note: '@codebase' })
        } else if (t === 'git') {
          extras.push({ title: 'Git changes (diff of the working tree against HEAD)', body: '```diff\n' + (await window.api.gitDiffText(root)) + '\n```', note: '@git' })
        } else if (t === 'problems') {
          extras.push({ title: 'Problems (errors and warnings) reported in the open files', body: getProblemsText() || 'No problems.', note: '@problems' })
        } else if (t === 'terminal') {
          extras.push({ title: 'Current output of the terminal', body: '```\n' + (getTerminalText() || '(the terminal is empty or closed)') + '\n```', note: '@terminal' })
        } else {
          const dir = folderSet.has(t) ? t : folderSet.has(t + '/') ? t + '/' : null
          if (dir) {
            const entries = await window.api.readDir(`${root}/${dir}`).catch(() => [] as { name: string; isDir: boolean }[])
            extras.push({
              title: `Contents of the folder ${dir}`,
              body: entries.map((e: { name: string; isDir: boolean }) => e.name + (e.isDir ? '/' : '')).join('\n') || '(empty)',
              note: '@' + dir
            })
          }
        }
      }
      for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
        const rel = m[1].replace(/[.,;:!?)]+$/, '')
        if (known.has(rel)) wanted.add(rel)
        else if (known.has(m[1])) wanted.add(m[1])
      }
      let total = 0
      for (const rel of wanted) {
        try {
          const content = await window.api.readFile(`${root}/${rel}`)
          if (content.includes('\u0000') || content.length > MAX_REF_CHARS || total + content.length > MAX_REF_TOTAL) {
            skipped.push(rel)
          } else {
            total += content.length
            refs.push({ path: rel, text: content })
          }
        } catch {
          skipped.push(rel)
        }
      }
    }

    const rules = root ? await window.api.rulesPrompt(root) : '' // the project's own instructions
    const { system, note } = buildSystem(getContext(), includeCtx, refs, skipped, extras, rules)
    // The API rejects empty messages (e.g. a reply that was stopped before any text arrived).
    const history = msgs.filter((m) => m.content.trim() !== '').map((m) => ({
      role: m.role,
      content: m.content
    }))
    const id = ++reqId.current
    activeReq.current = id
    const attached = images
    setMsgs([
      ...msgs,
      { role: 'user', content: text, note, images: attached.length || undefined },
      { role: 'assistant', content: '' }
    ])
    setInput('')
    setImages([])
    setImageError(null)
    window.api.aiChat({
      requestId: id,
      model,
      system,
      messages: [...history, { role: 'user', content: text }],
      images: attached.map((i) => ({ mediaType: i.mediaType, data: i.data }))
    })
  }, [input, images, busy, msgs, model, includeCtx, getContext, getProblemsText, getTerminalText, root, loadFiles])

  const stop = (): void => {
    if (activeReq.current !== null) window.api.aiAbort(activeReq.current)
  }

  const saveKey = async (): Promise<void> => {
    if (!keyInput.trim()) return
    await window.api.aiSetKey(keyInput)
    setKeyInput('')
    setEditingKey(false)
    setHasKey(true)
  }

  const clearKey = async (): Promise<void> => {
    await window.api.aiClearKey()
    setHasKey(false)
  }

  if (!auth.direct && auth.loaded && hasKey === false) {
    return (
      <aside className="chat" aria-label="AI chat">
        <div className="chat-header">AI CHAT</div>
        <SignInCard />
      </aside>
    )
  }

  if (auth.direct && (hasKey === false || editingKey)) {
    return (
      <aside className="chat" aria-label="AI chat">
        <div className="chat-header">AI CHAT</div>
        <div className="chat-key">
          <p>Enter your Anthropic API key. It is encrypted with Windows and stored only on this PC.</p>
          <input
            type="password"
            placeholder="sk-ant-..."
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
          />
          <div>
            <button onClick={() => void saveKey()}>Save key</button>
            {editingKey && (
              <>
                <button onClick={() => setEditingKey(false)}>Cancel</button>
                <button onClick={() => void clearKey()}>Remove key</button>
              </>
            )}
          </div>
        </div>
      </aside>
    )
  }

  return (
    <aside className="chat">
      <div className="chat-header">
        <span>AI CHAT</span>
        <span>
          <RulesChip root={root} onOpen={onOpenFile} />
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button title="Switch to agent mode" onClick={onSwitch}>
            Agent
          </button>
          {auth.direct && (
            <button title="API key" onClick={() => setEditingKey(true)}>
              Key
            </button>
          )}
          <button title="New chat" onClick={() => !busy && setMsgs([])}>
            New
          </button>
        </span>
      </div>
      <div className="chat-list" ref={listRef} role="document" tabIndex={0} aria-label="Conversation">
        {msgs.length === 0 && (
          <div className="empty">Ask about the open file, or anything about code.</div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={'chat-msg ' + m.role}>
            {m.note && <div className="chat-note">{m.note}</div>}
            {m.images ? <div className="chat-note">{m.images} image{m.images > 1 ? 's' : ''} attached</div> : null}
            {m.role === 'user'
              ? m.content
              : parse(m.content).map((s, j) =>
                  s.kind === 'code' ? (
                    <CodeBlock
                      key={j}
                      lang={s.lang}
                      code={s.code}
                      canApply={getContext() !== null}
                      onInsert={onInsert}
                      onApply={onApply}
                    />
                  ) : (
                    <span key={j} style={{ whiteSpace: 'pre-wrap' }}>
                      {s.text}
                    </span>
                  )
                )}
            {m.role === 'assistant' && busy && i === msgs.length - 1 && !m.content && '…'}
            {m.error && <div className="chat-error">{m.error}</div>}
            {m.usage && (
              <div className="chat-usage" data-chat-usage title="Tokens used by this reply">
                {fmtTokens(m.usage.input)} in · {fmtTokens(m.usage.output)} out
              </div>
            )}
          </div>
        ))}
      </div>
      <div
        className="chat-input"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if ([...e.dataTransfer.files].some((f) => f.type.startsWith('image/'))) {
            e.preventDefault()
            void addImages([...e.dataTransfer.files])
          }
        }}
      >
        <div className="chat-ctx-row">
          <label className="chat-ctx">
            <input
              type="checkbox"
              checked={includeCtx}
              onChange={(e) => setIncludeCtx(e.target.checked)}
            />
            Include open file
          </label>
          <button className="chat-attach" data-chat-attach title="Attach an image (or paste or drop one)" onClick={() => fileInputRef.current?.click()}>
            + Image
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-chat-file-input
            onChange={(e) => {
              void addImages([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
        </div>
        {images.length > 0 && (
          <div className="chat-thumbs" data-chat-thumbs>
            {images.map((img) => (
              <div key={img.id} className="chat-thumb" title={img.name}>
                <img src={img.preview} alt={img.name} />
                <button title="Remove" onClick={() => setImages((cur) => cur.filter((x) => x.id !== img.id))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {imageError && <div className="chat-error">{imageError}</div>}
        {mention && suggestions.length > 0 && (
          <div className="mention-list">
            {suggestions.map((s, i) => (
              <div
                key={s.value}
                className={'mention-item' + (i === mentionSel ? ' sel' : '')}
                data-mention={s.value}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickMention(s.value)
                }}
                onMouseEnter={() => setMentionSel(i)}
              >
                {s.label}
                <span className="qp-detail">{s.detail}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={3}
          value={input}
          placeholder="Ask Claude... Type @ to add files. (Enter to send, Shift+Enter for newline)"
          onChange={(e) => {
            setInput(e.target.value)
            updateMention(e.target.value, e.target.selectionStart)
          }}
          onPaste={(e) => {
            const pictures = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
            if (pictures.length) {
              e.preventDefault() // a pasted picture becomes an attachment instead of text
              void addImages(pictures)
            }
          }}
          onKeyDown={(e) => {
            if (mention && suggestions.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                return setMentionSel((s) => Math.min(s + 1, suggestions.length - 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                return setMentionSel((s) => Math.max(s - 1, 0))
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                return pickMention(suggestions[mentionSel].value)
              }
              if (e.key === 'Escape') return setMention(null)
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {busy ? <button onClick={stop}>Stop</button> : <button onClick={() => void send()}>Send</button>}
      </div>
    </aside>
  )
}
