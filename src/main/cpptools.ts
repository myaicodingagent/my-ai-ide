import { spawn } from 'child_process'
import { existsSync, readdirSync, realpathSync, statSync, promises as fs } from 'fs'
import { createHash } from 'crypto'
import { app } from 'electron'
import { basename, delimiter, dirname, extname, join } from 'path'
import { homedir } from 'os'

// C and C++: a debug adapter that speaks the Debug Adapter Protocol (lldb-dap from LLVM) and a compiler to make the program (clang or gcc). A single source file is compiled with debug
// information and run; programs built by CMake or Make are debugged through a launch configuration's "program".

export const CPP_HELP =
  process.platform === 'win32'
    ? 'C and C++ debugging needs a debugger and a compiler. Run "Debug: Install the C/C++ Debugger" from the command palette (Ctrl+Shift+P), or install LLVM-MinGW yourself:  winget install MartinStorsjo.LLVM-MinGW.UCRT  (then restart the editor).'
    : process.platform === 'darwin'
      ? 'C and C++ debugging needs lldb-dap and clang. Install them with:  xcode-select --install   (or: brew install llvm)'
      : 'C and C++ debugging needs lldb-dap and clang or gcc. For example:  sudo apt install lldb clang   (or: sudo dnf install lldb clang)'

const exe = (n: string): string => (process.platform === 'win32' ? n + '.exe' : n)

/** Folders that tools are often installed in without being on the PATH (winget packages, MSYS2, Homebrew, versioned LLVM folders). */
function toolDirs(): string[] {
  const out: string[] = []
  const add = (d: string | undefined): void => {
    if (d && !out.includes(d) && existsSync(d)) out.push(d)
  }
  const subdirs = (d: string): string[] => {
    try {
      return readdirSync(d).map((n) => join(d, n)).filter((p) => statSync(p).isDirectory())
    } catch {
      return []
    }
  }
  if (process.platform === 'win32') {
    const pk = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages')
    for (const p of subdirs(pk).filter((x) => /LLVM|MinGW|WinLibs/i.test(basename(x)))) {
      add(join(p, 'bin'))
      add(join(p, 'mingw64', 'bin'))
      for (const q of subdirs(p)) add(join(q, 'bin'))
    }
    add('C:\\Program Files\\LLVM\\bin')
    for (const m of ['ucrt64', 'clang64', 'mingw64']) add(`C:\\msys64\\${m}\\bin`)
    add('C:\\mingw64\\bin')
  } else {
    for (const d of ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin']) add(d)
    for (const p of subdirs('/usr/lib').filter((x) => /llvm-\d+/.test(basename(x)))) add(join(p, 'bin'))
  }
  return out
}

/** The first of the names found on the PATH or in the usual places, searching `first` before anything else. */
export function findTool(names: string[], first: string[] = []): string | null {
  const dirs = [...first, ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter), ...toolDirs()]
  for (const n of names) {
    for (const d of dirs) {
      if (!d) continue
      const f = join(d, exe(n))
      if (existsSync(f)) return f
    }
  }
  return null
}

/** lldb-dap (LLVM's debug adapter; Debian and Ubuntu name it lldb-dap-18 but also keep it in /usr/lib/llvm-18/bin). */
export function findCppDebugger(): string | null {
  return findTool(['lldb-dap', 'lldb-vscode'])
}

export const isCppSource = (file: string): boolean => /\.(c|cc|cpp|cxx|c\+\+)$/i.test(file)

/** Makes the program from one source file, with debug information and without optimizing. Resolves to the program's path. */
export async function compileCpp(file: string, debuggerDir: string): Promise<string> {
  // The debug information records the path the compiler was given; the debugger is told the real (long) spelling of the same file.
  try {
    file = realpathSync.native(file)
  } catch {
    // keep as given
  }
  const cpp = extname(file).toLowerCase() !== '.c'
  const names = cpp ? ['clang++', 'g++', 'c++'] : ['clang', 'gcc', 'cc']
  const compiler = findTool(names, [debuggerDir])
  if (!compiler) throw new Error(`No ${cpp ? 'C++' : 'C'} compiler was found (clang or gcc). ${CPP_HELP}`)
  const outDir = join(app.getPath('userData'), 'cppbuild', createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 10))
  await fs.mkdir(outDir, { recursive: true })
  const out = join(outDir, basename(file, extname(file)) + (process.platform === 'win32' ? '.exe' : ''))
  // On Windows the MinGW runtime libraries are linked in, so the program runs without the compiler's folder on the PATH.
  const args = ['-g', '-O0', ...(process.platform === 'win32' ? ['-static'] : []), file, '-o', out]
  const r = await new Promise<{ code: number; text: string }>((resolve, reject) => {
    const c = spawn(compiler, args, { cwd: dirname(file), windowsHide: true })
    let text = ''
    const take = (b: Buffer): void => {
      text = (text + b.toString('utf-8')).slice(-12000)
    }
    c.stdout.on('data', take)
    c.stderr.on('data', take)
    c.on('error', (e) => reject(new Error(`Could not run the compiler ${compiler}: ${e.message}`)))
    c.on('close', (code) => resolve({ code: code ?? -1, text }))
  })
  if (r.code !== 0) {
    const lines = r.text.split(/\r?\n/).filter((l) => /error|undefined reference|cannot find/i.test(l))
    throw new Error('The program did not compile:\n' + (lines.length ? [...new Set(lines)].slice(0, 10).join('\n') : r.text.trim().slice(-900)))
  }
  return out
}
