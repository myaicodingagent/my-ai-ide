# My AI IDE

A desktop code editor with Claude built in, for Windows. Electron + React + Monaco (the editor core of VS Code).

## Install

Run `release\My-AI-IDE-Setup-<version>.exe` (build it first, see below). The installer is unsigned, so Windows
SmartScreen shows "unknown publisher": choose *More info → Run anyway*.

On first use, click **Sign in** (status bar, or the chat panel). Your browser opens on the website; confirm the short code shown
in the app, and the app is signed in. Your plan and today's allowance appear in the status bar; click it for the account
(sign out, service address). The sign-in token is encrypted with Windows (Electron `safeStorage`) and kept only on your PC.
All model calls go through our service, which applies your plan and limits; the app never holds a model key.

**Development:** with `ANTHROPIC_API_KEY` set (or `MY_AI_IDE_DIRECT=1`) the app skips the account and talks to the provider
with that key, which is what the end-to-end tests use. `MY_AI_IDE_BACKEND_URL` points the app at another service (the default is
`DEFAULT_BACKEND_URL` in `src/main/backend.ts`: change it before building a release).

You can also open a project from a terminal: `"My AI IDE.exe" C:\code\project`.

## Features

| Feature | How |
|---|---|
| Window layout | The layout of VS Code: a **menu bar** (File, Edit, Selection, View, Go, Run, Terminal, Help; **Alt+F**, **Alt+E**... open them, arrows move, Enter chooses, toggles show a check mark), an **activity bar** of icons on the left (Explorer, Search, Source Control, Run and Debug, Extensions, Agents, with Account and Settings at the bottom), the side bar, the editor, the AI panel and a status bar. Every menu entry runs the same command as the palette or a keyboard shortcut. |
| Explorer sections and bottom panel | The Explorer has collapsible **Open Editors** (unsaved files show a dot; Save All / Close All), the folder tree, **Outline** (the symbols of the open file: functions, classes... from the TypeScript service for JS/TS, by pattern for other languages and headings in Markdown) and **Timeline** (the commits that changed the open file; click one for its history). The bottom panel has the tabs **Problems** (errors and warnings of the open files, filter, click to jump), **Output** (channels: the app's messages, tasks, extensions), **Debug Console** (program output and an expression box) and **Terminal**; **Ctrl+`** shows the terminal, or switches to it, or hides the panel. |
| Editor | Monaco: tabs, syntax highlighting, minimap. Ctrl+S saves. |
| Explorer, Go to File, palette | Open Folder button, **Ctrl+P**, **Ctrl+Shift+P** |
| Settings | **Ctrl+,** or the **Settings** button in the status bar. Editor font family and size, minimap, word wrap, ligatures, terminal font size, UI zoom, color theme, default AI model, autocomplete. Everything applies live, is remembered, and **Reset to defaults** undoes it all. |
| Updates | The app checks for a new version at startup and every few hours (**Settings → Updates**, where you can also check by hand or turn it off). When one exists a button appears in the status bar: click to download, click again to restart and install. Nothing downloads or installs without you. See *Publishing an update* below to set up the source. |
| Color themes | Click **Theme: …** in the status bar, or Ctrl+Shift+P → *Preferences: Color Theme*. 12 built in, plus your own (see *Custom themes* below) (Dark Modern, One Dark, Dracula, Monokai, Nord, Tokyo Night, GitHub Dark, Solarized Dark, Light Modern, GitHub Light, Solarized Light, High Contrast). Moving through the list previews each one live; Esc keeps your current theme. The theme colours the whole UI, the editor, diffs, the terminal and the window frame, and is remembered. |
| Find in files | **Ctrl+Shift+F**. Plain text by default; `Aa` matches case, `.*` uses a regular expression. Click a result to jump to the line. |
| Terminals | **Ctrl+\`** shows or hides the panel. **+** opens another terminal (**Ctrl+Shift+\`**) and **▾** picks the shell (PowerShell, PowerShell 7, Command Prompt, Git Bash, WSL: whichever are installed); the default is in Settings. Each tab is its own session and keeps running while the panel is hidden. Drag the top edge to resize. A shell that exits closes its tab, and closing the last tab hides the panel. Palette → *Terminal: New SSH Terminal…* opens `ssh` (the OpenSSH client that comes with Windows) to `user@host` or a name from your `~/.ssh/config`. |
| AI chat | **Ctrl+L**. Includes the open file and selection. Type **@** to attach project files. Code blocks have Copy and Insert. The conversation is saved per project folder (plain JSON in `%APPDATA%\my-ai-ide\chats`); **New** clears it. |
| Source control | **Ctrl+Shift+G** (or the branch in the status bar). Changed files, stage/unstage/discard, commit, switch branch, per-file diff, push/pull state, and an AI-written commit message. File tree shows git letters (M, A, U, D) and the editor margin shows changed lines. **Stashes** (stash, apply, pop, delete), a **History** view (commits of the branch, the files each changed, a diff per file; *Git: File History* for one file) and **merge conflicts**: a banner with *Abort*, conflicted files marked `!`, Accept Current / Incoming / Both links above each conflict in the editor, and ◀ ▶ to take a whole side of a file. |
| Explorer | Right-click for New File/Folder, Rename (F2), Delete (to the Recycle Bin), Reveal in Explorer, Copy Path. The tree follows changes made outside the app. |
| Editing niceties | Breadcrumbs, tab context menu (Close Others/All, Save All), auto-save and format-on-save (Settings), Problems count in the status bar (TypeScript/JavaScript diagnostics), recent folders, and tabs restored per folder on reopen. |
| Replace in files | In the search panel, type a replacement and use Replace in a file or Replace All. |
| Project rules | Put instructions in `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.ai-ide/rules.md` or `.cursor/rules/*.md(c)`. They are sent to chat, inline edit and the agent; a **Rules** chip in the panel header shows what was found. Palette: *AI: Create or Open Project Rules*. |
| Chat context | Besides `@file`: **@git** (working-tree diff), **@problems** (current errors), **@terminal** (output of the active terminal), **@folder/** (listing). Paste, drop or attach (**+ Image**) pictures for the model to look at. Each reply shows its token usage. |
| Apply | Code blocks in chat get **Apply**: the model merges the snippet into the open file, you review a diff, and Accept puts it in the editor unsaved (Ctrl+Z undoes it). |
| Split editor | `Ctrl+\`, or a tab's right-click menu → *Split Right* / *Split Down*. Two groups with their own tabs share the open files (an edit shows in both). Drag the divider to resize. Commands such as Save, Format and the chat context act on the group you used last. |
| Workspace folders | Palette → *File: Add Folder to Workspace…*. Several folders in one window: each gets its own tree, Quick Open and Find/Replace in files cover all of them, and Source Control has a picker for which folder's repository to show. The first folder is the main one (agent, terminal, rules). Remembered per main folder. Palette → *File: Open Workspace from File…* opens a `.code-workspace` file (its `folders`; other settings in it are ignored) and *File: Save Workspace As…* writes one. |
| Search by meaning | In the search panel press **✦** and ask in plain words ("where do users log in?"). Two rankings are merged: a local word index (names are split at camelCase/snake_case), and **embeddings** from a small model (all-MiniLM-L6-v2, ~23 MB, downloaded once on first use, then fully offline; Settings → *Search by meaning on this PC* turns it off) that finds code sharing no words with the question. Claude Haiku also widens the question into likely identifiers and orders the best matches (only the question and short excerpts are sent). Vectors are cached on disk, so a project is embedded once; a large project is learned in the background and the panel says how far it got. In chat, **@codebase** attaches the matching code; the agent has a `search_codebase` tool. |
| Next edit | After you edit, Haiku predicts the change you will probably make next (the same rename on the next call site...). A box under the target lines shows it: **Tab** jumps there, **Tab** again applies, **Esc** dismisses. Off in Settings → *Next edit suggestions*. |
| Inline edit | Select code, **Ctrl+K**, describe the change, review the diff, Accept or Reject. |
| Autocomplete | Grey ghost text while you type, **Tab** accepts. Uses Claude Haiku 5.5. Toggle in the tab bar. Besides the current file it sends short excerpts of up to 3 other open files (the ones you touched most recently, or that mention the word at the caret) when you use your own key; with an account only the current file is sent for now. |
| Agent | Chat panel → **Agent**. Lists, reads and searches files; edits files and runs commands. The conversation is saved per project folder: reopen the folder and the transcript, the agent's memory of it, and the **Undo** buttons for its changes all come back (plain JSON in `%APPDATA%\my-ai-idegent`). **New** forgets it and deletes the files. |
| Background agents | **Agents** tab, or **⤴ Background** in the agent panel. A task runs on its own copy of the project (a git worktree on its own branch) while you keep working; file edits there need no approval, commands still do. When it finishes, review the changed files as diffs, then **Apply to my files** (conflicts show up like merge conflicts) or **Discard**. Your untracked files are copied into the copy and an ignored `node_modules` is linked to the original (so dependencies are there without reinstalling; do not change packages from a background task). Needs a git repository with a commit; up to 3 at a time. |
| Debugger | **Run** tab. Click the margin or press **F9** for a breakpoint (give it a condition in the Breakpoints list); **F5** starts the open file, **F10** / **F11** / **Shift+F11** step, **Shift+F5** stops. Variables (expandable), watch expressions, call stack, a debug console that evaluates in the stopped frame, and a stop on uncaught exceptions. Works for **JavaScript, TypeScript** (bundled with esbuild; breakpoints and stack frames map back to your `.ts` lines through source maps), **Python** (through `debugpy`: run `pip install debugpy` once; the panel says so if it is missing) and **Go** (through Delve: palette → *Debug: Install the Go Debugger (Delve)*, or `go install github.com/go-delve/delve/cmd/dlv@latest`; the package that holds the open file is built and run). Palette → *Debug: Attach to Node.js Program…* connects to a Node program that is already running: give its `--inspect` port (`9229`, or `host:port`) or `pid 1234` (the process is asked to open its inspector); Stop only disconnects, the program keeps running. Choose a **launch configuration** from `launch.json` (see *Tasks and launch.json*) to set arguments, environment and folder. |
| Extensions | **Ext** tab. Search the Open VSX registry or install a `.vsix`. Themes and snippets from VS Code extensions are converted. Extensions that run code (`"main"` in package.json) run in a separate process with a **`vscode` API layer**: commands, `window.show*Message`/`showQuickPick`/`showInputBox`, status bar items, output channels, `workspace` (folders, configuration defaults, `findFiles`, `fs`, `applyEdit`, `openTextDocument`), text editor selection/edits, completion and hover providers, diagnostics, `env.clipboard`, and global/workspace state. Anything not covered (webviews, tree views, language clients, debug adapters, terminals, tasks...) fails with a message that says what is unsupported, rather than silently misbehaving. Extensions can also use this editor's own `ide` API (`"engines": { "my-ai-ide": "*" }`). They run with your permissions and are not sandboxed, so install only ones you trust. |
| WSL and SSH | Palette → *File: Open WSL Folder…* starts terminals and agent commands inside that distribution. Palette → ***File: Open Folder over SSH…*** connects to `user@host` (or a name from your `~/.ssh/config`; agent, key file or password; the host key is shown for you to trust the first time and checked afterwards), lets you browse to a folder, and opens it like a local one: the explorer, Quick Open, editing and saving, create/rename/delete (a server has no Recycle Bin, so delete is permanent), Find and Replace in files, and a terminal that logs in and starts in that folder. **Source control** works there (the git on the server, run over the SSH connection: status, diff, stage, commit, branches, push/pull), and so does the **agent**: its file tools go through SFTP, `run_command` runs in a shell on the server (each command still needs your approval), and rules files (`AGENTS.md`...) are read. Background agents, the debugger, extensions and search by meaning do not work in an SSH folder yet (the agent uses `search_text` and `find_files` instead; symlinks on the server are not resolved when checking that a path stays inside the project; changes on the server made outside the editor show up when you refresh Source Control). The status bar shows `⇄ SSH: name`. If Git calls a WSL folder unsafe, Source Control offers to trust it. |
| Tasks and launch.json | Put `tasks.json` and `launch.json` in `.ai-ide/` or `.vscode/` (comments and trailing commas allowed; `${workspaceFolder}`, `${file}`, `${fileBasename}`... are expanded). Palette → *Tasks: Run Task* lists your tasks and the `package.json` scripts, *Tasks: Run Build Task* / *Run Test Task* use the task in that group, `dependsOn` runs in order. Launch configurations (`node`, `pwa-node`, `python`, `debugpy`, `go`: program, args, env, cwd, stopOnEntry) appear in the Run tab. A broken file or unsupported type is reported with the reason. |
| Merge editor | A conflicted file shows **Open Merge Editor** above the first conflict: Current and Incoming side by side, and the Result underneath, which you can edit. Accept Current / Incoming / Both per conflict, or all at once; **Complete Merge** writes the file and stages it. |
| Notebooks | `.ipynb` files open as notebooks (nbformat 4, so they stay compatible with Jupyter): code and text cells, run with **Shift+Enter** or ▶, Python `input()` asks in a small dialog, outputs (text, errors, images, HTML as text), execution counts, Add/Move/Delete, command mode keys (**B** below, **A** above, **D D** delete, **M**/**Y** cell type), Clear Outputs, Stop. Kernels: **JavaScript** (built in) and **Python** (your Python on PATH; no `ipykernel` needed). They are this editor's own kernels, not Jupyter's: no other Jupyter kernels, no widgets (JavaScript cells have no `input()`), and Stop ends the kernel (variables are lost). *File: Create New Notebook*; "{ }" or *Open as Notebook* switches between the cells and the JSON text. |
| Accessibility | Everything works from the keyboard: **F6** / **Shift+F6** move between the explorer, editor, terminal and chat, dialogs trap and restore focus, the tabs, tree, menus and pickers use the standard roles (tablist, tree, menu, combobox/listbox, dialog), and status changes (saved, search results, kernel done...) are announced to screen readers. A visible focus ring is shown for keyboard use. Every built-in theme meets WCAG AA text contrast (`npm run test:contrast` checks it, including custom themes you add). Settings: *Screen reader mode*, *Reduce motion* (your system setting is also respected). |

