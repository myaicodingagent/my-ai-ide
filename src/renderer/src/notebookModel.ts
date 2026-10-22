// Jupyter notebooks (.ipynb, nbformat 4): reading, editing and writing, with everything the editor does not understand
// kept as it was so that saving never damages a notebook made by another program.

export type CellType = 'code' | 'markdown' | 'raw'

export interface NbOutput {
  output_type: 'stream' | 'display_data' | 'execute_result' | 'error'
  // stream
  name?: 'stdout' | 'stderr'
  text?: string | string[]
  // display_data / execute_result
  data?: Record<string, string | string[]>
  metadata?: Record<string, unknown>
  execution_count?: number | null
  // error
  ename?: string
  evalue?: string
  traceback?: string[]
  [k: string]: unknown
}

export interface NbCell {
  id: string
  cell_type: CellType
  source: string // always one string in memory; split into lines when written
  outputs: NbOutput[]
  execution_count: number | null
  metadata: Record<string, unknown>
  extra: Record<string, unknown> // fields we do not know, written back unchanged
}

export interface Notebook {
  cells: NbCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
  extra: Record<string, unknown>
}

const joinLines = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '')

/** Lines the way Jupyter stores them: every line but the last keeps its line break. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  return parts.map((p, i) => (i < parts.length - 1 ? p + '\n' : p)).filter((p, i, a) => !(i === a.length - 1 && p === ''))
}

let counter = 0
export const newCellId = (): string => `c${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function emptyNotebook(kernel: 'python' | 'javascript' = 'python'): Notebook {
  return {
    cells: [],
    metadata:
      kernel === 'python'
        ? { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }
        : { kernelspec: { display_name: 'JavaScript (Node)', language: 'javascript', name: 'javascript' }, language_info: { name: 'javascript' } },
    nbformat: 4,
    nbformat_minor: 5,
    extra: {}
  }
}

export function parseNotebook(text: string): { nb: Notebook } | { error: string } {
  if (!text.trim()) return { nb: emptyNotebook() }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { error: `This file is not valid JSON (${(e as Error).message}).` }
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cells)) return { error: 'This does not look like a notebook (no "cells" list).' }
  const nbformat = typeof raw.nbformat === 'number' ? raw.nbformat : 4
  if (nbformat < 4) return { error: `Notebook format ${nbformat} is too old. Open it in Jupyter and save it as version 4.` }
  const known = new Set(['cells', 'metadata', 'nbformat', 'nbformat_minor'])
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (!known.has(k)) extra[k] = v
  const seen = new Set<string>()
  const cells: NbCell[] = (raw.cells as Record<string, unknown>[]).map((c) => {
    const type: CellType = c.cell_type === 'markdown' || c.cell_type === 'raw' ? c.cell_type : 'code'
    let id = typeof c.id === 'string' && c.id ? c.id : newCellId()
    if (seen.has(id)) id = newCellId()
    seen.add(id)
    const knownCell = new Set(['id', 'cell_type', 'source', 'outputs', 'execution_count', 'metadata'])
    const cellExtra: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(c)) if (!knownCell.has(k)) cellExtra[k] = v
    return {
      id,
      cell_type: type,
      source: joinLines(c.source),
      outputs: type === 'code' && Array.isArray(c.outputs) ? (c.outputs as NbOutput[]) : [],
      execution_count: type === 'code' && typeof c.execution_count === 'number' ? c.execution_count : null,
      metadata: c.metadata && typeof c.metadata === 'object' ? (c.metadata as Record<string, unknown>) : {},
      extra: cellExtra
    }
  })
  return {
    nb: {
      cells,
      metadata: raw.metadata && typeof raw.metadata === 'object' ? (raw.metadata as Record<string, unknown>) : {},
      nbformat,
      nbformat_minor: typeof raw.nbformat_minor === 'number' ? raw.nbformat_minor : 5,
      extra
    }
  }
}

/** The file text, in the layout Jupyter itself uses (1-space indent, trailing newline). */
export function serializeNotebook(nb: Notebook): string {
  const cells = nb.cells.map((c) => {
    const base: Record<string, unknown> = { ...c.extra, cell_type: c.cell_type, id: c.id, metadata: c.metadata, source: splitLines(c.source) }
    if (c.cell_type === 'code') {
      base.execution_count = c.execution_count
      base.outputs = c.outputs
    }
    // Jupyter writes the keys in this order.
    const order = ['cell_type', 'execution_count', 'id', 'metadata', 'outputs', 'source']
    const out: Record<string, unknown> = {}
    for (const k of order) if (k in base) out[k] = base[k]
    for (const k of Object.keys(base)) if (!(k in out)) out[k] = base[k]
    return out
  })
  const doc: Record<string, unknown> = { ...nb.extra, cells, metadata: nb.metadata, nbformat: nb.nbformat, nbformat_minor: nb.nbformat_minor }
  const order = ['cells', 'metadata', 'nbformat', 'nbformat_minor']
  const out: Record<string, unknown> = {}
  for (const k of order) out[k] = doc[k]
  for (const k of Object.keys(doc)) if (!(k in out)) out[k] = doc[k]
  return JSON.stringify(out, null, 1) + '\n'
}

