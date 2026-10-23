import { monaco } from './monaco-setup'

const DEBOUNCE_MS = 350
const PREFIX_CHARS = 6000
const SUFFIX_CHARS = 2000
const CONTEXT_FILES = 3
const CONTEXT_CHARS = 1200

// Other open files are sent as context. Files you edited or opened most recently, and files that mention the
// word at the caret, come first.
const touched = new Map<string, number>()
let clock = 0
const touch = (m: monaco.editor.ITextModel): void => void touched.set(m.uri.toString(), ++clock)
monaco.editor.getModels().forEach(touch)
monaco.editor.onDidCreateModel((m) => {
  touch(m)
  m.onDidChangeContent(() => touch(m))
})
monaco.editor.onDidCreateEditor((ed) => {
  ed.onDidFocusEditorText(() => {
    const m = ed.getModel()
    if (m) touch(m)
  })
})

function otherFilesContext(current: monaco.editor.ITextModel, word: string): string {
  const skip = (m: monaco.editor.ITextModel): boolean =>
    m === current || m.uri.scheme !== 'file' || m.getValueLength() > 200_000 || m.getValueLength() === 0
  const scored = monaco.editor
    .getModels()
    .filter((m) => !skip(m))
    .map((m) => {
      const text = m.getValue()
      const at = word.length >= 3 ? text.indexOf(word) : -1
      return { m, text, at, score: (at >= 0 ? 1_000_000 : 0) + (touched.get(m.uri.toString()) ?? 0) }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, CONTEXT_FILES)
  return scored
    .map(({ m, text, at }) => {
      const from = at >= 0 ? Math.max(0, at - 300) : 0
      return `--- ${m.uri.path.split('/').pop()} (${m.getLanguageId()}) ---
${text.slice(from, from + CONTEXT_CHARS)}`
    })
    .join('\n\n')
}

// Separate id range from chat (1+) and inline edit (1,000,000+).
let nextId = 2_000_000

const SYSTEM =
  'You are a code completion engine. The user message is a source file with the marker <CURSOR> at the caret. ' +
  'Reply with ONLY the text to insert at <CURSOR>: no explanation, no markdown fences, and do not repeat code that is already before or after the caret. ' +
  'Keep it short: finish the current statement or write the next few lines. If nothing useful fits, reply with an empty message. ' +
  'Other open files may be shown before the file for reference; never complete them, only the file with <CURSOR>. ' +
  'Do not include internal or system XML tags in your response.'

function clean(raw: string): string {
  return raw
    .replace(/^```[\w+-]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/<\/?(thinking|CURSOR)>/g, '')
    .replace(/\s+$/, '')
}

export function registerAutocomplete(isEnabled: () => boolean): monaco.IDisposable {
  return monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, _ctx, token) {
      const none = { items: [] }
      if (!isEnabled()) return none

      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, DEBOUNCE_MS)
        token.onCancellationRequested(() => {
          clearTimeout(t)
          resolve()
        })
      })
      if (token.isCancellationRequested) return none

      const offset = model.getOffsetAt(position)
      const text = model.getValue()
      const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset)
      const suffix = text.slice(offset, offset + SUFFIX_CHARS)
      if (prefix.trim().length < 3) return none

      const wordAt = model.getWordUntilPosition(position).word
      const others = otherFilesContext(model, wordAt)
      const id = ++nextId
      token.onCancellationRequested(() => window.api.aiAbort(id))
      const raw = await window.api.aiComplete({
        requestId: id,
        system: SYSTEM,
        prompt: `File: ${model.uri.path.split('/').pop()} (${model.getLanguageId()})\n\n${prefix}<CURSOR>${suffix}`,
        inline: { language: model.getLanguageId(), prefix, suffix }
      })
      if (!raw || token.isCancellationRequested) return none

      const insertText = clean(raw)
      if (!insertText.trim()) return none
      return {
        items: [{ insertText, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }]
      }
    },
    freeInlineCompletions() {}
  })
}
