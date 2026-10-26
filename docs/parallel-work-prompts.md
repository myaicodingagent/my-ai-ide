# Prompts for parallel sessions

Each prompt below is self-contained and is meant for its own Claude Code session, in its own git worktree
(`git worktree add ../my-ai-ide-<name> -b <branch>`), so the sessions do not step on each other. They touch different files.
Start from `main` (it is green in CI). Each prompt ends with the rules that apply to all of them.

Rules for every session (put them at the end of each prompt, or in CLAUDE.md):

- Work on your own branch. Do not push to `main`, do not tag, do not publish a GitHub release.
- Do not run `npm run test:nvda`: it takes over the keyboard and sends keys to whatever window is in front.
- Tests that need Docker use the container `sshtest` (see the top of `tests/ssh-linux.cjs`); do not delete it.
- Run `npm run typecheck`, `npm run build` and the tests named in the prompt before you say you are done; show the output.
- Update the README (the feature row, the test list and *Known limits*) in the same commit as the change.
- Say plainly what you did not finish or could not test.

---

## 1. Extension comments API (`vscode.comments`)

Branch `comments-api`. Files you own: `src/main/exthost.js` (the `vscode` API layer), `src/main/extensions.ts`, a new
`src/renderer/src/comments.ts`, and a small part of `src/renderer/src/App.tsx`/`monaco-setup.ts`.

> Read the *Extensions* row of README.md and src/main/exthost.js first. Add the part of the VS Code comments API that extensions
> for code review use: `vscode.comments.createCommentController(id, label)`, `controller.createCommentThread(uri, range, comments)`,
> `commentingRangeProvider`, `CommentThread` (`range`, `comments`, `collapsibleState`, `canReply`, `dispose()`), `Comment`
> (`author`, `body`, `mode`, `contextValue`), `onDidChangeCommentThreads`, and the menus `comments/comment/title`,
> `comments/commentThread/title` and `comments/commentThread/context`. Threads are drawn in the editor as Monaco view zones under
> the line with the author, the text (markdown), a reply box when `canReply` is true, and the menu entries as buttons; the reply
> command gets a `CommentReply` ({ thread, text }). Keep it keyboard and screen-reader usable (roles, names, announce new
> comments). Add `tests/ext-comments.cjs` in the style of `tests/ext-tree.cjs` (a small extension written to a temp folder,
> the real app driven through the debugging port) and an `npm run test:ext-comments` script. Update the README: the Extensions
> row and *Known limits* (remove `comments/*` from the ignored menus).

## 2. Live Share: undo, line endings, many guests

Branch `liveshare-undo`. Files you own: `src/renderer/src/liveshare.ts`, `src/main/liveshare.ts`, `tests/liveshare*.cjs`.

> Read README.md (Live Share row and *Known limits*) and both liveshare.ts files. Fix the two known limits and test eight guests:
> (1) Undo after somebody else's edit is odd: make Ctrl+Z undo only your own edits, using a Yjs `UndoManager` scoped to the
> 'local' origin and wired to the editor's undo/redo, so a guest's undo does not remove the host's typing. (2) Text files with
> Windows line endings can drift when one side's pasted text has another line ending: normalise what goes into the shared
> `Y.Text` to `\n`, convert offsets between the model (which counts `\r\n` as two) and the Y.Text, and keep each side's model
> line ending. Add tests to `tests/liveshare.cjs` (a CRLF file edited from both sides ends identical on disk and in both editors;
> undo after a remote edit) and a handler-level `tests/liveshare-many.cjs` with eight raw WebSocket guests that join, open a
> document and type at the same time: all nine copies must converge, and a ninth guest must be refused with "The session is
> full". Run `npm run test:liveshare`, `npm run test:liveshare-remote`, `npm run test:liveshare-remote-ui` (needs Docker) and the new one.

## 3. macOS and Linux builds, and a Linux CI job

Branch `cross-platform`. Files you own: `electron-builder.yml`, `package.json` scripts, `.github/workflows/`, and small
platform fixes in `src/main/*.ts` (not Live Share, not the extension host).

