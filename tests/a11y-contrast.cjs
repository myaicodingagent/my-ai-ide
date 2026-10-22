// Checks that every built-in theme meets WCAG AA contrast (4.5:1 for text) for the colours the UI draws text with.
// `npm run test:contrast`; with --fix it prints (and, with --write, applies) the smallest lightness change that makes a failing colour pass.
const fs = require('fs'), path = require('path')
const root = path.join(__dirname, '..')
const out = path.join(root, 'node_modules', '.cache', 'themedata-bundle.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/renderer/src/themeData.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' })
const { BUILTIN_THEMES } = require(out)

const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const lum = (h) => { const c = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const toHsl = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2; const d = mx - mn; let hh = 0, s = 0; if (d) { s = d / (1 - Math.abs(2 * l - 1)); hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360 } return [hh, s, l] }
const fromHsl = ([h, s, l]) => { const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2; const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]; return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('') }

// The smallest change in lightness (same hue and saturation) that gives `target` against every background.
function fixColor(color, backgrounds, target) {
  const [h, s, l] = toHsl(color)
  const dark = backgrounds.every((b) => lum(b) < 0.4)
  for (let step = 0; step <= 100; step++) {
    const nl = Math.min(1, Math.max(0, l + (dark ? 1 : -1) * step * 0.01))
    const c = fromHsl([h, s, nl])
    if (backgrounds.every((b) => ratio(c, b) >= target)) return c
  }
  return dark ? '#ffffff' : '#000000'
}

const AA = 4.5
const problems = []
for (const t of BUILTIN_THEMES) {
  const { ui, syntax } = t
  const bgs = [ui.bg, ui.side, ui.sunken]
  const need = (label, color, backgrounds, section, key, extra) => {
    const worst = Math.min(...backgrounds.map((b) => ratio(color, b)))
    if (worst < AA) problems.push({ theme: t.id, label, section, key, color, worst, fix: extra ? extra() : fixColor(color, backgrounds, AA + 0.05) })
  }
  need('text on the editor, sidebar and inputs', ui.fg, bgs, 'ui', 'fg')
  need('secondary text', ui.muted, bgs, 'ui', 'muted')
  need('error text', ui.danger, [ui.bg, ui.side], 'ui', 'danger')
  // Text on a button-coloured background: pick white or black, whichever reads better.
  if (ratio(ui.onAccent, ui.accent) < AA) {
    const best = ratio('#ffffff', ui.accent) >= ratio('#000000', ui.accent) ? '#ffffff' : '#000000'
    problems.push({ theme: t.id, label: 'text on buttons', section: 'ui', key: 'onAccent', color: ui.onAccent, worst: ratio(ui.onAccent, ui.accent), fix: best, stillFails: ratio(best, ui.accent) < AA })
  }
  for (const [k, v] of Object.entries(syntax)) need(`code colour "${k}"`, v, [ui.bg], 'syntax', k)
}

if (process.argv.includes('--fix')) {
  for (const p of problems) console.log(`${p.theme}.${p.section}.${p.key}: ${p.color} (${p.worst.toFixed(2)}) -> ${p.fix}${p.stillFails ? ' (still below 4.5: change the accent)' : ''}`)
  if (process.argv.includes('--write')) {
    const file = path.join(root, 'src/renderer/src/themeData.ts')
    let s = fs.readFileSync(file, 'utf8')
    for (const p of problems) {
      const at = s.indexOf(`id: '${p.theme}'`)
      const sect = s.indexOf(`${p.section}: {`, at)
      const re = new RegExp(`(\\b${p.key}: ')${p.color}(')`)
      const rest = s.slice(sect)
      if (!re.test(rest)) throw new Error('cannot find ' + p.theme + '.' + p.key)
      s = s.slice(0, sect) + rest.replace(re, `$1${p.fix}$2`)
    }
    fs.writeFileSync(file, s)
    console.log('written')
  }
  process.exit(0)
}

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`) }
for (const t of BUILTIN_THEMES) {
  const mine = problems.filter((p) => p.theme === t.id)
  check(`${t.label}: all text colours reach 4.5:1`, mine.length === 0, mine.map((p) => `${p.key} ${p.worst.toFixed(2)}`).join(', '))
}
const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
