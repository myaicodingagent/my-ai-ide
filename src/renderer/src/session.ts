// Remembers which folders were opened recently and, per folder, which files were open. Plain localStorage;
// every access is guarded because storage can be blocked or hold something unexpected.

const RECENT_KEY = 'recent-folders'
const SESSION_PREFIX = 'session:'
const MAX_RECENT = 10

export interface SavedSession {
  tabs: string[] // absolute paths, in tab order
  active: string | null
}

const read = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const write = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not remembered; nothing else is affected.
  }
}

const sameFolder = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

export function getRecentFolders(): string[] {
  const v = read(RECENT_KEY)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : []
}

/** Puts a folder at the top of the recent list. */
export function addRecentFolder(root: string): void {
  if (/^\\\\liveshare\./i.test(root)) return // a session's folder is gone when the session ends
  write(RECENT_KEY, [root, ...getRecentFolders().filter((f) => !sameFolder(f, root))].slice(0, MAX_RECENT))
}

export function removeRecentFolder(root: string): void {
  write(RECENT_KEY, getRecentFolders().filter((f) => !sameFolder(f, root)))
}

/** The additional folders of a workspace whose first folder is `root`. */
export function loadExtraFolders(root: string): string[] {
  const v = read('workspace:' + root.replace(/\\/g, '/').toLowerCase())
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : []
}

export function saveExtraFolders(root: string, folders: string[]): void {
  write('workspace:' + root.replace(/\\/g, '/').toLowerCase(), folders)
}

export function saveSession(root: string, session: SavedSession): void {
  write(SESSION_PREFIX + root.replace(/\\/g, '/').toLowerCase(), session)
}

export function loadSession(root: string): SavedSession {
  const v = read(SESSION_PREFIX + root.replace(/\\/g, '/').toLowerCase()) as Partial<SavedSession> | null
  const tabs = Array.isArray(v?.tabs) ? v.tabs.filter((x): x is string => typeof x === 'string').slice(0, 30) : []
  return { tabs, active: typeof v?.active === 'string' ? v.active : null }
}
