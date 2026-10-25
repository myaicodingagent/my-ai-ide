import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { createServer, Socket } from 'net'
import { PassThrough } from 'stream'
import * as ssh from './sshfs'
import { wslLocation, wslUnc } from './shellspec'

// Where a program runs when the project folder is not on this PC's disk: on another computer over SSH, or in a WSL distribution.
// The debuggers ask this module instead of sshfs.ts, so both are handled alike: a program is started there, its debugger port is
// reached from here, and file paths are translated (the editor's \\ssh.name\home\me\x or \\wsl.localhost\Ubuntu\home\me\x
// against /home/me/x for the program). A WSL distribution is named "wsl:<distro>"; a computer by the name of its connection.

export type RemoteProcess = ssh.RemoteProcess

export const isRemotePath = (p: unknown): boolean => ssh.isRemotePath(p) || (typeof p === 'string' && wslLocation(p) !== null)

export function parseRemote(p: string): { name: string; path: string } | null {
  const w = wslLocation(p)
  return w ? { name: 'wsl:' + w.distro, path: w.path } : ssh.parseRemote(p)
}

/** The path as the programs there write it. */
export function nativePath(unc: string): string | null {
  const w = wslLocation(unc)
  return w ? w.path : ssh.nativePath(unc)
}

/** The editor's address for a path that a program there reported. */
export function fromNativePath(name: string, p: string): string {
  return name.startsWith('wsl:') ? wslUnc(name.slice(4), p.replace(/\\/g, '/')) : ssh.fromNativePath(name, p)
}

/**
 * Makes a port that a program there listens on (127.0.0.1) reachable here, on a port of this PC. Each connection is carried by a
 * wsl.exe that runs a small bridge inside the distribution (bash's /dev/tcp). WSL's own localhost forwarding is not used: it
 * notices new ports only after a delay, and a debugger that accepts one client (debugpy, Delve) cannot be probed for readiness.
 */
export function forwardPort(unc: string, port: number): Promise<{ port: number; close(): void }> {
  const w = wslLocation(unc)
  if (!w) return ssh.forwardPort(unc, port)
  const sockets = new Set<Socket>()
  const children = new Set<ChildProcess>()
  const listening = waitListening(w.distro, port)
  const server = createServer((sock) => {
    sockets.add(sock)
    const bridge = spawn('wsl.exe', ['-d', w.distro, '--exec', 'bash', '-c', 'exec 3<>/dev/tcp/127.0.0.1/$1 || exit 1; cat >&3 <&0 & cat <&3; kill $! 2>/dev/null', 'bash', String(port)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    children.add(bridge)
    sock.pipe(bridge.stdin)
    bridge.stdout.pipe(sock)
    const end = (): void => {
      sock.destroy()
      bridge.kill()
    }
    bridge.on('close', end)
    bridge.on('error', end)
    bridge.stdin.on('error', () => undefined)
    sock.on('close', () => {
      sockets.delete(sock)
      children.delete(bridge)
      bridge.kill()
    })
    sock.on('error', () => sock.destroy())
  })
  return listening.then(
    () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          resolve({
            port: (server.address() as { port: number }).port,
            close: () => {
              for (const x of sockets) x.destroy()
              for (const c of children) c.kill()
              server.close()
            }
          })
        })
      })
  )
}

/**
 * Waits until something listens on a port inside the distribution, by reading the kernel's table of sockets (a connection would be
 * taken for the debugger's client). Programs that were just started need a moment, and a bridge that finds no listener gives up
 * only after wsl.exe has started, which is too slow to tell "not yet" from "connected".
 */
async function waitListening(distro: string, port: number): Promise<void> {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  const script = `grep -Eiq ':${hex} [0-9A-F:]+ 0A ' /proc/net/tcp /proc/net/tcp6`
  const t0 = Date.now()
  for (;;) {
    const ok = await new Promise<boolean>((res) => {
      const p = spawn('wsl.exe', ['-d', distro, '--exec', 'sh', '-c', script], { stdio: 'ignore', windowsHide: true })
      p.once('close', (code) => res(code === 0))
      p.once('error', () => res(false))
    })
    if (ok) return
    if (Date.now() - t0 > 30_000) throw new Error(`Nothing listens on port ${port} in the distribution.`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Throws a readable error unless the file exists. */
export async function requireFile(unc: string): Promise<void> {
  if (!wslLocation(unc)) return ssh.requireFile(unc)
  const st = await fs.stat(unc).catch(() => null)
  if (!st || !st.isFile()) throw new Error(`The file does not exist: ${unc}`)
}

const shq = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

/**
 * Starts a program there, in the folder `unc` names, shaped like a child process. kill() ends the program itself (the shell
 * reports its process id first), not only the wsl.exe that carries its output.
 */
export function spawnRemote(unc: string, command: string[], opts: { env?: Record<string, string>; stdin?: boolean } = {}): RemoteProcess {
  const w = wslLocation(unc)
  if (!w) return ssh.spawnRemote(unc, command, opts)
  const proc = new EventEmitter() as RemoteProcess
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.pid = 0
  proc.exitCode = null
  const env = Object.entries(opts.env ?? {}).map(([k, v]) => `export ${k}=${shq(v)}`)
  const line = `echo __MYIDE_PID__$$ && ${[...env, ''].join(' && ')}exec ${command.map(shq).join(' ')}`
  const child = spawn('wsl.exe', ['-d', w.distro, '--cd', w.path, '--exec', 'sh', '-c', line], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let ended = false
  proc.kill = (): boolean => {
    if (ended) return false
    if (proc.pid) spawn('wsl.exe', ['-d', w.distro, '--exec', 'sh', '-c', `kill ${proc.pid} 2>/dev/null || kill -9 ${proc.pid} 2>/dev/null; true`], { stdio: 'ignore', windowsHide: true })
    setTimeout(() => child.kill(), 1500)
    return true
  }
  let head: Buffer = Buffer.alloc(0)
  let gotPid = false
  child.stdout.on('data', (d: Buffer) => {
    if (gotPid) return void proc.stdout.write(d)
    head = Buffer.concat([head, d])
    const nl = head.indexOf(10)
    if (nl < 0) return
    const m = /__MYIDE_PID__(\d+)/.exec(head.subarray(0, nl).toString('latin1'))
    gotPid = true
    if (m) proc.pid = Number(m[1])
    const rest = head.subarray(nl + 1)
    if (rest.length) proc.stdout.write(rest)
  })
  child.stderr.on('data', (d: Buffer) => proc.stderr.write(d))
  child.on('error', (e) => proc.emit('error', e))
  child.on('close', (code) => {
    ended = true
    proc.exitCode = code ?? -1
    proc.stdout.end()
    proc.stderr.end()
    proc.emit('close', code)
  })
  if (opts.stdin) proc.stdin.pipe(child.stdin)
  else child.stdin.end()
  return proc
}