// ---- Editing ----

export const kernelLanguage = (nb: Notebook): 'python' | 'javascript' => {
  const spec = (nb.metadata.kernelspec ?? {}) as { language?: string; name?: string }
  const lang = String(spec.language ?? (nb.metadata.language_info as { name?: string } | undefined)?.name ?? spec.name ?? 'python').toLowerCase()
  return /^(javascript|node|js)/.test(lang) ? 'javascript' : 'python'
}

export function newCell(type: CellType, source = ''): NbCell {
  return { id: newCellId(), cell_type: type, source, outputs: [], execution_count: null, metadata: {}, extra: {} }
}

export function insertCell(nb: Notebook, index: number, cell: NbCell): Notebook {
  const cells = [...nb.cells]
  cells.splice(Math.max(0, Math.min(cells.length, index)), 0, cell)
  return { ...nb, cells }
}

export const deleteCell = (nb: Notebook, id: string): Notebook => ({ ...nb, cells: nb.cells.filter((c) => c.id !== id) })

export function moveCell(nb: Notebook, id: string, delta: number): Notebook {
  const i = nb.cells.findIndex((c) => c.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= nb.cells.length) return nb
  const cells = [...nb.cells]
  ;[cells[i], cells[j]] = [cells[j], cells[i]]
  return { ...nb, cells }
}

export const updateCell = (nb: Notebook, id: string, patch: Partial<NbCell>): Notebook => ({
  ...nb,
  cells: nb.cells.map((c) => (c.id === id ? { ...c, ...patch } : c))
})

export function setCellType(nb: Notebook, id: string, type: CellType): Notebook {
  return updateCell(nb, id, type === 'code' ? { cell_type: type } : { cell_type: type, outputs: [], execution_count: null })
}

export const clearOutputs = (nb: Notebook): Notebook => ({
  ...nb,
  cells: nb.cells.map((c) => (c.cell_type === 'code' ? { ...c, outputs: [], execution_count: null } : c))
})

/** Splits a cell in two at a character offset of its source (the second half gets a new id). */
export function splitCell(nb: Notebook, id: string, offset: number): Notebook {
  const i = nb.cells.findIndex((c) => c.id === id)
  if (i < 0) return nb
  const c = nb.cells[i]
  const first = { ...c, source: c.source.slice(0, offset).replace(/\n$/, ''), outputs: [], execution_count: null }
  const second = { ...newCell(c.cell_type, c.source.slice(offset).replace(/^\n/, '')) }
  const cells = [...nb.cells]
  cells.splice(i, 1, first, second)
  return { ...nb, cells }
}

/** Joins a cell with the one after it. */
export function mergeWithNext(nb: Notebook, id: string): Notebook {
  const i = nb.cells.findIndex((c) => c.id === id)
  if (i < 0 || i >= nb.cells.length - 1) return nb
  const a = nb.cells[i]
  const b = nb.cells[i + 1]
  const cells = [...nb.cells]
  cells.splice(i, 2, { ...a, source: a.source + (a.source && b.source ? '\n' : '') + b.source, outputs: [], execution_count: null })
  return { ...nb, cells }
}

// ---- Outputs ----

/** A stream output with more text appended (consecutive output of the same stream is one block). */
export function appendStream(outputs: NbOutput[], name: 'stdout' | 'stderr', text: string): NbOutput[] {
  const last = outputs[outputs.length - 1]
  if (last && last.output_type === 'stream' && last.name === name) {
    return [...outputs.slice(0, -1), { ...last, text: joinLines(last.text) + text }]
  }
  return [...outputs, { output_type: 'stream', name, text }]
}

/** Carriage returns and backspaces rewrite the current line, as in a terminal (progress bars...). */
export function renderStreamText(text: string): string {
  const lines: string[] = []
  let cur = ''
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(cur)
      cur = ''
    } else if (ch === '\r') cur = ''
    else if (ch === '\b') cur = cur.slice(0, -1)
    else cur += ch
  }
  lines.push(cur)
  return lines.join('\n')
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export const stripAnsi = (s: string): string => s.replace(ANSI, '')

export const outputText = (v: unknown): string => joinLines(v)

/** The richest thing in a display output that can be shown, in order of preference. */
export function bestMime(data: Record<string, string | string[]>): { mime: string; value: string } | null {
  for (const mime of ['image/png', 'image/jpeg', 'image/svg+xml', 'text/html', 'text/markdown', 'text/plain']) {
    if (data[mime] !== undefined) return { mime, value: joinLines(data[mime]) }
  }
  return null
}
