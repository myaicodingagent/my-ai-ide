import type { TaskDef } from '../../main/tasks'

// Variables like VS Code's: ${workspaceFolder}, ${file} ... Unknown ones are left as they are.
export interface VarContext {
  root: string
  file: string | null // the file open in the editor
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const dirName = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')

export function expandVars(text: string, ctx: VarContext): string {
  return text.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const f = ctx.file
    switch (name) {
      case 'workspaceFolder':
        return ctx.root
      case 'workspaceFolderBasename':
        return baseName(ctx.root)
      case 'file':
        return f ?? whole
      case 'fileBasename':
        return f ? baseName(f) : whole
      case 'fileBasenameNoExtension':
        return f ? baseName(f).replace(/\.[^.]*$/, '') : whole
      case 'fileExtname':
        return f ? (/\.[^.\\/]*$/.exec(baseName(f))?.[0] ?? '') : whole
      case 'fileDirname':
        return f ? dirName(f) : whole
      case 'relativeFile':
        return f && f.toLowerCase().startsWith(ctx.root.toLowerCase()) ? f.slice(ctx.root.length).replace(/^[\\/]/, '') : (f ?? whole)
      default:
        return whole
    }
  })
}

/** The commands to run for a task: what it depends on first (each once), then its own. Missing dependencies are reported. */
export function taskChain(tasks: TaskDef[], label: string): { commands: string[]; missing: string[] } {
  const commands: string[] = []
  const missing: string[] = []
  const done = new Set<string>()
  const visit = (l: string, stack: string[]): void => {
    if (done.has(l) || stack.includes(l)) return
    const t = tasks.find((x) => x.label === l)
    if (!t) return void missing.push(l)
    for (const d of t.dependsOn) visit(d, [...stack, l])
    done.add(l)
    if (t.command) commands.push(t.command)
  }
  visit(label, [])
  return { commands, missing }
}
