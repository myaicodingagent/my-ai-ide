import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { monaco } from './monaco-setup'
import { FileTree, DirEntry, GitInfo, treeKeyDown } from './FileTree'
import { LiveRegions, announce } from './a11y'
import { ContextMenu, MenuItem } from './ContextMenu'
import { Breadcrumbs } from './Breadcrumbs'
import { addRecentFolder, getRecentFolders, loadExtraFolders, loadSession, removeRecentFolder, saveExtraFolders, saveSession } from './session'
import { TerminalPanel, PanelTab, readActiveTerminalText } from './TerminalPanel'
import { DebugConsoleView, OutputView, ProblemsView } from './PanelViews'
import { OpenEditors, Outline, Timeline } from './ExplorerSections'
import { ExtTreeView, ExtWebviewView, treeEvent, treeReset } from './ExtTreeView'
import { WebviewFrame } from './WebviewFrame'
import { closeWebview, getActiveWebview, setActiveWebview, useActiveWebview, useWebviewPanels, webviewEvent, webviewReset } from './webviewStore'
import { useExtensions } from './extStore'
import { initLanguageServers, notifySaved, releaseGhost, restartLanguageServers, useLspServers } from './lspClient'
import { APP_CHANNEL, TASKS_CHANNEL, appendOutput as logOutput } from './outputStore'
import { ApprovalDialog, Approval } from './ApprovalDialog'
import { QuickPick, PickItem } from './QuickPick'
import { ChatPanel, EditorContext } from './ChatPanel'
import { InlineEdit, InlineTarget } from './InlineEdit'
import { registerAutocomplete } from './autocomplete'
import { AgentPanel } from './AgentPanel'
import { SearchPanel } from './SearchPanel'
import { Welcome } from './Welcome'
import { MenuBar, MenuDef } from './MenuBar'
import { Icons } from './ActivityBar'
import { applyTheme, getTheme, getThemes, subscribeTheme } from './theme'
import { SettingsDialog } from './SettingsDialog'
import { AccountDialog } from './AccountCard'
import { planSummary, useAuth } from './authStore'
import { useUpdateState } from './update'
import { editorOptions, getSettings, updateSettings, useSettings } from './settings'
import { GitPanel } from './GitPanel'
import { DiffView, DiffViewData } from './DiffView'
import { InputDialog, InputRequest } from './InputDialog'
import { changeCount, refreshGit, setGitExtraRoots, useGit } from './gitStore'
import type { CommitFile, GitFile } from '../../main/git'
import { attachConflictDecorations, registerConflictLenses } from './conflicts'
import { SplitPane } from './SplitPane'
import { attachNextEdit } from './nextedit'
import { BackgroundPanel } from './BackgroundPanel'
import { DebugPanel } from './DebugPanel'
import { ExtensionsPanel } from './ExtensionsPanel'
import { ChoiceDialog } from './ChoiceDialog'
import { applyExtEdits, attachExtEditorState, clearExtProviders, registerExtProvider, setExtDiagnostics, unregisterExtProvider } from './extBridge'
import { MergeView } from './MergeView'
import { NotebookView } from './NotebookView'
import { emptyNotebook, newCell, serializeNotebook } from './notebookModel'
import { countConflicts } from './mergeParse'
import type { LaunchConfig, TaskDef, TasksInfo } from '../../main/tasks'
import { expandVars, taskChain } from './tasksRun'
import { validSshTarget, wslUnc } from '../../main/shellspec'
import type { ConnectResult } from '../../main/sshfs'
import { extensionCommands, initExtensions } from './extStore'
import { attachDebugEditor, toggleBreakpointAtCaret } from './debugEditor'
import { attachDebugging, getDebug, initDebug, isActive as debugActive, startDebugging, stepDebug, stopDebugging, clearBreakpoints as clearAllBreakpoints } from './debugStore'
import { initBackground, needsAttention, useBgTasks } from './bgStore'

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
  // More folders in the same workspace. `root` stays the main one (agent, chat rules, terminal, session).
  const [extraRoots, setExtraRoots] = useState<string[]>([])
  const roots = useMemo(() => (root ? [root, ...extraRoots] : []), [root, extraRoots])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [showTerminal, setShowTerminal] = useState(false) // the bottom panel is shown
  const [panelTab, setPanelTab] = useState<PanelTab>('terminal')
  // The terminal panel stays mounted after the first time it is shown, so its sessions survive hiding it.
  const [terminalOpened, setTerminalOpened] = useState(false)
  const [newTermSignal, setNewTermSignal] = useState(0)
  useEffect(() => {
    if (showTerminal) setTerminalOpened(true)
  }, [showTerminal])
  const [newTermShell, setNewTermShell] = useState<string | null>(null)
  const [newTermExtra, setNewTermExtra] = useState<{ title: string; command: string; cwd: string | null } | null>(null)
  const newTerminal = useCallback((shellId?: string, extra?: { title: string; command: string; cwd: string | null }): void => {
    setNewTermShell(typeof shellId === 'string' ? shellId : null)
    setNewTermExtra(extra ?? null)
    setPanelTab('terminal')
    setShowTerminal(true)
    setTerminalOpened(true)
    setNewTermSignal((n) => n + 1)
  }, [])
  const hideTerminal = useCallback((): void => setShowTerminal(false), [])
  // The last terminal closing hides the panel only if the terminal is what you are looking at.
  const panelTabRef = useRef(panelTab)
  panelTabRef.current = panelTab
  const terminalEmpty = useCallback((): void => {
    if (panelTabRef.current === 'terminal') setShowTerminal(false)
  }, [])
  const showPanelTab = useCallback((tab: PanelTab): void => {
    setPanelTab(tab)
    setShowTerminal(true)
    setTerminalOpened(true)
  }, [])
  // Ctrl+`: show the terminal; if the panel shows something else, switch to the terminal; if it is the terminal, hide.
  const toggleTerminal = useCallback((): void => {
    setShowTerminal((vis) => {
      if (vis && panelTabRef.current !== 'terminal') {
        setPanelTab('terminal')
        return true
      }
      if (!vis) setPanelTab('terminal')
      return !vis
    })
  }, [])
  useEffect(() => {
    if (!showTerminal) {
      setNewTermShell(null) // a shell or task asked for once is not asked for again when the panel is shown later
      setNewTermExtra(null)
    }
  }, [showTerminal])
  const [sidebarView, setSidebarView] = useState<string>('files') // 'files', 'search', 'git', 'agents', 'debug', 'ext', or xc:<container> for a view container an extension adds
  const [searchFocus, setSearchFocus] = useState(0)
  const showSearch = useCallback((): void => {
    setSidebarView('search')
    setSearchFocus((n) => n + 1)
  }, [])
  const bgTasks = useBgTasks()
  const bgAttention = bgTasks.filter((t) => root && samePath(t.root) === samePath(root) && needsAttention(t)).length
  const [bgFocus, setBgFocus] = useState(0)
  const [bgPrefill, setBgPrefill] = useState<{ text: string; n: number } | null>(null)
  useEffect(() => initBackground(), [])
  const showAgents = useCallback((): void => {
    setShowSidebar(true)
    setSidebarView('agents')
    setBgFocus((n) => n + 1)
  }, [])
  const runInBackground = useCallback((task: string): void => {
    setShowSidebar(true)
    setSidebarView('agents')
    setBgPrefill((cur) => ({ text: task, n: (cur?.n ?? 0) + 1 }))
  }, [])
  // ---- Extensions: what they ask of the editor, and a small message bar for them ----
  const [toast, setToast] = useState<{ text: string; kind: string; n: number } | null>(null)
  const showToast = useCallback((text: string, kind = 'info'): void => {
    setToast((cur) => ({ text, kind, n: (cur?.n ?? 0) + 1 }))
    logOutput(APP_CHANNEL, (kind === 'error' ? 'Error: ' : '') + text)
    announce(text, kind === 'error' ? 'assertive' : 'polite')
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])
  useEffect(() => {
    initExtensions()
    return window.api.onExtRequest(async (req) => {
      const respond = (r: { result?: unknown; error?: string }): void => void window.api.extRespond(req.reqId, r)
      try {
        const p = req.params ?? {}
        switch (req.method) {
          case 'message':
            // With buttons it is a question; without, a note that fades.
            if (Array.isArray(p.items) && p.items.length) {
              return setChoice({ text: String(p.text), kind: String(p.kind), choices: p.items.map(String), resolve: (c) => respond({ result: c }) })
            }
            showToast(String(p.text), String(p.kind))
            return respond({ result: null })
          case 'quickPick': {
            const items = (p.items as { label: string; description?: string; detail?: string }[]) ?? []
            let done = false
            const finish = (v: unknown): void => {
              if (done) return
              done = true
              respond({ result: v })
            }
            setPickItems(items.map((it, i) => ({ label: it.label, detail: it.description ?? it.detail, run: () => finish(p.canPickMany ? [i] : i) })))
            setPickOpts({ initial: 0, onCancel: () => finish(null) })
            return setPicker('commands')
          }
          case 'setDiagnostics':
            return setExtDiagnostics(String(p.owner), String(p.path), Array.isArray(p.items) ? p.items : [])
          case 'registerProvider':
            return registerExtProvider(p as Parameters<typeof registerExtProvider>[0])
          case 'unregisterProvider':
            return unregisterExtProvider(String(p.id))
          case 'treeView':
          case 'treeViewGone':
          case 'treeChanged':
            return treeEvent(req.method, String(p.viewId), typeof p.handle === 'number' ? p.handle : null)
          case 'webviewCreate':
          case 'webviewHtml':
          case 'webviewTitle':
          case 'webviewReveal':
          case 'webviewDispose':
          case 'webviewPost':
            return webviewEvent(req.method, p)
          case 'reset':
            clearExtProviders()
            treeReset()
            webviewReset()
            return setExtStatus({})
          case 'statusBar':
            return setExtStatus((cur) => {
              const next = { ...cur }
              if (p.visible && p.text) next[String(p.id)] = { text: String(p.text), tooltip: String(p.tooltip ?? ''), command: p.command ? String(p.command) : undefined, extId: String(p.extId) }
              else delete next[String(p.id)]
              return next
            })
          case 'applyEdits': {
            const file = String(p.path)
            const ed = focusedEditor()
            if (!applyExtEdits(file, Array.isArray(p.edits) ? p.edits : [], p.snippet === true, ed)) {
              await openFileRef.current(file)
              await new Promise((r) => setTimeout(r, 120))
              if (!applyExtEdits(file, Array.isArray(p.edits) ? p.edits : [], p.snippet === true, focusedEditor())) return respond({ error: 'That file could not be opened.' })
            }
            return respond({ result: null })
          }
          case 'editorAction':
            if (p.id === 'save') await saveRef.current()
            else void focusedEditor()?.getAction(String(p.id))?.run()
            return respond({ result: null })
          case 'input':
            pendingInput.current = (v) => respond({ result: v ?? null })
            return setInputRequest({
              title: String(p.prompt ?? 'Enter a value'),
              value: typeof p.value === 'string' ? p.value : '',
              placeholder: typeof p.placeholder === 'string' ? p.placeholder : undefined,
              onSubmit: (v) => {
                const done = pendingInput.current
                pendingInput.current = null
                done?.(v)
              }
            })
          case 'getEditor': {
            const c = getEditorContext()
            return respond({ result: c ? { path: c.path, language: c.language, text: c.text, selection: c.selection } : null })
          }
          case 'replaceSelection':
          case 'insert': {
            const ed = focusedEditor()
            const sel = ed?.getSelection()
            if (!ed || !sel) return respond({ error: 'No editor is open.' })
            const range = req.method === 'insert' ? new monaco.Range(sel.endLineNumber, sel.endColumn, sel.endLineNumber, sel.endColumn) : sel
            ed.executeEdits('extension', [{ range, text: String(p.text), forceMoveMarkers: true }])
            return respond({ result: null })
          }
          case 'openFile':
            await openFileRef.current(String(p.file), typeof p.line === 'number' ? p.line : undefined)
            return respond({ result: null })
          case 'fileChanged':
            return void onWorkspaceTouched()
          default:
            return respond({ error: 'Unknown request: ' + req.method })
        }
      } catch (e) {
        respond({ error: e instanceof Error ? e.message : String(e) })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const runExtCommand = useCallback(async (c: { extId: string; id: string }): Promise<void> => {
    const r = await window.api.extRun(c.extId, c.id)
    if (!r.ok) showToast(r.error, 'error')
  }, [showToast])
  useEffect(() => void window.api.extSetRoot(root), [root])

  // ---- WSL: open a folder inside a Linux distribution ----
  const openWslFolderPicker = useCallback(async (): Promise<void> => {
    const shells = await window.api.termShells()
    const distros = shells.filter((s) => s.id.startsWith('wsl:')).map((s) => s.id.slice(4))
    if (distros.length === 0) return void window.alert('No WSL distribution was found. Install one by running "wsl --install" in a terminal.')
    const openHome = async (distro: string): Promise<void> => {
      let homes: { name: string; path: string; isDir: boolean }[] = []
      try {
        homes = (await window.api.readDir(wslUnc(distro, '/home'))).filter((e: { isDir: boolean }) => e.isDir)
      } catch {
        // The distribution may be stopped or have no /home; fall back to its root.
      }
      if (homes.length === 1) return void openFolderPathRef.current(homes[0].path)
      if (homes.length > 1) {
        setPickItems(homes.map((h) => ({ label: h.name, detail: h.path, run: () => void openFolderPathRef.current(h.path) })))
        setPickOpts({ initial: 0 })
        return setPicker('commands')
      }
      void openFolderPathRef.current(wslUnc(distro, '/'))
    }
    setPickItems(distros.map((d) => ({ label: d, detail: 'Open a folder in this Linux distribution', run: () => void openHome(d) })))
    setPickOpts({ initial: 0 })
    setPicker('commands')
  }, [])

  // ---- SSH: open a folder on another computer ----
  // Runs a connect attempt and, whenever the computer needs something (to trust its key, a password, a passphrase), asks and tries again.
  const sshAttempt = useCallback(async (attempt: (secrets: { password?: string; passphrase?: string; trust?: string }) => Promise<ConnectResult>, secrets: { password?: string; passphrase?: string; trust?: string } = {}): Promise<{ name: string; home: string } | null> => {
    const r = await attempt(secrets)
    if (r.ok) return { name: r.name, home: r.home }
    if (!r.need) {
      showToast(r.error, 'error')
      return null
    }
    return new Promise((resolve) => {
      const next = (more: { password?: string; passphrase?: string; trust?: string }): void => void sshAttempt(attempt, { ...secrets, ...more }).then(resolve)
      if (r.need === 'trust') {
        setChoice({
          text: 'This computer is not known yet. Its key fingerprint is ' + (r.fingerprint ?? '') + '. Only continue if that is what you expect.',
          kind: 'warning',
          choices: ['Trust and connect'],
          resolve: (c) => (c ? next({ trust: r.fingerprint }) : resolve(null))
        })
        return
      }
      setInputRequest({
        title: r.need === 'password' ? 'Password for the remote computer' : 'Passphrase for your SSH key',
        secret: true,
        confirmLabel: 'Connect',
        validate: (v) => (v ? null : 'Type it, or press Escape to cancel.'),
        onSubmit: (v) => next(r.need === 'password' ? { password: v } : { passphrase: v })
      })
    })
  }, [showToast])

  const browseRemote = useCallback(async (name: string, from: string): Promise<void> => {
    const b = await window.api.sshBrowse(name, from)
    if (!b.ok) return void showToast(b.error, 'error')
    const open = async (p: string): Promise<void> => void openFolderPathRef.current(await window.api.sshToUnc(name, p))
    const items = [
      { label: '✓ Open this folder', detail: b.path, run: () => void open(b.path) },
      ...(b.parent !== null ? [{ label: '..', detail: b.parent, run: () => void browseRemote(name, b.parent as string) }] : []),
      ...b.dirs.map((d) => ({ label: d, detail: 'Go into this folder', run: () => void browseRemote(name, (b.path === '/' ? '' : b.path) + '/' + d) }))
    ]
    setPickItems(items)
    setPickOpts({ initial: 0 })
    setPicker('commands')
  }, [showToast])

  const openSshFolderPicker = useCallback((): void => {
    setInputRequest({
      title: 'Connect to a computer over SSH (user@host, host:port, or a name from your ssh config)',
      placeholder: 'user@host',
      confirmLabel: 'Connect',
      validate: (v) => (validSshTarget(v.trim().replace(/:\d+$/, '')) ? null : 'Use a host name, an address, user@host or a name from your ssh config.'),
      onSubmit: (v) => {
        void sshAttempt((s) => window.api.sshConnect(v.trim(), s)).then((c) => {
          if (c) void browseRemote(c.name, c.home)
        })
      }
    })
  }, [sshAttempt, browseRemote])

  // ---- Moving between the parts of the window with the keyboard (F6 / Shift+F6, or the "Focus" commands) ----
  type Region = 'explorer' | 'editor' | 'terminal' | 'chat'
  const regionOf = (el: Element | null): Region | null =>
    !el ? null : el.closest('.sidebar') ? 'explorer' : el.closest('.terminal-panel') ? 'terminal' : el.closest('aside.chat') ? 'chat' : el.closest('.groups') ? 'editor' : null
  const focusRegion = (name: Region): void => {
    if (name === 'explorer') {
      setShowSidebar(true)
      setSidebarView((v) => (v === 'files' ? v : v))
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>('.sidebar .tree-row[tabindex="0"], .sidebar .tree-row')
        const tab = document.querySelector<HTMLElement>('.sidebar-views [aria-selected="true"]')
        ;(sidebarViewRef.current === 'files' ? (row ?? tab) : tab)?.focus()
      })
    } else if (name === 'editor') {
      const ed = focusedEditor()
      if (ed?.getModel()) ed.focus()
      else document.querySelector<HTMLElement>('.tabs [tabindex="0"], .tabs [role="tab"]')?.focus()
    } else if (name === 'terminal') {
      setPanelTab('terminal')
      setShowTerminal(true)
      setTerminalOpened(true)
      setTimeout(() => document.querySelector<HTMLElement>('.terminal-panel .xterm-helper-textarea')?.focus(), 80)
    } else {
      setShowChat(true)
      setTimeout(() => document.querySelector<HTMLElement>('aside.chat textarea')?.focus(), 50)
    }
    announce({ explorer: 'Side bar', editor: 'Editor', terminal: 'Terminal', chat: 'AI panel' }[name])
  }
  const cycleRegion = (dir: number): void => {
    const order: Region[] = ['explorer', 'editor', ...(showTerminalRef.current ? (['terminal'] as Region[]) : []), ...(showChatRef.current ? (['chat'] as Region[]) : [])]
    const at = order.indexOf(regionOf(document.activeElement) ?? 'editor')
    focusRegion(order[(at + dir + order.length) % order.length])
  }
  const cycleRegionRef = useRef(cycleRegion)
  cycleRegionRef.current = cycleRegion
  const sidebarViewRef = useRef(sidebarView)
  sidebarViewRef.current = sidebarView
  const showTerminalRef = useRef(showTerminal)
  showTerminalRef.current = showTerminal

  // ---- Debugger ----
  const openFileRef = useRef<(path: string, line?: number) => Promise<void>>(async () => undefined)
  const openFolderPathRef = useRef<(dir: string) => Promise<void>>(async () => undefined)
  const sshAttemptRef = useRef<(attempt: (s: { password?: string; passphrase?: string; trust?: string }) => Promise<ConnectResult>) => Promise<{ name: string; home: string } | null>>(async () => null)
  useEffect(() => initDebug((f) => void openFileRef.current(f.file as string, f.line)), [])
  // ---- Notebooks: .ipynb files open as cells; "Open as text" shows the JSON instead ----
  const [nbAsText, setNbAsText] = useState<Set<string>>(new Set())
  const createNotebook = useCallback((): void => {
    const r = rootRef.current
    if (!r) return void window.alert('Open a folder first.')
    setInputRequest({
      title: 'New notebook name',
      value: 'Untitled.ipynb',
      selectEnd: 8,
      confirmLabel: 'Create',
      validate: (v) => (/^[^\\/:*?"<>|]+$/.test(v.trim()) ? null : 'Use a file name without slashes or special characters.'),
      onSubmit: async (v) => {
        const name = v.trim().toLowerCase().endsWith('.ipynb') ? v.trim() : v.trim() + '.ipynb'
        const target = r.replace(/[\\/]+$/, '') + '\\' + name
        const nb = emptyNotebook('python')
        nb.cells.push(newCell('code'))
        const res = await window.api.fsCreateFile(r, target)
        if (!res.ok) return void window.alert(res.error)
        await window.api.writeFile(target, serializeNotebook(nb))
        setTreeVersion((n) => n + 1)
        await openFileRef.current(target)
      }
    })
  }, [])

  // ---- Three-way merge editor ----
  const [mergeView, setMergeView] = useState<{ path: string; text: string; repo: string | null } | null>(null)
  const openMerge = useCallback(async (abs: string, repo?: string): Promise<void> => {
    const tab = tabsRef.current.find((t) => samePath(t.path) === samePath(abs))
    let text: string
    try {
      text = tab ? tab.model.getValue() : await window.api.readFile(abs)
    } catch {
      return void window.alert('That file could not be read.')
    }
    if (countConflicts(text) === 0) return void window.alert('This file has no merge conflicts.')
    const owner = repo ?? rootsRef.current.find((r) => relIfInside(r, abs)) ?? rootRef.current
    setDiffView(null)
    setMergeView({ path: abs, text, repo: owner })
  }, [])
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const uri = (e as CustomEvent<string>).detail
      const model = monaco.editor.getModel(monaco.Uri.parse(uri))
      if (model && model.uri.scheme === 'file') void openMerge(model.uri.fsPath)
    }
    window.addEventListener('myaiide-open-merge', onOpen)
    return () => window.removeEventListener('myaiide-open-merge', onOpen)
  }, [openMerge])
  const completeMerge = useCallback(async (resolved: string): Promise<void> => {
    const mv = mergeViewRef.current
    if (!mv) return
    await window.api.writeFile(mv.path, resolved)
    const tab = tabsRef.current.find((t) => samePath(t.path) === samePath(mv.path))
    if (tab) applyDiskContent(tab, resolved)
    setMergeView(null)
    // Mark the file resolved (stage it) when no conflict markers are left in it.
    if (mv.repo && countConflicts(resolved) === 0) {
      const rel = relIfInside(mv.repo, mv.path)
      if (rel) await window.api.gitStage(mv.repo, [rel])
    }
    void refreshGit(rootRef.current)
  }, [])

  // ---- Tasks and launch configurations (.ai-ide/tasks.json, launch.json; VS Code's files work too) ----
  const [tasksInfo, setTasksInfo] = useState<TasksInfo | null>(null)
  const [launchSel, setLaunchSel] = useState('') // '' = the file open in the editor
  const reloadTasks = useCallback(async (): Promise<TasksInfo | null> => {
    const r = rootRef.current
    if (!r) return setTasksInfo(null), null
    const info = await window.api.tasksLoad(r)
    setTasksInfo(info)
    setLaunchSel((cur) => (cur && !info.launch.some((l) => l.name === cur) ? '' : cur))
    return info
  }, [])
  useEffect(() => void reloadTasks(), [root, reloadTasks])
  const showDebug = useCallback((): void => {
    setShowSidebar(true)
    setSidebarView('debug')
    void reloadTasks()
  }, [reloadTasks])
  const runTask = useCallback(async (task: TaskDef, all: TaskDef[]): Promise<void> => {
    const r = rootRef.current
    if (!r) return
    const { commands, missing } = taskChain(all, task.label)
    if (missing.length) return void window.alert('This task depends on tasks that do not exist: ' + missing.join(', '))
    if (commands.length === 0) return void window.alert('This task has nothing to run.')
    announce('Running task ' + task.label)
    logOutput(TASKS_CHANNEL, 'Running task: ' + task.label)
    const ctx = { root: r, file: focusedPath() }
    const cwd = task.cwd ? expandVars(task.cwd, ctx) : r
    newTerminal(undefined, { title: 'Task: ' + task.label, command: expandVars(commands.join('; '), ctx), cwd })
  }, [])
  const openTasksPicker = useCallback(async (only?: string): Promise<void> => {
    const info = await reloadTasks()
    if (!info) return
    let list = info.tasks
    if (only) list = list.filter((t) => t.group === only)
    if (info.errors.length) window.alert('Problems in the tasks files:\n' + info.errors.join('\n'))
    if (list.length === 0) {
      const file = await window.api.tasksEnsure(rootRef.current as string, 'tasks')
      await openFileRef.current(file)
      return void window.alert(only ? 'No "' + only + '" task is defined. The tasks file is open: add "group": "' + only + '" to one.' : 'No tasks yet. A starter tasks file is open.')
    }
    if (only && list.length === 1) return void runTask(list[0], info.tasks)
    setPickItems(list.map((t) => ({ label: t.label, detail: (t.group ? '[' + t.group + '] ' : '') + (t.detail ?? t.command), run: () => void runTask(t, info.tasks) })))
    setPickOpts({ initial: 0 })
    setPicker('commands')
  }, [])
  const openConfigFile = useCallback(async (kind: 'tasks' | 'launch'): Promise<void> => {
    const r = rootRef.current
    if (!r) return
    const file = await window.api.tasksEnsure(r, kind)
    await openFileRef.current(file)
    void reloadTasks()
  }, [])
  // Files the debugger can run: JavaScript and TypeScript (Node), Python.
  const isRunnable = (p: string | null): p is string => !!p && /[.]((c|m)?(j|t)sx?|pyw?|go|cs|c|cc|cpp|cxx|java)$/i.test(p)
  // Saves the file first (the program runs from disk), then starts it under the debugger.
  const startDebug = useCallback(async (): Promise<string | null> => {
    const file = focusedPath()
    const r = rootRef.current
    const cfg = tasksInfoRef.current?.launch.find((l) => l.name === launchSelRef.current)
    // A launch configuration names its own program; only the plain "Current file" choice needs an open file.
    if (!(cfg && r) && !isRunnable(file)) return 'Open a .js, .ts, .py, .go, .cs, .c, .cpp or .java file to debug it.'
    const tab = tabsRef.current.find((t) => t.path === file)
    if (tab?.dirty) await saveTab(tab)
    showDebug()
    if (!cfg || !r) return startDebugging(file as string, r ?? undefined)
    // A launch configuration: its own program, arguments, folder and environment.
    const ctx = { root: r, file: file ?? '' }
    let program = expandVars(cfg.program, ctx)
    if (!/^([A-Za-z]:)?[\\/]/.test(program)) program = r + '/' + program
    const cfgTab = tabsRef.current.find((t) => samePath(t.path) === samePath(program))
    if (cfgTab?.dirty) await saveTab(cfgTab)
    return startDebugging(program, cfg.cwd ? expandVars(cfg.cwd, ctx) : r, cfg.stopOnEntry, {
      args: cfg.args.map((a) => expandVars(a, ctx)),
      env: Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, expandVars(v, ctx)]))
    })
  }, [showDebug])
  const mergeViewRef = useRef(mergeView)
  mergeViewRef.current = mergeView
  const tasksInfoRef = useRef<TasksInfo | null>(null)
  const launchSelRef = useRef('')
  tasksInfoRef.current = tasksInfo
  launchSelRef.current = launchSel
  const [showChat, setShowChat] = useState(true)
  const showChatRef = useRef(showChat)
  showChatRef.current = showChat
  const [panelMode, setPanelMode] = useState<'chat' | 'agent'>('chat')
  const [picker, setPicker] = useState<'files' | 'commands' | 'themes' | 'branches' | 'problems' | null>(null)
  const [pickItems, setPickItems] = useState<PickItem[]>([])
  const [pickOpts, setPickOpts] = useState<{ initial: number; onCancel?: () => void }>({ initial: 0 })
  const [themeLabel, setThemeLabel] = useState(getTheme().label)
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null)
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null)
  const pendingInput = useRef<((v: string | undefined) => void) | null>(null)
  const [choice, setChoice] = useState<{ text: string; kind: string; choices: string[]; resolve: (c: string | null) => void } | null>(null)
  const [extStatus, setExtStatus] = useState<Record<string, { text: string; tooltip: string; command?: string; extId: string }>>({})
  const saveRef = useRef<() => Promise<void>>(async () => undefined)
  useEffect(() => {
    if (!inputRequest && pendingInput.current) {
      pendingInput.current(undefined) // the box was closed without an answer
      pendingInput.current = null
    }
  }, [inputRequest])
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
  const extraRootsRef = useRef(extraRoots)
  extraRootsRef.current = extraRoots
  const rootsRef = useRef(roots)
  const lspServers = useLspServers()
  const webviewPanels = useWebviewPanels()
  const activeWebview = useActiveWebview()
  useEffect(() => setActiveWebview(null), [active]) // opening a file leaves an extension's page
  // Tree views and view containers that extensions add.
  const extRecords = useExtensions()
  const extViews = useMemo(() => extRecords.filter((r) => r.enabled).flatMap((r) => r.views.map((v) => ({ ...v, ext: r.id }))), [extRecords])
  // The title of the window: shown in the title bar (the menu bar) and used by the system for the task bar.
  const windowTitle = useMemo(() => {
    const tab = tabs.find((t) => t.path === active)
    return [tab ? baseName(tab.path) + (tab.dirty ? ' ●' : '') : '', root ? baseName(root) : '', 'My AI IDE'].filter(Boolean).join(' — ')
  }, [tabs, active, root])
  useEffect(() => {
    document.title = windowTitle
  }, [windowTitle])
  useEffect(() => {
    document.documentElement.dataset.platform = window.api.platform
  }, [])
  const renderExtView = (v: { id: string; name: string; webview?: boolean }): JSX.Element =>
    v.webview ? <ExtWebviewView key={v.id} viewId={v.id} name={v.name} /> : <ExtTreeView key={v.id} viewId={v.id} name={v.name} onOpenFile={(p) => void openFile(p)} />
  const extContainers = useMemo(() => extRecords.filter((r) => r.enabled).flatMap((r) => r.containers.map((c) => ({ ...c, ext: r.id }))), [extRecords])
  const customContainerIds = useMemo(() => new Set(extContainers.map((c) => c.id)), [extContainers])
  rootsRef.current = roots
  // Language servers (Go, Python, Rust, C/C++): started when a file of that language is open.
  useEffect(() => {
    initLanguageServers({ getRoots: () => rootsRef.current, openFile: (p, line) => void openFileRef.current(p, line), notify: showToast })
  }, [showToast])
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
  useEffect(() => void window.api.indexEmbeddings(settings.meaningSearch), [settings.meaningSearch])
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
  const [showAccount, setShowAccount] = useState(false)
  const auth = useAuth()
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
  // Second editor group (split view). Both groups share the open files' text models.
  const splitEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const focusRef = useRef<'main' | 'split'>('main') // which group the user was last working in
  const [split, setSplit] = useState<{ paths: string[]; active: string | null; dir: 'right' | 'down'; size: number } | null>(null)
  const splitRef = useRef(split)
  splitRef.current = split
  const groupsRef = useRef<HTMLDivElement>(null)
  // Commands (save, format, inline edit, chat context...) act on the group that was last used.
  const focusedEditor = (): monaco.editor.IStandaloneCodeEditor | null =>
    focusRef.current === 'split' && splitEditorRef.current?.getModel() ? splitEditorRef.current : editorRef.current
  // Closes a model: the editors let go of it first, because Monaco's own code throws if a model is disposed while one still shows it.
  const disposeModel = (m: monaco.editor.ITextModel): void => {
    for (const ed of [editorRef.current, splitEditorRef.current]) if (ed && ed.getModel() === m) ed.setModel(null)
    m.dispose()
  }
  const focusedPath = (): string | null =>
    focusRef.current === 'split' && splitRef.current?.active ? splitRef.current.active : activeRef.current
  const tabsRef = useRef<Tab[]>([])
  const startInlineRef = useRef<() => void>(() => {})
  tabsRef.current = tabs

  startInlineRef.current = (): void => {
    const ed = focusedEditor()
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
      glyphMargin: true, // breakpoints
      ...editorOptions(),
      padding: { top: 12, bottom: 12 },
      minimap: { enabled: getSettings().minimap, renderCharacters: false },
      wordWrap: getSettings().wordWrap ? 'on' : 'off',
      scrollBeyondLastLine: false,
      cursorBlinking: getSettings().reduceMotion ? 'solid' : 'smooth',
      bracketPairColorization: { enabled: true },
      renderLineHighlight: 'all',
      guides: { bracketPairs: true, indentation: true }
    })
    ed.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }))
    ed.onDidFocusEditorText(() => {
      focusRef.current = 'main'
    })
    // Overrides Monaco's Ctrl+K chord prefix.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => startInlineRef.current())
    registerConflictLenses()
    const conflictDecos = attachConflictDecorations(ed)
    const nextEdit = attachNextEdit(ed, () => getSettings().nextEdit)
    const debugDecos = attachDebugEditor(ed)
    const extState = attachExtEditorState(ed, () => focusRef.current === 'main')
    editorRef.current = ed
    return () => {
      extState.dispose()
      debugDecos.dispose()
      nextEdit.dispose()
      conflictDecos.dispose()
      ed.dispose()
    }
  }, [])

  // Switches to another folder: asks about unsaved work, closes the old folder's tabs, then opens the new one.
  const openFolderPath = useCallback(async (dir: string): Promise<void> => {
    if (rootRef.current && samePath(dir) === samePath(rootRef.current)) return
    if (/^\\\\ssh\./i.test(dir)) {
      // A folder on another computer: connect again if the link was lost (for example after restarting the app).
      const c = await sshAttemptRef.current((s) => window.api.sshEnsure(dir, s))
      if (!c) return
    }
    if (!(await window.api.fsIsDir(dir))) {
      removeRecentFolder(dir)
      setRecent(getRecentFolders())
      return void window.alert(`The folder no longer exists:\n${dir}`)
    }
    const dirty = tabsRef.current.filter((t) => t.dirty)
    if (dirty.length && !window.confirm(`${dirty.length} open file(s) have unsaved changes that will be lost. Open another folder anyway?`)) return
    // Let go of the models in the editors first: a model that is disposed while shown makes Monaco's own code throw.
    editorRef.current?.setModel(null)
    splitEditorRef.current?.setModel(null)
    for (const t of tabsRef.current) disposeModel(t.model)
    diskText.current.clear()
    setTabs([])
    setActive(null)
    setDiffView(null)
    setSelected(null)
    sessionReadyFor.current = null // the new folder's saved tabs are restored before saving starts again
    setExtraRoots([])
    setRoot(dir)
  }, [])
  openFolderPathRef.current = openFolderPath
  sshAttemptRef.current = sshAttempt

  // ---- Workspace folders: more than one project folder in the same window ----
  const extrasLoadedFor = useRef<string | null>(null)
  // Folders from a .code-workspace file, used instead of the remembered ones when its main folder opens.
  const pendingExtras = useRef<string[] | null>(null)
  useEffect(() => {
    extrasLoadedFor.current = null
    if (!root) return setExtraRoots([])
    let cancelled = false
    void (async () => {
      const saved = pendingExtras.current ?? loadExtraFolders(root)
      pendingExtras.current = null
      const alive: string[] = []
      for (const d of saved) if (await window.api.fsIsDir(d)) alive.push(d)
      if (cancelled) return
      setExtraRoots(alive)
      extrasLoadedFor.current = root
    })()
    return () => {
      cancelled = true
    }
  }, [root])
  useEffect(() => {
    if (root && extrasLoadedFor.current === root) saveExtraFolders(root, extraRoots)
    setGitExtraRoots(extraRoots)
    void refreshGit(root)
  }, [extraRoots, root])

  const addWorkspaceFolder = useCallback(async (): Promise<void> => {
    const dir = await window.api.openFolder()
    const r = rootRef.current
    if (!dir || !r) return
    if ([r, ...extraRootsRef.current].some((x) => samePath(x) === samePath(dir))) return void window.alert('That folder is already in the workspace.')
    extrasLoadedFor.current = r // a manual change counts as loaded
    setExtraRoots((cur) => [...cur, dir])
  }, [])
  const openWorkspaceFile = useCallback(async (): Promise<void> => {
    const r = await window.api.openWorkspaceFile()
    if (!r) return
    if ('error' in r) return void window.alert(r.error)
    const [main, ...rest] = r.folders
    if (rootRef.current && samePath(main) === samePath(rootRef.current)) {
      extrasLoadedFor.current = rootRef.current
      return setExtraRoots(rest)
    }
    pendingExtras.current = rest
    await openFolderPathRef.current(main)
    if (rootRef.current && samePath(rootRef.current) !== samePath(main)) pendingExtras.current = null // the user declined
  }, [])
  const saveWorkspaceFile = useCallback(async (): Promise<void> => {
    const r = rootRef.current
    if (!r) return void window.alert('Open a folder first.')
    const file = await window.api.saveWorkspaceFile([r, ...extraRootsRef.current])
    if (file) showToast(`Saved ${baseName(file)}`)
  }, [])
  const removeWorkspaceFolder = useCallback((dir: string): void => {
    setExtraRoots((cur) => cur.filter((x) => x !== dir))
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
    notifySaved(tab.model)
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
          releaseGhost(path) // a stand-in model made for a peek view gives way to the real one
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
    if (focusRef.current === 'split' && splitRef.current) {
      const p = target
      setSplit((sp) => (sp ? { ...sp, paths: sp.paths.includes(p) ? sp.paths : [...sp.paths, p], active: p } : sp))
      if (line) {
        pendingReveal.current = null
        setTimeout(() => {
          const ed = splitEditorRef.current
          if (!ed) return
          ed.revealLineInCenter(line)
          ed.setPosition({ lineNumber: line, column: 1 })
          ed.focus()
        }, 60)
      }
      return
    }
    setActive(target)
    revealPending() // works now if the file was already showing; otherwise the effect below does it
  }, [revealPending])
  openFileRef.current = openFile

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
    const tab = tabsRef.current.find((t) => t.path === focusedPath())
    if (!tab) return
    if (getSettings().formatOnSave) {
      try {
        await focusedEditor()?.getAction('editor.action.formatDocument')?.run() // only formats languages Monaco knows
      } catch {
        // A formatter that fails must not stop the save.
      }
    }
    await saveTab(tab)
  }, [saveTab])

  saveRef.current = save

  const saveAll = useCallback(async (): Promise<void> => {
    for (const t of tabsRef.current.filter((x) => x.dirty)) await saveTab(t)
  }, [saveTab])

  const getEditorContext = useCallback((): EditorContext | null => {
    const ed = focusedEditor()
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
      disposeModel(tab.model)
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
    const model = focusedEditor()?.getModel()
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
    focusedEditor()?.focus() // the file is now modified (not saved), so Ctrl+Z undoes it
  }

  const insertIntoEditor = useCallback((code: string): void => {
    const ed = focusedEditor()
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
    // The file belongs to whichever workspace folder contains it, and that folder's repository.
    const owner = model && model.uri.scheme === 'file' ? rootsRef.current.find((r) => relIfInside(r, model.uri.fsPath)) : undefined
    const rel = owner && model ? relIfInside(owner, model.uri.fsPath) : null
    if (!owner || !model || !rel || git.byRoot[owner]?.state !== 'ok') {
      gitDecorations.current.clear()
      return
    }
    let cancelled = false
    void window.api.gitLineChanges(owner, rel).then((res) => {
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
  }, [active, modelTick, root, roots, git.version, git.byRoot])

  // `repo` is the workspace folder whose repository the file belongs to.
  const openDiff = useCallback(async (f: GitFile, staged: boolean, repo: string): Promise<void> => {
    const r = await window.api.gitDiff(repo, f.rel, staged)
    if ('error' in r) return void window.alert(r.error)
    setDiffView({
      title: `${baseName(f.rel)} (${staged ? 'Staged Changes' : 'Working Tree'})`,
      path: f.abs,
      original: r.original,
      modified: r.modified
    })
  }, [])

  // A file as it was changed by one commit (opened from the History view).
  const openCommitDiff = useCallback(async (hash: string, short: string, file: CommitFile, repo: string): Promise<void> => {
    const r = await window.api.gitCommitDiff(repo, hash, file.rel, file.orig)
    setDiffView({
      title: `${baseName(file.rel)} (${short})`,
      path: joinPath(repo, file.rel),
      original: r.original,
      modified: r.modified
    })
  }, [])

  const [historyFor, setHistoryFor] = useState<{ abs: string; n: number } | null>(null)
  const showFileHistory = useCallback((abs: string): void => {
    if (!rootsRef.current.some((r) => relIfInside(r, abs))) return
    setSidebarView('git')
    setHistoryFor((cur) => ({ abs, n: (cur?.n ?? 0) + 1 }))
  }, [])

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
    if (tab) disposeModel(tab.model)
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
      disposeModel(t.model)
      diskText.current.delete(t.path)
    }
    const rest = tabsRef.current.filter((t) => !paths.includes(t.path))
    setTabs(rest)
    setActive((a) => (a && paths.includes(a) ? (rest.length ? rest[rest.length - 1].path : null) : a))
  }

  // ---- Split editor ----
  const openSplit = (path: string | null, dir: 'right' | 'down'): void => {
    const p = path ?? focusedPath()
    if (!p) return
    focusRef.current = 'split'
    setSplit((sp) => (sp ? { ...sp, dir, paths: sp.paths.includes(p) ? sp.paths : [...sp.paths, p], active: p } : { paths: [p], active: p, dir, size: 50 }))
  }
  const closeSplit = (): void => {
    focusRef.current = 'main'
    setSplit(null)
    editorRef.current?.focus()
  }
  const closeSplitTab = (path: string): void => {
    setSplit((sp) => {
      if (!sp) return sp
      const paths = sp.paths.filter((x) => x !== path)
      if (paths.length === 0) return null
      return { ...sp, paths, active: sp.active === path ? paths[paths.length - 1] : sp.active }
    })
  }
  const toggleSplit = (): void => (split ? closeSplit() : openSplit(null, 'right'))
  // Files closed in the main group disappear from the split group too; with none left the split closes.
  useEffect(() => {
    setSplit((sp) => {
      if (!sp) return sp
      const paths = sp.paths.filter((p) => tabs.some((t) => t.path === p))
      if (paths.length === sp.paths.length) return sp
      if (paths.length === 0) {
        focusRef.current = 'main'
        return null
      }
      return { ...sp, paths, active: sp.active && paths.includes(sp.active) ? sp.active : paths[paths.length - 1] }
    })
  }, [tabs])
  const startResizeSplit = (e: React.MouseEvent): void => {
    e.preventDefault()
    const box = groupsRef.current?.getBoundingClientRect()
    if (!box) return
    const down = splitRef.current?.dir === 'down'
    const onMove = (ev: MouseEvent): void => {
      const frac = down ? (ev.clientY - box.top) / box.height : (ev.clientX - box.left) / box.width
      const size = Math.min(85, Math.max(15, Math.round((1 - frac) * 100)))
      setSplit((sp) => (sp ? { ...sp, size } : sp))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
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

  // Keys on a tab: Left/Right/Home/End move to and open another tab, Enter or Space opens it, Delete closes it.
  const onTabKey = (e: React.KeyboardEvent, path: string): void => {
    const list = tabsRef.current
    const i = list.findIndex((t) => t.path === path)
    const to = (n: number): void => {
      const t = list[(n + list.length) % list.length]
      if (!t) return
      setActive(t.path)
      setDiffView(null)
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`.tabs [data-tab-path="${CSS.escape(t.path)}"]`)?.focus())
    }
    if (e.key === 'ArrowRight') (e.preventDefault(), to(i + 1))
    else if (e.key === 'ArrowLeft') (e.preventDefault(), to(i - 1))
    else if (e.key === 'Home') (e.preventDefault(), to(0))
    else if (e.key === 'End') (e.preventDefault(), to(list.length - 1))
    else if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), setActive(path), setDiffView(null))
    else if (e.key === 'Delete') (e.preventDefault(), closeTab(path))
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
    for (const f of Object.values(git.byRoot).flatMap((s) => s.files)) {
      const k = samePath(f.abs)
      const unmerged = f.index === 'U' || f.work === 'U' || (f.index === 'A' && f.work === 'A') || (f.index === 'D' && f.work === 'D')
      letters.set(k, unmerged ? '!' : f.index === '?' ? 'U' : f.work !== ' ' ? f.work : f.index)
      for (let d = k, i = d.lastIndexOf('/'); i > 0; i = d.lastIndexOf('/')) {
        d = d.slice(0, i)
        dirtyDirs.add(d)
      }
    }
    return { letters, dirtyDirs }
  }, [git.byRoot])

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
    disposeModel(tab.model)
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
      { label: 'Reveal in Side Bar', run: () => revealInExplorer(path) },
      { label: 'Split Right', run: () => openSplit(path, 'right'), separator: true },
      { label: 'Split Down', run: () => openSplit(path, 'down') },
      {
        label: 'Git: Open Merge Editor',
        run: () => {
          const p = focusedPath()
          if (p) void openMerge(p)
        }
      },
      { label: 'Git: File History', run: () => showFileHistory(path), separator: true, disabled: !rootsRef.current.some((x) => relIfInside(x, path) && git.byRoot[x]?.state === 'ok') }
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
  const actionsRef = useRef({ closeTab, reopenClosedTab, switchTab, saveAll, toggleSplit, closeSplitTab })
  actionsRef.current = { closeTab, reopenClosedTab, switchTab, saveAll, toggleSplit, closeSplitTab }

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
    void window.api.fsWatch(roots.length ? roots : null)
    if (!root) return
    const off = window.api.onFsChanged(() => void onWorkspaceTouched())
    return () => {
      off()
      void window.api.fsWatch(null)
    }
  }, [root, roots, onWorkspaceTouched])

  useEffect(() => {
    const model = tabs.find((t) => t.path === active)?.model ?? null
    editorRef.current?.setModel(model)
    editorRef.current?.updateOptions({ ariaLabel: model ? `Editor, ${baseName(model.uri.fsPath || model.uri.path)}` : 'Editor' })
    // Tell the Git margin effect that the editor now shows a different file (it runs before this effect does).
    if (shownModel.current !== model) {
      shownModel.current = model
      setModelTick((n) => n + 1)
    }
    revealPending()
  }, [active, tabs, revealPending])

  const openFileSearch = useCallback(async (): Promise<void> => {
    if (!root) return
    const folders = rootsRef.current
    const lists = await Promise.all(folders.map((r) => window.api.listFiles(r).catch(() => [] as string[])))
    setPickItems(
      lists.flatMap((files, i) =>
        files.map((f) => ({
          label: baseName(f),
          // With several folders the detail starts with the folder the file is in.
          detail: (folders.length > 1 ? baseName(folders[i]) + '/' : '') + f.slice(folders[i].length + 1),
          run: () => void openFile(f)
        }))
      )
    )
    setPickOpts({ initial: 0 })
    setPicker('files')
  }, [root, openFile])

  // Runs one of Monaco's own editor commands (format, go to line, fold...) on the open file.
  const runEditorAction =
    (id: string) =>
    (): void => {
      const ed = focusedEditor()
      if (!ed || !ed.getModel()) return
      // Wait for the palette to finish closing: Monaco's own boxes (go to line...) close when focus moves,
      // and closing the palette moves it.
      // Monaco's quick-input boxes need the editor to really hold focus, so retry briefly before running.
      let tries = 0
      const go = (): void => {
        ed.focus()
        if (!ed.hasTextFocus() && ++tries < 10) return void setTimeout(go, 40)
        // Some of Monaco's features (go to definition...) are commands, not actions: run those as commands.
        const action = ed.getAction(id)
        if (action) void action.run()
        else ed.trigger('menu', id, null)
      }
      setTimeout(go, 80)
    }

  // Asks what to attach to (a port, host:port, or "pid N" where the language allows it), then attaches.
  const askAttach = (language: 'node' | 'python' | 'go', title: string, placeholder: string, allowPid: boolean): void =>
    setInputRequest({
      title,
      placeholder,
      confirmLabel: 'Attach',
      validate: (v) => ((allowPid ? /^\s*(pid\s+\d+|\d{2,5}|[A-Za-z0-9.-]+:\d{2,5})\s*$/i : /^\s*(\d{2,5}|[A-Za-z0-9.-]+:\d{2,5})\s*$/).test(v) ? null : `Use a port like 5678, host:port${allowPid ? ', or "pid 12345"' : ''}.`),
      onSubmit: (v) => {
        const t = v.trim()
        const pid = /^pid\s+(\d+)$/i.exec(t)
        const hp = /^(?:([A-Za-z0-9.-]+):)?(\d+)$/.exec(t)
        showDebug()
        void attachDebugging(pid ? { language, pid: Number(pid[1]) } : { language, host: hp?.[1], port: Number(hp?.[2]) }).then((err) => err && showToast(err, 'error'))
      }
    })

  const buildCommands = (): PickItem[] => [
      { label: 'File: Open Folder', run: () => void openFolder() },
      { label: 'File: Save', run: () => void save() },
      { label: 'Agent: Run a Task in the Background…', run: () => showAgents() },
      { label: 'Extensions: Show Installed Extensions', run: () => { setShowSidebar(true); setSidebarView('ext') } },
      ...extensionCommands().map((c) => ({ label: c.ext + ': ' + c.title, run: () => void runExtCommand(c) })),
      { label: 'Notebook: Create New Notebook…', run: () => createNotebook() },
      {
        label: 'Notebook: Open as Notebook / as Text',
        run: () => {
          const p = focusedPath()
          if (p && /\.ipynb$/i.test(p)) setNbAsText((s) => (s.has(p) ? (s.delete(p), new Set(s)) : new Set(s).add(p)))
        }
      },
      { label: 'Tasks: Run Task…', run: () => void openTasksPicker() },
      { label: 'Tasks: Run Build Task', run: () => void openTasksPicker('build') },
      { label: 'Tasks: Run Test Task', run: () => void openTasksPicker('test') },
      { label: 'Tasks: Open Tasks File', run: () => void openConfigFile('tasks') },
      { label: 'Debug: Open Launch Configurations', run: () => void openConfigFile('launch') },
      { label: 'View: Focus Side Bar', run: () => focusRegion('explorer') },
      { label: 'View: Focus Editor', run: () => focusRegion('editor') },
      { label: 'View: Focus Terminal', run: () => focusRegion('terminal') },
      { label: 'View: Focus AI Panel', run: () => focusRegion('chat') },
      { label: 'Debug: Start Debugging (F5)', run: () => void startDebug() },
      {
        label: 'Debug: Install the Go Debugger (Delve)',
        run: () => newTerminal(undefined, { title: 'Install Delve', command: 'go install github.com/go-delve/delve/cmd/dlv@latest', cwd: rootRef.current })
      },
      {
        label: 'Debug: Install the Java Debugger (JDK)',
        run: () =>
          window.api.platform === 'win32'
            ? newTerminal(undefined, { title: 'Install a JDK', command: 'winget install EclipseAdoptium.Temurin.21.JDK', cwd: rootRef.current })
            : showToast(window.api.platform === 'darwin' ? 'Install a JDK with: brew install openjdk' : 'Install a JDK, for example: sudo apt install default-jdk', 'info')
      },
      {
        label: 'Debug: Install the C/C++ Debugger',
        run: () =>
          window.api.platform === 'win32'
            ? newTerminal(undefined, { title: 'Install the C/C++ debugger', command: 'winget install MartinStorsjo.LLVM-MinGW.UCRT', cwd: rootRef.current })
            : showToast(window.api.platform === 'darwin' ? 'Install lldb and clang with: xcode-select --install' : 'Install lldb and clang, for example: sudo apt install lldb clang', 'info')
      },
      {
        label: 'Debug: Install the C# Debugger (netcoredbg)',
        run: () => {
          showToast('Downloading netcoredbg from GitHub...', 'info')
          void window.api.dbgInstallCsharp().then((r) => showToast(r.ok ? (r.version === 'already installed' ? 'netcoredbg is already installed.' : `netcoredbg ${r.version} installed.`) : r.error, r.ok ? 'info' : 'error'))
        }
      },
      {
        label: 'Debug: Install the Python Debugger (debugpy)',
        run: () => newTerminal(undefined, { title: 'Install debugpy', command: 'python -m pip install --user debugpy', cwd: rootRef.current })
      },
      {
        label: 'Debug: Attach to Node.js Program…',
        run: () => askAttach('node', 'Attach to a running Node.js program: a port (9229, or host:port) or a process id with "pid "', '9229   or   pid 12345', true)
      },
      {
        label: 'Debug: Attach to Python Program…',
        run: () => askAttach('python', 'Attach to a Python program started with: python -m debugpy --listen 5678 script.py. Give its port (or host:port)', '5678   or   host:5678', false)
      },
      {
        label: 'Debug: Attach to Go Process…',
        run: () => askAttach('go', 'Attach to a running Go program: "pid 12345", or the port (or host:port) of a Delve server (dlv attach --headless --listen=:2345)', 'pid 12345   or   2345', true)
      },
      { label: 'Debug: Stop (Shift+F5)', run: () => void stopDebugging() },
      { label: 'Debug: Toggle Breakpoint (F9)', run: () => toggleBreakpointAtCaret(focusedEditor()) },
      { label: 'Debug: Step Over (F10)', run: () => void stepDebug('stepOver') },
      { label: 'Debug: Step Into (F11)', run: () => void stepDebug('stepInto') },
      { label: 'Debug: Step Out (Shift+F11)', run: () => void stepDebug('stepOut') },
      { label: 'Debug: Remove All Breakpoints', run: () => clearAllBreakpoints() },
      { label: 'Debug: Show Run and Debug', run: () => showDebug() },
      { label: 'File: Add Folder to Workspace…', run: () => void addWorkspaceFolder() },
      { label: 'File: Open Workspace from File…', run: () => void openWorkspaceFile() },
      { label: 'File: Save Workspace As…', run: () => void saveWorkspaceFile() },
      {
        label: 'File: Remove Folder from Workspace…',
        run: () => {
          const extra = extraRootsRef.current
          if (extra.length === 0) return void window.alert('The workspace has only one folder.')
          setPickItems(extra.map((d) => ({ label: baseName(d), detail: d, run: () => removeWorkspaceFolder(d) })))
          setPickOpts({ initial: 0 })
          setPicker('commands')
        }
      },
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
      { label: 'View: Split Editor Right (Ctrl+\\)', run: () => openSplit(null, 'right') },
      { label: 'View: Split Editor Down', run: () => openSplit(null, 'down') },
      { label: 'View: Close Split Editor', run: () => closeSplit() },
      { label: 'AI: Toggle Next Edit Suggestions', run: () => updateSettings({ nextEdit: !getSettings().nextEdit }) },
      { label: 'View: Toggle Word Wrap', run: () => updateSettings({ wordWrap: !getSettings().wordWrap }) },
      { label: 'View: Show Problems', run: openProblemsPicker },
      { label: 'Editor: Format Document', run: runEditorAction('editor.action.formatDocument') },
      { label: 'Editor: Go to Line…  (Ctrl+G)', run: runEditorAction('editor.action.gotoLine') },
      { label: 'Editor: Go to Symbol in File…', run: runEditorAction('editor.action.quickOutline') },
      { label: 'Editor: Find  (Ctrl+F)', run: runEditorAction('actions.find') },
      { label: 'Editor: Replace  (Ctrl+H)', run: runEditorAction('editor.action.startFindReplaceAction') },
      { label: 'Editor: Toggle Line Comment', run: runEditorAction('editor.action.commentLine') },
      { label: 'Editor: Fold All', run: runEditorAction('editor.foldAll') },
      { label: 'Editor: Unfold All', run: runEditorAction('editor.unfoldAll') },
      { label: 'Editor: Sort Lines Ascending', run: runEditorAction('editor.action.sortLinesAscending') },
      { label: 'Developer: Toggle Developer Tools', run: () => void window.api.toggleDevTools() },
      { label: 'File: Go to File...', run: () => void openFileSearch() },
      { label: 'File: New File…', run: () => rootRef.current && createEntry(selected ? (selected.isDir ? selected.path : parentOf(selected.path)) : rootRef.current, 'file') },
      { label: 'File: New Folder…', run: () => rootRef.current && createEntry(selected ? (selected.isDir ? selected.path : parentOf(selected.path)) : rootRef.current, 'folder') },
      { label: 'Search: Find in Files (Ctrl+Shift+F)', run: showSearch },
      { label: 'View: Toggle Terminal', run: toggleTerminal },
      { label: 'View: Show Output', run: () => showPanelTab('output') },
      { label: 'Language Servers: Restart', run: () => void restartLanguageServers() },
      { label: 'View: Show Debug Console', run: () => showPanelTab('debug') },
      { label: 'Terminal: New Terminal (Ctrl+Shift+`)', run: () => newTerminal() },
      {
        label: 'Terminal: New SSH Terminal…',
        run: () =>
          setInputRequest({
            title: 'SSH address: user@host, or a name from your ~/.ssh/config',
            placeholder: 'me@example.com',
            confirmLabel: 'Connect',
            validate: (v) => (validSshTarget(v.trim()) ? null : 'Use a host name, an address, user@host or a name from your ssh config.'),
            onSubmit: (v) => newTerminal('ssh:' + v.trim())
          })
      },
      {
        label: 'Git: Open Merge Editor',
        run: () => {
          const p = focusedPath()
          if (p) void openMerge(p)
        }
      },
      { label: 'Account: Sign In or Account Details…', run: () => setShowAccount(true) },
      {
        label: 'File: Open Folder over SSH…',
        run: () => openSshFolderPicker()
      },
      {
        label: 'File: Open WSL Folder…',
        run: () => void openWslFolderPicker()
      },
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
      {
        label: 'Git: File History',
        run: () => {
          const p = activeRef.current
          if (p) showFileHistory(p)
        }
      },
      {
        label: 'Git: Stash Changes',
        run: () => {
          const r = rootRef.current
          if (r)
            void window.api.gitStashPush(r, '', true).then((res) => {
              if (!res.ok) window.alert(res.error)
              else void onWorkspaceTouched()
              void refreshGit(r)
            })
        }
      },
      { label: 'Git: Checkout to…', run: () => void openBranchPicker() },
      { label: 'Git: Pull', run: () => void window.api.gitRemote(rootRef.current ?? '', 'pull').then((r) => (r.ok ? refreshGit(rootRef.current) : window.alert(r.error))) },
      { label: 'Git: Push', run: () => void window.api.gitRemote(rootRef.current ?? '', 'push').then((r) => (r.ok ? refreshGit(rootRef.current) : window.alert(r.error))) },
      { label: 'Preferences: Color Theme', run: openThemePicker },
      { label: 'Preferences: Open Settings (Ctrl+,)', run: () => setShowSettings(true) }
  ]
  const openPalette = useCallback((): void => {
    setPickItems(buildCommands())
    setPickOpts({ initial: 0 })
    setPicker('commands')
  }, [buildCommands])

  // ---- The menu bar: every entry runs a command that is also in the palette, or a Monaco editor action ----
  const cmd = (prefix: string) => (): void => void buildCommands().find((c) => c.label.startsWith(prefix))?.run()
  const act = (id: string) => runEditorAction(id)
  const selectAllInEditor = (): void => {
    const ed = focusedEditor()
    const model = ed?.getModel()
    if (!ed || !model) return
    ed.focus()
    ed.setSelection(model.getFullModelRange())
  }
  // Cut, copy and paste go through the system clipboard directly, so they do not depend on the browser's own permission rules.
  const clipboardAction = (kind: 'cut' | 'copy' | 'paste') => (): void => {
    const ed = focusedEditor()
    const model = ed?.getModel()
    if (!ed || !model) return
    ed.focus()
    const sel = ed.getSelection()
    if (!sel) return
    if (kind === 'paste') {
      void window.api.readText().then((text) => {
        if (!text) return
        ed.pushUndoStop()
        ed.executeEdits('menu', [{ range: sel, text, forceMoveMarkers: true }])
        ed.pushUndoStop()
      })
      return
    }
    // With nothing selected, the whole line is used, as in VS Code.
    const range = sel.isEmpty() ? { startLineNumber: sel.startLineNumber, startColumn: 1, endLineNumber: sel.startLineNumber + 1, endColumn: 1 } : sel
    const text = model.getValueInRange(range)
    void window.api.copyText(text)
    if (kind === 'cut') {
      ed.pushUndoStop()
      ed.executeEdits('menu', [{ range, text: '', forceMoveMarkers: true }])
      ed.pushUndoStop()
    }
  }
  // Undo and redo are Monaco commands, not actions, so they are sent to the editor as commands.
  const editorCommand = (id: string) => (): void => {
    const ed = focusedEditor()
    if (!ed || !ed.getModel()) return
    ed.focus()
    ed.trigger('menu', id, null)
  }
  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New File…', run: cmd('File: New File…') },
        { label: 'New Folder…', run: cmd('File: New Folder…') },
        { label: 'Open Folder…', run: () => void openFolder(), separator: true },
        { label: 'Open Recent…', run: cmd('File: Open Recent…') },
        { label: 'Open Workspace from File…', run: () => void openWorkspaceFile() },
        { label: 'Add Folder to Workspace…', run: () => void addWorkspaceFolder() },
        { label: 'Save Workspace As…', run: () => void saveWorkspaceFile() },
        { label: 'Open Folder over SSH…', run: () => openSshFolderPicker(), separator: true },
        { label: 'Open WSL Folder…', run: cmd('File: Open WSL Folder…') },
        { label: 'Save', shortcut: 'Ctrl+S', run: () => void save(), separator: true },
        { label: 'Save All', shortcut: 'Ctrl+Alt+S', run: () => void saveAll() },
        { label: 'Close Editor', shortcut: 'Ctrl+W', run: cmd('File: Close Editor'), separator: true },
        { label: 'Reopen Closed Editor', shortcut: 'Ctrl+Shift+T', run: reopenClosedTab },
        { label: 'Settings', shortcut: 'Ctrl+,', run: () => setShowSettings(true), separator: true },
        { label: 'Color Theme', run: openThemePicker },
        { label: 'Exit', run: () => window.close(), separator: true }
      ]
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', run: editorCommand('undo') },
        { label: 'Redo', shortcut: 'Ctrl+Y', run: editorCommand('redo') },
        { label: 'Cut', shortcut: 'Ctrl+X', run: clipboardAction('cut'), separator: true },
        { label: 'Copy', shortcut: 'Ctrl+C', run: clipboardAction('copy') },
        { label: 'Paste', shortcut: 'Ctrl+V', run: clipboardAction('paste') },
        { label: 'Find', shortcut: 'Ctrl+F', run: act('actions.find'), separator: true },
        { label: 'Replace', shortcut: 'Ctrl+H', run: act('editor.action.startFindReplaceAction') },
        { label: 'Find in Files', shortcut: 'Ctrl+Shift+F', run: showSearch },
        { label: 'Toggle Line Comment', shortcut: 'Ctrl+/', run: act('editor.action.commentLine'), separator: true },
        { label: 'Toggle Block Comment', shortcut: 'Shift+Alt+A', run: act('editor.action.blockComment') },
        { label: 'Format Document', shortcut: 'Shift+Alt+F', run: act('editor.action.formatDocument') },
        { label: 'Edit Selection with AI', shortcut: 'Ctrl+K', run: () => startInlineRef.current(), separator: true }
      ]
    },
    {
      label: 'Selection',
      items: [
        { label: 'Select All', shortcut: 'Ctrl+A', run: selectAllInEditor },
        { label: 'Expand Selection', shortcut: 'Shift+Alt+Right', run: act('editor.action.smartSelect.expand') },
        { label: 'Shrink Selection', shortcut: 'Shift+Alt+Left', run: act('editor.action.smartSelect.shrink') },
        { label: 'Copy Line Up', shortcut: 'Shift+Alt+Up', run: act('editor.action.copyLinesUpAction'), separator: true },
        { label: 'Copy Line Down', shortcut: 'Shift+Alt+Down', run: act('editor.action.copyLinesDownAction') },
        { label: 'Move Line Up', shortcut: 'Alt+Up', run: act('editor.action.moveLinesUpAction') },
        { label: 'Move Line Down', shortcut: 'Alt+Down', run: act('editor.action.moveLinesDownAction') },
        { label: 'Add Cursor Above', shortcut: 'Ctrl+Alt+Up', run: act('editor.action.insertCursorAbove'), separator: true },
        { label: 'Add Cursor Below', shortcut: 'Ctrl+Alt+Down', run: act('editor.action.insertCursorBelow') },
        { label: 'Add Next Occurrence', shortcut: 'Ctrl+D', run: act('editor.action.addSelectionToNextFindMatch') },
        { label: 'Select All Occurrences', shortcut: 'Ctrl+Shift+L', run: act('editor.action.selectHighlights') }
      ]
    },
    {
      label: 'View',
      items: [
        { label: 'Command Palette…', shortcut: 'Ctrl+Shift+P', run: openPalette },
        { label: 'Explorer', run: () => { setShowSidebar(true); setSidebarView('files') }, separator: true },
        { label: 'Search', shortcut: 'Ctrl+Shift+F', run: showSearch },
        { label: 'Source Control', shortcut: 'Ctrl+Shift+G', run: () => { setShowSidebar(true); setSidebarView('git') } },
        { label: 'Run and Debug', run: () => showDebug() },
        { label: 'Extensions', run: () => { setShowSidebar(true); setSidebarView('ext') } },
        { label: 'Agents', run: () => showAgents() },
        { label: 'AI Chat', shortcut: 'Ctrl+L', run: () => setShowChat((v) => !v), checked: showChat, separator: true },
        { label: 'Terminal', shortcut: 'Ctrl+`', run: toggleTerminal, checked: showTerminal && panelTab === 'terminal' },
        { label: 'Problems', run: () => showPanelTab('problems'), checked: showTerminal && panelTab === 'problems' },
        { label: 'Output', run: () => showPanelTab('output'), checked: showTerminal && panelTab === 'output' },
        { label: 'Debug Console', run: () => showPanelTab('debug'), checked: showTerminal && panelTab === 'debug' },
        { label: 'Toggle Sidebar', shortcut: 'Ctrl+B', run: () => setShowSidebar((v) => !v), checked: showSidebar, separator: true },
        { label: 'Toggle Word Wrap', run: () => updateSettings({ wordWrap: !getSettings().wordWrap }), checked: getSettings().wordWrap },
        { label: 'Split Editor Right', shortcut: 'Ctrl+\\', run: () => openSplit(null, 'right'), separator: true },
        { label: 'Split Editor Down', run: () => openSplit(null, 'down') },
        { label: 'Close Split Editor', run: () => closeSplit() },
        { label: 'Zoom In', shortcut: 'Ctrl+=', run: () => updateSettings({ uiZoom: getSettings().uiZoom + 0.1 }), separator: true },
        { label: 'Zoom Out', shortcut: 'Ctrl+-', run: () => updateSettings({ uiZoom: getSettings().uiZoom - 0.1 }) },
        { label: 'Reset Zoom', shortcut: 'Ctrl+0', run: () => updateSettings({ uiZoom: 1 }) }
      ]
    },
    {
      label: 'Go',
      items: [
        { label: 'Go to File…', shortcut: 'Ctrl+P', run: () => void openFileSearch() },
        { label: 'Go to Symbol in File…', shortcut: 'Ctrl+Shift+O', run: act('editor.action.quickOutline') },
        { label: 'Go to Line…', shortcut: 'Ctrl+G', run: act('editor.action.gotoLine') },
        { label: 'Go to Definition', shortcut: 'F12', run: act('editor.action.revealDefinition'), separator: true },
        { label: 'Go to References', shortcut: 'Shift+F12', run: act('editor.action.goToReferences') },
        { label: 'Next Problem', shortcut: 'F8', run: act('editor.action.marker.next'), separator: true },
        { label: 'Previous Problem', shortcut: 'Shift+F8', run: act('editor.action.marker.prev') },
        { label: 'Reveal Active File in Explorer', run: () => activeRef.current && revealInExplorer(activeRef.current), separator: true }
      ]
    },
    {
      label: 'Run',
      items: [
        { label: 'Start Debugging', shortcut: 'F5', run: () => void startDebug() },
        { label: 'Stop Debugging', shortcut: 'Shift+F5', run: () => void stopDebugging() },
        { label: 'Step Over', shortcut: 'F10', run: () => void stepDebug('stepOver'), separator: true },
        { label: 'Step Into', shortcut: 'F11', run: () => void stepDebug('stepInto') },
        { label: 'Step Out', shortcut: 'Shift+F11', run: () => void stepDebug('stepOut') },
        { label: 'Toggle Breakpoint', shortcut: 'F9', run: () => toggleBreakpointAtCaret(focusedEditor()), separator: true },
        { label: 'Remove All Breakpoints', run: () => clearAllBreakpoints() },
        { label: 'Attach to Node.js Program…', run: cmd('Debug: Attach to Node.js Program'), separator: true },
        { label: 'Attach to Python Program…', run: cmd('Debug: Attach to Python Program') },
        { label: 'Attach to Go Process…', run: cmd('Debug: Attach to Go Process') },
        { label: 'Open Launch Configurations', run: () => void openConfigFile('launch') }
      ]
    },
    {
      label: 'Terminal',
      items: [
        { label: 'New Terminal', shortcut: 'Ctrl+Shift+`', run: () => newTerminal() },
        { label: 'New SSH Terminal…', run: cmd('Terminal: New SSH Terminal') },
        { label: 'Run Task…', run: () => void openTasksPicker(), separator: true },
        { label: 'Run Build Task', run: () => void openTasksPicker('build') },
        { label: 'Run Test Task', run: () => void openTasksPicker('test') },
        { label: 'Open Tasks File', run: () => void openConfigFile('tasks') },
        { label: 'Toggle Terminal', shortcut: 'Ctrl+`', run: toggleTerminal, checked: showTerminal && panelTab === 'terminal', separator: true }
      ]
    },
    {
      label: 'Help',
      items: [
        { label: 'Show All Commands', shortcut: 'Ctrl+Shift+P', run: openPalette },
        { label: 'Project Rules (AGENTS.md)', run: cmd('AI: Create or Open Project Rules') },
        { label: 'Account…', run: () => setShowAccount(true) },
        { label: 'Toggle Developer Tools', run: () => void window.api.toggleDevTools(), separator: true },
        { label: 'About My AI IDE', run: () => window.alert('My AI IDE\nA code editor with Claude built in.\nElectron + React + Monaco.'), separator: true }
      ]
    }
  ]


  // Debugger keys: F5 start / continue, Shift+F5 stop, F9 breakpoint, F10 / F11 / Shift+F11 step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const paused = getDebug().status === 'paused'
      if (e.key === 'F6') {
        e.preventDefault()
        cycleRegionRef.current(e.shiftKey ? -1 : 1)
        return
      }
      if (e.key === 'F5' && e.shiftKey) {
        e.preventDefault()
        void stopDebugging()
      } else if (e.key === 'F5') {
        e.preventDefault()
        if (debugActive()) void stepDebug('continue')
        else void startDebug()
      } else if (e.key === 'F9') {
        e.preventDefault()
        toggleBreakpointAtCaret(focusedEditor())
      } else if (e.key === 'F10' && paused) {
        e.preventDefault()
        void stepDebug('stepOver')
      } else if (e.key === 'F11' && paused) {
        e.preventDefault()
        void stepDebug(e.shiftKey ? 'stepOut' : 'stepInto')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startDebug])

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
      } else if (k === 'w' && !e.shiftKey && getActiveWebview()) {
        e.preventDefault()
        closeWebview(getActiveWebview() as string)
      } else if (k === 'w' && !e.shiftKey) {
        e.preventDefault()
        if (focusRef.current === 'split' && splitRef.current?.active) a.closeSplitTab(splitRef.current.active)
        else if (activeRef.current) a.closeTab(activeRef.current)
      } else if (e.key === '\\') {
        e.preventDefault()
        a.toggleSplit()
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
        setShowSidebar(true)
        setSidebarView('git')
      } else if (k === 'e' && e.shiftKey) {
        e.preventDefault()
        setShowSidebar(true)
        setSidebarView('files')
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
        toggleTerminal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, openPalette, openFileSearch, showSearch, newTerminal, toggleTerminal])

  return (
    <div className="app">
      <MenuBar menus={menus} title={windowTitle} />
      <div className="workbench">
      <nav className="activitybar" aria-label="Activity bar">
        <div className="sidebar-views" role="tablist" aria-label="Side bar views" aria-orientation="vertical">
          {(
            [
              { id: 'files', label: 'Explorer', key: 'Ctrl+Shift+E', icon: Icons.files, go: () => { setShowSidebar(true); setSidebarView('files') } },
              { id: 'search', label: 'Search', key: 'Ctrl+Shift+F', icon: Icons.search, go: showSearch },
              { id: 'git', label: 'Source Control', key: 'Ctrl+Shift+G', icon: Icons.git, go: () => { setShowSidebar(true); setSidebarView('git') } },
              { id: 'debug', label: 'Run', key: 'F5', icon: Icons.debug, go: showDebug },
              { id: 'ext', label: 'Extensions', key: '', icon: Icons.ext, go: () => { setShowSidebar(true); setSidebarView('ext') } },
              { id: 'agents', label: 'Agents', key: '', icon: Icons.agents, go: showAgents },
              ...extContainers.map((c) => ({ id: 'xc:' + c.id, label: c.title, key: '', icon: Icons.views, go: () => { setShowSidebar(true); setSidebarView('xc:' + c.id) } }))
            ] as { id: string; label: string; key: string; icon: JSX.Element; go: () => void }[]
          ).map((v) => {
            const count = v.id === 'git' ? (git.status.state === 'ok' ? changeCount(git.status) : 0) : v.id === 'agents' ? bgAttention : 0
            const on = sidebarView === v.id && showSidebar
            return (
              <button
                key={v.id}
                role="tab"
                aria-selected={sidebarView === v.id}
                className={'activity-btn' + (on ? ' on' : '')}
                data-view={v.id}
                title={v.label + (v.key ? ` (${v.key})` : '')}
                onClick={v.go}
              >
                {v.icon}
                <span className="sr-only">{v.label}</span>
                {count > 0 && <span className="badge" data-bg-badge={v.id === 'agents' ? '' : undefined}>{count}</span>}
              </button>
            )
          })}
        </div>
        <div className="activity-bottom">
          <button className="activity-btn" title="Account" aria-label="Account" onClick={() => setShowAccount(true)}>
            {Icons.account}
          </button>
          <button className="activity-btn" title="Settings (Ctrl+,)" aria-label="Settings" onClick={() => setShowSettings(true)}>
            {Icons.settings}
          </button>
        </div>
      </nav>
      <aside className={'sidebar' + (showSidebar ? '' : ' hidden')} aria-label="Side bar">
        <div className="sidebar-header">
          <span className="sidebar-title">
            {({ files: 'Explorer', search: 'Search', git: 'Source Control', debug: 'Run and Debug', ext: 'Extensions', agents: 'Agents' } as Record<string, string>)[sidebarView] ?? extContainers.find((c) => 'xc:' + c.id === sidebarView)?.title ?? ''}
          </span>
          <button className="ghost icon-btn" title="Open Folder…" aria-label="Open Folder" onClick={openFolder}>
            {Icons.folder}
          </button>
        </div>
        <div className="explorer" style={{ display: sidebarView === 'files' ? 'flex' : 'none' }}>
        <OpenEditors
          tabs={tabs}
          active={active}
          onActivate={(p) => {
            setActive(p)
            setDiffView(null)
          }}
          onClose={closeTab}
          onSaveAll={() => void saveAll()}
          onCloseAll={() => closeMany(tabsRef.current.map((t) => t.path))}
        />
        <div
          className="tree"
          role="tree"
          aria-label="Files"
          onKeyDown={treeKeyDown}
          onContextMenu={(e) => {
            if (!root) return
            e.preventDefault()
            setTreeMenu({ x: e.clientX, y: e.clientY, entry: null }) // empty space: the menu for the project folder
          }}
        >
          {root ? (
            <>
              {roots.map((r, i) => (
                <div key={r} data-workspace-folder={r}>
                  <div className="tree-root" title={r}>
                    <span>{baseName(r)}</span>
                    {i > 0 && (
                      <button className="tree-root-x" data-remove-folder title="Remove this folder from the workspace" onClick={() => removeWorkspaceFolder(r)}>
                        ×
                      </button>
                    )}
                  </div>
                  <FileTree
                    root={r}
                    version={treeVersion}
                    selected={selected?.path ?? null}
                    reveal={reveal}
                    git={gitInfo}
                    onOpen={openFile}
                    onSelect={setSelected}
                    onMenu={(entry, x, y) => setTreeMenu({ x, y, entry })}
                  />
                </div>
              ))}
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
        {root && (
          <>
            <Outline model={tabs.find((t) => t.path === active)?.model ?? null} onReveal={(line) => active && void openFile(active, line)} />
            {extViews.filter((v) => !customContainerIds.has(v.container) && v.container !== 'scm' && v.container !== 'debug').map(renderExtView)}
            <Timeline roots={roots} file={active} refreshKey={`${git.status.branch ?? ''}:${git.status.state === 'ok' ? changeCount(git.status) : 0}:${git.status.ahead ?? 0}`} onOpen={showFileHistory} />
          </>
        )}
        </div>
        {/* Kept mounted so results survive switching back to the explorer. */}
        <div className="tree" style={{ display: sidebarView === 'search' ? 'block' : 'none' }}>
          <SearchPanel
            roots={roots}
            focusSignal={searchFocus}
            onOpen={(p, l) => void openFile(p, l)}
            isDirty={(abs) => tabsRef.current.some((t) => t.dirty && samePath(t.path) === samePath(abs))}
            onReplaced={() => void onWorkspaceTouched()}
          />
        </div>
        {extContainers.map((c) => (
          <div key={c.id} className="tree" style={{ display: sidebarView === 'xc:' + c.id ? 'block' : 'none' }} data-ext-container={c.id}>
            {extViews.filter((v) => v.container === c.id).map(renderExtView)}
          </div>
        ))}
        <div className="tree" style={{ display: sidebarView === 'ext' ? 'block' : 'none' }}>
          <ExtensionsPanel />
        </div>
        <div className="tree" style={{ display: sidebarView === 'debug' ? 'block' : 'none' }}>
          <DebugPanel
            root={root}
            activeFile={isRunnable(focusedPath()) ? focusedPath() : null}
            onStart={startDebug}
            configs={tasksInfo?.launch ?? []}
            selected={launchSel}
            onSelect={setLaunchSel}
            onEditConfigs={() => void openConfigFile('launch')}
            problems={tasksInfo?.errors ?? []}
            onOpenFile={(p, line) => void openFile(p, line)}
          />
          {extViews.filter((v) => v.container === 'debug').map(renderExtView)}
        </div>
        <div className="tree" style={{ display: sidebarView === 'agents' ? 'block' : 'none' }}>
          <BackgroundPanel
            root={root}
            focusSignal={bgFocus}
            prefill={bgPrefill}
            onOpenDiff={(title, abs, original, modified) => setDiffView({ title, path: abs, original, modified })}
            onApplied={() => void onWorkspaceTouched()}
          />
        </div>
        <div className="tree" style={{ display: sidebarView === 'git' ? 'block' : 'none' }}>
          <GitPanel
            root={root}
            roots={roots}
            onOpenDiff={(f, staged, repo) => void openDiff(f, staged, repo)}
            onOpenFile={(abs) => void openFile(abs)}
            onChanged={() => void onWorkspaceTouched()}
            onOpenCommitDiff={(h, sh, file, repo) => void openCommitDiff(h, sh, file, repo)}
            onOpenMerge={(abs, repo) => void openMerge(abs, repo)}
            historyFor={historyFor}
          />
          {extViews.filter((v) => v.container === 'scm').map(renderExtView)}
        </div>
      </aside>
      <main className="main" aria-label="Editor">
        <div ref={groupsRef} className={'groups' + (split?.dir === 'down' ? ' down' : '')}>
        <div
          className="group group-main"
          style={split ? { flex: `0 0 ${100 - split.size}%` } : undefined}
          onMouseDownCapture={() => {
            focusRef.current = 'main'
          }}
        >
        <div className="tabs" role="tablist" aria-label="Open files">
          {tabs.map((t) => (
            <div
              key={t.path}
              className={'tab' + (t.path === active ? ' active' : '')}
              data-tab-path={t.path}
              title={t.path}
              role="tab"
              aria-selected={t.path === active}
              tabIndex={t.path === active ? 0 : -1}
              onKeyDown={(e) => onTabKey(e, t.path)}
              onClick={() => {
                setActive(t.path)
                setDiffView(null)
                setActiveWebview(null)
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
              {t.dirty && <span className="tab-dot" title="Unsaved changes" role="img" aria-label="unsaved changes" />}
              <span
                className="close"
                role="button"
                aria-label={`Close ${baseName(t.path)}`}
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
        {webviewPanels.some((w) => !w.view) && (
          <div className="tabs webview-tabs" role="tablist" aria-label="Extension pages">
            {webviewPanels.filter((w) => !w.view).map((w) => (
              <div
                key={w.id}
                className={'tab webview-tab' + (w.id === activeWebview ? ' active' : '')}
                data-webview-tab={w.id}
                title={w.title}
                role="tab"
                aria-selected={w.id === activeWebview}
                tabIndex={0}
                onClick={() => setActiveWebview(w.id)}
                onKeyDown={(e) => e.key === 'Enter' && setActiveWebview(w.id)}
                onAuxClick={(e) => e.button === 1 && closeWebview(w.id)}
              >
                <span className="tab-name">{w.title}</span>
                <span className="close" role="button" aria-label={`Close ${w.title}`} title="Close" onClick={(e) => { e.stopPropagation(); closeWebview(w.id) }}>
                  ×
                </span>
              </div>
            ))}
          </div>
        )}
        {active && tabs.length > 0 && <Breadcrumbs root={roots.find((r) => relIfInside(r, active)) ?? root} path={active} onReveal={revealInExplorer} />}
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
          {active && /\.ipynb$/i.test(active) && !nbAsText.has(active) && tabs.find((t) => t.path === active) && !diffView && !mergeView && (
            <NotebookView
              key={active}
              path={active}
              model={tabs.find((t) => t.path === active)!.model}
              onOpenAsText={() => setNbAsText((s) => new Set(s).add(active))}
            />
          )}
          {webviewPanels.some((w) => !w.view) && (
            <div className={'webview-host' + (activeWebview ? ' on' : '')} style={{ visibility: activeWebview ? 'visible' : 'hidden' }}>
              {webviewPanels.filter((w) => !w.view).map((w) => (
                <WebviewFrame key={w.id} panel={w} visible={w.id === activeWebview} />
              ))}
            </div>
          )}
          {mergeView && <MergeView path={mergeView.path} text={mergeView.text} onComplete={(t) => void completeMerge(t)} onClose={() => setMergeView(null)} />}
          {diffView && (
            <DiffView
              data={diffView}
              onOpenFile={() => void openFile(diffView.path)}
              onClose={() => setDiffView(null)}
            />
          )}
        </div>
        </div>
        {split && (
          <>
            <div className="split-handle" data-split-handle onMouseDown={startResizeSplit} />
            <SplitPane
              tabs={tabs}
              paths={split.paths}
              active={split.active}
              onActivate={(p) => {
                focusRef.current = 'split'
                setSplit((sp) => (sp ? { ...sp, active: p } : sp))
              }}
              onCloseTab={closeSplitTab}
              onClose={closeSplit}
              onFocus={() => {
                focusRef.current = 'split'
              }}
              onEditor={(ed) => {
                splitEditorRef.current = ed
              }}
              onCursor={setCursor}
              onStartInline={() => startInlineRef.current()}
            />
          </>
        )}
        </div>
        {terminalOpened && (
          <TerminalPanel
            cwd={root}
            visible={showTerminal}
            newTabSignal={newTermSignal}
            newTabShell={newTermShell}
            newTabExtra={newTermExtra}
            onEmpty={terminalEmpty}
            onHide={hideTerminal}
            panelTab={panelTab}
            onPanelTab={showPanelTab}
            problemCount={problems.errors + problems.warnings}
          >
            {panelTab === 'problems' && <ProblemsView onOpen={(f, l) => void openFile(f, l)} />}
            {panelTab === 'output' && <OutputView />}
            {panelTab === 'debug' && <DebugConsoleView />}
          </TerminalPanel>
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
          onRunInBackground={runInBackground}
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
      <LiveRegions />
      <footer className="statusbar" aria-label="Status bar">
        <span className="sb-item" title={root ?? 'No folder open'}>
          {root ? baseName(root) : 'No folder'}
        </span>
        {root && /^\\\\ssh\./i.test(root) && (
          <span className="sb-item" data-sb="ssh" title="This folder is on another computer, opened over SSH">
            ⇄ SSH: {root.split('\\')[2]?.slice(4)}
          </span>
        )}
        {!auth.direct && auth.loaded && (
          <button
            className="sb-item sb-btn"
            data-sb="account"
            title={auth.state.state === 'signed-in' ? 'Your account and plan' : 'Sign in to use the AI features'}
            onClick={() => setShowAccount(true)}
          >
            {auth.state.state === 'signed-in' ? '● ' + (planSummary(auth.state.me) || 'Signed in') : auth.state.state === 'signing-in' ? 'Signing in…' : '○ Sign in'}
          </button>
        )}
        {Object.entries(extStatus).map(([id, it]) => (
          <button key={id} className="sb-item sb-btn" data-sb-ext={id} title={it.tooltip || it.text} disabled={!it.command} onClick={() => it.command && void window.api.extRun(it.extId, it.command)}>
            {it.text}
          </button>
        ))}
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
        {lspServers.length > 0 && (
          <span className="sb-item" data-sb="lsp" title={lspServers.map((s) => `${s.label}: ${s.root}`).join('\n')}>
            {lspServers.map((s) => s.label.replace(/ \(.*\)$/, '')).join(', ')}
          </span>
        )}
        <button
          className="sb-item sb-btn"
          data-sb="problems"
          title="Errors and warnings in open files"
          onClick={() => showPanelTab('problems')}
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
      {showAccount && <AccountDialog onClose={() => setShowAccount(false)} />}
      {applying && <div className="apply-toast" data-apply-busy>Claude is applying the change…</div>}
      {choice && (
        <ChoiceDialog
          text={choice.text}
          kind={choice.kind}
          choices={choice.choices}
          onChoose={(c) => {
            const done = choice.resolve
            setChoice(null)
            done(c)
          }}
        />
      )}
      {toast && (
        <div className={'apply-toast ext-toast' + (toast.kind === 'error' ? ' error' : '')} data-toast role="presentation" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
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
