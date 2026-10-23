import Anthropic from '@anthropic-ai/sdk'
import * as backend from './backend'
import { loadKey } from './ai'

// One place for "ask the model a question and get text back", used by everything that is not the chat stream or the agent loop
// (commit messages, Apply, search expansion, extension prompts, suggestions). Signed in, it goes through our service; in direct
// mode (a developer's own key, and the tests) it goes straight to the provider.

export const FAST = 'claude-haiku-5-5'
export const STRONG = 'claude-sonnet-5-5'

const MAX_PROMPT = 20000 // the service accepts one question of at most this many characters

/** Cuts the middle out of long text, keeping the start and the end. */
export function squeeze(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head - 40
  return text.slice(0, head) + '\n[... part left out to fit ...]\n' + text.slice(text.length - tail)
}

/**
 * Puts instructions, earlier turns and the newest message into the single question the service takes.
 * The newest message and the instructions are kept first; the earliest turns are dropped when there is no room.
 */
export function fit(system: string, history: { role: string; content: string }[], last: string, max = MAX_PROMPT): string {
  const lastPart = squeeze(last, Math.floor(max * 0.4))
  const instr = system.trim() ? squeeze(system.trim(), Math.floor(max * 0.45)) : ''
  const head = instr ? `Instructions:\n${instr}\n\n` : ''
  let room = max - head.length - lastPart.length - 120
  const kept: string[] = []
  for (let i = history.length - 1; i >= 0 && room > 200; i--) {
    const m = history[i]
    const line = `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${squeeze(m.content, Math.min(room, 4000))}`
    if (line.length > room) break
    kept.unshift(line)
    room -= line.length + 2
  }
  const conv = kept.length ? `Conversation so far:\n${kept.join('\n\n')}\n\n` : ''
  return `${head}${conv}${history.length || head ? 'Now answer this message:\n' : ''}${lastPart}`.slice(0, max)
}

export async function ready(): Promise<boolean> {
  return backend.directMode() ? (await loadKey()) !== null : backend.ready()
}

export const notReady = 'Sign in to use the AI features (Account button in the status bar).'

/** A complete answer as text. Throws an Error whose message is fit to show. */
export async function text(opts: { system?: string; prompt: string; strong?: boolean; maxTokens?: number; signal?: AbortSignal }): Promise<string> {
  if (!backend.directMode()) {
    try {
      return (await backend.ask({ prompt: fit(opts.system ?? '', [], opts.prompt), strong: opts.strong, signal: opts.signal })).text
    } catch (e) {
      throw new Error(backend.explain(e))
    }
  }
  const apiKey = await loadKey()
  if (!apiKey) throw new Error('No API key set.')
  const client = new Anthropic({ apiKey })
  if (opts.strong) {
    const stream = client.messages.stream(
      {
        model: STRONG,
        max_tokens: opts.maxTokens ?? 32000,
        output_config: { effort: 'low' },
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: 'user', content: opts.prompt }]
      },
      { signal: opts.signal }
    )
    const final = await stream.finalMessage()
    if (final.stop_reason === 'max_tokens') throw new Error('The answer was too long for the model to finish.')
    const b = final.content.find((x) => x.type === 'text')
    return b && b.type === 'text' ? b.text : ''
  }
  const res = await client.messages.create(
    {
      model: FAST,
      max_tokens: opts.maxTokens ?? 1500,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: 'user', content: opts.prompt }]
    },
    { signal: opts.signal }
  )
  const b = res.content.find((x) => x.type === 'text')
  return b && b.type === 'text' ? b.text : ''
}
