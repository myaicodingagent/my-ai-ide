import { app, ipcMain, safeStorage, BrowserWindow } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ChatImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string // base64, no prefix
}

interface ChatRequest {
  requestId: number
  model: string
  system: string
  messages: ChatMessage[]
  // Pictures attached to the last message (the newest user turn).
  images?: ChatImage[]
}

// Turns the conversation into API messages; images go on the last user message, before its text.
function toApiMessages(req: ChatRequest): Anthropic.Beta.Messages.BetaMessageParam[] {
  const images = (req.images ?? []).slice(0, 5)
  return req.messages.map((m, i) => {
    if (images.length === 0 || i !== req.messages.length - 1 || m.role !== 'user') return { role: m.role, content: m.content }
    return {
      role: 'user' as const,
      content: [
        ...images.map((img) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.mediaType, data: img.data }
        })),
        { type: 'text' as const, text: m.content }
      ]
    }
  })
}

const keyFile = (): string => join(app.getPath('userData'), 'anthropic-key.bin')
const inflight = new Map<number, AbortController>()

export async function loadKey(): Promise<string | null> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    const buf = await fs.readFile(keyFile())
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

// Chat history is kept per project folder, as plain JSON in the app's data folder.
const MAX_SAVED_MESSAGES = 100
const chatFile = (root: string): string =>
  join(app.getPath('userData'), 'chats', createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16) + '.json')

export function registerAiHandlers(getWin: () => BrowserWindow | null): void {
  // "Apply" on a chat code block: asks the model to produce the whole file with the change merged in.
  // The result is only a proposal; the UI shows a diff and nothing is written until the user accepts.
  ipcMain.handle(
    'ai:apply',
    async (
      _e,
      req: { fileName: string; language: string; original: string; snippet: string }
    ): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
      const apiKey = await loadKey()
      if (!apiKey) return { ok: false, error: 'No API key set. Add one in the Chat tab.' }
      if (req.original.length > 50_000) return { ok: false, error: 'This file is too large for Apply. Use Insert instead.' }
      try {
        const stream = new Anthropic({ apiKey }).messages.stream({
          model: 'claude-sonnet-5-5',
          max_tokens: 32000,
          output_config: { effort: 'low' },
          system:
            'You apply a proposed change to a source file. You get the complete original file and a code snippet the user wants applied. ' +
            'The snippet may be a full replacement, a partial piece with placeholders such as "// ... existing code ...", or a fragment that belongs at some place in the file. ' +
            'Reply with ONLY the complete updated file: no explanation, no markdown fences. Keep everything that the change does not affect exactly as it was, including formatting and comments. Use \n line endings.',
          messages: [
            {
              role: 'user',
              content: `File: ${req.fileName} (${req.language})

Original file:
<<<FILE
${req.original}
FILE>>>

Change to apply:
<<<CHANGE
${req.snippet}
CHANGE>>>`
            }
          ]
        })
        const final = await stream.finalMessage()
        if (final.stop_reason === 'max_tokens') return { ok: false, error: 'The updated file was too long for the model to return. Use Insert instead.' }
        const block = final.content.find((b) => b.type === 'text')
        let text = block && block.type === 'text' ? block.text : ''
        text = text.replace(/^```[\w+-]*\n/, '').replace(/\n```\s*$/, '') // in case it added a fence anyway
        return text.trim() ? { ok: true, text } : { ok: false, error: 'The model returned nothing.' }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('chat:load', async (_e, root: string) => {
    try {
      const data = JSON.parse(await fs.readFile(chatFile(root), 'utf-8'))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  })

  ipcMain.handle('chat:save', async (_e, root: string, msgs: unknown[]) => {
    // Keep recent messages only, and start at a user message (the API needs the first message to be one).
    let recent = msgs.slice(-MAX_SAVED_MESSAGES) as { role?: string }[]
    const firstUser = recent.findIndex((m) => m.role === 'user')
    recent = firstUser < 0 ? [] : recent.slice(firstUser)
    await fs.mkdir(join(app.getPath('userData'), 'chats'), { recursive: true })
    await fs.writeFile(chatFile(root), JSON.stringify(recent), 'utf-8')
  })

  ipcMain.handle('ai:hasKey', async () => (await loadKey()) !== null)

  ipcMain.handle('ai:setKey', async (_e, key: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable, so the key cannot be stored safely.')
    }
    await fs.writeFile(keyFile(), safeStorage.encryptString(key.trim()))
  })

  ipcMain.handle('ai:clearKey', async () => {
    await fs.rm(keyFile(), { force: true })
  })

  ipcMain.on('ai:abort', (_e, requestId: number) => inflight.get(requestId)?.abort())

  // Short, non-streaming completion for ghost-text autocomplete. Fails quietly with null.
  ipcMain.handle(
    'ai:complete',
    async (_e, req: { requestId: number; system: string; prompt: string }) => {
      const apiKey = await loadKey()
      if (!apiKey) return null
      const controller = new AbortController()
      inflight.set(req.requestId, controller)
      try {
        const client = new Anthropic({ apiKey })
        const res = await client.messages.create(
          {
            model: 'claude-haiku-5-5',
            max_tokens: 256,
            thinking: { type: 'disabled' },
            output_config: { effort: 'low' },
            system: req.system,
            messages: [{ role: 'user', content: req.prompt }]
          },
          { signal: controller.signal }
        )
        const block = res.content.find((b) => b.type === 'text')
        return block && block.type === 'text' ? block.text : null
      } catch {
        return null
      } finally {
        inflight.delete(req.requestId)
      }
    }
  )

  ipcMain.on('ai:chat', async (_e, req: ChatRequest) => {
    const send = (channel: string, ...args: unknown[]): void =>
      getWin()?.webContents.send(channel, req.requestId, ...args)

    const apiKey = await loadKey()
    if (!apiKey) return send('ai:error', 'No API key set. Click the key icon to add one.')

    const controller = new AbortController()
    inflight.set(req.requestId, controller)
    try {
      const client = new Anthropic({ apiKey })
      // Server-side fallbacks reroute a request the safety classifiers decline.
      const stream = client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: 64000,
          system: req.system,
          messages: toApiMessages(req),
          ...(req.model.includes('haiku')
            ? {}
            : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const })
        },
        { signal: controller.signal }
      )
      stream.on('text', (text) => send('ai:delta', text))
      const final = await stream.finalMessage()
      send('ai:done', final.stop_reason, final.usage.input_tokens, final.usage.output_tokens)
    } catch (err) {
      if (controller.signal.aborted) return send('ai:done', 'aborted', 0, 0)
      if (err instanceof Anthropic.AuthenticationError) {
        send('ai:error', 'The API key was rejected. Check it and try again.')
      } else if (err instanceof Anthropic.RateLimitError) {
        send('ai:error', 'Rate limited. Wait a moment and retry.')
      } else if (err instanceof Anthropic.APIError) {
        send('ai:error', `API error ${err.status ?? ''}: ${err.message}`)
      } else {
        send('ai:error', err instanceof Error ? err.message : String(err))
      }
    } finally {
      inflight.delete(req.requestId)
    }
  })
}