### Agent safety

- Every file change is shown as a diff and written only after you click **Accept**. Each accepted change has an **Undo** button (kept in memory for the session).
- Every command is shown in full and runs only after you click **Run**. There is no "always allow".
- File tools cannot leave the project folder (symlinks are resolved) and cannot touch `.git`.
- Commands run in PowerShell in the project folder, stop after 60 s by default (max 10 min), and do not receive your API key.
- A run stops after 25 steps.

### Cost

With an account, usage is counted by the service against your plan (a request per question, per Apply, per commit message, five for an agent task; suggestions have their own allowance; Next edit suggestions are off by default because each one is a request). In development mode (own key) these call the Anthropic API directly and are billed to you. The agent re-sends
the conversation on every step (prompt caching is on). Autocomplete sends a request each time you pause typing; turn it off
when you do not need it. Models can be picked in each panel (Opus 5.5 default, Sonnet 5.5, Haiku 5.5).

## Develop

```powershell
npm install
npm run dev          # run with hot reload
npm run typecheck
npm run build        # compile to out/
npm run dist         # build the installer into release/
npm run test:e2e     # drive the packaged app against a fake Claude API (run `npm run dist` first)
npm run test:real    # same idea against the REAL API using ANTHROPIC_API_KEY; costs a few cents per run
npm run test:git     # git handlers against real temporary repositories
npm run test:fsops   # file operations and replace-in-files
npm run test:update-config
npm run test:index   # codebase search (index, ranking, Claude expansion against a fake API)
npm run test:debug   # the debugger against real Node programs
npm run test:ext     # extensions: install, themes, snippets, host process, registry (fake)
npm run test:shells  # WSL / SSH helpers
npm run test:ssh     # editing files over SSH against a built-in test SSH server
npm run test:ssh-git # git and the agent's tools over SSH (the test server runs the commands with local git and sh)
npm run test:menus   # drives every menu entry in a running dev app (see tests/menus.cjs: start the app with --remote-debugging-port=9444 on a throwaway folder)
npm run test:menus2  # native-dialog entries, language-service entries, saving, debugger stepping and every keyboard shortcut; starts the app itself
npm run test:backend # sign-in and every service call against a fake of the service
npm run test:e2e-account # the packaged app without a key: sign in, chat, agent, sign out (fake service)
npm run test:tasks   # tasks.json / launch.json
npm run test:merge   # three-way merge parsing
npm run test:contrast # WCAG contrast of every theme
npm run test:notebook # notebook kernels;  test:nbmodel: the notebook file model
```

