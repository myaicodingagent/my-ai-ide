import { ipcMain } from 'electron'
import { join, relative } from 'path'
import { promises as fs } from 'fs'

// Project rules: instructions the user keeps in the project ("use tabs", "run tests with npm test") that
// every AI feature should follow. Plain markdown files in well-known places, so the same files work in other editors.

const FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.ai-ide/rules.md']
const DIRS = ['.cursor/rules', '.ai-ide/rules'] // *.md and *.mdc files inside
const MAX_FILE_CHARS = 20_000
const MAX_TOTAL_CHARS = 40_000
const MAX_FILE_BYTES = 200_000

export interface RuleFile {
  name: string // relative to the project, forward slashes
  path: string // absolute
}

async function readIfSmall(path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    return await fs.readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/** The rule files found in a project and their combined text, ready to put in a prompt. */
export async function loadRules(root: string): Promise<{ files: RuleFile[]; text: string }> {
  if (isRemotePath(root)) return { files: [], text: '' } // rules files on another computer are not read yet
  const found: { file: RuleFile; text: string }[] = []
  const add = async (abs: string): Promise<void> => {
    const text = await readIfSmall(abs)
    if (text && text.trim()) found.push({ file: { name: relative(root, abs).replace(/\\/g, '/'), path: abs }, text })
  }
  for (const f of FILES) await add(join(root, f))
  for (const d of DIRS) {
    const names = await fs.readdir(join(root, d)).catch(() => [] as string[])
    for (const n of names.filter((x) => /\.(md|mdc)$/i.test(x)).sort().slice(0, 10)) await add(join(root, d, n))
  }

  let budget = MAX_TOTAL_CHARS
  const parts: string[] = []
  for (const { file, text } of found) {
    if (budget <= 0) break
    let body = text.trim()
    const limit = Math.min(MAX_FILE_CHARS, budget)
    if (body.length > limit) body = body.slice(0, limit) + `\n[... ${file.name} was cut off here: it is longer than ${limit} characters]`
    parts.push(`### ${file.name}\n${body}`)
    budget -= body.length
  }
  return { files: found.map((f) => f.file), text: parts.join('\n\n') }
}

/** The text to add to a system prompt, or an empty string when the project has no rules. */
export async function rulesPrompt(root: string): Promise<string> {
  const { text } = await loadRules(root)
  return text
    ? '\n\nProject rules. The user keeps these instructions in the project; follow them unless they conflict with what you are told above:\n\n' + text
    : ''
}

const TEMPLATE = `# Project rules

Instructions for AI assistants working in this project. Edit freely; every chat, agent run and inline edit reads this file.

## Conventions
- (for example: use TypeScript, two-space indentation, no semicolons)

## Commands
- Run the tests: (for example: npm test)
- Build: (for example: npm run build)

## Things to avoid
- (for example: do not edit files in src/generated)
`

import { isRemotePath } from './sshfs'

export function registerRulesHandlers(): void {
  ipcMain.handle('rules:load', async (_e, root: string) => {
    const { files, text } = await loadRules(root)
    return { files, chars: text.length }
  })

  ipcMain.handle('rules:prompt', (_e, root: string) => rulesPrompt(root))

  // Creates AGENTS.md from a template, unless the project already has a rules file.
  ipcMain.handle('rules:create', async (_e, root: string) => {
    const existing = (await loadRules(root)).files[0]
    if (existing) return { path: existing.path, created: false }
    const path = join(root, 'AGENTS.md')
    await fs.writeFile(path, TEMPLATE, { encoding: 'utf-8', flag: 'wx' }).catch(() => undefined)
    return { path, created: true }
  })
}
