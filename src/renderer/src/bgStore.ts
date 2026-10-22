import { useSyncExternalStore } from 'react'
import type { BgTask } from '../../main/background'
import { announce } from './a11y'

// Background agent tasks, kept in sync with the main process (which owns them).

let tasks: BgTask[] = []
const listeners = new Set<() => void>()
let started = false

const emit = (next: BgTask[]): void => {
  tasks = next
  listeners.forEach((cb) => cb())
}

const sorted = (list: BgTask[]): BgTask[] => [...list].sort((a, b) => b.started - a.started)

/** Starts listening (once) and loads what the main process already has. */
export function initBackground(): void {
  if (started) return
  started = true
  const seen = new Map<string, string>()
  window.api.onBgUpdate((t) => {
    // Say when a task needs the user or has finished (not for every step it takes).
    if (seen.get(t.id) !== t.status) {
      const label = t.task.length > 60 ? t.task.slice(0, 60) + '…' : t.task
      if (t.status === 'waiting') announce(`Background task needs approval to run a command: ${label}`)
      else if (t.status === 'done') announce(`Background task finished: ${label}`)
      else if (t.status === 'failed') announce(`Background task failed: ${label}`, 'assertive')
      seen.set(t.id, t.status)
    }
    // Updates arrive as whole objects; keep the newest copy of each task.
    emit(sorted([...tasks.filter((x) => x.id !== t.id), { ...t, files: [...t.files] }]))
  })
  window.api.onBgRemoved((id) => emit(tasks.filter((x) => x.id !== id)))
  void window.api.bgList().then((list) => emit(sorted(list)))
}

export const getBgTasks = (): BgTask[] => tasks
export const useBgTasks = (): BgTask[] =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    getBgTasks
  )

/** Tasks that want the user: a command waiting for approval, or finished work that has not been applied. */
export const needsAttention = (t: BgTask): boolean =>
  t.status === 'waiting' || ((t.status === 'done' || t.status === 'stopped' || t.status === 'failed') && t.files.length > 0)
