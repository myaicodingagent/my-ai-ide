import { createHash } from 'crypto'
import { basename } from 'path'
import * as host from './hostenv'
import { CPP_HELP, isCppSource } from './cpptools'
import { JAVA_HELP } from './javatools'
import JAVA_DAP_SOURCE from './JavaDap.java?raw'

// Building and finding the debuggers for C/C++ and Java in a folder on another computer or in a WSL distribution (a POSIX
// system): the compiler, the debug adapter and the program are all there. These return what dap.ts needs to start the adapter.

const TOOL_PATH = 'PATH="$PATH:/usr/local/bin:/usr/lib/llvm-18/bin:/usr/lib/llvm-17/bin:/usr/lib/llvm-16/bin:$HOME/.local/bin:/usr/lib/jvm/default-java/bin"'
const where = (unc: string): string => (host.parseRemote(unc)?.name.startsWith('wsl:') ? 'in the distribution' : 'on the other computer')

/** The full path of the first of these programs that the other system has (on its PATH or in the usual install folders). */
export async function remoteTool(folderUnc: string, names: string[]): Promise<string | null> {
  const r = await host.exec(folderUnc, ['sh', '-c', `${TOOL_PATH}; for c in "$@"; do p=$(command -v "$c") && { echo "$p"; exit 0; }; done; exit 1`, 'sh', ...names], { timeout: 20_000 })
  if (r.code === -1) throw new Error(r.stderr || 'Could not reach the other system.')
  return r.code === 0 ? r.stdout.trim().split('\n')[0] : null
}

const outputOf = (r: { stdout: string; stderr: string }): string => (r.stderr + r.stdout).trim()
const hashOf = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 10)

/** C or C++: compiles the file there with debug information; returns the program and lldb-dap (both as paths there). */
export async function prepareRemoteCpp(file: string, cwdUnc: string): Promise<{ debuggerPath: string; program: string }> {
  if (!isCppSource(file)) throw new Error('Open a .c or .cpp file to debug it (a header cannot be run).')
  const native = host.nativePath(file) as string
  const debuggerPath = await remoteTool(cwdUnc, ['lldb-dap', 'lldb-dap-18', 'lldb-dap-17', 'lldb-dap-16', 'lldb-vscode'])
  if (!debuggerPath) throw new Error(`lldb-dap was not found ${where(cwdUnc)}. ${CPP_HELP}`)
  const cpp = !/\.c$/i.test(native)
  const outDir = `/tmp/my-ai-ide-cpp-${hashOf(native)}`
  const script = `${TOOL_PATH}; mkdir -p "$2"; for c in $3; do if command -v "$c" >/dev/null 2>&1; then exec "$c" -g -O0 "$1" -o "$2/prog"; fi; done; echo "no compiler" >&2; exit 127`
  const r = await host.exec(cwdUnc, ['sh', '-c', script, 'sh', native, outDir, cpp ? 'clang++ g++ c++' : 'clang gcc cc'], { timeout: 120_000 })
  if (r.code === 127 && /no compiler/.test(r.stderr)) throw new Error(`No ${cpp ? 'C++' : 'C'} compiler was found ${where(cwdUnc)} (clang or gcc).`)
  if (r.code !== 0) {
    const lines = outputOf(r).split(/\r?\n/).filter((l) => /error|undefined reference|cannot find/i.test(l))
    throw new Error('The program did not compile:\n' + (lines.length ? [...new Set(lines)].slice(0, 10).join('\n') : outputOf(r).slice(-900)))
  }
  return { debuggerPath, program: `${outDir}/prog` }
}

