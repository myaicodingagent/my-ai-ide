import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { monaco } from './monaco-setup'
import { FileTree, DirEntry, GitInfo } from './FileTree'
import { ContextMenu, MenuItem } from './ContextMenu'
import { Breadcrumbs } from './Breadcrumbs'
import { addRecentFolder, getRecentFolders, loadSession, removeRecentFolder, saveSession } from './session'
import { TerminalPanel, readActiveTerminalText } from './TerminalPanel'
import { ApprovalDialog, Approval } from './ApprovalDialog'
import { QuickPick, PickItem } from './QuickPick'
import { ChatPanel, EditorContext } from './ChatPanel'
import { InlineEdit, InlineTarget } from './InlineEdit'
import { registerAutocomplete } from './autocomplete'
import { AgentPanel } from './AgentPanel'
import { SearchPanel } from './SearchPanel'
import { Welcome } from './Welcome'
import { applyTheme, getTheme, getThemes, subscribeTheme } from './theme'
import { SettingsDialog } from './SettingsDialog'
import { useUpdateState } from './update'
import { editorOptions, getSettings, updateSettings, useSettings } from './settings'
import { GitPanel } from './GitPanel'
import { DiffView, DiffViewData } from './DiffView'
import { InputDialog, InputRequest } from './InputDialog'
import { changeCount, refreshGit, useGit } from './gitStore'
import type { GitFile } from '../../main/git'

