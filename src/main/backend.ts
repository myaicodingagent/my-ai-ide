import { app, ipcMain, safeStorage, shell, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { hostname } from 'os'

// The IDE talks to our service instead of to the model provider: the user signs in with their account (the same device-code flow as
// the VS Code extension), and every model call goes through the service, which applies the plan, the limits and the billing.
// Contract: ai-assistant-web/docs/IDE_SIGNIN.md and the extension's src/api.ts.

/** Where the service lives. Set MY_AI_IDE_BACKEND_URL to use another one (development, staging). */
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8080'
const REFRESH_WHEN_LEFT_MS = 14 * 24 * 3600 * 1000
const MAX_PROMPT = 20000 // the service's limit for one question

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface Me {
  active: boolean
  plan: string | null
  expiresAt: string | null
  dailyRequestCap: number
  strongModelAllowed: boolean
  requestsToday?: number
  fastModel?: string
  strongModel?: string
  completionCap?: number
  completionsToday?: number
  credits?: number
  teamName?: string | null
}

export type AuthState =
  | { state: 'signed-out' }
  | { state: 'signing-in'; userCode: string; url: string }
  | { state: 'signed-in'; me: Me | null }

interface Stored {
  token: string
  expiresAt: string
}

let getWin: () => BrowserWindow | null = () => null
let memToken: Stored | null = null
let signIn: { abort: AbortController } | null = null
let pendingUserCode: { userCode: string; url: string } | null = null
let lastMe: Me | null = null

const dir = (): string => app.getPath('userData')
const deviceFile = (): string => join(dir(), 'device-id.txt')
const tokenFile = (): string => join(dir(), 'service-token.bin')
const urlFile = (): string => join(dir(), 'service-url.txt')

let baseUrlCache: string | null = null
export async function baseUrl(): Promise<string> {
  if (process.env.MY_AI_IDE_BACKEND_URL) return process.env.MY_AI_IDE_BACKEND_URL.replace(/\/+$/, '')
  if (baseUrlCache) return baseUrlCache
  try {
    const t = (await fs.readFile(urlFile(), 'utf-8')).trim()
    if (/^https?:\/\//i.test(t)) return (baseUrlCache = t.replace(/\/+$/, ''))
  } catch {
    // Not changed by the user.
  }
  return DEFAULT_BACKEND_URL
}

/** True when model calls should go straight to the provider with a developer's own key (tests and development). */
export const directMode = (): boolean => !!process.env.ANTHROPIC_API_KEY || process.env.MY_AI_IDE_DIRECT === '1'

let deviceIdCache: string | null = null
async function deviceId(): Promise<string> {
  if (deviceIdCache) return deviceIdCache
  try {
    const t = (await fs.readFile(deviceFile(), 'utf-8')).trim()
    if (/^[A-Za-z0-9-]{16,64}$/.test(t)) return (deviceIdCache = t)
  } catch {
    // First run.
  }
  const id = 'ide-' + randomBytes(16).toString('hex')
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(deviceFile(), id, 'utf-8')
  return (deviceIdCache = id)
}

async function loadToken(): Promise<Stored | null> {
  if (memToken) return memToken
  try {
    const raw = await fs.readFile(tokenFile())
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : ''
    const t = JSON.parse(text) as Stored
    if (t?.token) return (memToken = t)
  } catch {
    // Not signed in.
  }
  return null
}

async function saveToken(t: Stored): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption is not available, so the sign-in cannot be stored safely.')
  memToken = t
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(tokenFile(), safeStorage.encryptString(JSON.stringify(t)))
}

async function dropToken(): Promise<void> {
  memToken = null
  lastMe = null
  await fs.rm(tokenFile(), { force: true })
}

function announce(): void {
  void currentState().then((s) => getWin()?.webContents.send('auth:state', s))
}

export async function currentState(): Promise<AuthState> {
  if (signIn && pendingUserCode) return { state: 'signing-in', ...pendingUserCode }
  if (await loadToken()) return { state: 'signed-in', me: lastMe }
  return { state: 'signed-out' }
}

/** Whether a model call can be made right now (signed in, or a developer key in direct mode). */
export async function ready(): Promise<boolean> {
  return directMode() || (await loadToken()) !== null
}

let clientVersion = ''

async function rawFetch(path: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
  try {
    return await fetch((await baseUrl()) + path, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...(clientVersion ? { 'X-Client-Version': clientVersion } : {}) },
      signal: init.signal ?? AbortSignal.timeout(120_000)
    })
  } catch {
    if (init.signal?.aborted) throw new ApiError(0, 'Cancelled')
    throw new ApiError(0, 'Cannot reach the service. Check your internet connection.')
  }
}

async function detail(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { detail?: string }
    if (b.detail) return b.detail
  } catch {
    // Not a problem body.
  }
  return `The service answered ${r.status}.`
}

