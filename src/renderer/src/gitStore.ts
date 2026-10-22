import { useSyncExternalStore } from 'react'
import type { GitStatus } from '../../main/git'

// The Git status of the open folder, shared by the Source Control panel, the status bar and the
// editor margin. It is refreshed after anything that could change it (saves, git operations, file changes,
// the window regaining focus) and on a slow timer, so changes made in a terminal show up too.

interface Snapshot {
  status: GitStatus
  root: string | null
  // Changes on every refresh, so the editor margin knows to look again.
  version: number
}

let snap: Snapshot = { status: { state: 'norepo', files: [] }, root: null, version: 0 }
const listeners = new Set<() => void>()
let inflight = 0

const emit = (next: Snapshot): void => {
  snap = next
  listeners.forEach((cb) => cb())
}

export function subscribeGit(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export const getGit = (): Snapshot => snap
export const useGit = (): Snapshot => useSyncExternalStore(subscribeGit, getGit)

const same = (a: GitStatus, b: GitStatus): boolean => JSON.stringify(a) === JSON.stringify(b)

export async function refreshGit(root: string | null): Promise<void> {
  if (!root) return emit({ status: { state: 'norepo', files: [] }, root: null, version: snap.version + 1 })
  const ticket = ++inflight
  const status = await window.api.gitStatus(root)
  if (ticket !== inflight) return // a newer refresh is on its way
  // Keep the same object when nothing changed, so React does not re-render for no reason.
  if (snap.root === root && same(snap.status, status)) return emit({ ...snap, version: snap.version + 1 })
  emit({ status, root, version: snap.version + 1 })
}

/** Counts used for badges: files with any change. */
export const changeCount = (s: GitStatus): number => s.files.length
