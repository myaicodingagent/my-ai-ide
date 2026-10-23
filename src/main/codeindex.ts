import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, relative } from 'path'
import * as llm from './llm'
import { directMode } from './backend'
import { isRemotePath } from './sshfs'
import { dot, embed, embedStatus, loadVectorCache, saveVectorCache, textHash, type EmbedStatus } from './embeddings'

// Search the whole codebase by meaning, without sending the code anywhere for indexing.
//
// 1. Every text file is cut into overlapping chunks of about 50 lines, kept in a local BM25 index (names are split
//    at camelCase / snake_case, so `parseConfigFile` is found by "config" and "parse").
// 2. Optionally Claude (Haiku) first expands the question into the identifiers and words the code is likely to use
//    ("where do we log people in" -> login, authenticate, session ...), and afterwards re-orders the best chunks.
//    Only the question and short excerpts of the top candidates are sent, never the whole project.
// 3. Unless switched off, every chunk also gets an embedding from a small model that runs on this PC (embeddings.ts), and the question
//    is compared with them by cosine similarity. This finds code that shares no words with the question. The word ranking and the
//    meaning ranking are merged (reciprocal rank fusion), so exact names and paraphrases both count.
// The index lives in memory, is brought up to date from file modification times whenever it is used, and is
// rebuilt from scratch in a second or two for a typical project.

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'out', 'dist', 'build', 'release', 'target', 'coverage', '.next', '.nuxt', '.cache',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.gradle', 'bin', 'obj', 'vendor'
])
const SKIP_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svgz', 'pdf', 'zip', 'gz', 'tgz', '7z', 'rar', 'exe', 'dll', 'so',
  'dylib', 'bin', 'class', 'jar', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'wasm', 'map',
  'lock', 'min', 'pyc', 'node', 'db', 'sqlite'
])
const MAX_FILES = 25000
const MAX_FILE_BYTES = 300_000
const CHUNK_LINES = 50
const CHUNK_OVERLAP = 8
const MAX_CHUNK_CHARS = 4000

interface Chunk {
  file: string // relative to the root, forward slashes
  start: number // 1-based line numbers, inclusive
  end: number
  text: string
  length: number // number of indexed terms
  hash?: string // of the text that is embedded, the key of the vector cache
  vec?: Float32Array // the embedding, once computed
  terms: string[] // distinct terms, to remove the chunk from the postings again
}

interface FileInfo {
  mtime: number
  size: number
  chunkIds: number[]
}

interface Index {
  root: string
  files: Map<string, FileInfo>
  chunks: Map<number, Chunk>
  postings: Map<string, Map<number, number>> // term -> chunk id -> count
  nextId: number
  totalLength: number
  refreshing: Promise<void> | null
  embedding: Promise<void> | null // the background job that computes vectors
  embedded: number // chunks that have a vector
  vectorCache: Map<string, Float32Array> | null
  embedError?: string
}

const indexes = new Map<string, Index>()

// The "Search by meaning" setting; the editor tells us when it changes.
let embeddingsEnabled = true

// ---- Tokenising ----

const WORD = /[A-Za-z][A-Za-z0-9]*|[0-9]+/g

