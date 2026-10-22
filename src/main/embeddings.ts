import { app } from 'electron'
import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'

// Embeddings for searching code by meaning, computed on this PC.
//
// A small model (all-MiniLM-L6-v2, about 23 MB, quantized) turns a piece of code or a question into 384 numbers; text with a similar
// meaning gets similar numbers. The model is downloaded once, the first time it is needed, and then runs offline through ONNX
// Runtime. Nothing about your code is sent anywhere: only the model file comes down.

export const MODEL = 'Xenova/all-MiniLM-L6-v2'
export const DIMS = 384
const BATCH = 16
const MAX_CHARS = 1500 // the model reads about 256 tokens; more text only slows it down
const RETRY_AFTER_MS = 60_000

export type EmbedState = 'idle' | 'loading' | 'ready' | 'error'
export interface EmbedStatus {
  state: EmbedState
  error?: string
}

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>

let extractor: Extractor | null = null
let loading: Promise<Extractor> | null = null
let state: EmbedState = 'idle'
let lastError: string | undefined
let failedAt = 0

/** Replaced in tests, which cannot download a model. */
let override: ((texts: string[]) => Promise<Float32Array[]>) | null = null
export function setEmbedderForTests(fn: ((texts: string[]) => Promise<Float32Array[]>) | null): void {
  override = fn
  state = fn ? 'ready' : 'idle'
  lastError = undefined
  failedAt = 0
}

export const embedStatus = (): EmbedStatus => ({ state, error: lastError })

const modelDir = (): string => join(app.getPath('userData'), 'models')

async function load(): Promise<Extractor> {
  if (extractor) return extractor
  if (loading) return loading
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) throw new Error(lastError ?? 'The embedding model could not be loaded.')
  state = 'loading'
  loading = (async () => {
    // The package is an ES module and large, so it is loaded only when meaning search is first used.
    const tf = await import('@huggingface/transformers')
    tf.env.cacheDir = modelDir()
    tf.env.allowLocalModels = false
    const pipe = await tf.pipeline('feature-extraction', MODEL, { dtype: 'q8' })
    extractor = pipe as unknown as Extractor
    state = 'ready'
    lastError = undefined
    failedAt = 0
    return extractor
  })().catch((e) => {
    state = 'error'
    failedAt = Date.now()
    const msg = e instanceof Error ? e.message : String(e)
    lastError = /fetch|network|ENOTFOUND|ECONN|EAI_AGAIN|getaddrinfo|timed? ?out/i.test(msg) ? 'The search model has not been downloaded yet and there is no internet connection to get it.' : msg
    throw new Error(lastError)
  }).finally(() => {
    loading = null
  })
  return loading
}

const clip = (t: string): string => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t)

/** One normalized vector per text. Throws when the model is not available. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (override) return override(texts)
  const ex = await load()
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const part = texts.slice(i, i + BATCH).map(clip)
    const r = await ex(part, { pooling: 'mean', normalize: true })
    for (let k = 0; k < part.length; k++) out.push(Float32Array.from(r.data.subarray(k * DIMS, (k + 1) * DIMS)))
  }
  return out
}

/** Both vectors are normalized, so the dot product is the cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export const textHash = (t: string): string => createHash('sha1').update(clip(t)).digest('base64').slice(0, 16)

// ---- A cache on disk, so the vectors of a project are computed once ----
// Stored as 8-bit numbers (a normalized vector's values are all between -1 and 1), about 0.5 KB per chunk.

const toBytes = (v: Float32Array): Buffer => Buffer.from(Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127)))).buffer)
const fromBytes = (b: Buffer): Float32Array => {
  const out = new Float32Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = ((b[i] << 24) >> 24) / 127
  return out
}

const cacheFile = (root: string): string => join(app.getPath('userData'), 'embeddings', createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 20) + '.json')

export async function loadVectorCache(root: string): Promise<Map<string, Float32Array>> {
  const map = new Map<string, Float32Array>()
  try {
    const j = JSON.parse(await fs.readFile(cacheFile(root), 'utf-8')) as { model?: string; vecs?: Record<string, string> }
    if (j.model !== MODEL || !j.vecs) return map
    for (const [h, b64] of Object.entries(j.vecs)) {
      const b = Buffer.from(b64, 'base64')
      if (b.length === DIMS) map.set(h, fromBytes(b))
    }
  } catch {
    // No cache yet, or it is damaged: the vectors are computed again.
  }
  return map
}

export async function saveVectorCache(root: string, vecs: Map<string, Float32Array>): Promise<void> {
  try {
    const obj: Record<string, string> = {}
    for (const [h, v] of vecs) obj[h] = toBytes(v).toString('base64')
    await fs.mkdir(join(app.getPath('userData'), 'embeddings'), { recursive: true })
    await fs.writeFile(cacheFile(root), JSON.stringify({ model: MODEL, vecs: obj }), 'utf-8')
  } catch {
    // A cache that cannot be written only costs time next session.
  }
}
