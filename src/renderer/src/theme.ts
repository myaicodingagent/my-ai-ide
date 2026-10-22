import { monaco } from './monaco-setup'

// One palette drives everything: the CSS variables used by the UI, the Monaco editor theme
// (also used by diff views) and the terminal colours.

interface UiColors {
  bg: string // editor and main surfaces
  side: string // sidebar, chat panel, tab strip, status bar
  sunken: string // inputs and code blocks
  hover: string
  active: string // selected list rows
  border: string
  fg: string
  muted: string
  accent: string
  onAccent: string // text on an accent background
  danger: string
  ok: string // background tint for "applied" markers
  sel: string // editor selection
}

interface SyntaxColors {
  comment: string
  keyword: string
  string: string
  number: string
  type: string
  func: string
  variable: string
  constant: string
  tag: string
  attr: string
}

export interface Theme {
  id: string
  label: string
  type: 'dark' | 'light' | 'hc'
  ui: UiColors
  syntax: SyntaxColors
  custom?: boolean // loaded from a file in the themes folder
}

const BUILTIN_THEMES: Theme[] = [
  {
    id: 'dark-modern',
    label: 'Dark Modern',
    type: 'dark',
    ui: { bg: '#1f1f1f', side: '#181818', sunken: '#141414', hover: '#2a2d2e', active: '#37373d', border: '#2b2b2b', fg: '#cccccc', muted: '#8b8b8b', accent: '#0078d4', onAccent: '#ffffff', danger: '#f85149', ok: '#1b3a28', sel: '#264f78' },
    syntax: { comment: '#6a9955', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8', type: '#4ec9b0', func: '#dcdcaa', variable: '#9cdcfe', constant: '#4fc1ff', tag: '#569cd6', attr: '#9cdcfe' }
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    type: 'dark',
    ui: { bg: '#282c34', side: '#21252b', sunken: '#1c1f24', hover: '#2c313a', active: '#3a3f4b', border: '#181a1f', fg: '#abb2bf', muted: '#7f848e', accent: '#528bff', onAccent: '#ffffff', danger: '#e06c75', ok: '#2b3d2f', sel: '#3e4451' },
    syntax: { comment: '#5c6370', keyword: '#c678dd', string: '#98c379', number: '#d19a66', type: '#e5c07b', func: '#61afef', variable: '#e06c75', constant: '#d19a66', tag: '#e06c75', attr: '#d19a66' }
  },
  {
    id: 'dracula',
    label: 'Dracula',
    type: 'dark',
    ui: { bg: '#282a36', side: '#21222c', sunken: '#1a1b24', hover: '#343746', active: '#44475a', border: '#191a21', fg: '#f8f8f2', muted: '#9aa5ce', accent: '#bd93f9', onAccent: '#282a36', danger: '#ff5555', ok: '#25402e', sel: '#44475a' },
    syntax: { comment: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', type: '#8be9fd', func: '#50fa7b', variable: '#f8f8f2', constant: '#bd93f9', tag: '#ff79c6', attr: '#50fa7b' }
  },
  {
    id: 'monokai',
    label: 'Monokai',
    type: 'dark',
    ui: { bg: '#272822', side: '#1e1f1c', sunken: '#191a16', hover: '#34352f', active: '#49483e', border: '#131310', fg: '#f8f8f2', muted: '#929288', accent: '#a6e22e', onAccent: '#1e1f1c', danger: '#f92672', ok: '#2f3d1f', sel: '#49483e' },
    syntax: { comment: '#75715e', keyword: '#f92672', string: '#e6db74', number: '#ae81ff', type: '#66d9ef', func: '#a6e22e', variable: '#f8f8f2', constant: '#ae81ff', tag: '#f92672', attr: '#a6e22e' }
  },
  {
    id: 'nord',
    label: 'Nord',
    type: 'dark',
    ui: { bg: '#2e3440', side: '#292e39', sunken: '#242933', hover: '#3b4252', active: '#434c5e', border: '#232831', fg: '#d8dee9', muted: '#8d98ad', accent: '#88c0d0', onAccent: '#2e3440', danger: '#bf616a', ok: '#3b4f45', sel: '#434c5e' },
    syntax: { comment: '#616e88', keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead', type: '#8fbcbb', func: '#88c0d0', variable: '#d8dee9', constant: '#b48ead', tag: '#81a1c1', attr: '#8fbcbb' }
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    type: 'dark',
    ui: { bg: '#1a1b26', side: '#16161e', sunken: '#12121a', hover: '#20222f', active: '#292e42', border: '#101014', fg: '#c0caf5', muted: '#787c99', accent: '#7aa2f7', onAccent: '#1a1b26', danger: '#f7768e', ok: '#23372b', sel: '#283457' },
    syntax: { comment: '#565f89', keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64', type: '#2ac3de', func: '#7aa2f7', variable: '#c0caf5', constant: '#ff9e64', tag: '#f7768e', attr: '#e0af68' }
  },
  {
    id: 'github-dark',
    label: 'GitHub Dark',
    type: 'dark',
    ui: { bg: '#0d1117', side: '#010409', sunken: '#010409', hover: '#161b22', active: '#21262d', border: '#30363d', fg: '#e6edf3', muted: '#8b949e', accent: '#2f81f7', onAccent: '#ffffff', danger: '#f85149', ok: '#12261e', sel: '#1c3d6e' },
    syntax: { comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', type: '#ffa657', func: '#d2a8ff', variable: '#e6edf3', constant: '#79c0ff', tag: '#7ee787', attr: '#79c0ff' }
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    type: 'dark',
    ui: { bg: '#002b36', side: '#00252f', sunken: '#001e26', hover: '#073642', active: '#0a4553', border: '#00181f', fg: '#93a1a1', muted: '#657b83', accent: '#268bd2', onAccent: '#fdf6e3', danger: '#dc322f', ok: '#0e3b30', sel: '#274642' },
    syntax: { comment: '#586e75', keyword: '#859900', string: '#2aa198', number: '#d33682', type: '#b58900', func: '#268bd2', variable: '#93a1a1', constant: '#cb4b16', tag: '#268bd2', attr: '#93a1a1' }
  },
  {
    id: 'light-modern',
    label: 'Light Modern',
    type: 'light',
    ui: { bg: '#ffffff', side: '#f8f8f8', sunken: '#f1f1f1', hover: '#eeeeee', active: '#e4e6f1', border: '#e5e5e5', fg: '#3b3b3b', muted: '#6e7681', accent: '#005fb8', onAccent: '#ffffff', danger: '#cf222e', ok: '#dafbe1', sel: '#add6ff' },
    syntax: { comment: '#008000', keyword: '#0000ff', string: '#a31515', number: '#098658', type: '#267f99', func: '#795e26', variable: '#001080', constant: '#0070c1', tag: '#800000', attr: '#e50000' }
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    type: 'light',
    ui: { bg: '#ffffff', side: '#f6f8fa', sunken: '#eef1f4', hover: '#eaeef2', active: '#ddf4ff', border: '#d0d7de', fg: '#1f2328', muted: '#656d76', accent: '#0969da', onAccent: '#ffffff', danger: '#cf222e', ok: '#dafbe1', sel: '#b6e3ff' },
    syntax: { comment: '#6e7781', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', type: '#953800', func: '#8250df', variable: '#1f2328', constant: '#0550ae', tag: '#116329', attr: '#0550ae' }
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    type: 'light',
    ui: { bg: '#fdf6e3', side: '#eee8d5', sunken: '#f5efdc', hover: '#eee8d5', active: '#e0dac5', border: '#ddd6c1', fg: '#586e75', muted: '#93a1a1', accent: '#268bd2', onAccent: '#fdf6e3', danger: '#dc322f', ok: '#e3edcd', sel: '#e6dfc8' },
    syntax: { comment: '#93a1a1', keyword: '#859900', string: '#2aa198', number: '#d33682', type: '#b58900', func: '#268bd2', variable: '#586e75', constant: '#cb4b16', tag: '#268bd2', attr: '#93a1a1' }
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    type: 'hc',
    ui: { bg: '#000000', side: '#000000', sunken: '#000000', hover: '#262626', active: '#0a3a6b', border: '#6fc3df', fg: '#ffffff', muted: '#cfcfcf', accent: '#1aebff', onAccent: '#000000', danger: '#ff6b6b', ok: '#003d1a', sel: '#264f78' },
    syntax: { comment: '#7ca668', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8', type: '#4ec9b0', func: '#dcdcaa', variable: '#9cdcfe', constant: '#4fc1ff', tag: '#569cd6', attr: '#9cdcfe' }
  }
]

export const DEFAULT_THEME_ID = 'dark-modern'
const STORAGE_KEY = 'theme-id'

// Built-in themes plus any valid custom ones; replaced whenever custom themes are (re)loaded.
let all: Theme[] = BUILTIN_THEMES
let themeErrors: string[] = []

export const getThemes = (): Theme[] => all
export const getThemeErrors = (): string[] => themeErrors

const byId = (id: string): Theme => all.find((t) => t.id === id) ?? all[0]

// --- Monaco ------------------------------------------------------------------

const hex = (c: string): string => c.replace('#', '')
// "#rrggbb" + two hex digits of alpha
const alpha = (c: string, a: string): string => c + a

// Monaco only accepts letters, digits and hyphens in a theme name, and ids of custom themes contain
// the file name (":" and "."), so those get a name made from a hash of the id instead.
function monacoThemeName(t: Theme): string {
  if (!t.custom) return t.id
  let h = 5381
  for (const ch of t.id) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0
  return `custom-${h.toString(16)}`
}

function defineMonacoTheme(t: Theme): void {
  const s = t.syntax
  const u = t.ui
  monaco.editor.defineTheme(monacoThemeName(t), {
    base: t.type === 'light' ? 'vs' : t.type === 'hc' ? 'hc-black' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: hex(u.fg) },
      { token: 'comment', foreground: hex(s.comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: hex(s.keyword) },
      { token: 'string', foreground: hex(s.string) },
      { token: 'string.escape', foreground: hex(s.constant) },
      { token: 'regexp', foreground: hex(s.string) },
      { token: 'number', foreground: hex(s.number) },
      { token: 'type', foreground: hex(s.type) },
      { token: 'type.identifier', foreground: hex(s.type) },
      { token: 'function', foreground: hex(s.func) },
      { token: 'identifier', foreground: hex(s.variable) },
      { token: 'variable', foreground: hex(s.variable) },
      { token: 'variable.predefined', foreground: hex(s.constant) },
      { token: 'constant', foreground: hex(s.constant) },
      { token: 'tag', foreground: hex(s.tag) },
      { token: 'metatag', foreground: hex(s.tag) },
      { token: 'attribute.name', foreground: hex(s.attr) },
      { token: 'attribute.value', foreground: hex(s.string) },
      // Monaco's built-in dark/light themes colour these language-specific tokens, and a more specific
      // token name beats a general one, so they have to be set here for the theme to apply to JSON and CSS.
      { token: 'string.key.json', foreground: hex(s.attr) },
      { token: 'string.value.json', foreground: hex(s.string) },
      { token: 'keyword.json', foreground: hex(s.constant) },
      { token: 'number.json', foreground: hex(s.number) },
      { token: 'tag.css', foreground: hex(s.tag) },
      { token: 'attribute.name.css', foreground: hex(s.attr) },
      { token: 'attribute.value.css', foreground: hex(s.string) },
      { token: 'attribute.value.number.css', foreground: hex(s.number) },
      { token: 'attribute.value.unit.css', foreground: hex(s.number) },
      { token: 'attribute.value.hex.css', foreground: hex(s.number) },
      { token: 'delimiter', foreground: hex(u.fg) },
      { token: 'delimiter.html', foreground: hex(s.tag) }
    ],
    colors: {
      'editor.background': u.bg,
      'editor.foreground': u.fg,
      'editor.selectionBackground': u.sel,
      'editor.inactiveSelectionBackground': alpha(u.sel, '99'),
      'editor.lineHighlightBackground': alpha(u.hover, t.type === 'light' ? 'cc' : '99'),
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': u.accent,
      'editorLineNumber.foreground': u.muted,
      'editorLineNumber.activeForeground': u.fg,
      'editorGutter.background': u.bg,
      'editorIndentGuide.background1': alpha(u.border, '99'),
      'editorWidget.background': u.side,
      'editorWidget.border': u.border,
      'editorSuggestWidget.background': u.side,
      'editorSuggestWidget.border': u.border,
      'editorSuggestWidget.selectedBackground': u.active,
      'editorHoverWidget.background': u.side,
      'editorHoverWidget.border': u.border,
      'editorGhostText.foreground': alpha(u.muted, 'cc'),
      'input.background': u.sunken,
      'input.border': u.border,
      'list.hoverBackground': u.hover,
      'list.activeSelectionBackground': u.active,
      'minimap.background': u.bg,
      'scrollbarSlider.background': alpha(u.muted, '33'),
      'scrollbarSlider.hoverBackground': alpha(u.muted, '55'),
      'scrollbarSlider.activeBackground': alpha(u.muted, '77'),
      'diffEditor.insertedTextBackground': t.type === 'light' ? '#2ea04333' : '#2ea04338',
      'diffEditor.removedTextBackground': t.type === 'light' ? '#f8514933' : '#f8514938',
      'diffEditor.insertedLineBackground': t.type === 'light' ? '#2ea0431a' : '#2ea04320',
      'diffEditor.removedLineBackground': t.type === 'light' ? '#f851491a' : '#f8514920'
    }
  })
}

// --- Terminal ----------------------------------------------------------------

const ANSI_DARK = {
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff'
}
const ANSI_LIGHT = {
  black: '#000000', red: '#cd3131', green: '#00a000', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
  brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14a014', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5'
}

export function terminalTheme(t: Theme = getTheme()): Record<string, string> {
  return {
    background: t.ui.bg,
    foreground: t.ui.fg,
    cursor: t.ui.accent,
    cursorAccent: t.ui.bg,
    selectionBackground: t.ui.sel,
    ...(t.type === 'light' ? ANSI_LIGHT : ANSI_DARK)
  }
}

// --- Applying a theme --------------------------------------------------------

let current = byId(DEFAULT_THEME_ID)
const listeners = new Set<() => void>()

export const getTheme = (): Theme => current

export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Switches the whole UI to a theme. With `persist` it is also remembered for the next launch. */
export function applyTheme(id: string, persist = false): void {
  const t = byId(id)
  current = t
  const root = document.documentElement
  const u = t.ui
  const vars: Record<string, string> = {
    bg: u.bg, side: u.side, sunken: u.sunken, hover: u.hover, active: u.active, border: u.border,
    fg: u.fg, muted: u.muted, accent: u.accent, 'on-accent': u.onAccent, danger: u.danger, ok: u.ok, sel: u.sel
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(`--${k}`, v)
  root.dataset.themeType = t.type
  root.style.colorScheme = t.type === 'light' ? 'light' : 'dark' // native scrollbars, form controls
  monaco.editor.setTheme(monacoThemeName(t))
  // Match the window frame (title bar, dialogs) to the theme.
  void window.api.setNativeTheme(t.type === 'light' ? 'light' : 'dark')
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, t.id)
    } catch {
      // The choice just won't be remembered.
    }
  }
  listeners.forEach((cb) => cb())
}

// --- Custom themes (JSON files in the themes folder) --------------------------

const UI_KEYS = ['bg', 'side', 'sunken', 'hover', 'active', 'border', 'fg', 'muted', 'accent', 'onAccent', 'danger', 'ok', 'sel']
const SYNTAX_KEYS = ['comment', 'keyword', 'string', 'number', 'type', 'func', 'variable', 'constant', 'tag', 'attr']
const FIELDS = ['name', 'type', 'base', 'ui', 'syntax']
const BASE_FOR_TYPE = { dark: 'dark-modern', light: 'light-modern', hc: 'high-contrast' }

// Accepts #rgb or #rrggbb and returns #rrggbb in lower case, or null if it is not a colour.
function normalizeColor(v: unknown): string | null {
  const m = typeof v === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim()) : null
  if (!m) return null
  const h = m[1].toLowerCase()
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h)
}

// Starts from the base palette and overlays the colours given in the file. Problems are added to `errors`.
function readPalette<T extends object>(src: unknown, keys: string[], base: T, where: string, errors: string[]): T {
  const out = { ...base } as Record<string, string>
  if (src === undefined) return out as T
  if (typeof src !== 'object' || src === null || Array.isArray(src)) {
    errors.push(`"${where}" must be an object of colors`)
    return out as T
  }
  for (const [k, v] of Object.entries(src)) {
    if (!keys.includes(k)) errors.push(`unknown color "${where}.${k}" (allowed: ${keys.join(', ')})`)
    else {
      const c = normalizeColor(v)
      if (c) out[k] = c
      else errors.push(`"${where}.${k}" must be a color like #1a2b3c (got ${JSON.stringify(v)})`)
    }
  }
  return out as T
}

/** Turns the text of a theme file into a theme, or a list of what is wrong with it. */
export function parseCustomTheme(file: string, text: string): { theme?: Theme; errors: string[] } {
  if (!text.trim()) return { errors: ['the file is empty or larger than 100 KB'] }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { errors: [`not valid JSON (${(e as Error).message})`] }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { errors: ['the top level must be an object'] }
  }
  const d = data as Record<string, unknown>
  const errors: string[] = []
  for (const k of Object.keys(d)) if (!FIELDS.includes(k)) errors.push(`unknown field "${k}" (allowed: ${FIELDS.join(', ')})`)

  const rawType = d.type === undefined ? 'dark' : d.type
  if (rawType !== 'dark' && rawType !== 'light' && rawType !== 'hc') errors.push('"type" must be "dark", "light" or "hc"')
  const type: Theme['type'] = rawType === 'light' || rawType === 'hc' ? rawType : 'dark'

  // Colours missing from the file come from this built-in theme.
  const baseId = typeof d.base === 'string' ? d.base : BASE_FOR_TYPE[type]
  const found = BUILTIN_THEMES.find((b) => b.id === baseId)
  if (!found) errors.push(`"base" must be a built-in theme id (${BUILTIN_THEMES.map((b) => b.id).join(', ')})`)
  const base = found ?? BUILTIN_THEMES[0]

  const ui = readPalette<UiColors>(d.ui, UI_KEYS, base.ui, 'ui', errors)
  const syntax = readPalette<SyntaxColors>(d.syntax, SYNTAX_KEYS, base.syntax, 'syntax', errors)
  if (errors.length) return { errors }

  const label = typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 40) : file.replace(/\.json$/i, '')
  return { theme: { id: `custom:${file}`, label, type, ui, syntax, custom: true }, errors: [] }
}

