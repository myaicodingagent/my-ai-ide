import { monaco } from './monaco-setup'

const DEBOUNCE_MS = 350
const PREFIX_CHARS = 6000
const SUFFIX_CHARS = 2000

// Separate id range from chat (1+) and inline edit (1,000,000+).
let nextId = 2_000_000

const SYSTEM =
  'You are a code completion engine. The user message is a source file with the marker <CURSOR> at the caret. ' +
  'Reply with ONLY the text to insert at <CURSOR>: no explanation, no markdown fences, and do not repeat code that is already before or after the caret. ' +
  'Keep it short: finish the current statement or write the next few lines. If nothing useful fits, reply with an empty message. ' +
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

      const id = ++nextId
      token.onCancellationRequested(() => window.api.aiAbort(id))
      const raw = await window.api.aiComplete({
        requestId: id,
        system: SYSTEM,
        prompt: `File: ${model.uri.path.split('/').pop()} (${model.getLanguageId()})\n\n${prefix}<CURSOR>${suffix}`
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
