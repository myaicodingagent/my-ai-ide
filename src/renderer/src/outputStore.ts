import { useSyncExternalStore } from 'react'

// The Output panel: named channels of text. "My AI IDE" gets the app's own messages, "Tasks" the tasks that were started;
// extensions' output comes from the extension host (see PanelViews).
export const APP_CHANNEL = 'My AI IDE'
export const TASKS_CHANNEL = 'Tasks'

const MAX_CHARS = 200_000
let channels: Record<string, string> = { [APP_CHANNEL]: '', [TASKS_CHANNEL]: '', 'Language Servers': '' }
const listeners = new Set<() => void>()
const emit = (): void => {
  channels = { ...channels }
  listeners.forEach((l) => l())
}

export function appendOutput(channel: string, text: string): void {
  const stamp = new Date().toLocaleTimeString()
  const line = text.endsWith('\n') ? text : text + '\n'
  channels[channel] = ((channels[channel] ?? '') + `[${stamp}] ${line}`).slice(-MAX_CHARS)
  emit()
}

export function clearChannel(channel: string): void {
  channels[channel] = ''
  emit()
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export const useChannels = (): Record<string, string> => useSyncExternalStore(subscribe, () => channels)