interface Tab {
  path: string
  model: monaco.editor.ITextModel
  dirty: boolean
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

// Windows paths compare case-insensitively and may use either slash.
const samePath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

// The part of `p` below `root` with forward slashes, or null if `p` is not inside `root`.
const relIfInside = (root: string, p: string): string | null =>
  samePath(p).startsWith(samePath(root) + '/') ? p.replace(/\\/g, '/').slice(root.length + 1) : null

export function App(): JSX.Element {
  const [root, setRoot] = useState<string | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [showTerminal, setShowTerminal] = useState(false)
  // The terminal panel stays mounted after the first time it is shown, so its sessions survive hiding it.
  const [terminalOpened, setTerminalOpened] = useState(false)
  const [newTermSignal, setNewTermSignal] = useState(0)
  useEffect(() => {
    if (showTerminal) setTerminalOpened(true)
  }, [showTerminal])
  const newTerminal = useCallback((): void => {
    setShowTerminal(true)
    setTerminalOpened(true)
    setNewTermSignal((n) => n + 1)
  }, [])
  const hideTerminal = useCallback((): void => setShowTerminal(false), [])
  const [sidebarView, setSidebarView] = useState<'files' | 'search' | 'git'>('files')
  const [searchFocus, setSearchFocus] = useState(0)
  const showSearch = useCallback((): void => {
    setSidebarView('search')
    setSearchFocus((n) => n + 1)
  }, [])
  const [showChat, setShowChat] = useState(true)
  const [panelMode, setPanelMode] = useState<'chat' | 'agent'>('chat')
  const [picker, setPicker] = useState<'files' | 'commands' | 'themes' | 'branches' | 'problems' | null>(null)
  const [pickItems, setPickItems] = useState<PickItem[]>([])
  const [pickOpts, setPickOpts] = useState<{ initial: number; onCancel?: () => void }>({ initial: 0 })
  const [themeLabel, setThemeLabel] = useState(getTheme().label)
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null)
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null)
  const [diffView, setDiffView] = useState<DiffViewData | null>(null)
  const git = useGit()
  const [showSidebar, setShowSidebar] = useState(true)
  const [recent, setRecent] = useState<string[]>(getRecentFolders)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [problems, setProblems] = useState({ errors: 0, warnings: 0 })
  const closedStack = useRef<string[]>([]) // paths of recently closed tabs, newest last
  const diskText = useRef(new Map<string, string>()) // what each open file contained on disk when we last read or wrote it
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; entry: DirEntry | null } | null>(null)
  const [selected, setSelected] = useState<DirEntry | null>(null)
  const [reveal, setReveal] = useState<{ path: string; n: number } | null>(null)
  const gitDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const rootRef = useRef(root)
  rootRef.current = root
  const sessionReadyFor = useRef<string | null>(null) // the folder whose saved tabs have been restored
  const shownModel = useRef<monaco.editor.ITextModel | null>(null)
  const [modelTick, setModelTick] = useState(0)

  useEffect(() => subscribeTheme(() => setThemeLabel(getTheme().label)), [])

  // Lists the themes; moving through them previews each one live, Esc puts the old one back.
  const openThemePicker = useCallback((): void => {
    const original = getTheme().id
    const themes = getThemes()
    setPickItems(
      themes.map((t) => ({
        label: t.label,
        detail: (t.custom ? 'custom · ' : '') + (t.type === 'hc' ? 'high contrast' : t.type) + (t.id === original ? ' · current' : ''),
        preview: () => applyTheme(t.id),
        run: () => applyTheme(t.id, true)
      }))
    )
    setPickOpts({ initial: Math.max(0, themes.findIndex((t) => t.id === original)), onCancel: () => applyTheme(original) })
    setPicker('themes')
  }, [])
  const [inlineTarget, setInlineTarget] = useState<InlineTarget | null>(null)
  const settings = useSettings()
  const update = useUpdateState()

  // Look for a new version shortly after startup and then every few hours (unless switched off in Settings).
  useEffect(() => {
    if (!settings.autoCheckUpdates) return
    const check = (): void => void window.api.updateCheck()
    const first = setTimeout(check, 8000)
    const every = setInterval(check, 6 * 60 * 60 * 1000)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [settings.autoCheckUpdates])
  const [showSettings, setShowSettings] = useState(false)
  const autocomplete = settings.autocomplete
  const autocompleteRef = useRef(autocomplete)
  autocompleteRef.current = autocomplete

  const toggleAutocomplete = useCallback((): void => {
    updateSettings({ autocomplete: !getSettings().autocomplete })
  }, [])

  // Editor appearance follows the settings live.
  useEffect(() => {
    editorRef.current?.updateOptions({
      ...editorOptions(settings),
      minimap: { enabled: settings.minimap, renderCharacters: false },
      wordWrap: settings.wordWrap ? 'on' : 'off'
    })
  }, [settings])

  useEffect(() => {
    const reg = registerAutocomplete(() => autocompleteRef.current)
    return () => reg.dispose()
  }, [])

  // Startup: a folder given on the command line wins, otherwise reopen the last one (if it still exists).
  useEffect(() => {
    void (async () => {
      const fromCommandLine = await window.api.initialFolder()
      if (fromCommandLine) return setRoot(fromCommandLine)
      const last = getRecentFolders()[0]
      if (last && (await window.api.fsIsDir(last))) setRoot(last)
    })()
  }, [])

  // Blocks closing while any tab has unsaved edits; the main process then asks the user.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent): void => {
      if (tabsRef.current.some((t) => t.dirty)) e.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const tabsRef = useRef<Tab[]>([])
  const startInlineRef = useRef<() => void>(() => {})
  tabsRef.current = tabs

  startInlineRef.current = (): void => {
    const ed = editorRef.current
    const model = ed?.getModel()
    const sel = ed?.getSelection()
    if (!ed || !model || !sel) return
    // With no selection, edit the current line.
    const range = sel.isEmpty()
      ? new monaco.Range(sel.startLineNumber, 1, sel.startLineNumber, model.getLineMaxColumn(sel.startLineNumber))
      : sel
    setInlineTarget({
      model,
      range,
      original: model.getValueInRange(range),
      fileName: baseName(model.uri.fsPath),
      language: model.getLanguageId(),
      fileText: model.getValue(),
      root: rootRef.current
    })
  }

  useEffect(() => {
    const ed = monaco.editor.create(containerRef.current!, {
      // The colour theme is global and set by applyTheme().
      automaticLayout: true,
      model: null,
      ...editorOptions(),
      padding: { top: 12, bottom: 12 },
      minimap: { enabled: getSettings().minimap, renderCharacters: false },
      wordWrap: getSettings().wordWrap ? 'on' : 'off',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true },
      renderLineHighlight: 'all',
      guides: { bracketPairs: true, indentation: true }
    })
    ed.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }))
    // Overrides Monaco's Ctrl+K chord prefix.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => startInlineRef.current())
    editorRef.current = ed
    return () => ed.dispose()
  }, [])

  // Switches to another folder: asks about unsaved work, closes the old folder's tabs, then opens the new one.
  const openFolderPath = useCallback(async (dir: string): Promise<void> => {
    if (rootRef.current && samePath(dir) === samePath(rootRef.current)) return
    if (!(await window.api.fsIsDir(dir))) {
      removeRecentFolder(dir)
      setRecent(getRecentFolders())
      return void window.alert(`The folder no longer exists:\n${dir}`)
    }
    const dirty = tabsRef.current.filter((t) => t.dirty)
    if (dirty.length && !window.confirm(`${dirty.length} open file(s) have unsaved changes that will be lost. Open another folder anyway?`)) return
    for (const t of tabsRef.current) t.model.dispose()
    diskText.current.clear()
    setTabs([])
    setActive(null)
    setDiffView(null)
    setSelected(null)
    sessionReadyFor.current = null // the new folder's saved tabs are restored before saving starts again
    setRoot(dir)
  }, [])

  const openFolder = async (): Promise<void> => {
    const dir = await window.api.openFolder()
    if (dir) await openFolderPath(dir)
  }

  // A line to jump to once the editor shows the file (set by search results).
  const pendingReveal = useRef<{ path: string; line: number } | null>(null)
  const revealPending = useCallback((): void => {
    const r = pendingReveal.current
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!r || !ed || !model || samePath(model.uri.fsPath) !== samePath(r.path)) return
    ed.revealLineInCenter(r.line)
    ed.setPosition({ lineNumber: r.line, column: 1 })
    ed.focus()
    pendingReveal.current = null
  }, [])

  // Files being opened right now. Opening is asynchronous, so two requests for the same file (session
  // restore and a click, say) must share one open instead of both creating a model for it.
  const opening = useRef(new Map<string, Promise<string>>()) // resolves to the path the tab is stored under
  // Paths whose editor content is being replaced by us from disk; those edits are not "unsaved changes".
  const programmatic = useRef(new Set<string>())

  // Replaces a tab's text with what is on disk, keeping the editor's undo history and leaving the tab clean.
  const applyDiskContent = useCallback((tab: Tab, text: string): void => {
    programmatic.current.add(tab.path)
    try {
      tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null)
    } finally {
      programmatic.current.delete(tab.path)
    }
    diskText.current.set(tab.path, text)
    setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, dirty: false } : t)))
  }, [])

  const openFile = useCallback(async (path: string, line?: number): Promise<void> => {
    if (line) pendingReveal.current = { path, line }
    setDiffView(null) // opening a file leaves any diff that was covering the editor
    // The same file can arrive spelled differently (c:\ from the editor's markers, C:\ from the tree), so
    // tabs are matched ignoring case and slash direction, and the tab keeps the spelling it was opened with.
    const key = samePath(path)
    let target = tabsRef.current.find((t) => samePath(t.path) === key)?.path
    if (target === undefined) {
      let pending = opening.current.get(key)
      if (!pending) {
        pending = (async () => {
          const content = await window.api.readFile(path)
          diskText.current.set(path, content)
          const model = monaco.editor.createModel(content, undefined, monaco.Uri.file(path))
          model.onDidChangeContent(() => {
            if (programmatic.current.has(path)) return
            setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, dirty: true } : t)))
          })
          setTabs((ts) => [...ts, { path, model, dirty: false }])
          return path
        })().finally(() => opening.current.delete(key))
        opening.current.set(key, pending)
      }
      target = await pending
    }
    setActive(target)
    revealPending() // works now if the file was already showing; otherwise the effect below does it
  }, [revealPending])

  // Writes one tab to disk. If something else changed the file since we last read or wrote it, an explicit
  // save asks before overwriting, and an automatic save leaves the file alone.
  const saveTab = useCallback(async (tab: Tab, opts: { auto?: boolean } = {}): Promise<boolean> => {
    const lf = (s: string): string => s.replace(/\r\n/g, '\n')
    const known = diskText.current.get(tab.path)
    if (known !== undefined) {
      const disk = await window.api.readFile(tab.path).catch(() => null)
      if (disk !== null && lf(disk) !== lf(known)) {
        if (opts.auto) return false
        if (!window.confirm(`${baseName(tab.path)} has changed on disk since you opened it.\n\nOverwrite it with your version?`)) return false
      }
    }
    const text = tab.model.getValue()
    await window.api.writeFile(tab.path, text)
    diskText.current.set(tab.path, text)
    setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, dirty: false } : t)))
    void refreshGit(rootRef.current) // the change markers and the Source Control list follow a save
    return true
  }, [])

  const save = useCallback(async (): Promise<void> => {
    const tab = tabsRef.current.find((t) => t.path === activeRef.current)
    if (!tab) return
    if (getSettings().formatOnSave) {
      try {
        await editorRef.current?.getAction('editor.action.formatDocument')?.run() // only formats languages Monaco knows
      } catch {
        // A formatter that fails must not stop the save.
      }
    }
    await saveTab(tab)
  }, [saveTab])

  const saveAll = useCallback(async (): Promise<void> => {
    for (const t of tabsRef.current.filter((x) => x.dirty)) await saveTab(t)
  }, [saveTab])

  const getEditorContext = useCallback((): EditorContext | null => {
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!ed || !model) return null
    const sel = ed.getSelection()
    return {
      path: model.uri.fsPath,
      language: model.getLanguageId(),
      text: model.getValue(),
      selection: sel && !sel.isEmpty() ? model.getValueInRange(sel) : ''
    }
  }, [])

  const [treeVersion, setTreeVersion] = useState(0)

  const isDirtyRel = useCallback(
    (rel: string): boolean => {
      if (!root) return false
      const abs = samePath(`${root}/${rel}`)
      return tabsRef.current.some((t) => t.dirty && samePath(t.path) === abs)
    },
    [root]
  )

  // The agent (or an undo) changed a file on disk: refresh the tree and any open tab for it.
  const onAgentFileChanged = useCallback((abs: string, content: string | null): void => {
    setTreeVersion((v) => v + 1)
    void refreshGit(rootRef.current)
    const tab = tabsRef.current.find((t) => samePath(t.path) === samePath(abs))
    if (!tab) return
    if (content === null) {
      const rest = tabsRef.current.filter((t) => t !== tab)
      tab.model.dispose()
      setTabs(rest)
      setActive((a) => (a === tab.path ? (rest.length ? rest[rest.length - 1].path : null) : a))
      return
    }
    applyDiskContent(tab, content)
  }, [applyDiskContent])

  // A command ran (e.g. npm install, a formatter): refresh the tree and reload open tabs that changed
  // on disk. Tabs with unsaved edits are left alone.
  const onWorkspaceTouched = useCallback(async (): Promise<void> => {
    setTreeVersion((v) => v + 1)
    void refreshGit(rootRef.current)
    const lf = (s: string): string => s.replace(/\r\n/g, '\n')
    for (const tab of tabsRef.current) {
      if (tab.dirty) continue // the user's unsaved edits win; saving will check for the conflict
      try {
        const disk = await window.api.readFile(tab.path)
        const current = tabsRef.current.find((t) => t.path === tab.path)
        if (!current || current.dirty) continue // changed while we were reading
        diskText.current.set(tab.path, disk)
        if (lf(disk) !== lf(current.model.getValue())) applyDiskContent(current, disk)
      } catch {
        // Deleted or unreadable: leave the tab as it is.
      }
    }
  }, [applyDiskContent])

  // ---- AI helpers: problems text for @problems, and "Apply" of a chat code block ----
  const getProblemsText = useCallback((): string => {
    const r = rootRef.current
    return monaco.editor
      .getModelMarkers({})
      .filter((m) => m.resource.scheme === 'file' && m.severity >= monaco.MarkerSeverity.Warning)
      .slice(0, 100)
      .map((m) => {
        const where = (r && relIfInside(r, m.resource.fsPath)) || m.resource.fsPath
        const kind = m.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning'
        return `${where}:${m.startLineNumber}:${m.startColumn} ${kind}: ${m.message.split('\n')[0]}`
      })
      .join('\n')
  }, [])

  const [applyState, setApplyState] = useState<{ approval: Approval; model: monaco.editor.ITextModel; original: string } | null>(null)
  const [applying, setApplying] = useState(false)

  // Asks Claude to merge a chat code block into the open file, then shows the result as a diff to accept.
  const applyCode = useCallback(async (code: string): Promise<void> => {
    const model = editorRef.current?.getModel()
    if (!model || model.uri.scheme !== 'file') return void window.alert('Open the file you want to change first.')
    const original = model.getValue()
    setApplying(true)
    const res = await window.api.aiApply({
      fileName: baseName(model.uri.fsPath),
      language: model.getLanguageId(),
      original,
      snippet: code
    })
    setApplying(false)
    if (!res.ok) return void window.alert(res.error)
    if (res.text === original) return void window.alert('That change is already in the file.')
    const r = rootRef.current
    setApplyState({
      approval: { id: 'apply', tool: 'apply', path: (r && relIfInside(r, model.uri.fsPath)) || baseName(model.uri.fsPath), before: original, after: res.text, isNew: false },
      model,
      original
    })
  }, [])

  const decideApply = (ok: boolean): void => {
    const s = applyState
    setApplyState(null)
    if (!ok || !s) return
    if (s.model.isDisposed() || s.model.getValue() !== s.original) {
      return void window.alert('The file changed while Claude was working, so the change was not applied. Try Apply again.')
    }
    s.model.pushEditOperations([], [{ range: s.model.getFullModelRange(), text: s.approval.after }], () => null)
    editorRef.current?.focus() // the file is now modified (not saved), so Ctrl+Z undoes it
  }

  const insertIntoEditor = useCallback((code: string): void => {
    const ed = editorRef.current
    const sel = ed?.getSelection()
    if (!ed || !sel) return
    ed.executeEdits('ai-chat', [{ range: sel, text: code, forceMoveMarkers: true }])
    ed.focus()
  }, [])

  // ---- Git: keep the status fresh, show change markers in the margin, diffs and branches ----
  useEffect(() => {
    void refreshGit(root)
    if (!root) return
    const again = (): void => void refreshGit(root)
    const timer = setInterval(() => document.visibilityState === 'visible' && again(), 5000)
    window.addEventListener('focus', again) // changes made in another program show up when you come back
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', again)
    }
  }, [root])

  // Colored bars in the margin: green = added lines, blue = changed, red triangle = lines removed here.
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    gitDecorations.current ??= ed.createDecorationsCollection()
    const model = ed.getModel()
    const rel = root && model && model.uri.scheme === 'file' ? relIfInside(root, model.uri.fsPath) : null
    if (!root || !model || !rel || git.status.state !== 'ok') {
      gitDecorations.current.clear()
      return
    }
    let cancelled = false
    void window.api.gitLineChanges(root, rel).then((res) => {
      if (cancelled || model.isDisposed()) return
      const count = model.getLineCount()
      const whole = (cls: string): monaco.editor.IModelDeltaDecoration => ({
        range: new monaco.Range(1, 1, count, 1),
        options: { isWholeLine: true, linesDecorationsClassName: cls }
      })
      gitDecorations.current?.set(
        res.untracked
          ? [whole('git-gutter-added')]
          : res.changes.map((c) => ({
              range: new monaco.Range(Math.min(c.start, count), 1, Math.min(c.end, count), 1),
              options: { isWholeLine: true, linesDecorationsClassName: `git-gutter-${c.kind}` }
            }))
      )
    })
    return () => {
      cancelled = true
    }
  }, [active, modelTick, root, git.version, git.status.state])

  const openDiff = useCallback(
    async (f: GitFile, staged: boolean): Promise<void> => {
      if (!root) return
      const r = await window.api.gitDiff(root, f.rel, staged)
      if ('error' in r) return void window.alert(r.error)
      setDiffView({
        title: `${baseName(f.rel)} (${staged ? 'Staged Changes' : 'Working Tree'})`,
        path: f.abs,
        original: r.original,
        modified: r.modified
      })
    },
    [root]
  )

  const gitCheckout = useCallback(
    async (name: string, create: boolean): Promise<void> => {
      if (!root) return
      const r = await window.api.gitCheckout(root, name, create)
      if (!r.ok) window.alert(r.error)
      await refreshGit(root)
      void onWorkspaceTouched() // files differ between branches
    },
    [root, onWorkspaceTouched]
  )

  const openBranchPicker = useCallback(async (): Promise<void> => {
    if (!root) return
    const r = await window.api.gitBranches(root)
    const create: PickItem = {
      label: '＋ Create new branch…',
      run: () =>
        setInputRequest({
          title: 'New branch name',
          placeholder: 'feature/my-change',
          confirmLabel: 'Create',
          validate: (v) => (v.trim() ? null : 'Enter a name for the branch.'),
          onSubmit: (v) => void gitCheckout(v.trim(), true)
        })
    }
    setPickItems([
      create,
      ...r.branches.map((b) => ({
        label: b.name,
        detail: b.current ? 'current' : undefined,
        run: () => (b.current ? undefined : void gitCheckout(b.name, false))
      }))
    ])
    setPickOpts({ initial: 0 })
    setPicker('branches')
  }, [root, gitCheckout])

  const closeTab = (path: string): void => {
    const tab = tabs.find((t) => t.path === path)
    if (tab?.dirty && !window.confirm(`${baseName(path)} has unsaved changes. Close anyway?`)) return
    if (tab) closedStack.current = [...closedStack.current.filter((p) => p !== path), path].slice(-20)
    tab?.model.dispose()
    diskText.current.delete(path)
    const rest = tabs.filter((t) => t.path !== path)
    setTabs(rest)
    if (active === path) setActive(rest.length ? rest[rest.length - 1].path : null)
  }

  // Closes several tabs at once, asking only once if any of them has unsaved changes.
  const closeMany = (paths: string[]): void => {
    const doomed = tabsRef.current.filter((t) => paths.includes(t.path))
    const dirty = doomed.filter((t) => t.dirty)
    if (dirty.length && !window.confirm(`${dirty.length} of these files have unsaved changes. Close anyway?`)) return
    closedStack.current = [...closedStack.current.filter((p) => !paths.includes(p)), ...doomed.map((t) => t.path)].slice(-20)
    for (const t of doomed) {
      t.model.dispose()
      diskText.current.delete(t.path)
    }
    const rest = tabsRef.current.filter((t) => !paths.includes(t.path))
    setTabs(rest)
    setActive((a) => (a && paths.includes(a) ? (rest.length ? rest[rest.length - 1].path : null) : a))
  }

  const reopenClosedTab = (): void => {
    const path = closedStack.current[closedStack.current.length - 1]
    if (!path) return
    closedStack.current = closedStack.current.slice(0, -1)
    void openFile(path)
  }

  // Shows a file or folder in the explorer, opening the folders above it.
  const revealInExplorer = (abs: string): void => {
    setShowSidebar(true)
    setSidebarView('files')
    setSelected({ name: baseName(abs), path: abs, isDir: samePath(abs) !== samePath(activeRef.current ?? '') })
    setReveal((v) => ({ path: abs, n: (v?.n ?? 0) + 1 }))
  }

  const switchTab = (delta: number): void => {
    const list = tabsRef.current
    if (list.length < 2) return
    const i = list.findIndex((t) => t.path === activeRef.current)
    setActive(list[(i + delta + list.length) % list.length].path)
    setDiffView(null)
  }

  // ---- Explorer: git colours, create / rename / delete, context menu ----
  const gitInfo = useMemo<GitInfo>(() => {
    const letters = new Map<string, string>()
    const dirtyDirs = new Set<string>()
    for (const f of git.status.files) {
      const k = samePath(f.abs)
      const unmerged = f.index === 'U' || f.work === 'U' || (f.index === 'A' && f.work === 'A') || (f.index === 'D' && f.work === 'D')
      letters.set(k, unmerged ? '!' : f.index === '?' ? 'U' : f.work !== ' ' ? f.work : f.index)
      for (let d = k, i = d.lastIndexOf('/'); i > 0; i = d.lastIndexOf('/')) {
        d = d.slice(0, i)
        dirtyDirs.add(d)
      }
    }
    return { letters, dirtyDirs }
  }, [git.status])

  const activeRef = useRef(active)
  activeRef.current = active
  const joinPath = (dir: string, name: string): string => dir.replace(/[\\/]+$/, '') + '\\' + name
  const parentOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')
  const nameProblem = (v: string): string | null =>
    !v.trim()
      ? 'Enter a name.'
      : /[\\/:*?"<>|]/.test(v)
        ? 'A name cannot contain \\ / : * ? " < > |'
        : /[. ]$/.test(v.trim())
          ? 'A name cannot end with a dot or a space.'
          : null
  const tabsUnder = (p: string): Tab[] =>
    tabsRef.current.filter((t) => samePath(t.path) === samePath(p) || samePath(t.path).startsWith(samePath(p) + '/'))

  // Closes a tab without asking (the caller has already dealt with unsaved changes).
  const dropTab = useCallback((path: string): void => {
    const tab = tabsRef.current.find((t) => t.path === path)
    if (!tab) return
    tab.model.dispose()
    const rest = tabsRef.current.filter((t) => t !== tab)
    setTabs(rest)
    setActive((a) => (a === path ? (rest.length ? rest[rest.length - 1].path : null) : a))
  }, [])

  const afterFsChange = useCallback((): void => {
    setTreeVersion((v) => v + 1)
    void refreshGit(rootRef.current)
  }, [])

  const createEntry = useCallback(
    (dir: string, kind: 'file' | 'folder'): void => {
      setInputRequest({
        title: `New ${kind} in ${baseName(dir)}`,
        placeholder: kind === 'file' ? 'name.ext' : 'folder-name',
        confirmLabel: 'Create',
        validate: nameProblem,
        onSubmit: async (name) => {
          const r = rootRef.current
          if (!r) return
          const target = joinPath(dir, name.trim())
          const res = kind === 'file' ? await window.api.fsCreateFile(r, target) : await window.api.fsCreateDir(r, target)
          if (!res.ok) return void window.alert(res.error)
          afterFsChange()
          setSelected({ name: name.trim(), path: target, isDir: kind === 'folder' })
          setReveal((v) => ({ path: target, n: (v?.n ?? 0) + 1 }))
          if (kind === 'file') void openFile(target)
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [afterFsChange, openFile]
  )

  const renameEntry = useCallback(
    (entry: DirEntry): void => {
      const dot = entry.name.lastIndexOf('.')
      setInputRequest({
        title: `Rename ${entry.name}`,
        value: entry.name,
        selectEnd: !entry.isDir && dot > 0 ? dot : entry.name.length,
        confirmLabel: 'Rename',
        validate: nameProblem,
        onSubmit: async (name) => {
          const r = rootRef.current
          if (!r || name.trim() === entry.name) return
          const affected = tabsUnder(entry.path)
          if (affected.some((t) => t.dirty)) {
            return void window.alert('Save or close the unsaved files in this item first, then rename it.')
          }
          const target = joinPath(parentOf(entry.path), name.trim())
          const res = await window.api.fsRename(r, entry.path, target)
          if (!res.ok) return void window.alert(res.error)
          // Open files move with the rename: close the old tabs and reopen them at the new path.
          const wasActive = activeRef.current
          for (const t of affected) dropTab(t.path)
          const reopen = [...affected].sort((a) => (a.path === wasActive ? 1 : -1))
          for (const t of reopen) await openFile(target + t.path.slice(entry.path.length))
          afterFsChange()
          setSelected({ name: name.trim(), path: target, isDir: entry.isDir })
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [afterFsChange, dropTab, openFile]
  )

  const deleteEntry = useCallback(
    async (entry: DirEntry): Promise<void> => {
      const r = rootRef.current
      if (!r) return
      const affected = tabsUnder(entry.path)
      const dirty = affected.filter((t) => t.dirty).length
      const warning = dirty ? `\n\n${dirty} open file(s) inside have unsaved changes that will be lost.` : ''
      if (!window.confirm(`Move "${entry.name}" to the Recycle Bin?${warning}`)) return
      const res = await window.api.fsTrash(r, entry.path)
      if (!res.ok) return void window.alert(res.error)
      for (const t of affected) dropTab(t.path)
      setSelected((s) => (s && samePath(s.path).startsWith(samePath(entry.path)) ? null : s))
      afterFsChange()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [afterFsChange, dropTab]
  )

  const tabMenuItems = (path: string): MenuItem[] => {
    const list = tabsRef.current
    const i = list.findIndex((t) => t.path === path)
    const r = rootRef.current
    return [
      { label: 'Close', run: () => closeTab(path) },
      { label: 'Close Others', run: () => closeMany(list.filter((t) => t.path !== path).map((t) => t.path)), disabled: list.length < 2 },
      { label: 'Close to the Right', run: () => closeMany(list.slice(i + 1).map((t) => t.path)), disabled: i >= list.length - 1 },
      { label: 'Close All', run: () => closeMany(list.map((t) => t.path)) },
      { label: 'Copy Path', run: () => void window.api.copyText(path), separator: true },
      { label: 'Copy Relative Path', run: () => void window.api.copyText((r && relIfInside(r, path)) || baseName(path)) },
      { label: 'Reveal in File Explorer', run: () => void window.api.fsReveal(path) },
      { label: 'Reveal in Side Bar', run: () => revealInExplorer(path) }
    ]
  }

  const treeMenuItems = (entry: DirEntry | null): MenuItem[] => {
    const r = rootRef.current
    if (!r) return []
    const dir = entry ? (entry.isDir ? entry.path : parentOf(entry.path)) : r
    const items: MenuItem[] = []
    if (entry && !entry.isDir) items.push({ label: 'Open', run: () => void openFile(entry.path) })
    items.push(
      { label: 'New File…', run: () => createEntry(dir, 'file'), separator: items.length > 0 },
      { label: 'New Folder…', run: () => createEntry(dir, 'folder') }
    )
    if (entry) {
      items.push(
        { label: 'Rename…  (F2)', run: () => renameEntry(entry), separator: true },
        { label: 'Delete  (Del)', run: () => void deleteEntry(entry), danger: true }
      )
    }
    items.push({ label: 'Reveal in File Explorer', run: () => void window.api.fsReveal(entry?.path ?? r), separator: true })
    items.push({ label: 'Copy Path', run: () => void window.api.copyText(entry?.path ?? r) })
    if (entry) items.push({ label: 'Copy Relative Path', run: () => void window.api.copyText(relIfInside(r, entry.path) ?? entry.name) })
    return items
  }

  // F2 renames and Delete deletes the selected explorer item (not while typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F2' && e.key !== 'Delete') return
      const el = document.activeElement as HTMLElement | null
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable || el.closest('.monaco-editor, .xterm'))) return
      if (!selected || sidebarView !== 'files') return
      e.preventDefault()
      if (e.key === 'F2') renameEntry(selected)
      else void deleteEntry(selected)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, sidebarView, renameEntry, deleteEntry])

  // The newest versions of the tab actions, for the keyboard handler (which is registered only once).
  const actionsRef = useRef({ closeTab, reopenClosedTab, switchTab, saveAll })
  actionsRef.current = { closeTab, reopenClosedTab, switchTab, saveAll }

  // ---- Remember the folder and its open files; auto save; problems count ----
  useEffect(() => {
    if (!root) return
    addRecentFolder(root)
    setRecent(getRecentFolders())
    // Reopen the files that were open the last time this folder was used.
    let cancelled = false
    void (async () => {
      const saved = loadSession(root)
      for (const p of saved.tabs) {
        if (cancelled) return
        if (p !== saved.active) await openFile(p).catch(() => undefined) // a file that is gone is skipped
      }
      if (saved.active && !cancelled) await openFile(saved.active).catch(() => undefined)
      if (!cancelled) sessionReadyFor.current = root
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  const tabKey = tabs.map((t) => t.path).join('\n')
  useEffect(() => {
    if (!root || sessionReadyFor.current !== root) return // not before the saved tabs have been restored
    saveSession(root, { tabs: tabs.map((t) => t.path), active })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey, active, root])

  useEffect(() => {
    if (settings.autoSave !== 'afterDelay') return
    if (!tabs.some((t) => t.dirty)) return
    const timer = setTimeout(() => {
      for (const t of tabsRef.current.filter((x) => x.dirty)) void saveTab(t, { auto: true })
    }, 1000)
    return () => clearTimeout(timer) // every keystroke restarts the wait
  }, [tabs, settings.autoSave, saveTab])

  useEffect(() => {
    if (settings.autoSave !== 'onBlur') return
    const onBlur = (): void => {
      for (const t of tabsRef.current.filter((x) => x.dirty)) void saveTab(t, { auto: true })
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [settings.autoSave, saveTab])

  // Errors and warnings from the editor's language services, for the status bar.
  useEffect(() => {
    const count = (): void => {
      const ms = monaco.editor.getModelMarkers({}).filter((m) => m.resource.scheme === 'file')
      setProblems({
        errors: ms.filter((m) => m.severity === monaco.MarkerSeverity.Error).length,
        warnings: ms.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length
      })
    }
    count()
    const sub = monaco.editor.onDidChangeMarkers(count)
    return () => sub.dispose()
  }, [])

  const openProblemsPicker = useCallback((): void => {
    const ms = monaco.editor
      .getModelMarkers({})
      .filter((m) => m.resource.scheme === 'file' && m.severity >= monaco.MarkerSeverity.Warning)
      .sort((a, b) => b.severity - a.severity || a.resource.fsPath.localeCompare(b.resource.fsPath) || a.startLineNumber - b.startLineNumber)
      .slice(0, 200)
    setPickItems(
      ms.length
        ? ms.map((m) => ({
            label: `${m.severity === monaco.MarkerSeverity.Error ? '✖' : '⚠'} ${m.message.split('\n')[0]}`,
            detail: `${baseName(m.resource.fsPath)}:${m.startLineNumber}`,
            run: () => void openFile(m.resource.fsPath, m.startLineNumber)
          }))
        : [{ label: 'No problems found in open files', run: () => undefined }]
    )
    setPickOpts({ initial: 0 })
    setPicker('problems')
  }, [openFile])

  // Files changed outside the app (another program, a terminal, git): refresh the tree, git status and open tabs.
  useEffect(() => {
    void window.api.fsWatch(root)
    if (!root) return
    const off = window.api.onFsChanged(() => void onWorkspaceTouched())
    return () => {
      off()
      void window.api.fsWatch(null)
    }
  }, [root, onWorkspaceTouched])

  useEffect(() => {
    const model = tabs.find((t) => t.path === active)?.model ?? null
    editorRef.current?.setModel(model)
    // Tell the Git margin effect that the editor now shows a different file (it runs before this effect does).
    if (shownModel.current !== model) {
      shownModel.current = model
      setModelTick((n) => n + 1)
    }
    revealPending()
  }, [active, tabs, revealPending])

  const openFileSearch = useCallback(async (): Promise<void> => {
    if (!root) return
    const files = await window.api.listFiles(root)
    setPickItems(
      files.map((f) => ({
        label: baseName(f),
        detail: f.slice(root.length + 1),
        run: () => void openFile(f)
      }))
    )
    setPickOpts({ initial: 0 })
    setPicker('files')
  }, [root, openFile])

  // Runs one of Monaco's own editor commands (format, go to line, fold...) on the open file.
  const runEditorAction =
    (id: string) =>
    (): void => {
      const ed = editorRef.current
      if (!ed || !ed.getModel()) return
      // Wait for the palette to finish closing: Monaco's own boxes (go to line...) close when focus moves,
      // and closing the palette moves it.
      // Monaco's quick-input boxes need the editor to really hold focus, so retry briefly before running.
      let tries = 0
      const go = (): void => {
        ed.focus()
        if (!ed.hasTextFocus() && ++tries < 10) return void setTimeout(go, 40)
        void ed.getAction(id)?.run()
      }
      setTimeout(go, 80)
    }

  const openPalette = useCallback((): void => {
    setPickItems([
      { label: 'File: Open Folder', run: () => void openFolder() },
      { label: 'File: Save', run: () => void save() },
      { label: 'File: Save All (Ctrl+Alt+S)', run: () => void saveAll() },
      {
        label: 'File: Open Recent…',
        run: () => {
          setPickItems(
            getRecentFolders().map((f) => ({ label: baseName(f), detail: f, run: () => void openFolderPath(f) }))
          )
          setPickOpts({ initial: 0 })
          setPicker('files')
        }
      },
      { label: 'File: Close Editor (Ctrl+W)', run: () => activeRef.current && closeTab(activeRef.current) },
      { label: 'File: Reopen Closed Editor (Ctrl+Shift+T)', run: reopenClosedTab },
      { label: 'View: Toggle Sidebar (Ctrl+B)', run: () => setShowSidebar((v) => !v) },
      { label: 'View: Reveal Active File in Explorer', run: () => activeRef.current && revealInExplorer(activeRef.current) },
      { label: 'View: Zoom In (Ctrl+=)', run: () => updateSettings({ uiZoom: getSettings().uiZoom + 0.1 }) },
      { label: 'View: Zoom Out (Ctrl+-)', run: () => updateSettings({ uiZoom: getSettings().uiZoom - 0.1 }) },
      { label: 'View: Reset Zoom (Ctrl+0)', run: () => updateSettings({ uiZoom: 1 }) },
      { label: 'View: Toggle Word Wrap', run: () => updateSettings({ wordWrap: !getSettings().wordWrap }) },
      { label: 'View: Show Problems', run: openProblemsPicker },
      { label: 'Editor: Format Document', run: runEditorAction('editor.action.formatDocument') },
      { label: 'Editor: Go to Line…  (Ctrl+G)', run: runEditorAction('editor.action.gotoLine') },
      { label: 'Editor: Go to Symbol in File…', run: runEditorAction('editor.action.quickOutline') },
      { label: 'Editor: Find  (Ctrl+F)', run: runEditorAction('actions.find') },
      { label: 'Editor: Replace  (Ctrl+H)', run: runEditorAction('editor.action.startFindReplace') },
      { label: 'Editor: Toggle Line Comment', run: runEditorAction('editor.action.commentLine') },
      { label: 'Editor: Fold All', run: runEditorAction('editor.foldAll') },
      { label: 'Editor: Unfold All', run: runEditorAction('editor.unfoldAll') },
      { label: 'Editor: Sort Lines Ascending', run: runEditorAction('editor.action.sortLinesAscending') },
      { label: 'Developer: Toggle Developer Tools', run: () => void window.api.toggleDevTools() },
      { label: 'File: Go to File...', run: () => void openFileSearch() },
      { label: 'File: New File…', run: () => rootRef.current && createEntry(selected ? (selected.isDir ? selected.path : parentOf(selected.path)) : rootRef.current, 'file') },
      { label: 'File: New Folder…', run: () => rootRef.current && createEntry(selected ? (selected.isDir ? selected.path : parentOf(selected.path)) : rootRef.current, 'folder') },
      { label: 'Search: Find in Files (Ctrl+Shift+F)', run: showSearch },
      { label: 'View: Toggle Terminal', run: () => setShowTerminal((v) => !v) },
      { label: 'Terminal: New Terminal (Ctrl+Shift+`)', run: newTerminal },
      { label: 'View: Toggle AI Chat', run: () => setShowChat((v) => !v) },
      { label: 'AI: Edit Selection (Ctrl+K)', run: () => startInlineRef.current() },
      { label: 'AI: Toggle Autocomplete', run: toggleAutocomplete },
      {
        label: 'AI: Create or Open Project Rules (AGENTS.md)',
        run: () => {
          const r = rootRef.current
          if (r) void window.api.rulesCreate(r).then((res) => openFile(res.path))
        }
      },
      { label: 'Git: Show Source Control (Ctrl+Shift+G)', run: () => setSidebarView('git') },
      { label: 'Git: Refresh', run: () => void refreshGit(rootRef.current) },
      { label: 'Git: Checkout to…', run: () => void openBranchPicker() },
      { label: 'Git: Pull', run: () => void window.api.gitRemote(rootRef.current ?? '', 'pull').then((r) => (r.ok ? refreshGit(rootRef.current) : window.alert(r.error))) },
      { label: 'Git: Push', run: () => void window.api.gitRemote(rootRef.current ?? '', 'push').then((r) => (r.ok ? refreshGit(rootRef.current) : window.alert(r.error))) },
      { label: 'Preferences: Color Theme', run: openThemePicker },
      { label: 'Preferences: Open Settings (Ctrl+,)', run: () => setShowSettings(true) }
    ])
    setPickOpts({ initial: 0 })
    setPicker('commands')
  }, [save, saveAll, openFileSearch, toggleAutocomplete, showSearch, openThemePicker, newTerminal, openBranchPicker, createEntry, selected, openFolderPath, openProblemsPicker, openFile])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      const a = actionsRef.current
      if (k === 's' && e.altKey) {
        e.preventDefault()
        void a.saveAll()
      } else if (k === 's') {
        e.preventDefault()
        void save()
      } else if (k === 'w' && !e.shiftKey) {
        e.preventDefault()
        if (activeRef.current) a.closeTab(activeRef.current)
      } else if (k === 't' && e.shiftKey) {
        e.preventDefault()
        a.reopenClosedTab()
      } else if (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault()
        a.switchTab(e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1)
      } else if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
        const list = tabsRef.current
        const target = e.key === '9' ? list[list.length - 1] : list[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          setActive(target.path)
          setDiffView(null)
        }
      } else if (k === 'b' && !e.shiftKey) {
        e.preventDefault()
        setShowSidebar((v) => !v)
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        updateSettings({ uiZoom: getSettings().uiZoom + 0.1 })
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        updateSettings({ uiZoom: getSettings().uiZoom - 0.1 })
      } else if (e.key === '0') {
        e.preventDefault()
        updateSettings({ uiZoom: 1 })
      } else if (k === 'g' && e.shiftKey) {
        e.preventDefault()
        setSidebarView('git')
      } else if (k === 'f' && e.shiftKey) {
        e.preventDefault()
        showSearch()
      } else if (k === 'p' && e.shiftKey) {
        e.preventDefault()
        openPalette()
      } else if (k === 'p') {
        e.preventDefault()
        void openFileSearch()
      } else if (e.key === ',') {
        e.preventDefault()
        setShowSettings((v) => !v)
      } else if (k === 'l') {
        e.preventDefault()
        setShowChat((v) => !v)
      } else if (e.code === 'Backquote' && e.shiftKey) {
        e.preventDefault()
        newTerminal()
      } else if (e.key === '`') {
        e.preventDefault()
        setShowTerminal((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, openPalette, openFileSearch, showSearch, newTerminal])

  return (
    <div className="app">
      <div className="workbench">
      <aside className={'sidebar' + (showSidebar ? '' : ' hidden')}>
        <div className="sidebar-header">
          <span className="sidebar-views">
            <button className={sidebarView === 'files' ? 'on' : ''} onClick={() => setSidebarView('files')}>
              Explorer
            </button>
            <button className={sidebarView === 'search' ? 'on' : ''} onClick={showSearch}>
              Search
            </button>
            <button className={sidebarView === 'git' ? 'on' : ''} data-view="git" onClick={() => setSidebarView('git')}>
              Git
              {git.status.state === 'ok' && changeCount(git.status) > 0 && (
                <span className="badge">{changeCount(git.status)}</span>
              )}
            </button>
          </span>
          <button className="ghost" title="Open Folder…" onClick={openFolder}>
            Open…
          </button>
        </div>
        <div
          className="tree"
          style={{ display: sidebarView === 'files' ? 'block' : 'none' }}
          onContextMenu={(e) => {
            if (!root) return
            e.preventDefault()
            setTreeMenu({ x: e.clientX, y: e.clientY, entry: null }) // empty space: the menu for the project folder
          }}
        >
          {root ? (
            <>
              <div className="tree-root" title={root}>
                {baseName(root)}
              </div>
              <FileTree
                root={root}
                version={treeVersion}
                selected={selected?.path ?? null}
                reveal={reveal}
                git={gitInfo}
                onOpen={openFile}
                onSelect={setSelected}
                onMenu={(entry, x, y) => setTreeMenu({ x, y, entry })}
              />
            </>
          ) : (
            <div className="empty">
              <p>You have not opened a folder yet.</p>
              <button className="primary" onClick={openFolder}>
                Open Folder
              </button>
            </div>
          )}
        </div>
        {/* Kept mounted so results survive switching back to the explorer. */}
        <div className="tree" style={{ display: sidebarView === 'search' ? 'block' : 'none' }}>
          <SearchPanel
            root={root}
            focusSignal={searchFocus}
            onOpen={(p, l) => void openFile(p, l)}
            isDirty={(abs) => tabsRef.current.some((t) => t.dirty && samePath(t.path) === samePath(abs))}
            onReplaced={() => void onWorkspaceTouched()}
          />
        </div>
        <div className="tree" style={{ display: sidebarView === 'git' ? 'block' : 'none' }}>
          <GitPanel
            root={root}
            onOpenDiff={(f, staged) => void openDiff(f, staged)}
            onOpenFile={(abs) => void openFile(abs)}
            onChanged={() => void onWorkspaceTouched()}
          />
        </div>
      </aside>
      <main className="main">
        <div className="tabs">
          {tabs.map((t) => (
            <div
              key={t.path}
              className={'tab' + (t.path === active ? ' active' : '')}
              data-tab-path={t.path}
              title={t.path}
              onClick={() => {
                setActive(t.path)
                setDiffView(null)
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeTab(t.path) // middle click closes, like a browser tab
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ x: e.clientX, y: e.clientY, path: t.path })
              }}
            >
              <span className="tab-name">{baseName(t.path)}</span>
              {t.dirty && <span className="tab-dot" title="Unsaved changes" />}
              <span
                className="close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.path)
                }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
        {active && tabs.length > 0 && <Breadcrumbs root={root} path={active} onReveal={revealInExplorer} />}
        <div className="editor-wrap">
          <div ref={containerRef} className="editor" />
          {tabs.length === 0 && (
            <Welcome
              hasFolder={root !== null}
              recent={recent.filter((f) => !root || samePath(f) !== samePath(root))}
              onOpenFolder={openFolder}
              onOpenRecent={(f) => void openFolderPath(f)}
              onThemes={openThemePicker}
            />
          )}
          {diffView && (
            <DiffView
              data={diffView}
              onOpenFile={() => void openFile(diffView.path)}
              onClose={() => setDiffView(null)}
            />
          )}
        </div>
        {terminalOpened && (
          <TerminalPanel
            cwd={root}
            visible={showTerminal}
            newTabSignal={newTermSignal}
            onEmpty={hideTerminal}
            onHide={hideTerminal}
          />
        )}
      </main>
      {/* Both panels stay mounted so switching modes keeps each conversation. */}
      <div style={{ display: showChat && panelMode === 'chat' ? 'contents' : 'none' }}>
        <ChatPanel
          root={root}
          getContext={getEditorContext}
          getProblemsText={getProblemsText}
          getTerminalText={readActiveTerminalText}
          onInsert={insertIntoEditor}
          onApply={(code) => void applyCode(code)}
          onOpenFile={(p) => void openFile(p)}
          onSwitch={() => setPanelMode('agent')}
        />
      </div>
      <div style={{ display: showChat && panelMode === 'agent' ? 'contents' : 'none' }}>
        <AgentPanel
          root={root}
          onOpenFile={(p) => void openFile(p)}
          onSwitch={() => setPanelMode('chat')}
          isDirty={isDirtyRel}
          onFileChanged={onAgentFileChanged}
          onWorkspaceTouched={() => void onWorkspaceTouched()}
          onNeedsAttention={() => {
            setShowChat(true)
            setPanelMode('agent')
          }}
        />
      </div>
      </div>
      <footer className="statusbar">
        <span className="sb-item" title={root ?? 'No folder open'}>
          {root ? baseName(root) : 'No folder'}
        </span>
        {git.status.state === 'ok' && (
          <button
            className="sb-item sb-btn"
            data-sb="branch"
            title="Switch or create a branch"
            onClick={() => void openBranchPicker()}
          >
            ⎇ {git.status.branch}
            {changeCount(git.status) > 0 ? '*' : ''}
            {(git.status.ahead ?? 0) > 0 && ` ↑${git.status.ahead}`}
            {(git.status.behind ?? 0) > 0 && ` ↓${git.status.behind}`}
          </button>
        )}
        <span className="sb-spacer" />
        {tabs.length > 0 && cursor && (
          <span className="sb-item">
            Ln {cursor.line}, Col {cursor.col}
          </span>
        )}
        {tabs.length > 0 && (
          <span className="sb-item">{tabs.find((t) => t.path === active)?.model.getLanguageId()}</span>
        )}
        <button
          className="sb-item sb-btn"
          data-sb="problems"
          title="Errors and warnings in open files"
          onClick={openProblemsPicker}
        >
          ⊗ {problems.errors} ⚠ {problems.warnings}
        </button>
        {(update.status === 'available' || update.status === 'downloading' || update.status === 'ready') && (
          <button
            className="sb-item sb-btn sb-update"
            data-update={update.status}
            disabled={update.status === 'downloading'}
            title="Update available. Click to download it, then to restart and install."
            onClick={() =>
              update.status === 'available' ? void window.api.updateDownload() : update.status === 'ready' && window.api.updateInstall()
            }
          >
            {update.status === 'available'
              ? `Update ${update.version} available`
              : update.status === 'downloading'
                ? `Downloading update ${update.percent ?? 0}%`
                : 'Restart to update'}
          </button>
        )}
        <button
          className="sb-item sb-btn"
          title="Ghost-text suggestions as you type (uses Claude Haiku 5.5 and API credits)"
          onClick={toggleAutocomplete}
        >
          Autocomplete: {autocomplete ? 'on' : 'off'}
        </button>
        <button className="sb-item sb-btn" title="Change color theme" onClick={openThemePicker}>
          Theme: {themeLabel}
        </button>
        <button className="sb-item sb-btn" title="Show or hide the AI panel (Ctrl+L)" onClick={() => setShowChat((v) => !v)}>
          AI panel
        </button>
        <button className="sb-item sb-btn" title="Settings (Ctrl+,)" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </footer>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {applying && <div className="apply-toast" data-apply-busy>Claude is applying the change…</div>}
      {applyState && <ApprovalDialog approval={applyState.approval} unsavedWarning={false} onDecide={decideApply} />}
      {tabMenu && <ContextMenu x={tabMenu.x} y={tabMenu.y} items={tabMenuItems(tabMenu.path)} onClose={() => setTabMenu(null)} />}
      {treeMenu && (
        <ContextMenu x={treeMenu.x} y={treeMenu.y} items={treeMenuItems(treeMenu.entry)} onClose={() => setTreeMenu(null)} />
      )}
      {inputRequest && <InputDialog request={inputRequest} onClose={() => setInputRequest(null)} />}
      {inlineTarget && <InlineEdit target={inlineTarget} onClose={() => setInlineTarget(null)} />}
      {picker && (
        <QuickPick
          key={picker}
          items={pickItems}
          initialIndex={pickOpts.initial}
          onCancel={pickOpts.onCancel}
          placeholder={
            picker === 'files'
              ? 'Go to file...'
              : picker === 'themes'
                ? 'Select a color theme...'
                : picker === 'branches'
                  ? 'Select a branch...'
                  : picker === 'problems'
                    ? 'Problems in open files...'
                    : 'Type a command...'
          }
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
