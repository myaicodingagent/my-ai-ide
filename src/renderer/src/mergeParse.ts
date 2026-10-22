// Merge conflicts in a file's text (<<<<<<< / ||||||| / ======= / >>>>>>> markers), for the merge editor.

export interface MergeConflict {
  index: number
  start: number // 0-based line of <<<<<<<
  end: number // 0-based line of >>>>>>>
  oursLabel: string
  theirsLabel: string
  ours: string[]
  base: string[] | null // present with diff3-style markers
  theirs: string[]
}

export interface MergeParse {
  lines: string[]
  eol: string
  conflicts: MergeConflict[]
}

export function parseMerge(text: string): MergeParse {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const conflicts: MergeConflict[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^<<<<<<<( |$)/.test(lines[i])) {
      i++
      continue
    }
    const start = i
    let j = i + 1
    const ours: string[] = []
    const base: string[] = []
    const theirs: string[] = []
    let part: 'ours' | 'base' | 'theirs' = 'ours'
    let hasBase = false
    let closed = false
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (part !== 'theirs' && /^\|\|\|\|\|\|\|( |$)/.test(l)) {
        part = 'base'
        hasBase = true
      } else if (part !== 'theirs' && l === '=======') part = 'theirs'
      else if (part === 'theirs' && /^>>>>>>>( |$)/.test(l)) {
        closed = true
        break
      } else (part === 'ours' ? ours : part === 'base' ? base : theirs).push(l)
    }
    if (!closed) break // an unfinished conflict: leave the rest alone
    conflicts.push({
      index: conflicts.length,
      start,
      end: j,
      oursLabel: lines[start].slice(8).trim(),
      theirsLabel: lines[j].slice(8).trim(),
      ours,
      base: hasBase ? base : null,
      theirs
    })
    i = j + 1
  }
  return { lines, eol, conflicts }
}

export type Side = 'ours' | 'theirs' | 'base' | 'both' | 'both-reverse'

const pick = (c: MergeConflict, side: Side): string[] =>
  side === 'ours' ? c.ours : side === 'theirs' ? c.theirs : side === 'base' ? (c.base ?? []) : side === 'both' ? [...c.ours, ...c.theirs] : [...c.theirs, ...c.ours]

/** The text with every conflict replaced by the chosen side (per conflict, or one side for all). */
export function resolveText(text: string, choose: Side | ((c: MergeConflict) => Side | null)): string {
  const p = parseMerge(text)
  const out: string[] = []
  let at = 0
  for (const c of p.conflicts) {
    out.push(...p.lines.slice(at, c.start))
    const side = typeof choose === 'function' ? choose(c) : choose
    if (side === null) out.push(...p.lines.slice(c.start, c.end + 1)) // left as it is
    else out.push(...pick(c, side))
    at = c.end + 1
  }
  out.push(...p.lines.slice(at))
  return out.join(p.eol)
}

/** Where each conflict is in the text produced by resolveText with one side (0-based first line, line count). */
export function conflictSpans(text: string, side: Side): { start: number; count: number }[] {
  const p = parseMerge(text)
  const spans: { start: number; count: number }[] = []
  let removed = 0
  for (const c of p.conflicts) {
    const n = pick(c, side).length
    spans.push({ start: c.start - removed, count: n })
    removed += c.end - c.start + 1 - n
  }
  return spans
}

export const countConflicts = (text: string): number => parseMerge(text).conflicts.length
