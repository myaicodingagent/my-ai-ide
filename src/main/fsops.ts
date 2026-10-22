import { BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { promises as fs, watch, FSWatcher, realpathSync } from 'fs'
import * as ssh from './sshfs'

// File operations for the explorer (create, rename, delete, reveal) and a watcher that tells the UI when
// files change outside the app. Every path coming from the UI must stay inside the open project folder.

type Result = { ok: true } | { ok: false; error: string }

const IGNORED_DIRS = new Set(['node_modules', 'out', 'dist', 'release'])
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/

const real = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

const isInside = (root: string, p: string): boolean => {
  const rel = relative(real(root), real(p))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// The target does not exist yet, so judge it by its parent folder (which must exist and be inside the project).
function checkNew(root: string, target: string): string | null {
  const name = basename(target)
  if (!name || name === '.' || name === '..' || BAD_NAME.test(name) || /[. ]$/.test(name) || name.length > 255) {
    return `"${name}" is not a valid name.`
  }
  if (!isInside(root, dirname(target)) && real(dirname(target)) !== real(root)) return 'That location is outside the project folder.'
  return null
}

// Paths on a remote computer are judged by their text (they have no local real path), and the same name rules apply.
const remoteCheck = (root: string, target: string): string | null => {
  const name = target.split('\\').pop() ?? ''
  if (!name || name === '.' || name === '..' || BAD_NAME.test(name) || /[. ]$/.test(name) || name.length > 255) return `"${name}" is not a valid name.`
  const a = ssh.parseRemote(root)
  const b = ssh.parseRemote(target)
  if (!a || !b || a.name !== b.name || !(b.path === a.path || b.path.startsWith(a.path.replace(/\/$/, '') + '/'))) return 'That location is outside the project folder.'
  return null
}

const fail = (e: unknown): { ok: false; error: string } => {
  const err = e as NodeJS.ErrnoException
  if (err.code === 'EEXIST') return { ok: false, error: 'A file or folder with that name already exists.' }
  if (err.code === 'ENOENT') return { ok: false, error: 'The location no longer exists.' }
  if (err.code === 'EPERM' || err.code === 'EBUSY') return { ok: false, error: 'The file is in use or protected. Close it elsewhere and try again.' }
  return { ok: false, error: err.message ?? String(e) }
}

export function registerFsOps(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('fs:createFile', async (_e, root: string, target: string): Promise<Result> => {
    if (ssh.isRemotePath(target)) {
      const bad = remoteCheck(root, target)
      if (bad) return { ok: false, error: bad }
      return ssh.writeFile(target, '', true).then(() => ({ ok: true as const }), fail)
    }
    const problem = checkNew(root, target)
    if (problem) return { ok: false, error: problem }
    try {
      await fs.writeFile(target, '', { flag: 'wx' }) // wx: fail rather than overwrite
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('fs:createDir', async (_e, root: string, target: string): Promise<Result> => {
    if (ssh.isRemotePath(target)) {
      const bad = remoteCheck(root, target)
      if (bad) return { ok: false, error: bad }
      return ssh.mkdir(target).then(() => ({ ok: true as const }), fail)
    }
    const problem = checkNew(root, target)
    if (problem) return { ok: false, error: problem }
    try {
      await fs.mkdir(target)
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('fs:rename', async (_e, root: string, from: string, to: string): Promise<Result> => {
    if (ssh.isRemotePath(from) || ssh.isRemotePath(to)) {
      const bad = remoteCheck(root, to) ?? (ssh.isRemotePath(from) ? null : 'Files cannot be moved between computers.')
      if (bad) return { ok: false, error: bad }
      return ssh.rename(from, to).then(() => ({ ok: true as const }), fail)
    }
    if (!isInside(root, from)) return { ok: false, error: 'That item is outside the project folder.' }
    const problem = checkNew(root, to)
    if (problem) return { ok: false, error: problem }
    try {
      // On Windows a rename that only changes the case of the name is allowed; anything else must not overwrite.
      if (from.toLowerCase() !== to.toLowerCase()) {
        const exists = await fs.access(to).then(() => true, () => false)
        if (exists) return { ok: false, error: 'A file or folder with that name already exists.' }
      }
      await fs.rename(from, to)
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })

  // To the Recycle Bin, so a mistake can be undone from Windows.
  ipcMain.handle('fs:trash', async (_e, root: string, target: string): Promise<Result> => {
    // A server has no Recycle Bin: the item is deleted for good (the editor asks first).
    if (ssh.isRemotePath(target)) {
      if (remoteCheck(root, target)) return { ok: false, error: 'That item is outside the project folder.' }
      return ssh.remove(target).then(() => ({ ok: true as const }), fail)
    }
    if (!isInside(root, target)) return { ok: false, error: 'That item is outside the project folder.' }
    try {
      // MY_AI_IDE_NO_TRASH is for automated tests only, so they do not fill the real Recycle Bin.
      if (process.env.MY_AI_IDE_NO_TRASH) await fs.rm(target, { recursive: true, force: true })
      else await shell.trashItem(target)
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })

  // ---- Replace in files ----
  // Works line by line, exactly like the search that produced the results, so the numbers agree.
  // `targets` come from the search results: a file, optionally limited to some of its line numbers.
  ipcMain.handle(
    'fs:replace',
    async (
      _e,
      root: string,
      query: string,
      replacement: string,
      opts: { caseSensitive: boolean; regex: boolean },
      targets: { path: string; lines?: number[] }[]
    ): Promise<
      | { ok: true; replaced: number; files: number; skipped: string[] }
      | { ok: false; error: string }
    > => {
      if (!query) return { ok: false, error: 'Nothing to search for.' }
      let re: RegExp
      try {
        const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        re = new RegExp(source, opts.caseSensitive ? 'g' : 'gi')
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      // In regex mode "$1", "$&" and "$<name>" in the replacement refer to the match, as in the search box of
      // other editors. In plain-text mode the replacement is used exactly as typed.
      const expand = (m: RegExpExecArray): string =>
        opts.regex
          ? replacement.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (all, token: string, name?: string) => {
              if (token === '$') return '$'
              if (token === '&') return m[0]
              if (name) return m.groups?.[name] ?? ''
              const i = Number(token)
              return i > 0 && i < m.length ? (m[i] ?? '') : all
            })
          : replacement

      let replaced = 0
      let files = 0
      const skipped: string[] = []
      for (const t of targets.slice(0, 5000)) {
        const remote = ssh.isRemotePath(t.path)
        if (remote ? remoteCheck(root, t.path) : !isInside(root, t.path)) {
          skipped.push(`${basename(t.path)}: outside the project`)
          continue
        }
        try {
          const size = remote ? await ssh.statSize(t.path) : (await fs.stat(t.path)).size
          if (size > 1_000_000) {
            skipped.push(`${basename(t.path)}: too large`)
            continue
          }
          const text = remote ? await ssh.readFile(t.path) : await fs.readFile(t.path, 'utf-8')
          if (text.slice(0, 1000).includes('\u0000')) {
            skipped.push(`${basename(t.path)}: binary file`)
            continue
          }
          const only = t.lines ? new Set(t.lines) : null
          let count = 0
          const parts = text.split('\n')
          const out = parts.map((raw, i) => {
            if (only && !only.has(i + 1)) return raw
            if (i === parts.length - 1 && raw === '') return raw // the empty piece after the final newline is not a line
            const cr = raw.endsWith('\r') ? '\r' : ''
            const line = cr ? raw.slice(0, -1) : raw
            re.lastIndex = 0
            let result = ''
            let last = 0
            let m: RegExpExecArray | null
            while ((m = re.exec(line)) !== null) {
              result += line.slice(last, m.index) + expand(m)
              last = m.index + m[0].length
              count++
              if (m[0].length === 0) re.lastIndex++ // an empty match must not loop forever
            }
            return result + line.slice(last) + cr
          })
          if (count === 0) continue
          if (remote) await ssh.writeFile(t.path, out.join('\n'))
          else await fs.writeFile(t.path, out.join('\n'), 'utf-8')
          replaced += count
          files++
        } catch (e) {
          skipped.push(`${basename(t.path)}: ${(e as Error).message}`)
        }
      }
      return { ok: true, replaced, files, skipped }
    }
  )

  ipcMain.handle('fs:reveal', (_e, target: string) => {
    shell.showItemInFolder(resolve(target))
  })

  ipcMain.handle('app:copyText', (_e, text: string) => {
    clipboard.writeText(String(text))
  })

  // ---- watcher ----
  let watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | null = null
  const pending = new Set<string>()
  let gitChanged = false

  const flush = (): void => {
    timer = null
    const paths = [...pending]
    pending.clear()
    const git = gitChanged
    gitChanged = false
    if (paths.length || git) getWin()?.webContents.send('fs:changed', { paths: paths.slice(0, 200), git })
  }

  // One watcher per workspace folder (a single folder, a list of them, or null to stop).
  ipcMain.handle('fs:watch', (_e, folders: string | string[] | null) => {
    for (const w of watchers) w.close()
    watchers = []
    pending.clear()
    if (timer) clearTimeout(timer)
    timer = null
    for (const root of folders === null ? [] : Array.isArray(folders) ? folders : [folders]) {
      if (!root || ssh.isRemotePath(root)) continue // nothing to watch on another computer; the tree refreshes when you come back to the window
      try {
        // Watch the real (long-name) spelling of the folder: with a short 8.3 name such as ABDULB~1 some Node/libuv versions abort the whole process.
        let watchRoot = root
        try {
          watchRoot = realpathSync.native(root)
        } catch {
          // Watch it as given.
        }
        const watcher = watch(watchRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const name = filename.toString()
        const parts = name.split(/[\\/]/)
        if (parts[0] === '.git') {
          // Only the files that mean "the repository state changed"; the rest of .git is internal noise.
          if (/^\.git[\\/](index|HEAD|ORIG_HEAD|MERGE_HEAD|refs[\\/].*)$/.test(name)) gitChanged = true
          else return
        } else if (parts.some((p) => IGNORED_DIRS.has(p))) {
          return
        } else {
          pending.add(join(root, name))
        }
        if (!timer) timer = setTimeout(flush, 300)
      })
        watcher.on('error', () => undefined) // the folder was deleted or became unavailable
        watchers.push(watcher)
      } catch {
        // Watching is a convenience; the app still works without it.
      }
    }
  })
}
