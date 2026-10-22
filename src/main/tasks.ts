import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { parseJsonc } from './jsonc'

// Tasks and launch configurations.
//   .ai-ide/tasks.json   (or .vscode/tasks.json)   what "Tasks: Run Task" offers, in VS Code's format
//   .ai-ide/launch.json  (or .vscode/launch.json)   what the debugger can start
// npm scripts from package.json are offered as tasks as well. The files are read, never changed, except that
// "Open Tasks File" creates a starter file when there is none.

export interface TaskDef {
  label: string
  command: string // the full command line, ready for a shell
  cwd?: string
  group?: string // build, test...
  dependsOn: string[]
  detail?: string
  source: 'file' | 'npm'
}

export interface LaunchConfig {
  name: string
  program: string
  args: string[]
  cwd?: string
  stopOnEntry: boolean
  env: Record<string, string>
}

export interface TasksInfo {
  tasks: TaskDef[]
  launch: LaunchConfig[]
  tasksFile: string | null
  launchFile: string | null
  errors: string[]
}

const FOLDERS = ['.ai-ide', '.vscode']

/** Quotes an argument for PowerShell / POSIX shells when it needs it. */
export function quoteArg(a: string): string {
  if (a !== '' && /^[\w@%+=:,./\\-]+$/.test(a)) return a
  return "'" + a.replace(/'/g, "''") + "'"
}

async function readFirst(root: string, name: string): Promise<{ file: string; data: unknown } | { file: string; error: string } | null> {
  for (const dir of FOLDERS) {
    const file = join(root, dir, name)
    let text: string
    try {
      text = await fs.readFile(file, 'utf-8')
    } catch {
      continue
    }
    try {
      return { file, data: parseJsonc(text) }
    } catch (e) {
      return { file, error: `${dir}/${name}: not valid JSON (${(e as Error).message})` }
    }
  }
  return null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function parseTasks(data: unknown, errors: string[]): TaskDef[] {
  const out: TaskDef[] = []
  const list = Array.isArray((data as { tasks?: unknown })?.tasks) ? ((data as { tasks: unknown[] }).tasks) : []
  const base = (data ?? {}) as Record<string, unknown>
  list.forEach((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>
    const label = str(t.label) ?? str(t.taskName)
    if (!label) return void errors.push(`tasks[${i}] has no "label"`)
    const baseCommand = str(t.command) ?? str(base.command)
    const dependsOn = typeof t.dependsOn === 'string' ? [t.dependsOn] : strList(t.dependsOn)
    if (!baseCommand && dependsOn.length === 0) return void errors.push(`task "${label}" has no "command"`)
    const args = Array.isArray(t.args) ? t.args.map((a) => (typeof a === 'string' ? a : (a as { value?: string })?.value ?? '')) : []
    const options = (t.options ?? {}) as Record<string, unknown>
    const group = typeof t.group === 'string' ? t.group : str((t.group as { kind?: unknown })?.kind)
    out.push({
      label,
      command: baseCommand ? [baseCommand, ...args.map(quoteArg)].join(' ') : '',
      cwd: str(options.cwd),
      group,
      dependsOn,
      detail: str(t.detail),
      source: 'file'
    })
  })
  return out
}

export function parseLaunch(data: unknown, errors: string[]): LaunchConfig[] {
  const out: LaunchConfig[] = []
  const list = Array.isArray((data as { configurations?: unknown })?.configurations) ? (data as { configurations: unknown[] }).configurations : []
  list.forEach((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>
    const name = str(c.name)
    if (!name) return void errors.push(`configurations[${i}] has no "name"`)
    if (c.type !== undefined && !['node', 'pwa-node', 'python', 'debugpy'].includes(String(c.type))) return void errors.push(`"${name}": only "node" and "python" configurations are supported (this one is "${String(c.type)}")`)
    if (c.request !== undefined && c.request !== 'launch') return void errors.push(`"${name}": only "launch" is supported`)
    const program = str(c.program)
    if (!program) return void errors.push(`"${name}" has no "program"`)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries((c.env ?? {}) as Record<string, unknown>)) if (typeof v === 'string' || typeof v === 'number') env[k] = String(v)
    out.push({ name, program, args: strList(c.args), cwd: str(c.cwd), stopOnEntry: c.stopOnEntry === true, env })
  })
  return out
}

async function npmTasks(root: string): Promise<TaskDef[]> {
  try {
    const pkg = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf-8')) as { scripts?: Record<string, unknown> }
    return Object.entries(pkg.scripts ?? {})
      .filter(([, v]) => typeof v === 'string')
      .slice(0, 100)
      .map(([name, v]): TaskDef => ({
        label: `npm: ${name}`,
        command: name === 'start' || name === 'test' ? `npm ${name}` : `npm run ${quoteArg(name)}`,
        group: /^build/.test(name) ? 'build' : /^test/.test(name) ? 'test' : undefined,
        dependsOn: [],
        detail: String(v),
        source: 'npm'
      }))
  } catch {
    return []
  }
}

export async function loadTasks(root: string): Promise<TasksInfo> {
  const errors: string[] = []
  const info: TasksInfo = { tasks: [], launch: [], tasksFile: null, launchFile: null, errors }
  const t = await readFirst(root, 'tasks.json')
  if (t) {
    info.tasksFile = t.file
    if ('error' in t) errors.push(t.error)
    else info.tasks.push(...parseTasks(t.data, errors))
  }
  const l = await readFirst(root, 'launch.json')
  if (l) {
    info.launchFile = l.file
    if ('error' in l) errors.push(l.error)
    else info.launch.push(...parseLaunch(l.data, errors))
  }
  const labels = new Set(info.tasks.map((x) => x.label))
  info.tasks.push(...(await npmTasks(root)).filter((x) => !labels.has(x.label)))
  return info
}

const TASKS_TEMPLATE = `{
  // Tasks you can run from the command palette: "Tasks: Run Task".
  // Same format as VS Code's tasks.json. \${workspaceFolder} and \${file} can be used in commands.
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Say hello",
      "type": "shell",
      "command": "echo",
      "args": ["Hello from a task"],
      "group": "build"
    }
  ]
}
`

const LAUNCH_TEMPLATE = `{
  // Programs the debugger can start (JavaScript or TypeScript on Node, and Python). Choose one in the Run view, then press F5.
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run index.js",
      "type": "node",
      "request": "launch",
      "program": "\${workspaceFolder}/index.js",
      "args": [],
      "stopOnEntry": false,
      "env": {}
    }
  ]
}
`

export function registerTaskHandlers(): void {
  ipcMain.handle('tasks:load', (_e, root: string) => loadTasks(root))
  // Opens (creating from a starter file when needed) tasks.json or launch.json; returns its path.
  ipcMain.handle('tasks:ensure', async (_e, root: string, kind: 'tasks' | 'launch') => {
    const name = kind === 'tasks' ? 'tasks.json' : 'launch.json'
    for (const dir of FOLDERS) {
      const file = join(root, dir, name)
      try {
        await fs.access(file)
        return file
      } catch {
        // try the next folder
      }
    }
    const file = join(root, '.ai-ide', name)
    await fs.mkdir(join(root, '.ai-ide'), { recursive: true })
    await fs.writeFile(file, kind === 'tasks' ? TASKS_TEMPLATE : LAUNCH_TEMPLATE, 'utf-8')
    return file
  })
}