> The editor has only ever run on Windows 11 (README *Known limits*). Make a first honest step towards macOS and Linux:
> (1) find the places in src/main that assume Windows (`\\` paths, `powershell`, `.exe`, UNC `\\wsl.localhost` and `\\ssh.`
> addresses, `safeStorage` fallbacks, shells in `shellspec.ts`, `taskkill`, `where`) and make each one either work, or fail with
> a clear message on other systems, with the WSL and the SSH-by-UNC-path features kept Windows-only but not crashing elsewhere;
> (2) add `mac` and `linux` targets to electron-builder.yml (dmg and AppImage, unsigned) behind separate npm scripts; (3) extend
> `.github/workflows/ci.yml` with an `ubuntu-latest` job that runs typecheck, build and the tests that need only Node and git
> (`git fsops index merge contrast nbmodel when backend ext`), and a manual-trigger workflow `build.yml` that builds the Linux
> AppImage and uploads it as a workflow artifact (no release). Report which tests pass on Linux and which do not, with the
> reason. Do not claim macOS works: nobody has run it.

## 4. Code signing and a safer release pipeline

Branch `signing`. Files you own: `electron-builder.yml`, `.github/workflows/release.yml`, `docs/releasing.md`.

> The installer is unsigned, so Windows SmartScreen warns. Prepare signing without needing the certificate yet: (1) in
> electron-builder.yml use `win.signtoolOptions` or Azure Trusted Signing (`azureSignOptions`), whichever electron-builder 25
> supports, driven by environment variables so that nothing changes when they are not set (the unsigned build must still work);
> remove `signAndEditExecutable: false` only if that is safe without a certificate; (2) add a manually triggered workflow
> `release.yml` (workflow_dispatch with a `version` input) on `windows-latest` that checks out, runs typecheck and the CI tests,
> builds with `npm run dist` using the secrets if present, and creates a **draft** GitHub release with the installer,
> blockmap and latest.yml (never a published one); (3) write `docs/releasing.md`: how to get a certificate (Azure Trusted Signing
> vs an EV certificate: cost, time, what is verified), which secrets to add, how to test an update from the previous version
> (`MY_AI_IDE_UPDATE_URL`, and the script that was used for 0.2.0: install the old installer silently with `/S /currentuser
> /D=<folder>`, start it with a debugging port, call `window.api.updateCheck()` and `updateDownload()`), and how to roll back a
> bad release. Do not create or edit any release yourself.

## 5. Agent history without the 1.5 MB limit, and autocomplete over the project

Branch `agent-context`. Files you own: `src/main/agent.ts`, `src/main/ai.ts`, `src/renderer/src/autocomplete.ts`, `src/main/codeindex.ts`.

> Two known limits. (1) Saved agent history keeps only about 1.5 MB, dropping older turns whole. Replace the dropping with
> summarising: when a conversation is over the limit, ask the model (the cheapest configured one) to summarise the oldest turns
> into one short message that keeps decisions, file names and open questions, store the summary as the first message, and show it
> in the transcript as "Earlier conversation (summarised)". Keep the files encrypted as they are now. (2) Autocomplete sends
> only the current file and a few open ones. Use the existing code index (`codeindex.ts`, search by meaning) to add up to three
> short snippets of the project that match the text around the cursor, within the token budget, and never for files that are
> in `.gitignore` or match the secret patterns the agent already refuses to read. Add tests in the style of
> `tests/backend-handlers.cjs` and `tests/index-handlers.cjs` (no real API calls: use the fake model server the tests already
> use). Do not run `npm run test:real`: it spends real tokens.

## 6. A person's check with Narrator and JAWS (for you, not for a session)

Not a prompt: follow `docs/screen-reader-checklist.md` with each screen reader and fill in the table at its end; then give the
results to a session with this prompt:

> Here are the results of the screen reader check (paste the table). For each failed step, find the cause in the code
> (names, roles, live regions, focus), fix it, and add a check to `tests/nvda.cjs` or `tests/liveshare.cjs` when a machine can
> check it. Do not run `npm run test:nvda` while I am using the PC.
