import { useSyncExternalStore } from 'react'
import type { ExtRecord, SnippetSet } from '../../main/extensions'
import { monaco } from './monaco-setup'
import { loadCustomThemes } from './theme'

// The installed extensions, kept in sync with the main process, and what they bring to the editor:
// themes (through the theme list) and snippets (as completions).

let list: ExtRecord[] = []
let log: string[] = []
const listeners = new Set<() => void>()
let started = false
let snippetProviders: monaco.IDisposable[] = []

const emit = (): void => listeners.forEach((cb) => cb())

function registerSnippets(sets: SnippetSet[]): void {
  for (const p of snippetProviders) p.dispose()
  snippetProviders = []
  const byLanguage = new Map<string, SnippetSet['snippets']>()
  for (const s of sets) byLanguage.set(s.language, [...(byLanguage.get(s.language) ?? []), ...s.snippets])
  for (const [language, snippets] of byLanguage) {
    snippetProviders.push(
      monaco.languages.registerCompletionItemProvider(language, {
        provideCompletionItems(model, position) {
          const word = model.getWordUntilPosition(position)
          const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
          return {
            suggestions: snippets.map((s) => ({
              label: s.prefix,
              kind: monaco.languages.CompletionItemKind.Snippet,
              detail: s.description,
              documentation: { value: '```\n' + s.body + '\n```' },
              insertText: s.body,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range
            }))
          }
        }
      })
    )
  }
}

export async function refreshExtensions(): Promise<void> {
  list = await window.api.extList()
  emit()
  registerSnippets(await window.api.extSnippets().catch(() => []))
  await loadCustomThemes().catch(() => undefined) // extension themes are part of the theme list
}

export function initExtensions(): void {
  if (started) return
  started = true
  void refreshExtensions()
  void window.api.extLog().then((l) => {
    log = l
    emit()
  })
  window.api.onExtChanged(() => void refreshExtensions())
  window.api.onExtLog((l) => {
    log = l
    emit()
  })
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export const useExtensions = (): ExtRecord[] => useSyncExternalStore(subscribe, () => list)
export const useExtLog = (): string[] => useSyncExternalStore(subscribe, () => log)
export const getExtensions = (): ExtRecord[] => list

/** Commands of enabled native extensions, for the palette. */
export const extensionCommands = (): { extId: string; id: string; title: string; ext: string }[] =>
  list.filter((e) => e.enabled && (e.native || e.vscode)).flatMap((e) => e.commands.map((c) => ({ extId: e.id, id: c.id, title: c.title, ext: e.displayName })))
