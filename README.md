# My AI IDE

A desktop code editor with Claude built in, for Windows. Electron + React + Monaco (the editor core of VS Code).

## Install

Run `release\My-AI-IDE-Setup-<version>.exe` (build it first, see below). The installer is unsigned, so Windows
SmartScreen shows "unknown publisher": choose *More info → Run anyway*.

On first use, open the chat panel and paste your Anthropic API key. It is encrypted with Windows
(Electron `safeStorage`) and stored only on your PC. If `ANTHROPIC_API_KEY` is set in your environment it is used instead.

You can also open a project from a terminal: `"My AI IDE.exe" C:\code\project`.

## Features

| Feature | How |
|---|---|
| Editor | Monaco: tabs, syntax highlighting, minimap. Ctrl+S saves. |
| Explorer, Go to File, palette | Open Folder button, **Ctrl+P**, **Ctrl+Shift+P** |
| Settings | **Ctrl+,** or the **Settings** button in the status bar. Editor font family and size, minimap, word wrap, ligatures, terminal font size, UI zoom, color theme, default AI model, autocomplete. Everything applies live, is remembered, and **Reset to defaults** undoes it all. |
| Updates | The app checks for a new version at startup and every few hours (**Settings → Updates**, where you can also check by hand or turn it off). When one exists a button appears in the status bar: click to download, click again to restart and install. Nothing downloads or installs without you. See *Publishing an update* below to set up the source. |
| Color themes | Click **Theme: …** in the status bar, or Ctrl+Shift+P → *Preferences: Color Theme*. 12 built in, plus your own (see *Custom themes* below) (Dark Modern, One Dark, Dracula, Monokai, Nord, Tokyo Night, GitHub Dark, Solarized Dark, Light Modern, GitHub Light, Solarized Light, High Contrast). Moving through the list previews each one live; Esc keeps your current theme. The theme colours the whole UI, the editor, diffs, the terminal and the window frame, and is remembered. |
| Find in files | **Ctrl+Shift+F**. Plain text by default; `Aa` matches case, `.*` uses a regular expression. Click a result to jump to the line. |
| Terminals | **Ctrl+\`** shows or hides the panel. **+** opens another terminal (**Ctrl+Shift+\`**) and **▾** picks the shell (PowerShell, PowerShell 7, Command Prompt, Git Bash, WSL: whichever are installed); the default is in Settings. Each tab is its own session and keeps running while the panel is hidden. Drag the top edge to resize. A shell that exits closes its tab, and closing the last tab hides the panel. |
| AI chat | **Ctrl+L**. Includes the open file and selection. Type **@** to attach project files. Code blocks have Copy and Insert. The conversation is saved per project folder (plain JSON in `%APPDATA%\my-ai-ide\chats`); **New** clears it. |
| Source control | **Ctrl+Shift+G** (or the branch in the status bar). Changed files, stage/unstage/discard, commit, switch branch, per-file diff, push/pull state, and an AI-written commit message. File tree shows git letters (M, A, U, D) and the editor margin shows changed lines. |
| Explorer | Right-click for New File/Folder, Rename (F2), Delete (to the Recycle Bin), Reveal in Explorer, Copy Path. The tree follows changes made outside the app. |
| Editing niceties | Breadcrumbs, tab context menu (Close Others/All, Save All), auto-save and format-on-save (Settings), Problems count in the status bar (TypeScript/JavaScript diagnostics), recent folders, and tabs restored per folder on reopen. |
| Replace in files | In the search panel, type a replacement and use Replace in a file or Replace All. |
| Project rules | Put instructions in `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.ai-ide/rules.md` or `.cursor/rules/*.md(c)`. They are sent to chat, inline edit and the agent; a **Rules** chip in the panel header shows what was found. Palette: *AI: Create or Open Project Rules*. |
| Chat context | Besides `@file`: **@git** (working-tree diff), **@problems** (current errors), **@terminal** (output of the active terminal), **@folder/** (listing). Paste, drop or attach (**+ Image**) pictures for the model to look at. Each reply shows its token usage. |
| Apply | Code blocks in chat get **Apply**: the model merges the snippet into the open file, you review a diff, and Accept puts it in the editor unsaved (Ctrl+Z undoes it). |
| Inline edit | Select code, **Ctrl+K**, describe the change, review the diff, Accept or Reject. |
| Autocomplete | Grey ghost text while you type, **Tab** accepts. Uses Claude Haiku 5.5. Toggle in the tab bar. |
| Agent | Chat panel → **Agent**. Lists, reads and searches files; edits files and runs commands. The conversation is saved per project folder: reopen the folder and the transcript, the agent's memory of it, and the **Undo** buttons for its changes all come back (plain JSON in `%APPDATA%\my-ai-idegent`). **New** forgets it and deletes the files. |

### Agent safety

- Every file change is shown as a diff and written only after you click **Accept**. Each accepted change has an **Undo** button (kept in memory for the session).
- Every command is shown in full and runs only after you click **Run**. There is no "always allow".
- File tools cannot leave the project folder (symlinks are resolved) and cannot touch `.git`.
- Commands run in PowerShell in the project folder, stop after 60 s by default (max 10 min), and do not receive your API key.
- A run stops after 25 steps.

### Cost

Chat, inline edit, autocomplete and the agent call the Anthropic API with your key and are billed to you. The agent re-sends
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
```

If `npm run dev` exits immediately, check that `ELECTRON_RUN_AS_NODE` is not set in your shell.

### Layout

```
src/main/        Electron main process: files, terminal (node-pty), AI (ai.ts), agent loop and tools (agent.ts)
src/preload/     Typed bridge exposed to the UI as window.api
src/renderer/    React UI: App, ChatPanel, AgentPanel, InlineEdit, autocomplete, dialogs
build/           App icon and the afterPack hook that stamps the exe (rcedit)
tests/e2e.cjs    End-to-end test (fake API server + Chrome DevTools Protocol)
tests/real-e2e.cjs  Same driver against the real API (opt-in, costs money)
```

### Publishing an update

Updates come from GitHub Releases. One-time setup: in `electron-builder.yml`, replace `YOUR_GITHUB_USER` (and `repo` if yours is not
called `my-ai-ide`) with your account and repository. The repository must be public (a private one would need a token inside the
app). While `owner` is the placeholder `YOUR_GITHUB_USER` the app says "Updates are not set up in this build" and makes no network calls.

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

- Saved agent history keeps the most recent turns only (about 1.5 MB); older ones are dropped whole. The saved files contain file contents the agent read, unencrypted, so treat that folder like your project.
- Autocomplete sees only the current file.
- Only tested on Windows 11.
- Not built (compared with VS Code and Cursor): extensions/marketplace, debugger, remote/SSH/WSL workspaces, split editors, multi-root workspaces, codebase-wide semantic index, tab-to-next-edit prediction, background agents. Git has no merge-conflict UI, stash or history view.