/** Lower-case terms of a piece of text: identifiers whole and split into their parts. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const word of text.match(WORD) ?? []) {
    const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ')
    const lower = word.toLowerCase()
    if (parts.length > 1 && lower.length <= 40) out.push(lower)
    for (const p of parts) {
      const t = p.toLowerCase()
      if (t.length >= 2 && t.length <= 40) out.push(t)
    }
  }
  return out
}

// Light stemming so "parsing", "parsed" and "parser" meet "parse".
const stripSuffix = (t: string): string => {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3)
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2)
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2)
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1)
  return t
}
// A trailing e is dropped as well, so parse / parsing / parsed / parses all end up as "pars".
const stem = (t: string): string => {
  const r = stripSuffix(t)
  return r.length > 3 && r.endsWith('e') ? r.slice(0, -1) : r
}

const terms = (text: string): string[] => tokenize(text).map(stem)

const STOP = new Set(['the', 'is', 'are', 'was', 'be', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'we', 'do', 'does', 'how', 'where', 'what', 'which', 'this', 'that', 'it', 'with', 'from', 'by', 'an', 'as', 'at', 'can', 'our', 'my', 'there', 'when', 'why', 'find', 'code', 'file', 'files', 'show', 'me'])

// ---- Building and updating the index ----

function chunkLines(lines: string[]): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  let start = 0
  while (start < lines.length) {
    let end = Math.min(lines.length, start + CHUNK_LINES)
    // End a long chunk at the next blank line so a function is not cut in the middle if it can be avoided.
    if (end < lines.length) {
      for (let i = end; i > start + CHUNK_LINES * 0.6; i--) {
        if (lines[i - 1].trim() === '') {
          end = i
          break
        }
      }
    }
    let text = lines.slice(start, end).join('\n')
    if (text.length > MAX_CHUNK_CHARS) text = text.slice(0, MAX_CHUNK_CHARS)
    if (text.trim()) out.push({ start: start + 1, end, text })
    if (end >= lines.length) break
    start = Math.max(end - CHUNK_OVERLAP, start + 1)
  }
  return out
}

function removeFile(ix: Index, rel: string): void {
  const info = ix.files.get(rel)
  if (!info) return
  for (const id of info.chunkIds) {
    const ch = ix.chunks.get(id)
    if (!ch) continue
    for (const t of ch.terms) {
      const p = ix.postings.get(t)
      p?.delete(id)
      if (p && p.size === 0) ix.postings.delete(t)
    }
    ix.totalLength -= ch.length
    if (ch.vec) ix.embedded--
    ix.chunks.delete(id)
  }
  ix.files.delete(rel)
}

function addFile(ix: Index, rel: string, content: string, mtime: number, size: number): void {
  const chunkIds: number[] = []
  const lines = content.split(/\r?\n/)
  for (const c of chunkLines(lines)) {
    // The path is part of what a chunk is about ("auth/login.ts").
    const ts = terms(rel.replace(/[/\\._-]/g, ' ') + '\n' + c.text)
    const counts = new Map<string, number>()
    for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1)
    const id = ix.nextId++
    for (const [t, n] of counts) {
      let p = ix.postings.get(t)
      if (!p) ix.postings.set(t, (p = new Map()))
      p.set(id, n)
    }
    ix.chunks.set(id, { file: rel, start: c.start, end: c.end, text: c.text, length: ts.length, terms: [...counts.keys()] })
    ix.totalLength += ts.length
    chunkIds.push(id)
  }
  ix.files.set(rel, { mtime, size, chunkIds })
}

async function listFiles(root: string): Promise<{ rel: string; abs: string; mtime: number; size: number }[]> {
  const out: { rel: string; abs: string; mtime: number; size: number }[] = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES) return
    for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= MAX_FILES) return
      if (d.isDirectory()) {
        if (!IGNORED_DIRS.has(d.name) && !d.name.startsWith('.')) await walk(join(dir, d.name))
        continue
      }
      if (!d.isFile()) continue
      const ext = d.name.split('.').pop()?.toLowerCase() ?? ''
      if (SKIP_EXT.has(ext) || d.name.endsWith('.min.js')) continue
      const abs = join(dir, d.name)
      const st = await fs.stat(abs).catch(() => null)
      if (!st || st.size > MAX_FILE_BYTES || st.size === 0) continue
      out.push({ rel: relative(root, abs).replace(/\\/g, '/'), abs, mtime: st.mtimeMs, size: st.size })
    }
  }
  await walk(root)
  return out
}

async function refresh(root: string): Promise<Index> {
  let ix = indexes.get(root)
  if (!ix) {
    ix = { root, files: new Map(), chunks: new Map(), postings: new Map(), nextId: 1, totalLength: 0, refreshing: null, embedding: null, embedded: 0, vectorCache: null }
    indexes.set(root, ix)
  }
  const index = ix
  if (index.refreshing) {
    await index.refreshing
    return index
  }
  index.refreshing = (async () => {
    const now = await listFiles(root)
    const seen = new Set<string>()
    for (const f of now) {
      seen.add(f.rel)
      const old = index.files.get(f.rel)
      if (old && old.mtime === f.mtime && old.size === f.size) continue
      removeFile(index, f.rel)
      const content = await fs.readFile(f.abs, 'utf-8').catch(() => null)
      if (content === null || content.slice(0, 2000).includes('\u0000')) continue // binary
      addFile(index, f.rel, content, f.mtime, f.size)
    }
    for (const rel of [...index.files.keys()]) if (!seen.has(rel)) removeFile(index, rel)
  })().finally(() => {
    index.refreshing = null
  })
  await index.refreshing
  return index
}

// ---- Searching ----

export interface Hit {
  root: string
  rel: string
  abs: string
  start: number
  end: number
  score: number
  text: string
}

// Scores the chunks of all the given indexes together, so a term's rarity is judged across the whole workspace.
interface Scored {
  ix: Index
  id: number
  score: number
}

const hitOf = ({ ix, id, score }: Scored): Hit => {
  const c = ix.chunks.get(id)!
  return { root: ix.root, rel: c.file, abs: join(ix.root, c.file), start: c.start, end: c.end, score, text: c.text }
}

function bm25(all: Index[], weighted: Map<string, number>, limit: number): Scored[] {
  const N = all.reduce((n, ix) => n + ix.chunks.size, 0)
  if (N === 0) return []
  const avg = all.reduce((n, ix) => n + ix.totalLength, 0) / N || 1
  const k1 = 1.2
  const b = 0.75
  const scores = new Map<string, { ix: Index; id: number; score: number }>()
  for (const [term, weight] of weighted) {
    const df = all.reduce((n, ix) => n + (ix.postings.get(term)?.size ?? 0), 0)
    if (df === 0) continue
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (const ix of all) {
      const posting = ix.postings.get(term)
      if (!posting) continue
      for (const [id, tf] of posting) {
        const len = ix.chunks.get(id)!.length
        const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avg))
        const key = ix.root + '#' + id
        const cur = scores.get(key)
        if (cur) cur.score += s * weight
        else scores.set(key, { ix, id, score: s * weight })
      }
    }
  }
  return [...scores.values()].sort((x, y) => y.score - x.score).slice(0, limit)
}

// ---- Meaning: embeddings ----

const embedText = (ix: Index, c: Chunk): string => c.file.replace(/[/\\._-]/g, ' ') + '\n' + c.text

/** Computes the vectors of all chunks that do not have one yet, in the background; one job per folder. */
function startEmbedding(ix: Index): Promise<void> {
  if (ix.embedding) return ix.embedding
  ix.embedding = (async () => {
    ix.embedError = undefined
    if (!ix.vectorCache) ix.vectorCache = await loadVectorCache(ix.root)
    const cache = ix.vectorCache
    const todo: Chunk[] = []
    for (const c of ix.chunks.values()) {
      if (c.vec) continue
      c.hash ??= textHash(embedText(ix, c))
      const hit = cache.get(c.hash)
      if (hit) {
        c.vec = hit
        ix.embedded++
      } else todo.push(c)
    }
    let sinceSave = 0
    for (let i = 0; i < todo.length; i += 32) {
      const part = todo.slice(i, i + 32)
      const vecs = await embed(part.map((c) => embedText(ix, c)))
      part.forEach((c, k) => {
        if (!c.vec) ix.embedded++
        c.vec = vecs[k]
        cache.set(c.hash!, vecs[k])
      })
      sinceSave += part.length
      if (sinceSave >= 640) {
        sinceSave = 0
        void saveVectorCache(ix.root, cache)
      }
    }
    if (todo.length) await saveVectorCache(ix.root, cache)
  })()
    .catch((e) => {
      ix.embedError = e instanceof Error ? e.message : String(e)
    })
    .finally(() => {
      ix.embedding = null
    })
  return ix.embedding
}

