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
| Window layout | The layout of VS Code, with the **menu bar drawn in the title bar** (drag it to move the window, double-click to maximize; the system draws only the window buttons at the right end, in the colors of the theme; the title shows the open file, a dot while it has unsaved changes, and the folder): a **menu bar** (File, Edit, Selection, View, Go, Run, Terminal, Help; **Alt+F**, **Alt+E**... open them, arrows move, Enter chooses, toggles show a check mark), an **activity bar** of icons on the left (Explorer, Search, Source Control, Run and Debug, Extensions, Agents, with Account and Settings at the bottom), the side bar, the editor, the AI panel and a status bar. Every menu entry runs the same command as the palette or a keyboard shortcut. |
| Language servers | For **Go** (`gopls`), **Python** (`pylsp`, or `pyright-langserver`), **Rust** (`rust-analyzer`) and **C/C++** (`clangd`), the editor starts the language server when you open a file (one per project folder) and shows what it says: errors and warnings in the Problems panel, completions (as you type, or Ctrl+Space), hover, **Go to Definition / References** (F12, Shift+F12), the **Outline**, signature help, **Format Document** and **Rename** (F2, in open files). The status bar names the running servers; the *Language Servers* channel of the Output panel logs them; palette → *Language Servers: Restart* after installing one; **Settings → Language servers** turns them all off (and on again) without restarting. A server that is not installed is not an error: the Output channel and a message say how to install it (`go install golang.org/x/tools/gopls@latest`, `pip install python-lsp-server`, `rustup component add rust-analyzer`, `winget install LLVM.LLVM`). JavaScript and TypeScript keep using the built-in TypeScript service. |
| Explorer sections and bottom panel | The Explorer has collapsible **Open Editors** (unsaved files show a dot; Save All / Close All), the folder tree, **Outline** (the symbols of the open file: functions, classes... from the TypeScript service for JS/TS, by pattern for other languages and headings in Markdown) and **Timeline** (the commits that changed the open file; click one for its history). The groups of the Source Control view (**Staged Changes**, **Changes**, **Stashes**) and of the Extensions view (**Registry results**, **Installed**, the host log) are collapsible sections like these, with their counts kept in the header when folded; views that extensions put in the `scm` or `debug` containers appear below the Source Control and Run and Debug views. The bottom panel has the tabs **Problems** (errors and warnings of the open files, filter, click to jump), **Output** (channels: the app's messages, tasks, extensions), **Debug Console** (program output and an expression box) and **Terminal**; **Ctrl+`** shows the terminal, or switches to it, or hides the panel. |
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
| Background agents | **Agents** tab, or **⤴ Background** in the agent panel. A task runs on its own copy of the project (a git worktree on its own branch) while you keep working; file edits there need no approval, commands still do. When it finishes, review the changed files as diffs, then **Apply to my files** (conflicts show up like merge conflicts) or **Discard**. Your untracked files are copied into the copy and an ignored `node_modules` is linked to the original (so dependencies are there without reinstalling; do not change packages from a background task). Needs a git repository with a commit; up to 3 at a time. In an SSH folder the copy is made on the server (inside the repository's `.git/my-ai-ide-worktrees`, so `git status` does not show it) and needs `git`, `sh` and `tar` there. |
| Debugger | **Run** tab. Click the margin or press **F9** for a breakpoint (give it a condition in the Breakpoints list); **F5** starts the open file, **F10** / **F11** / **Shift+F11** step, **Shift+F5** stops. Variables (expandable), watch expressions, call stack, a debug console that evaluates in the stopped frame, and a stop on uncaught exceptions. Works for **JavaScript, TypeScript** (bundled with esbuild; breakpoints and stack frames map back to your `.ts` lines through source maps), **Python** (through `debugpy`: run `pip install debugpy` once; the panel says so if it is missing) and **Go** (through Delve: palette → *Debug: Install the Go Debugger (Delve)*, or `go install github.com/go-delve/delve/cmd/dlv@latest`; the package that holds the open file is built and run). **C#**: palette → *Debug: Install the C# Debugger (netcoredbg)* downloads netcoredbg (Samsung/netcoredbg, from its GitHub releases, once, into the app's data folder; or put it on your PATH); F5 on a `.cs` file then builds the nearest `.csproj` with `dotnet build` (Debug) and runs it under the debugger, with breakpoints, stepping, variables, expressions and unhandled-exception stops. **C and C++**: palette → *Debug: Install the C/C++ Debugger* (Windows: runs `winget install MartinStorsjo.LLVM-MinGW.UCRT`, which brings clang and `lldb-dap`; Linux and macOS: install `lldb` and `clang` with your package manager) or have `lldb-dap` and `clang`/`gcc` on the PATH; F5 on a `.c`, `.cpp`, `.cc` or `.cxx` file compiles that one file with `-g -O0` (statically linked on Windows) and runs it under `lldb-dap`, with breakpoints (also in headers), stepping, variables (a `std::vector` expands), expressions and the program's output. **Java**: needs a JDK (the `javac` compiler; palette → *Debug: Install the Java Debugger (JDK)* runs `winget install EclipseAdoptium.Temurin.21.JDK` on Windows; found through `JAVA_HOME`, the PATH or the usual install folders). F5 on a `.java` file with a `main` method compiles it, and the other source files of its package that it uses, with `javac -g` and runs it under the editor's own debug adapter (built on the JDK's Java Debug Interface; it is compiled with your JDK the first time). Breakpoints (also in the other files of the program), conditions, stepping, stop on entry, uncaught-exception stops, locals and `this` with their fields, arrays, and the contents of library objects (a list shows `[1, 2, 3]`), and the Debug Console and Watch can evaluate expressions: names, fields, array elements, method calls (`list.size()`, `Math.max(a, b)`), arithmetic, comparisons, `&&`, `||`, `!` and string `+`. Palette → *Debug: Attach to Node.js Program…* connects to a Node program that is already running: give its `--inspect` port (`9229`, or `host:port`) or `pid 1234` (the process is asked to open its inspector); Stop only disconnects, the program keeps running. *Debug: Attach to Python Program…* connects to a program started with `python -m debugpy --listen 5678 script.py` (give the port or `host:port`), and *Debug: Attach to Go Process…* to a running Go program by `pid 1234` (or to a Delve server started with `dlv attach --headless --listen=:2345`, by port); all three are also in the Run menu. Choose a **launch configuration** from `launch.json` (see *Tasks and launch.json*) to set arguments, environment and folder. |
| Extensions | **Ext** tab. Search the Open VSX registry or install a `.vsix`. Themes and snippets from VS Code extensions are converted. Extensions that run code (`"main"` in package.json) run in a separate process with a **`vscode` API layer**: commands, `window.show*Message`/`showQuickPick`/`showInputBox`, status bar items, output channels, `workspace` (folders, configuration defaults, `findFiles`, `fs`, `applyEdit`, `openTextDocument`), text editor selection/edits, completion and hover providers, diagnostics, `env.clipboard`, and global/workspace state. **Tree views** (`createTreeView` / `registerTreeDataProvider`, declared under `contributes.views`, in the Explorer or in an activity bar container of the extension's own; icons can be a codicon (`ThemeIcon`) or an image file (a path, a `Uri` or `{ light, dark }`: png, svg, jpg, gif, ico or webp up to 32 KB each); right-click, the Menu key or Shift+F10 on a node shows the entries from `contributes.menus["view/item/context"]` whose `when` clause matches (`view`, `viewItem`, `resourceFilename`..., `&&`, `||`, `!`, `==`, `!=`, `=~`), `group: "inline"` entries are buttons on the row, and the command gets the node) and `view/title` entries are buttons in the header of their view, `editor/context` entries are in the editor's right-click menu (shown while their `when` clause fits the file: `resourceExtname`, `editorLangId`, `editorHasSelection`..., and the command gets the file as a `Uri`), `explorer/context` entries are in the explorer's right-click menu of a file or folder (`explorerResourceIsFolder`, `resourceExtname`, `resourceFilename`, `resourceLangId`...), `editor/title/context` entries are in a tab's right-click menu, `editor/title` entries are buttons at the end of the tab bar (those outside the `navigation` group are behind a "…" button; text instead of an icon), and a `commandPalette` entry with `"when": "false"` hides a command from the palette) and **web pages** (`createWebviewPanel` as a tab, `registerWebviewViewProvider` in a side bar view; sandboxed frames, `acquireVsCodeApi`, messages both ways, `asWebviewUri` for the extension's own files; `setState`/`getState` in the page, and `registerWebviewPanelSerializer`: panels that were open when the editor was closed are brought back by their extension, with their state) work too. Anything not covered (language clients, debug adapters, terminals, tasks, SCM...) fails with a message that says what is unsupported, rather than silently misbehaving. Extensions can also use this editor's own `ide` API (`"engines": { "my-ai-ide": "*" }`). They run with your permissions and are not sandboxed, so install only ones you trust. |
| WSL and SSH | Palette → *File: Open WSL Folder…* starts terminals and agent commands inside that distribution. Palette → ***File: Open Folder over SSH…*** connects to `user@host` (or a name from your `~/.ssh/config`; agent, key file or password; the host key is shown for you to trust the first time and checked afterwards), lets you browse to a folder, and opens it like a local one: the explorer, Quick Open, editing and saving, create/rename/delete (a server has no Recycle Bin, so delete is permanent), Find and Replace in files, and a terminal that logs in and starts in that folder. **Source control** works there (the git on the server, run over the SSH connection: status, diff, stage, commit, branches, push/pull), and so does the **agent**: its file tools go through SFTP, `run_command` runs in a shell on the server (each command still needs your approval), and rules files (`AGENTS.md`...) are read. **Background agents** work there too (see that row), and so does the **debugger** (*Run* on a `.js`, `.py` or `.go` file starts the program on the server, with its own `node`, Python with `debugpy`, or Go with Delve; the debug port is reached through the same SSH connection, so nothing else has to be opened; breakpoints, stepping, variables and the console work as for local files; Stop ends the program on the server; TypeScript, attach and stop-on-entry for Python are not supported over SSH yet). Extensions do not work in an SSH folder yet (search by meaning does: files are read over the connection and indexed locally; symlinks on the server are not resolved when checking that a path stays inside the project; changes on the server made outside the editor show up when you refresh Source Control). The status bar shows `⇄ SSH: name`. If Git calls a WSL folder unsafe, Source Control offers to trust it. |
| Tasks and launch.json | Put `tasks.json` and `launch.json` in `.ai-ide/` or `.vscode/` (comments and trailing commas allowed; `${workspaceFolder}`, `${file}`, `${fileBasename}`... are expanded). Palette → *Tasks: Run Task* lists your tasks and the `package.json` scripts, *Tasks: Run Build Task* / *Run Test Task* use the task in that group, `dependsOn` runs in order. Launch configurations (`node`, `pwa-node`, `python`, `debugpy`, `go`: program, args, env, cwd, stopOnEntry) appear in the Run tab. A broken file or unsupported type is reported with the reason. |
| Merge editor | A conflicted file shows **Open Merge Editor** above the first conflict: Current and Incoming side by side, and the Result underneath, which you can edit. Accept Current / Incoming / Both per conflict, or all at once; **Complete Merge** writes the file and stages it. |
| Notebooks | `.ipynb` files open as notebooks (nbformat 4, so they stay compatible with Jupyter): code and text cells, run with **Shift+Enter** or ▶, Python `input()` asks in a small dialog, outputs (text, errors, images, HTML as text), execution counts, Add/Move/Delete, command mode keys (**B** below, **A** above, **D D** delete, **M**/**Y** cell type), Clear Outputs, Stop. Kernels: **JavaScript** (built in) and **Python** (your Python on PATH; no `ipykernel` needed). These two are this editor's own simple kernels (JavaScript cells have no `input()`, and Stop ends the kernel: variables are lost). **Jupyter kernels** are listed too ("Jupyter: Python 3 (ipykernel)", R, Julia... whatever is installed: found through `kernel.json` files in the usual places, `JUPYTER_PATH` and the folders of the Pythons on your PATH) and are driven with the real Jupyter messaging protocol over ZeroMQ (written into the app, nothing to install but the kernel); a notebook that names an installed kernel opens with it. With a Jupyter kernel Stop interrupts the running cell and keeps the variables, `input()` works, `clear_output()` (also with `wait=True`) and `display(..., display_id=...)` with its updates work (progress bars that redraw), and **ipywidgets** are drawn and live: sliders, buttons, boxes, `interact()` with its Output widget (the library of ipywidgets 8 draws both ipywidgets 8 and 7). *File: Create New Notebook*; "{ }" or *Open as Notebook* switches between the cells and the JSON text. |
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
npm run test:ssh-git # git, search by meaning (words and vectors) and the agent's tools over SSH (the test server runs the commands with local git and sh)
npm run test:packaged-debug # the PACKAGED app debugs a Java, a C++ and a C# program through the Run menu (needs npm run dist first; each language is skipped without its tools)
# (If an editor that has the project open keeps release\win-unpacked locked, so that npm run dist fails: build elsewhere with
#  npx electron-builder --win --dir -c.directories.output=C:\somewhere  and run the packaged tests with MY_AI_IDE_EXE=C:\somewhere\win-unpacked\My AI IDE.exe)
npm run test:ssh-debug # the debugger on a program "on the server": Node, Python (debugpy), Go (Delve), through an SSH tunnel
npm run test:ssh-background # background agents over SSH: copy on the server, review, apply, discard (the model is replaced by a fixed script)
npm run test:jupyter # real ipykernel through the notebook handlers: cells, errors, images, input(), interrupt, stop
npm run test:jupyter-ui # the real app: a Jupyter kernel runs a notebook and ipywidgets (slider, button, interact) are used with mouse and keyboard
npm run test:lsp-ssh # a language server on a Linux SSH server in the real app: errors, hover, go to definition (same Docker container as test:ssh-linux)
npm run test:ssh-linux # the same two against a real Linux SSH server in Docker (skipped unless one answers on 127.0.0.1:2222; see the top of tests/ssh-linux.cjs)
npm run test:menus   # drives every menu entry in a running dev app (see tests/menus.cjs: start the app with --remote-debugging-port=9444 on a throwaway folder)
npm run test:ext-tree    # an extension's tree views in the real app (Explorer section, own activity bar container, refresh, click commands, file and codicon icons, context and inline menus, the explorer, tab and tab bar menus)
npm run test:when # the "when" clauses of extension menus
npm run test:ext-restore # webview panel serializers: a panel and its state survive closing the app (starts the app three times)
npm run test:ext-webview # an extension's web pages in the real app (tab, sidebar view, scripts under a nonce CSP, messages, resources, refused paths)
npm run test:lsp     # real gopls and pylsp in the real app: errors, outline, hover, definition, completion, rename, formatting; starts the app itself
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
- Language servers run for folders on this PC and for folders opened over SSH (there the server is started on the other computer, found on its PATH and in `~/go/bin`, `~/.cargo/bin`, `~/.local/bin`; not for WSL folders yet), use full-file sync, and a rename changes closed files through stand-in models (written to disk a moment later; undo in the editor that started the rename undoes them too, redo as well, until that file is edited again), at most 50 closed files at once.
- Extensions: the `vscode` API layer is partial (see the Extensions row). Extensions that need language clients (this editor starts language servers itself, see *Language servers*), notebooks or debug adapters do not work; other menus (`scm/*`, `editor/title/run`, `touchBar`, `menuBar/*`, `commandPalette` entries with a `when` other than `false`...) are ignored, a tree node's icon cannot be a remote URL, a restored webview panel gets default options, and many large extensions use APIs beyond the supported set. Extension code is not sandboxed.
- The debugger handles JavaScript, TypeScript, Python (needs `debugpy`), Go (needs Delve), C# (needs the .NET SDK and netcoredbg), C/C++ (needs `lldb-dap` and a compiler) and Java (needs a JDK). C and C++ run one source file at a time (no CMake or Make projects, local folders only; GDB is not supported because its debug adapter did not behave reliably in tests); Java runs one program at a time from a source file (no Maven or Gradle projects, no jar dependencies, local folders only), and its expression evaluator has no lambdas, casts, `new`, generics or assignments; on Windows the MinGW toolchains from WinLibs fail to link when the user folder name contains a space, so LLVM-MinGW is what the install command uses; MSVC (`cl`) is not supported. C# works for local folders only (not over SSH), needs a `.csproj` (single files without a project are not run), and the downloaded netcoredbg is not checked against a checksum (GitHub publishes none) Attach works for Node (port or process id), Python (debugpy port; not by process id), Go (process id or Delve port), Java (the port of a JVM started with `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005`; the open folders are searched for its source files), C/C++ (process id, with `lldb-dap`; the program needs debug information) and C# (process id of a .NET program, with netcoredbg); palette → *Debug: Attach to Java Program…*, *…to C/C++ Process…*, *…to .NET Process…* (also in the Run menu); for Go, build with `-gcflags="all=-N -l"` to see variables. There is no browser debugging. Node comes from your PATH if there is one, otherwise from the app itself.
- SSH folders: files, search, a terminal, source control and the agent (see the WSL and SSH row); no extensions; language servers, the debugger and background agents need `node`/`python`+`debugpy`/`dlv` and `git`/`sh`/`tar` on the server (a server with a POSIX shell: Linux, macOS; tested against the built-in test server and against Ubuntu 24.04 with OpenSSH in Docker, not against macOS or a Windows OpenSSH server). Files over 5 MB are not opened remotely, and a lost connection is re-made when you open the folder again. Git in WSL folders uses Windows Git.
- Search by meaning indexes up to 25,000 text files per folder. The first search in a large project is word-only while the vectors are being computed in the background; the model needs one internet download (and about 70 MB of the installer is its runtime).
- Notebooks: there is no cell-level undo across runs. Jupyter kernels: widgets are not saved with the notebook (reopened, a widget shows its text until its cell is run again; widgets from extra packages such as ipympl, bqplot or ipyleaflet are not included, only the standard ipywidgets), HTML output of a cell that was run in this session runs its scripts in a frame of its own (no access to the editor; plotly, bokeh and folium output draws when the page can load what it needs from the internet), while HTML saved in a notebook that is opened again is shown without scripts until the cell is run again, `update_display_data` only changes outputs of the same cell, and a kernel that is not ipykernel cannot be interrupted on Windows (Stop ends it). Tested on Windows with ipykernel 6.28 (all of it) and 7.4 (the widget test only), and ipywidgets 7.8 and 8.1; not with IRkernel, IJulia or other kernels, and not on macOS or Linux.
- Background agents copy untracked files up to 5 MB each (2,000 files) and only link `node_modules` when git ignores it.
- Not built: live share/collaboration, a cloud/background agent that runs off your PC, and a formal screen-reader audit with real assistive technology (the accessibility work follows the standard roles and is tested by script, not by a person using NVDA or JAWS).

