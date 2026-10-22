// A small Markdown renderer for notebook text cells. Everything is escaped first and only a fixed set of tags is added,
// so the result is safe to put on the page. Links are shown as text (nothing in a notebook should navigate the window).

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(text: string): string {
  let s = esc(text)
  const codes: string[] = []
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '<span class="md-image">[image: $1]</span>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<span class="md-link" title="$2">$1</span>')
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`)
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  const isBlockStart = (l: string): boolean => /^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+[.)]\s|\s*([-*_])(\s*\2){2,}\s*$)/.test(l)
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
      continue
    }
    const ul = /^\s*[-*+]\s+/.test(line)
    const ol = /^\s*\d+[.)]\s+/.test(line)
    if (ul || ol) {
      const items: string[] = []
      const re = ul ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/
      while (i < lines.length && re.test(lines[i])) {
        let item = re.exec(lines[i])![1]
        i++
        // a wrapped line belongs to the item
        while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i]) && /^\s+/.test(lines[i])) item += ' ' + lines[i++].trim()
        items.push(`<li>${inline(item)}</li>`)
      }
      out.push(`<${ul ? 'ul' : 'ol'}>${items.join('')}</${ul ? 'ul' : 'ol'}>`)
      continue
    }
    const para: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) para.push(lines[i++])
    out.push(`<p>${para.map(inline).join('<br>')}</p>`)
  }
  return out.join('\n')
}
