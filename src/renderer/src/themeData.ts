// The palettes of the built-in themes, as plain data (no Monaco), so tests can check them too.

export interface UiColors {
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

export interface SyntaxColors {
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

export const BUILTIN_THEMES: Theme[] = [
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
    ui: { bg: '#282c34', side: '#21252b', sunken: '#1c1f24', hover: '#2c313a', active: '#3a3f4b', border: '#181a1f', fg: '#abb2bf', muted: '#8f949c', accent: '#528bff', onAccent: '#000000', danger: '#e2747d', ok: '#2b3d2f', sel: '#3e4451' },
    syntax: { comment: '#8f96a3', keyword: '#c678dd', string: '#98c379', number: '#d19a66', type: '#e5c07b', func: '#61afef', variable: '#e2747d', constant: '#d19a66', tag: '#e2747d', attr: '#d19a66' }
  },
  {
    id: 'dracula',
    label: 'Dracula',
    type: 'dark',
    ui: { bg: '#282a36', side: '#21222c', sunken: '#1a1b24', hover: '#343746', active: '#44475a', border: '#191a21', fg: '#f8f8f2', muted: '#9aa5ce', accent: '#bd93f9', onAccent: '#282a36', danger: '#ff5555', ok: '#25402e', sel: '#44475a' },
    syntax: { comment: '#8692b9', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', type: '#8be9fd', func: '#50fa7b', variable: '#f8f8f2', constant: '#bd93f9', tag: '#ff79c6', attr: '#50fa7b' }
  },
  {
    id: 'monokai',
    label: 'Monokai',
    type: 'dark',
    ui: { bg: '#272822', side: '#1e1f1c', sunken: '#191a16', hover: '#34352f', active: '#49483e', border: '#131310', fg: '#f8f8f2', muted: '#929288', accent: '#a6e22e', onAccent: '#1e1f1c', danger: '#fa4e8c', ok: '#2f3d1f', sel: '#49483e' },
    syntax: { comment: '#95917b', keyword: '#fa4e8c', string: '#e6db74', number: '#ae81ff', type: '#66d9ef', func: '#a6e22e', variable: '#f8f8f2', constant: '#ae81ff', tag: '#fa4e8c', attr: '#a6e22e' }
  },
  {
    id: 'nord',
    label: 'Nord',
    type: 'dark',
    ui: { bg: '#2e3440', side: '#292e39', sunken: '#242933', hover: '#3b4252', active: '#434c5e', border: '#232831', fg: '#d8dee9', muted: '#939db1', accent: '#88c0d0', onAccent: '#2e3440', danger: '#d18d93', ok: '#3b4f45', sel: '#434c5e' },
    syntax: { comment: '#939db2', keyword: '#81a1c1', string: '#a3be8c', number: '#b691af', type: '#8fbcbb', func: '#88c0d0', variable: '#d8dee9', constant: '#b691af', tag: '#81a1c1', attr: '#8fbcbb' }
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    type: 'dark',
    ui: { bg: '#1a1b26', side: '#16161e', sunken: '#12121a', hover: '#20222f', active: '#292e42', border: '#101014', fg: '#c0caf5', muted: '#8184a0', accent: '#7aa2f7', onAccent: '#1a1b26', danger: '#f7768e', ok: '#23372b', sel: '#283457' },
    syntax: { comment: '#7b83ac', keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64', type: '#2ac3de', func: '#7aa2f7', variable: '#c0caf5', constant: '#ff9e64', tag: '#f7768e', attr: '#e0af68' }
  },
  {
    id: 'github-dark',
    label: 'GitHub Dark',
    type: 'dark',
    ui: { bg: '#0d1117', side: '#010409', sunken: '#010409', hover: '#161b22', active: '#21262d', border: '#30363d', fg: '#e6edf3', muted: '#8b949e', accent: '#2f81f7', onAccent: '#000000', danger: '#f85149', ok: '#12261e', sel: '#1c3d6e' },
    syntax: { comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', type: '#ffa657', func: '#d2a8ff', variable: '#e6edf3', constant: '#79c0ff', tag: '#7ee787', attr: '#79c0ff' }
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    type: 'dark',
    ui: { bg: '#002b36', side: '#00252f', sunken: '#001e26', hover: '#073642', active: '#0a4553', border: '#00181f', fg: '#93a1a1', muted: '#7c929a', accent: '#268bd2', onAccent: '#000000', danger: '#e56663', ok: '#0e3b30', sel: '#274642' },
    syntax: { comment: '#7a939b', keyword: '#859900', string: '#2aa198', number: '#dd649f', type: '#b58900', func: '#3295da', variable: '#93a1a1', constant: '#e96630', tag: '#3295da', attr: '#93a1a1' }
  },
  {
    id: 'light-modern',
    label: 'Light Modern',
    type: 'light',
    ui: { bg: '#ffffff', side: '#f8f8f8', sunken: '#f1f1f1', hover: '#eeeeee', active: '#e4e6f1', border: '#e5e5e5', fg: '#3b3b3b', muted: '#676e79', accent: '#005fb8', onAccent: '#ffffff', danger: '#cf222e', ok: '#dafbe1', sel: '#add6ff' },
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
    ui: { bg: '#fdf6e3', side: '#eee8d5', sunken: '#f5efdc', hover: '#eee8d5', active: '#e0dac5', border: '#ddd6c1', fg: '#566b72', muted: '#5b6969', accent: '#268bd2', onAccent: '#000000', danger: '#c62421', ok: '#e3edcd', sel: '#e6dfc8' },
    syntax: { comment: '#627171', keyword: '#667500', string: '#217d76', number: '#cd2d7a', type: '#8c6a00', func: '#2074af', variable: '#586e75', constant: '#c24815', tag: '#2074af', attr: '#627171' }
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    type: 'hc',
    ui: { bg: '#000000', side: '#000000', sunken: '#000000', hover: '#262626', active: '#0a3a6b', border: '#6fc3df', fg: '#ffffff', muted: '#cfcfcf', accent: '#1aebff', onAccent: '#000000', danger: '#ff6b6b', ok: '#003d1a', sel: '#264f78' },
    syntax: { comment: '#7ca668', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8', type: '#4ec9b0', func: '#dcdcaa', variable: '#9cdcfe', constant: '#4fc1ff', tag: '#569cd6', attr: '#9cdcfe' }
  }
]

