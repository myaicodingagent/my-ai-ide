import { monaco } from './monaco-setup'
import { getExtensions } from './extStore'
import { evalWhen, menuOrder, WhenContext } from './whenClause'
import type { MenuItem } from './ContextMenu'

// The entries that extensions add to menus about a file: the explorer's right-click menu (contributes.menus["explorer/context"]),
// a tab's right-click menu ("editor/title/context") and the buttons at the end of the tab bar ("editor/title"). Each one shows when
// its `when` clause holds for the file, and runs the extension's command with the file.

export type FileMenuKind = 'explorerMenus' | 'tabMenus' | 'editorTitleMenus'
export interface FileMenuEntry {
  extId: string
  command: string
  title: string
  group: string
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

/** The language of a file from its name, the way the editor picks it. */
export function languageOfPath(path: string): string {
  const name = baseName(path).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  const langs = monaco.languages.getLanguages()
  const hit = langs.find((l) => l.filenames?.some((f) => f.toLowerCase() === name)) ?? (ext ? langs.find((l) => l.extensions?.some((x) => x.toLowerCase() === ext)) : undefined)
  return hit?.id ?? 'plaintext'
}

export function fileContext(path: string, opts: { isDir?: boolean; isRoot?: boolean; langId?: string } = {}): WhenContext {
  const base = baseName(path)
  return {
    resourceScheme: 'file',
    isFileSystemResource: true,
    resourcePath: path,
    resourceFilename: base,
    resourceExtname: base.includes('.') ? base.slice(base.lastIndexOf('.')) : '',
    resourceLangId: opts.isDir ? undefined : (opts.langId ?? languageOfPath(path)),
    editorLangId: opts.langId,
    explorerResourceIsFolder: !!opts.isDir,
    explorerResourceIsRoot: !!opts.isRoot
  }
}

/** The entries of one menu that apply to this file, in VS Code's order: `navigation` first, then the groups by name, then by the number after @. */
export function fileMenuEntries(kind: FileMenuKind, path: string, opts: { isDir?: boolean; isRoot?: boolean; langId?: string } = {}): FileMenuEntry[] {
  const ctx = fileContext(path, opts)
  return getExtensions()
    .filter((e) => e.enabled && (e.vscode || e.native))
    .flatMap((e) => (e[kind] ?? []).filter((m) => evalWhen(m.when, ctx)).map((m) => ({ extId: e.id, command: m.command, title: m.title, group: m.group })))
    .map((m, i) => ({ m, i, g: menuOrder(m.group) }))
    .sort((a, b) => {
      if (a.g.name !== b.g.name) return a.g.name === 'navigation' ? -1 : b.g.name === 'navigation' ? 1 : a.g.name < b.g.name ? -1 : 1
      return a.g.order - b.g.order || a.i - b.i
    })
    .map((x) => x.m)
}

export const runFileMenuEntry = (m: FileMenuEntry, path: string): void => void window.api.extRun(m.extId, m.command, [{ $uri: path }])

/** The same entries as items of a right-click menu, with a divider between groups. */
export function fileMenuItems(kind: FileMenuKind, path: string, opts: { isDir?: boolean; isRoot?: boolean; langId?: string } = {}): MenuItem[] {
  const list = fileMenuEntries(kind, path, opts)
  return list.map((m, i) => ({
    label: m.title,
    run: () => runFileMenuEntry(m, path),
    separator: i === 0 || menuOrder(m.group).name !== menuOrder(list[i - 1].group).name
  }))
}
