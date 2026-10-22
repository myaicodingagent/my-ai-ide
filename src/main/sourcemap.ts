import { dirname, resolve } from 'path'

// Reads a source map, to debug TypeScript through the JavaScript made from it: which generated position a line of the
// original file turned into (to set breakpoints), and which original position a generated one came from (to show
// where the program is stopped).

interface Segment {
  col: number // column in the generated line
  src: number
  line: number // line in the original file (0-based)
  srcCol: number
}

export interface SourceMapIndex {
  /** Absolute paths of the original files. */
  sources: string[]
  /** The first generated position of a line of an original file (0-based line), or the next line that has code. */
  generatedFor(source: number, line: number, lookAhead?: number): { line: number; column: number; origLine: number } | null
  /** The original position of a generated one (all 0-based), or null if it maps to nothing. */
  originalFor(line: number, column: number): { source: string; line: number; column: number } | null
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

/** Decodes the VLQ numbers of one comma-separated segment. */
export function decodeVlq(text: string): number[] {
  const out: number[] = []
  let value = 0
  let shift = 0
  for (const ch of text) {
    const digit = B64_INDEX.get(ch)
    if (digit === undefined) throw new Error('Bad source map')
    value += (digit & 31) * 2 ** shift
    if (digit & 32) {
      shift += 5
    } else {
      out.push(value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2))
      value = 0
      shift = 0
    }
  }
  return out
}

export function parseSourceMap(json: string, mapFile: string): SourceMapIndex {
  const raw = JSON.parse(json) as { sources?: string[]; sourceRoot?: string; mappings?: string }
  const base = dirname(mapFile)
  const sources = (raw.sources ?? []).map((s) => resolve(base, raw.sourceRoot ?? '', s))
  const lines: Segment[][] = []
  let src = 0
  let srcLine = 0
  let srcCol = 0
  for (const lineText of (raw.mappings ?? '').split(';')) {
    const segs: Segment[] = []
    let col = 0 // resets for every generated line
    if (lineText) {
      for (const segText of lineText.split(',')) {
        if (!segText) continue
        const f = decodeVlq(segText)
        col += f[0]
        if (f.length >= 4) {
          src += f[1]
          srcLine += f[2]
          srcCol += f[3]
          segs.push({ col, src, line: srcLine, srcCol })
        }
      }
    }
    lines.push(segs)
  }
  // original line -> first generated position
  let reverse: Map<string, { line: number; column: number }> | null = null
  const build = (): Map<string, { line: number; column: number }> => {
    const m = new Map<string, { line: number; column: number }>()
    lines.forEach((segs, gl) => {
      for (const s of segs) {
        const key = s.src + ':' + s.line
        const cur = m.get(key)
        if (!cur || gl < cur.line || (gl === cur.line && s.col < cur.column)) m.set(key, { line: gl, column: s.col })
      }
    })
    return m
  }
  return {
    sources,
    generatedFor(source, line, lookAhead = 30) {
      reverse ??= build()
      for (let l = line; l <= line + lookAhead; l++) {
        const g = reverse.get(source + ':' + l)
        if (g) return { ...g, origLine: l }
      }
      return null
    },
    originalFor(line, column) {
      const segs = lines[line]
      if (!segs || segs.length === 0) return null
      let best: Segment | null = null
      for (const s of segs) if (s.col <= column) best = s
      if (!best) best = segs[0]
      const source = sources[best.src]
      return source === undefined ? null : { source, line: best.line, column: best.srcCol }
    }
  }
}