const JSON_H = { 'Content-Type': 'application/json' }

/** A valid token and device id; renews the token when it is close to its end. */
async function session(): Promise<{ token: string; deviceId: string }> {
  const t = await loadToken()
  if (!t) throw new ApiError(401, 'Sign in to use the AI features.')
  const id = await deviceId()
  if (Date.parse(t.expiresAt) - Date.now() < REFRESH_WHEN_LEFT_MS) {
    const r = await rawFetch('/api/auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${t.token}`, 'X-Device-Id': id } })
    if (r.ok) {
      const j = (await r.json()) as Stored
      if (j.token) {
        await saveToken({ token: j.token, expiresAt: j.expiresAt })
        return { token: j.token, deviceId: id }
      }
    } else if (r.status === 401 || r.status === 403) {
      await dropToken()
      announce()
      throw new ApiError(401, 'Your sign-in ended. Sign in again.')
    }
    // Any other failure: try the old token, it may still be good.
  }
  return { token: t.token, deviceId: id }
}

/** Turns "the account was removed / device removed" answers into a clean signed-out state. */
async function checked(r: Response): Promise<Response> {
  if (r.ok) return r
  const d = await detail(r)
  if (r.status === 401 || (r.status === 403 && /device mismatch|account not found/i.test(d))) {
    await dropToken()
    announce()
    throw new ApiError(401, 'Your sign-in ended. Sign in again.')
  }
  if (r.status === 426) throw new ApiError(426, 'This version of the app is too old. Update it to continue.')
  throw new ApiError(r.status, d)
}

async function authed(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
  const s = await session()
  const r = await rawFetch(path, {
    ...init,
    headers: { ...JSON_H, ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${s.token}`, 'X-Device-Id': s.deviceId }
  })
  return checked(r)
}

// ---- sign-in ----

export async function startSignIn(): Promise<AuthState> {
  if (signIn) return currentState()
  const id = await deviceId()
  const r = await rawFetch('/api/device/start', { method: 'POST', headers: JSON_H, body: JSON.stringify({ deviceId: id, label: `My AI IDE on ${hostname()}`.slice(0, 60) }) })
  if (!r.ok) throw new ApiError(r.status, await detail(r))
  const j = (await r.json()) as { deviceCode: string; userCode: string; verificationUrl: string; expiresInSeconds: number; intervalSeconds: number }
  const url = `${j.verificationUrl.replace(/\/+$/, '')}/?code=${encodeURIComponent(j.userCode)}`
  const abort = new AbortController()
  signIn = { abort }
  pendingUserCode = { userCode: j.userCode, url }
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  announce()
  const deadline = Date.now() + Math.min(j.expiresInSeconds || 600, 600) * 1000
  const every = Math.max(2, j.intervalSeconds || 3) * 1000
  void (async () => {
    try {
      while (!abort.signal.aborted && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, every))
        if (abort.signal.aborted) return
        const p = await rawFetch('/api/device/poll', { method: 'POST', headers: JSON_H, body: JSON.stringify({ deviceCode: j.deviceCode }) }).catch(() => null)
        if (!p || p.status === 202) continue
        if (p.status === 410) return
        if (p.ok) {
          const t = (await p.json()) as Stored
          if (t.token) {
            await saveToken({ token: t.token, expiresAt: t.expiresAt })
            return
          }
        }
      }
    } finally {
      signIn = null
      pendingUserCode = null
      void refreshMe().finally(announce)
    }
  })()
  return currentState()
}

export function cancelSignIn(): void {
  signIn?.abort.abort()
}

export async function signOut(): Promise<void> {
  cancelSignIn()
  await dropToken()
  announce()
}

export async function refreshMe(): Promise<Me | null> {
  if (!(await loadToken())) return null
  try {
    const r = await authed('/api/me')
    lastMe = (await r.json()) as Me
  } catch {
    // Offline or signed out meanwhile: keep what we had.
  }
  return lastMe
}

// ---- model calls ----

export interface Image {
  mediaType: string
  data: string
}

export interface Answer {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
}

/** Parses Server-Sent Events: calls on(event, data) for each complete event. */
export function sseParser(on: (event: string, data: string) => void): (chunk: string) => void {
  let buf = ''
  return (chunk) => {
    buf += chunk.replace(/\r\n/g, '\n')
    for (;;) {
      const i = buf.indexOf('\n\n')
      if (i < 0) return
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) on(event, data.join('\n'))
    }
  }
}

/** A question to the service; the reply arrives piece by piece through onText. */
export async function ask(opts: { prompt: string; strong?: boolean; thinking?: boolean; images?: Image[]; signal?: AbortSignal; onText?: (t: string) => void }): Promise<Answer> {
  const body = JSON.stringify({
    prompt: opts.prompt.slice(0, MAX_PROMPT),
    strong: !!opts.strong,
    ...(opts.thinking ? { thinking: true } : {}),
    ...(opts.images?.length ? { images: opts.images.slice(0, 5) } : {})
  })
  const r = await authed('/api/chat/stream', { method: 'POST', body, signal: opts.signal ?? AbortSignal.timeout(180_000) })
  if (!r.body) throw new ApiError(0, 'The service sent an empty reply.')
  let text = ''
  let done: Answer | null = null
  let failure: ApiError | null = null
  const feed = sseParser((event, data) => {
    let d: Record<string, unknown> = {}
    try {
      d = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    if (event === 'delta') {
      const piece = String(d.text ?? '')
      text += piece
      opts.onText?.(piece)
    } else if (event === 'done') done = { text, model: String(d.model ?? ''), inputTokens: Number(d.inputTokens ?? 0), outputTokens: Number(d.outputTokens ?? 0) }
    else if (event === 'error') failure = new ApiError(Number(d.status ?? 502), String(d.detail ?? 'The service had a problem.'))
  })
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  try {
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      feed(dec.decode(value, { stream: true }))
      if (done || failure) break
    }
  } catch {
    if (opts.signal?.aborted) throw new ApiError(0, 'Cancelled')
    throw new ApiError(0, 'The connection was lost while the reply was being written.')
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  if (failure) throw failure
  if (!done) throw new ApiError(0, 'The connection was lost while the reply was being written.')
  void refreshMeSoon()
  return done
}

/** An inline completion for the text around the cursor. */
export async function complete(language: string, prefix: string, suffix: string, signal?: AbortSignal): Promise<string> {
  const r = await authed('/api/complete', { method: 'POST', body: JSON.stringify({ language, prefix, suffix }), signal })
  const j = (await r.json()) as { text?: string }
  return j.text ?? ''
}

/** Names to look for, from the fast model, given a question and the project's vocabulary. */
export async function expand(question: string, vocabulary: string, signal?: AbortSignal): Promise<string> {
  const r = await authed('/api/expand', { method: 'POST', body: JSON.stringify({ question, vocabulary }), signal })
  const j = (await r.json()) as { text?: string }
  return j.text ?? ''
}

export interface AgentStepResult {
  content: Array<Record<string, unknown>>
  stopReason: string
  model: string
  inputTokens: number
  outputTokens: number
  taskToken?: string
  stepsLeft?: number
}

/** One model turn of an agent task. Pass the previous result's taskToken back each time. */
export async function agentStep(messages: unknown[], taskToken: string | undefined, strong: boolean, signal?: AbortSignal, extraTools?: unknown[]): Promise<AgentStepResult> {
  const r = await authed('/api/agent/step', {
    method: 'POST',
    body: JSON.stringify({ messages, ...(taskToken ? { taskToken } : {}), ...(strong ? { strong } : {}), ...(extraTools?.length ? { extraTools } : {}) }),
    signal: signal ?? AbortSignal.timeout(180_000)
  })
  void refreshMeSoon()
  return (await r.json()) as AgentStepResult
}

let meTimer: ReturnType<typeof setTimeout> | undefined
function refreshMeSoon(): void {
  clearTimeout(meTimer)
  meTimer = setTimeout(() => void refreshMe().finally(announce), 1500)
}

/** Turns an error into a sentence for the person using the app. */
export function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 402) return 'You have no active plan. Choose a plan on the website to continue.'
    if (e.status === 403) return e.message || 'Your plan does not include this.'
    if (e.status === 429) return e.message || 'You have used today\'s allowance. It renews tomorrow.'
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}

export function registerBackendHandlers(win: () => BrowserWindow | null, version: string): void {
  getWin = win
  clientVersion = version
  ipcMain.handle('auth:state', () => currentState())
  ipcMain.handle('auth:start', async () => {
    try {
      return { ok: true as const, state: await startSignIn() }
    } catch (e) {
      return { ok: false as const, error: explain(e) }
    }
  })
  ipcMain.handle('auth:cancel', () => cancelSignIn())
  ipcMain.handle('auth:signOut', () => signOut())
  ipcMain.handle('auth:me', async () => {
    await refreshMe()
    return lastMe
  })
  ipcMain.handle('auth:ready', () => ready())
  ipcMain.handle('auth:mode', () => ({ direct: directMode() }))
  ipcMain.handle('auth:getUrl', async () => baseUrl())
  ipcMain.handle('auth:setUrl', async (_e, url: string) => {
    const u = String(url ?? '').trim().replace(/\/+$/, '')
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return { ok: false as const, error: 'Use an address that starts with https://' }
    baseUrlCache = u || null
    if (u) await fs.writeFile(urlFile(), u, 'utf-8')
    else await fs.rm(urlFile(), { force: true })
    await dropToken()
    announce()
    return { ok: true as const }
  })
  // On start, find out whether the saved sign-in is still good and what the plan allows.
  void refreshMe().finally(announce)
}
