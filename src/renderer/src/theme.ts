import { monaco } from './monaco-setup'

// One palette drives everything: the CSS variables used by the UI, the Monaco editor theme
// (also used by diff views) and the terminal colours.

import { BUILTIN_THEMES } from './themeData'
import { ensureContrast } from './contrast'
import type { SyntaxColors, Theme, UiColors } from './themeData'
export type { Theme } from './themeData'

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
  // The accent colour used for text (links, names): a shade of it that is readable on every surface.
  root.style.setProperty('--accent-text', ensureContrast(u.accent, [u.bg, u.side, u.sunken]))
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
