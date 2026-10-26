# Screen reader check by a person (Narrator and JAWS)

`npm run test:nvda` checks by machine what NVDA says in the main places. Nobody has yet checked **Narrator** or **JAWS**, or used the
newest features with any screen reader. This list is for a person to walk through, about 30 minutes per screen reader. Write down
every place where something is not said, said wrongly, or said twice.

Use the installed app (`release/My-AI-IDE-Setup-<version>.exe`), a folder with a few files, and the keyboard only.

Turn on *Screen reader mode* in Settings if the app has not detected the screen reader by itself (the editor and terminal should
announce it with a message the first time).

## Narrator (Windows, Ctrl+Win+Enter)

Narrator is known to treat the window differently from NVDA and JAWS (it has its own scan mode). For each step note what Narrator
says and whether scan mode (Caps Lock + Space) has to be off.

## JAWS

JAWS: if the virtual cursor takes the keys in the editor or the terminal, say so (the window is marked as an *application* to avoid this).

## Steps (same for both)

| # | Do | Expect to hear |
|---|----|----------------|
| 1 | Start the app, open a folder | the folder's name; F6 moves between explorer, editor, terminal, chat and says which |
| 2 | In the explorer: arrow down, Right to open a folder, Enter on a file | each row: name, level, "collapsed/expanded", position ("2 of 5"), git change; "Opened a.txt" |
| 3 | In the editor: arrows, type, Ctrl+S | the line read on moving; typed characters; "Saved a.txt" |
| 4 | Ctrl+Shift+P, type "save", arrows, Escape | "Type a command, dialog"; each entry with "n of m"; back in the editor |
| 5 | Alt+F, arrows, Escape | the menu bar, then each entry; focus returns |
| 6 | Ctrl+Shift+F, search for a word | the box is named; "n results in m files" |
| 7 | Ctrl+Shift+G | the commit message box is named; changed files with their state |
| 8 | Ctrl+` | the terminal; type `echo hi`, Enter: the output is read |
| 9 | Run a file with F5 on a `debugger;` line, or a breakpoint | "Paused ... in f, a.js line 2"; the call stack is reachable with Tab |
| 10 | Settings: Tab through all controls, Escape | every control has a name and a role; focus returns |

## Live Share (needs a second person or a second window)

| # | Do | Expect to hear |
|---|----|----------------|
| 11 | Host: palette → *Live Share: Start a Session*, answer the two questions | both questions are read with their buttons; the code is copied |
| 12 | Guest: palette → *Live Share: Join a Session*, paste the code | the dialog is named; after joining, the explorer shows the host's folder |
| 13 | Either: Tab to the status bar item | "Live Share: hosting/joined, 2 people: names..." (host: ". Press to copy the session code") |
| 14 | Someone joins or leaves | "X joined / left the Live Share session" |
| 15 | Host: *Live Share: Share the Terminal…*, watch-only; guest opens the terminal tab | "Shared terminal, read only"; the host's output is read as it arrives |
| 16 | Guest: *Live Share: Follow a Participant…* | the question is read with the names as buttons; "Following X"; the editor follows |
| 17 | Cut the host's network briefly | guest hears "The connection to the host was lost. Trying to reconnect." then "Reconnected to the Live Share session" |
| 18 | Host debugs and stops on a breakpoint | guest hears "The program of the host stopped in f"; the Run view lists the stack |

## Agents

| # | Do | Expect to hear |
|---|----|----------------|
| 19 | Start a background agent; Tab to its card | "Background task: ..., status" as a group; the changed files are buttons ("a.txt, modified. Press Enter to see what changed") |
| 20 | A task waits for approval | "Background task needs approval to run a command: ..." |

Record the result per screen reader in the table below and open an issue for each problem.

| Screen reader | Version | Date | Steps that failed (number and what happened) |
|---------------|---------|------|-----------------------------------------------|
| Narrator | | | |
| JAWS | | | |