/** A complete theme file for `t`, used by "Duplicate current theme" as a starting point to edit. */
export const themeToJson = (t: Theme): string =>
  JSON.stringify({ name: `${t.label} copy`, type: t.type, ui: t.ui, syntax: t.syntax }, null, 2) + '\n'

/** Reads the themes folder and rebuilds the theme list. Safe to call again after files change. */
export async function loadCustomThemes(): Promise<void> {
  let files: { file: string; text: string }[] = []
  try {
    files = await window.api.themesList()
  } catch {
    // Keep whatever is loaded now.
  }
  const custom: Theme[] = []
  const errors: string[] = []
  for (const f of files) {
    const r = parseCustomTheme(f.file, f.text)
    if (!r.theme) {
      errors.push(`${f.file}: ${r.errors.join('; ')}`)
      continue
    }
    // A theme that Monaco rejects must never stop the app from starting; report it and move on.
    try {
      defineMonacoTheme(r.theme)
      custom.push(r.theme)
    } catch (e) {
      errors.push(`${f.file}: could not be used (${(e as Error).message})`)
    }
  }
  all = [...BUILTIN_THEMES, ...custom]
  themeErrors = errors
  // Re-apply the active theme so edits to its file show up. If its file is gone, go back to the default.
  const gone = current.custom && !custom.some((t) => t.id === current.id)
  applyTheme(gone ? DEFAULT_THEME_ID : current.id)
}

export async function initTheme(): Promise<void> {
  BUILTIN_THEMES.forEach(defineMonacoTheme)
  try {
    await loadCustomThemes() // before applying the saved choice, which may be a custom theme
  } catch {
    // Custom themes are optional: carry on with the built-in ones.
  }
  let saved = DEFAULT_THEME_ID
  try {
    saved = localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME_ID
  } catch {
    // Use the default.
  }
  applyTheme(saved)
}
