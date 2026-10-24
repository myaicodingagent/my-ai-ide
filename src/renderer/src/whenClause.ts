// "when" clauses of extension menus (package.json: { "command": "x.rename", "when": "view == demo.tree && viewItem == fruit" }).
// Supported: keys, true/false, !, &&, ||, parentheses, ==, !=, =~ (a /regex/), and quoted or bare values on the right.
// A key that is not known is undefined, which makes the test false (and `!key` true), as in VS Code.

export type WhenContext = Record<string, string | boolean | undefined>

type Tok = { t: 'op' | 'word' | 'str' | 're'; v: string }

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
    } else if (src.startsWith('&&', i) || src.startsWith('||', i) || src.startsWith('==', i) || src.startsWith('!=', i) || src.startsWith('=~', i)) {
      out.push({ t: 'op', v: src.slice(i, i + 2) })
      i += 2
    } else if (c === '!' || c === '(' || c === ')') {
      out.push({ t: 'op', v: c })
      i++
    } else if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1)
      if (end < 0) return null
      out.push({ t: 'str', v: src.slice(i + 1, end) })
      i = end + 1
    } else if (c === '/' && out.length && out[out.length - 1].v === '=~') {
      let j = i + 1
      while (j < src.length && (src[j] !== '/' || src[j - 1] === String.fromCharCode(92))) j++
      if (j >= src.length) return null
      let k = j + 1
      while (k < src.length && /[a-z]/i.test(src[k])) k++
      out.push({ t: 're', v: src.slice(i + 1, j) + '/' + src.slice(j + 1, k) })
      i = k
    } else {
      let j = i
      while (j < src.length && !/[\s()!=&|]/.test(src[j])) j++
      if (j === i) return null
      out.push({ t: 'word', v: src.slice(i, j) })
      i = j
    }
  }
  return out
}

/** Evaluates a when clause; an empty clause is true, one that cannot be understood is false. */
export function evalWhen(clause: string, ctx: WhenContext): boolean {
  if (!clause.trim()) return true
  const toks = tokenize(clause)
  if (!toks) return false
  let pos = 0
  const peek = (): Tok | undefined => toks[pos]
  const key = (name: string): string | boolean | undefined => (name === 'true' ? true : name === 'false' ? false : ctx[name])
  const truthy = (v: string | boolean | undefined): boolean => v !== undefined && v !== false && v !== ''

  function parseOr(): boolean {
    let v = parseAnd()
    while (peek()?.v === '||' && peek()?.t === 'op') {
      pos++
      const r = parseAnd()
      v = v || r
    }
    return v
  }
  function parseAnd(): boolean {
    let v = parseNot()
    while (peek()?.v === '&&' && peek()?.t === 'op') {
      pos++
      const r = parseNot()
      v = v && r
    }
    return v
  }
  function parseNot(): boolean {
    if (peek()?.t === 'op' && peek()?.v === '!') {
      pos++
      return !parseNot()
    }
    return parseCmp()
  }
  function parseCmp(): boolean {
    const t = peek()
    if (!t) throw new Error('unexpected end')
    pos++
    if (t.t === 'op' && t.v === '(') {
      const v = parseOr()
      if (peek()?.v !== ')') throw new Error('missing )')
      pos++
      return v
    }
    if (t.t !== 'word') throw new Error('unexpected ' + t.v)
    const left = key(t.v)
    const op = peek()
    if (op?.t === 'op' && (op.v === '==' || op.v === '!=')) {
      pos++
      const r = peek()
      if (!r || (r.t !== 'word' && r.t !== 'str')) throw new Error('missing value')
      pos++
      const right = r.t === 'word' ? (r.v === 'true' ? true : r.v === 'false' ? false : r.v) : r.v
      const same = left === right || (left !== undefined && String(left) === String(right))
      return op.v === '==' ? same : !same
    }
    if (op?.t === 'op' && op.v === '=~') {
      pos++
      const r = peek()
      if (!r || r.t !== 're') throw new Error('missing regex')
      pos++
      const cut = r.v.lastIndexOf('/')
      try {
        return left !== undefined && new RegExp(r.v.slice(0, cut), r.v.slice(cut + 1)).test(String(left))
      } catch {
        return false
      }
    }
    return truthy(left)
  }

  try {
    const v = parseOr()
    return pos === toks.length ? v : false
  } catch {
    return false
  }
}

/** Menu order: "navigation" first, then groups by name; "group@3" puts an entry at position 3 in its group. */
export function menuOrder(group: string): { name: string; order: number } {
  const [name, order] = group.split('@')
  return { name: name || '', order: order !== undefined && /^-?\d+$/.test(order) ? Number(order) : 0 }
}