If `npm run dev` exits immediately, check that `ELECTRON_RUN_AS_NODE` is not set in your shell.

### Layout

```
src/main/        Electron main process: files, terminal (node-pty), AI (ai.ts), agent loop and tools (agent.ts), git.ts,
                 background.ts (worktree agents), codeindex.ts (search by meaning), debugger.ts, extensions.ts, shellspec.ts (WSL/SSH)
src/preload/     Typed bridge exposed to the UI as window.api
src/renderer/    React UI: App, ChatPanel, AgentPanel, InlineEdit, autocomplete, dialogs
build/           App icon and the afterPack hook that stamps the exe (rcedit)
tests/e2e.cjs    End-to-end test (fake API server + Chrome DevTools Protocol)
tests/real-e2e.cjs  Same driver against the real API (opt-in, costs money)
```

### Publishing an update

Updates come from GitHub Releases: `electron-builder.yml` points at `myaicodingagent/my-ai-ide`. The repository must be public (a private one
would need a token inside the app). If `owner` is changed back to the placeholder `YOUR_GITHUB_USER` the app says "Updates are not set up in this build"
and makes no network calls.

For each release:

1. Raise `version` in `package.json` (for example `0.1.0` to `0.2.0`).
2. `npm run dist`. This writes `release/My-AI-IDE-Setup-<version>.exe`, its `.blockmap`, and `latest.yml`.
3. On GitHub create a release tagged `v<version>` and attach those three files (or run
   `npx electron-builder --win nsis --publish always` with a `GH_TOKEN` environment variable to upload them for you).

