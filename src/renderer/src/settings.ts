import { useSyncExternalStore } from 'react'
import { DEFAULT_MODEL, MODELS } from './models'

export interface Settings {
  fontSize: number // editor
  fontFamily: string // editor and terminal; one font name
  minimap: boolean
  wordWrap: boolean
  ligatures: boolean
  uiZoom: number // 1 = 100%
  terminalFontSize: number
  terminalShell: string // id of the shell new terminals start with (see term:shells in the main process)
  defaultModel: string // used by chat, agent and inline edit
  autocomplete: boolean
  screenReader: boolean // tell the editor and terminal that a screen reader is in use (otherwise they detect it)
  reduceMotion: boolean // no animations (the system's own setting is respected as well)
  meaningSearch: boolean // search by meaning with a small model that runs on this PC (downloaded once, about 23 MB)
  languageServers: boolean // start language servers (gopls, pylsp, rust-analyzer, clangd...) for the open files
  nextEdit: boolean // suggest the edit you are likely to make next (Tab jumps to it, Tab applies it)
  autoCheckUpdates: boolean // look for a new version at startup and every few hours
  autoSave: 'off' | 'afterDelay' | 'onBlur' // when to save edited files without being asked
  formatOnSave: boolean // format the active file first (JS, TS, JSON, CSS, HTML)
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  fontFamily: 'Cascadia Code',
  minimap: true,
  wordWrap: false,
  ligatures: false,
  uiZoom: 1,
  terminalFontSize: 13,
  terminalShell: 'powershell',
  defaultModel: DEFAULT_MODEL,
  autocomplete: true,
  nextEdit: false,
  languageServers: true,
  meaningSearch: true,
  screenReader: false,
  reduceMotion: false,
  autoCheckUpdates: true,
  autoSave: 'off',
  formatOnSave: false
}

export const LIMITS = {
  fontSize: [10, 28],
  terminalFontSize: [10, 24],
  uiZoom: [0.8, 1.6]
} as const

const STORAGE_KEY = 'settings'
const LEGACY_AUTOCOMPLETE_KEY = 'autocomplete-enabled'

const clamp = (n: unknown, [lo, hi]: readonly [number, number], fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback

// Accepts whatever was stored (possibly from an older version or hand-edited) and returns valid settings.
function sanitize(raw: Partial<Record<keyof Settings, unknown>>): Settings {
  const d = DEFAULT_SETTINGS
  const family = typeof raw.fontFamily === 'string' ? raw.fontFamily.replace(/["'\\;{}]/g, '').trim() : ''
  return {
    fontSize: Math.round(clamp(raw.fontSize, LIMITS.fontSize, d.fontSize)),
    fontFamily: family || d.fontFamily,
    minimap: typeof raw.minimap === 'boolean' ? raw.minimap : d.minimap,
    wordWrap: typeof raw.wordWrap === 'boolean' ? raw.wordWrap : d.wordWrap,
    ligatures: typeof raw.ligatures === 'boolean' ? raw.ligatures : d.ligatures,
    uiZoom: Math.round(clamp(raw.uiZoom, LIMITS.uiZoom, d.uiZoom) * 10) / 10,
    terminalFontSize: Math.round(clamp(raw.terminalFontSize, LIMITS.terminalFontSize, d.terminalFontSize)),
    terminalShell: typeof raw.terminalShell === 'string' && /^[a-z0-9_-]{1,30}$/i.test(raw.terminalShell) ? raw.terminalShell : d.terminalShell,
    defaultModel: MODELS.some((m) => m.id === raw.defaultModel) ? (raw.defaultModel as string) : d.defaultModel,
    autocomplete: typeof raw.autocomplete === 'boolean' ? raw.autocomplete : d.autocomplete,
    nextEdit: typeof raw.nextEdit === 'boolean' ? raw.nextEdit : d.nextEdit,
    languageServers: typeof raw.languageServers === 'boolean' ? raw.languageServers : d.languageServers,
    meaningSearch: typeof raw.meaningSearch === 'boolean' ? raw.meaningSearch : d.meaningSearch,
    screenReader: typeof raw.screenReader === 'boolean' ? raw.screenReader : d.screenReader,
    reduceMotion: typeof raw.reduceMotion === 'boolean' ? raw.reduceMotion : d.reduceMotion,
    autoCheckUpdates: typeof raw.autoCheckUpdates === 'boolean' ? raw.autoCheckUpdates : d.autoCheckUpdates,
    autoSave: raw.autoSave === 'afterDelay' || raw.autoSave === 'onBlur' ? raw.autoSave : 'off',
    formatOnSave: typeof raw.formatOnSave === 'boolean' ? raw.formatOnSave : d.formatOnSave
  }
}

function load(): Settings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return sanitize(JSON.parse(saved))
    // First run with settings: keep the autocomplete choice made in an earlier version.
    if (localStorage.getItem(LEGACY_AUTOCOMPLETE_KEY) === 'off') return { ...DEFAULT_SETTINGS, autocomplete: false }
  } catch {
    // Unreadable or blocked storage: use the defaults.
  }
  return { ...DEFAULT_SETTINGS }
}

let current: Settings = DEFAULT_SETTINGS
const listeners = new Set<() => void>()

export const getSettings = (): Settings => current

export function subscribeSettings(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The editor/terminal font as a CSS font-family list, with fallbacks if the chosen font is not installed. */
export const fontStack = (family: string = current.fontFamily): string =>
  `"${family}", "Cascadia Mono", Consolas, monospace`

/** Monaco options that come from the settings (used for the main editor and the diff views). */
export function editorOptions(s: Settings = current): {
  fontFamily: string
  fontSize: number
  lineHeight: number
  fontLigatures: boolean
  accessibilitySupport: 'auto' | 'on'
  smoothScrolling: boolean
  cursorSmoothCaretAnimation: 'on' | 'off'
} {
  const still = prefersLessMotion(s)
  return {
    fontFamily: fontStack(s.fontFamily),
    fontSize: s.fontSize,
    lineHeight: Math.round(s.fontSize * 1.6),
    fontLigatures: s.ligatures,
    accessibilitySupport: s.screenReader ? 'on' : 'auto',
    smoothScrolling: !still,
    cursorSmoothCaretAnimation: still ? 'off' : 'on'
  }
}

/** True when animation should be left out: asked for in Settings or by the system. */
export function prefersLessMotion(s: Settings = current): boolean {
  return s.reduceMotion || (typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

function applyToPage(s: Settings): void {
  document.documentElement.style.setProperty('--font-code', fontStack(s.fontFamily))
  document.documentElement.classList.toggle('reduce-motion', s.reduceMotion)
  window.api.setZoom(s.uiZoom)
}

export function updateSettings(patch: Partial<Settings>, persist = true): void {
  current = sanitize({ ...current, ...patch })
  applyToPage(current)
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
    } catch {
      // The change just won't be remembered.
    }
  }
  listeners.forEach((cb) => cb())
}

export const resetSettings = (): void => updateSettings({ ...DEFAULT_SETTINGS })

export function initSettings(): void {
  current = load()
  applyToPage(current)
}

/** React hook: the current settings, re-rendering when they change. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings)
}
