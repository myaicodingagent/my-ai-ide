import { execFile } from 'child_process'

// Finding Python 3 on this PC (notebooks and the Python debugger both need it).

export interface PythonInfo {
  file: string // what to run: "py", "python", "python3"
  args: string[] // put before the script ("-3" for the Windows launcher)
  version: string
  executable: string // the interpreter itself (sys.executable)
}

let cache: PythonInfo | null | undefined

function run(file: string, args: string[], timeout = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve(err ? null : (stdout + stderr).trim()))
  })
}

export async function findPython(): Promise<PythonInfo | null> {
  if (cache !== undefined) return cache
  const candidates: [string, string[]][] = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]]
  for (const [file, pre] of candidates) {
    const v = await run(file, [...pre, '--version'])
    if (v && /^Python 3\./.test(v)) {
      const exe = await run(file, [...pre, '-c', 'import sys; print(sys.executable)'])
      return (cache = { file, args: pre, version: v.replace('Python ', ''), executable: exe && !exe.includes('\n') ? exe : file })
    }
  }
  return (cache = null)
}

/** Whether the debugpy package (the Python debugger) can be imported. */
export async function hasDebugpy(py: PythonInfo): Promise<boolean> {
  return (await run(py.file, [...py.args, '-c', 'import debugpy; print(debugpy.__version__)'])) !== null
}

export function resetPythonCache(): void {
  cache = undefined
}