Installed copies with an older version then show **Update <version> available**. The download is checked against the SHA-512 in
`latest.yml` and discarded if it does not match.

To host updates yourself instead, change `publish` to `provider: generic` with a `url`, or set the environment variable
`MY_AI_IDE_UPDATE_URL` to a folder that serves `latest.yml` and the installer (this is how the tests run).

Installers are unsigned, so Windows shows the SmartScreen warning for each new version too; a code-signing certificate fixes both.

### Custom themes

Put a `.json` file in the themes folder (`%APPDATA%\my-ai-ide\themes`; Settings → **Open folder** opens it and adds a
`_example-theme.json`), then press **Reload** in Settings. Files whose name starts with `_` are ignored. You can also use
**Import…** to copy a file in, or **Duplicate current** to write the active theme out as a complete file to start from.

```json
{
  "name": "My Theme",
  "type": "dark",
  "base": "dark-modern",
  "ui": { "bg": "#1b1d2b", "side": "#161824", "accent": "#ff6ac1" },
  "syntax": { "keyword": "#ff6ac1", "string": "#5af78e", "comment": "#686868" }
}
```

- `name`: shown in the picker. `type`: `dark`, `light` or `hc` (decides the native color scheme and terminal palette).
- `base`: a built-in theme id (default: `dark-modern` / `light-modern` / `high-contrast` by type). Colors you leave out come from it.
- `ui` keys: `bg side sunken hover active border fg muted accent onAccent danger ok sel`.
  `syntax` keys: `comment keyword string number type func variable constant tag attr`.
  Colors are `#rgb` or `#rrggbb`.