/** Java: finds the JDK there, makes sure the editor's adapter is compiled there, and compiles the file. */
export async function prepareRemoteJava(file: string | null, cwdUnc: string): Promise<{ java: string; adapterDir: string; mainClass?: string; classes?: string; sourceRoot?: string }> {
  const javac = await remoteTool(cwdUnc, ['javac'])
  const java = await remoteTool(cwdUnc, ['java'])
  if (!javac || !java) throw new Error(`No JDK was found ${where(cwdUnc)}. ${JAVA_HELP}`)
  const adapterDir = `/tmp/my-ai-ide-java-dap-${hashOf(JAVA_DAP_SOURCE)}`
  const build = await host.exec(cwdUnc, ['sh', '-c', `[ -f "$2/JavaDap.class" ] || { mkdir -p "$2" && cat > "$2/JavaDap.java" && "$1" -encoding UTF-8 -d "$2" "$2/JavaDap.java"; }`, 'sh', javac, adapterDir], { input: JAVA_DAP_SOURCE, timeout: 120_000 })
  if (build.code !== 0) throw new Error('Could not build the Java debugger with the JDK there:\n' + outputOf(build).slice(-800))
  if (!file) return { java, adapterDir }
  const native = host.nativePath(file) as string
  const text = await host.readFile(file)
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? ''
  const cls = basename(native, '.java')
  if (!/\bvoid\s+main\s*\(/.test(text)) throw new Error(`${basename(native)} has no main method, so there is nothing to run. Open the file that has public static void main.`)
  let sourceRoot = native.slice(0, native.lastIndexOf('/')) || '/'
  if (pkg) {
    const rel = '/' + pkg.split('.').join('/')
    if (sourceRoot.toLowerCase().endsWith(rel.toLowerCase())) sourceRoot = sourceRoot.slice(0, sourceRoot.length - rel.length) || '/'
  }
  const classes = `/tmp/my-ai-ide-java-${hashOf(native)}`
  const r = await host.exec(cwdUnc, ['sh', '-c', 'rm -rf "$1" && mkdir -p "$1" && exec "$2" -g -encoding UTF-8 -d "$1" -sourcepath "$3" "$4"', 'sh', classes, javac, sourceRoot, native], { timeout: 120_000 })
  if (r.code !== 0) throw new Error('The program did not compile:\n' + outputOf(r).split(/\r?\n/).slice(0, 14).join('\n'))
  return { java, adapterDir, mainClass: pkg ? `${pkg}.${cls}` : cls, classes, sourceRoot }
}

const NETCOREDBG_REMOTE_HELP =
  'C# debugging there needs netcoredbg. Download the Linux release from github.com/Samsung/netcoredbg/releases and unpack it so that netcoredbg is on the PATH or at ~/.local/share/my-ai-ide/netcoredbg/netcoredbg, for example: ' +
  'mkdir -p ~/.local/share/my-ai-ide && curl -L https://github.com/Samsung/netcoredbg/releases/latest/download/netcoredbg-linux-amd64.tar.gz | tar -xz -C ~/.local/share/my-ai-ide'

export async function remoteNetcoredbg(folderUnc: string): Promise<string> {
  const p = await remoteTool(folderUnc, ['netcoredbg'])
  if (p) return p
  // the folder under the home directory is not on any PATH: look there directly
  const r = await host.exec(folderUnc, ['sh', '-c', 'f="$HOME/.local/share/my-ai-ide/netcoredbg/netcoredbg"; [ -x "$f" ] && echo "$f"'], { timeout: 10_000 })
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim()
  throw new Error(NETCOREDBG_REMOTE_HELP)
}

/** C#: finds the project above the file there, builds it and returns the program's dll and netcoredbg (paths there). */
export async function prepareRemoteCsharp(file: string, cwdUnc: string, log: (t: string) => void): Promise<{ debuggerPath: string; dll: string; projDir: string }> {
  const native = host.nativePath(file) as string
  const dotnet = await remoteTool(cwdUnc, ['dotnet'])
  if (!dotnet) throw new Error(`The .NET SDK was not found ${where(cwdUnc)}. Install it (dotnet.microsoft.com/download) to build and debug C# there.`)
  const debuggerPath = await remoteNetcoredbg(cwdUnc)
  const find = await host.exec(cwdUnc, ['sh', '-c', 'd=$(dirname "$1"); while :; do p=$(ls "$d"/*.csproj 2>/dev/null | head -n 1); if [ -n "$p" ]; then echo "$p"; exit 0; fi; [ "$d" = / ] && exit 1; d=$(dirname "$d"); done', 'sh', native], { timeout: 10_000 })
  const proj = find.code === 0 ? find.stdout.trim() : ''
  if (!proj) throw new Error('No .csproj file was found next to this file or above it. Create a project with: dotnet new console')
  log(`Building ${basename(proj)}...\n`)
  const projDir = proj.slice(0, proj.lastIndexOf('/')) || '/'
  const build = await host.exec(cwdUnc, ['sh', '-c', 'cd "$2" && DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 "$1" build "$3" -c Debug --nologo -v q -clp:NoSummary', 'sh', dotnet, projDir, proj], { timeout: 300_000 })
  if (build.code !== 0) {
    const errors = outputOf(build).split(/\r?\n/).filter((l) => /\berror\b/i.test(l))
    throw new Error('The project did not build:\n' + (errors.length ? [...new Set(errors)].slice(0, 8).join('\n') : outputOf(build).slice(-800)))
  }
  const target = await host.exec(cwdUnc, ['sh', '-c', 'cd "$2" && DOTNET_CLI_TELEMETRY_OPTOUT=1 "$1" msbuild "$3" -getProperty:TargetPath -p:Configuration=Debug', 'sh', dotnet, projDir, proj], { timeout: 120_000 })
  const dll = target.stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
  if (target.code !== 0 || !dll) throw new Error('The project built, but its program file could not be found.')
  return { debuggerPath, dll, projDir }
}
