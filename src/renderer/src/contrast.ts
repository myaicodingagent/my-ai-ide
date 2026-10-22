// WCAG contrast helpers. Used to make sure text drawn in the theme's accent colour stays readable.

const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))

export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  const d = mx - mn
  let h = 0
  let s = 0
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1))
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, s, l]
}

function fromHsl([h, s, l]: [number, number, number]): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
}

/** `color`, or the nearest lighter/darker shade of it, that reaches `target` contrast on every background. */
export function ensureContrast(color: string, backgrounds: string[], target = 4.5): string {
  if (backgrounds.every((b) => contrastRatio(color, b) >= target)) return color
  const [h, s, l] = toHsl(color)
  const dark = backgrounds.every((b) => luminance(b) < 0.4)
  for (let step = 1; step <= 100; step++) {
    const c = fromHsl([h, s, Math.min(1, Math.max(0, l + (dark ? 1 : -1) * step * 0.01))])
    if (backgrounds.every((b) => contrastRatio(c, b) >= target)) return c
  }
  return dark ? '#ffffff' : '#000000'
}