- Mistakes are reported in Settings with the file name and the reason; one bad file never affects the others.

Built-in themes live in `src/renderer/src/theme.ts` in the same shape; add one to `BUILTIN_THEMES` to ship it with the app.
The tests use their own throwaway app profile (`--user-data-dir`), so they never touch your real settings or chats.

### Packaging notes

`signAndEditExecutable` is off because electron-builder's signing toolkit needs symlink rights on Windows; `build/afterPack.js`
sets the exe icon and version info with `rcedit` instead. To ship to others, get a code-signing certificate and turn it back on.

## Known limits

- Saved agent history keeps the most recent turns only (about 1.5 MB); older ones are dropped whole. The files contain file contents the agent read; they are encrypted with Windows (`safeStorage`) when it is available, and files saved by older versions are encrypted on their next save.
- Autocomplete sends the current file plus a few other open files; it does not index the rest of the project. With an account the service gets only the current file.
- Only tested on Windows 11.
- Extensions: the `vscode` API layer is partial (see the Extensions row). Extensions that need language servers, webviews, tree views, notebooks or debug adapters do not work, and many large extensions use APIs beyond the supported set. Extension code is not sandboxed.
- The debugger handles JavaScript, TypeScript, Python (needs `debugpy`) and Go (needs Delve); not Java, C#, C++... Attach works for Node programs only (not Python or Go), and there is no browser debugging. Node comes from your PATH if there is one, otherwise from the app itself.
- SSH folders: files, search, a terminal, source control and the agent (see the WSL and SSH row); no background agents, debugger, extensions or search by meaning. Files over 5 MB are not opened remotely, and a lost connection is re-made when you open the folder again. Git in WSL folders uses Windows Git.
- Search by meaning indexes up to 25,000 text files per folder. The first search in a large project is word-only while the vectors are being computed in the background; the model needs one internet download (and about 70 MB of the installer is its runtime).
- Notebooks use this editor's own JavaScript and Python kernels, not Jupyter kernels; there is no cell-level undo across runs and no interactive widgets.
- Background agents copy untracked files up to 5 MB each (2,000 files) and only link `node_modules` when git ignores it.
- Not built: live share/collaboration, a cloud/background agent that runs off your PC, and a formal screen-reader audit with real assistive technology (the accessibility work follows the standard roles and is tested by script, not by a person using NVDA or JAWS).