/** The chunks closest in meaning to the question, best first. */
function nearest(all: Index[], q: Float32Array, limit: number): Scored[] {
  const best: Scored[] = []
  let floor = -Infinity
  for (const ix of all) {
    for (const [id, c] of ix.chunks) {
      if (!c.vec) continue
      const s = dot(q, c.vec)
      if (s < 0.15 || s <= floor) continue // unrelated
      best.push({ ix, id, score: s })
      if (best.length > limit * 4) {
        best.sort((x, y) => y.score - x.score)
        best.length = limit
        floor = best[best.length - 1].score
      }
    }
  }
  return best.sort((x, y) => y.score - x.score).slice(0, limit)
}

/** Reciprocal rank fusion: a chunk near the top of either list rises; one near the top of both rises most. */
function fuse(lists: Scored[][], limit: number): Scored[] {
  const K = 60
  const sum = new Map<string, Scored>()
  for (const list of lists) {
    list.forEach((s, rank) => {
      const key = s.ix.root + '#' + s.id
      const add = 1 / (K + rank + 1)
      const cur = sum.get(key)
      if (cur) cur.score += add
      else sum.set(key, { ix: s.ix, id: s.id, score: add })
    })
  }
  return [...sum.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Keeps the best hit per overlapping region, so the same lines are not listed twice. */
function dedupe(hits: Hit[]): Hit[] {
  const kept: Hit[] = []
  for (const h of hits) {
    if (kept.some((k) => k.abs === h.abs && h.start <= k.end && k.start <= h.end)) continue
    kept.push(h)
  }
  return kept
}

function queryTerms(query: string, extra: string[] = []): Map<string, number> {
  const w = new Map<string, number>()
  for (const t of terms(query)) if (!STOP.has(t)) w.set(t, Math.max(w.get(t) ?? 0, 1))
  for (const t of extra.flatMap((e) => terms(e))) if (!STOP.has(t)) w.set(t, Math.max(w.get(t) ?? 0, 0.6))
  return w
}

const FAST_MODEL = 'claude-haiku-5-5'

async function ask(system: string, user: string, maxTokens: number): Promise<string> {
  return llm.text({ system, prompt: user, maxTokens })
}

const jsonFrom = (text: string): unknown => {
  const m = /\[[\s\S]*\]/.exec(text)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

async function expandQuery(query: string): Promise<string[] | null> {
  try {
    const text = await ask(
      'Task: expand a code search query. The user asks about a codebase in everyday words. Reply with ONLY a JSON array of at most 12 ' +
        'lower-case identifiers, function or class name fragments and technical words that code answering the question is likely to contain. ' +
        'No explanation.',
      query,
      300
    )
    const arr = jsonFrom(text)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, 12) : null
  } catch {
    return null
  }
}

async function rerank(query: string, hits: Hit[]): Promise<Hit[] | null> {
  try {
    const listing = hits
      .map((h, i) => `[${i}] ${h.rel}:${h.start}-${h.end}\n${h.text.split('\n').slice(0, 14).join('\n')}`)
      .join('\n\n')
    const text = await ask(
      'Task: rerank code search results. Given a question about a codebase and numbered excerpts, reply with ONLY a JSON array of the ' +
        'excerpt numbers that help answer it, most relevant first. Leave out irrelevant ones. No explanation.',
      `Question: ${query}\n\nExcerpts:\n${listing}`,
      200
    )
    const arr = jsonFrom(text)
    if (!Array.isArray(arr)) return null
    const order = arr.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < hits.length)
    const chosen = [...new Set(order)].map((i) => hits[i])
    // Whatever the model left out follows, so nothing found disappears.
    return [...chosen, ...hits.filter((h) => !chosen.includes(h))]
  } catch {
    return null
  }
}

export interface SemanticInfo {
  used: boolean // the meaning ranking contributed to the results
  model: EmbedStatus
  done: number // chunks that have a vector
  total: number
  error?: string
}

export interface SearchResult {
  ok: boolean
  semantic?: SemanticInfo
  error?: string
  hits: Hit[]
  indexed: { files: number; chunks: number }
  expanded: string[] | null
  reranked: boolean
}

export async function searchCodebase(roots: string[], query: string, opts: { limit?: number; ai?: boolean; embed?: boolean; waitMs?: number } = {}): Promise<SearchResult> {
  const limit = Math.min(30, Math.max(1, opts.limit ?? 10))
  const empty: SearchResult = { ok: true, hits: [], indexed: { files: 0, chunks: 0 }, expanded: null, reranked: false }
  if (!query.trim() || roots.length === 0) return empty
  if (roots.some(isRemotePath)) return { ...empty, ok: false, error: 'Search by meaning does not work in folders opened over SSH yet.' }
  try {
    const built = await Promise.all(roots.map((r) => refresh(r)))
    const indexed = { files: built.reduce((n, i) => n + i.files.size, 0), chunks: built.reduce((n, i) => n + i.chunks.size, 0) }
    const useAi = opts.ai !== false && (await llm.ready())
    const expanded = useAi ? await expandQuery(query) : null
    const weighted = queryTerms(query, expanded ?? [])
    const words = bm25(built, weighted, limit * 5)
    // Meaning: compute vectors in the background (waiting a little, so a small project is ready on its first search), then compare.
    let semantic: SemanticInfo | undefined
    let ranked = words
    if (opts.embed ?? embeddingsEnabled) {
      const jobs = built.map((ix) => startEmbedding(ix))
      const total = (): number => built.reduce((n, i) => n + i.chunks.size, 0)
      const done = (): number => built.reduce((n, i) => n + i.embedded, 0)
      await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, opts.waitMs ?? 8000))])
      const error = built.find((i) => i.embedError)?.embedError
      let used = false
      if (done() > 0) {
        try {
          const [q] = await embed([query + (expanded?.length ? ' ' + expanded.join(' ') : '')])
          const close = nearest(built, q, limit * 5)
          if (close.length) {
            ranked = fuse([words, close], limit * 5)
            used = true
          }
        } catch (e) {
          semantic = { used: false, model: embedStatus(), done: done(), total: total(), error: e instanceof Error ? e.message : String(e) }
        }
      }
      semantic ??= { used, model: embedStatus(), done: done(), total: total(), error }
    }
    let hits = dedupe(ranked.map(hitOf)).slice(0, Math.max(limit, 20))
    let reranked = false
    // Reordering by the model costs one more request, so through the service it is left out (the meaning ranking already does this job).
    if (useAi && directMode() && hits.length > 1) {
      const better = await rerank(query, hits)
      if (better) {
        hits = better
        reranked = true
      }
    }
    return { ok: true, hits: hits.slice(0, limit), indexed, expanded, reranked, semantic }
  } catch (e) {
    return { ...empty, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Text for the model (chat @codebase and the agent tool). */
export function formatHits(hits: Hit[], maxChars = 24_000): string {
  let out = ''
  for (const h of hits) {
    const block = `${h.rel}:${h.start}-${h.end}\n\`\`\`\n${h.text}\n\`\`\`\n\n`
    if (out.length + block.length > maxChars) break
    out += block
  }
  return out.trim() || 'No matching code found.'
}

export function registerCodeIndexHandlers(): void {
  ipcMain.handle('index:search', (_e, roots: string[], query: string, opts?: { limit?: number; ai?: boolean; embed?: boolean }) =>
    searchCodebase(roots, String(query ?? ''), opts ?? {})
  )
  ipcMain.handle('index:embeddings', (_e, on: boolean) => {
    embeddingsEnabled = on !== false
  })
  ipcMain.handle('index:embedStatus', () => embedStatus())
  // Forget a folder's index (e.g. after a big checkout); it is rebuilt on the next search.
  ipcMain.handle('index:reset', (_e, root: string) => {
    indexes.delete(root)
  })
}
