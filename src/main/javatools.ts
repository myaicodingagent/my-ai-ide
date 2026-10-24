import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, promises as fs } from 'fs'
import { app } from 'electron'
import { basename, delimiter, dirname, join } from 'path'
import JAVA_DAP_SOURCE from './JavaDap.java?raw'

// Java: the editor's own debug adapter (JavaDap.java, built on the JDK's Java Debug Interface) is compiled once with the
// user's javac and started with their java; a single source file (with the files next to it that it uses) is compiled
// with debug information and run.

export const JAVA_HELP =
  process.platform === 'win32'
    ? 'Java debugging needs a JDK (the Java compiler "javac", not only the runtime). Run "Debug: Install the Java Debugger (JDK)" from the command palette (Ctrl+Shift+P), or install one yourself:  winget install EclipseAdoptium.Temurin.21.JDK'
    : process.platform === 'darwin'
      ? 'Java debugging needs a JDK (the Java compiler "javac"). Install one with:  brew install openjdk   (or from adoptium.net)'
      : 'Java debugging needs a JDK (the Java compiler "javac"). For example:  sudo apt install default-jdk   (or: sudo dnf install java-latest-openjdk-devel)'

const exe = (n: string): string => (process.platform === 'win32' ? n + '.exe' : n)

function jdkBinDirs(): string[] {
  const out: string[] = []
  const add = (d: string | undefined): void => {
    if (d && !out.includes(d) && existsSync(join(d, exe('javac')))) out.push(d)
  }
  const kids = (d: string): string[] => {
    try {
      return readdirSync(d).map((n) => join(d, n)).filter((p) => statSync(p).isDirectory())
    } catch {
      return []
    }
  }
  if (process.env.JAVA_HOME) add(join(process.env.JAVA_HOME.replace(/^"|"$/g, ''), 'bin'))
  for (const d of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) add(d)
  if (process.platform === 'win32') {
    for (const base of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Amazon Corretto', 'Zulu', 'BellSoft', 'Semeru']) {
      for (const root of [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)']) for (const j of kids(join(root, base))) add(join(j, 'bin'))
    }
  } else if (process.platform === 'darwin') {
    for (const j of kids('/Library/Java/JavaVirtualMachines')) add(join(j, 'Contents', 'Home', 'bin'))
    add('/opt/homebrew/opt/openjdk/bin')
  } else {
    for (const j of kids('/usr/lib/jvm')) add(join(j, 'bin'))
  }
  return out
}

/** The first JDK found (JAVA_HOME, the PATH, the usual places): both `java` and `javac` must be there. */
export function findJdk(): { java: string; javac: string } | null {
  const bin = jdkBinDirs()[0]
  return bin && existsSync(join(bin, exe('java'))) ? { java: join(bin, exe('java')), javac: join(bin, exe('javac')) } : null
}

function run(file: string, args: string[], cwd: string): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(file, args, { cwd, windowsHide: true })
    let text = ''
    const take = (b: Buffer): void => {
      text = (text + b.toString('utf-8')).slice(-12000)
    }
    c.stdout.on('data', take)
    c.stderr.on('data', take)
    c.on('error', (e) => reject(new Error(`Could not run ${basename(file)}: ${e.message}`)))
    c.on('close', (code) => resolve({ code: code ?? -1, text }))
  })
}

/** The folder with the compiled adapter (made the first time, and again when the editor's version of it changes). */
export async function ensureJavaAdapter(javac: string): Promise<string> {
  const stamp = createHash('sha1').update(JAVA_DAP_SOURCE).digest('hex').slice(0, 10)
  const dir = join(app.getPath('userData'), 'tools', 'java-dap', stamp)
  if (existsSync(join(dir, 'JavaDap.class'))) return dir
  await fs.mkdir(dir, { recursive: true })
  const src = join(dir, 'JavaDap.java')
  await fs.writeFile(src, JAVA_DAP_SOURCE, 'utf-8')
  const r = await run(javac, ['-encoding', 'UTF-8', '-d', dir, src], dir)
  if (r.code !== 0) throw new Error('Could not build the Java debugger with this JDK:\n' + r.text.trim().slice(-800))
  return dir
}

export interface JavaProgram {
  mainClass: string
  classes: string // the folder with the compiled classes
  sourceRoot: string // the folder the package names start at
}

/** Compiles one source file (and what it uses from the folder its package starts at) with debug information. */
export async function compileJava(file: string, javac: string): Promise<JavaProgram> {
  try {
    file = realpathSync.native(file)
  } catch {
    // keep as given
  }
  const text = readFileSync(file, 'utf-8')
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? ''
  const cls = basename(file, '.java')
  if (!/\bstatic\s+void\s+main\s*\(/.test(text) && !/\bvoid\s+main\s*\(/.test(text)) throw new Error(`${basename(file)} has no main method, so there is nothing to run. Open the file that has public static void main(String[] args).`)
  // The folder the package starts at: the file's own folder with the package path taken off its end.
  let root = dirname(file)
  if (pkg) {
    const rel = pkg.split('.').join(process.platform === 'win32' ? '\\' : '/')
    if (root.toLowerCase().endsWith(rel.toLowerCase())) root = root.slice(0, root.length - rel.length).replace(/[\\/]+$/, '')
  }
  const outDir = join(app.getPath('userData'), 'javabuild', createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 10))
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })
  const r = await run(javac, ['-g', '-encoding', 'UTF-8', '-d', outDir, '-sourcepath', root, file], dirname(file))
  if (r.code !== 0) {
    throw new Error('The program did not compile:\n' + r.text.trim().split(/\r?\n/).slice(0, 14).join('\n'))
  }
  return { mainClass: pkg ? `${pkg}.${cls}` : cls, classes: outDir, sourceRoot: root }
}
