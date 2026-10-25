import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import * as host from './hostenv'
import type { AgentEvent } from './agent'

// "Cloud" agents: the agent loop runs on a machine you control (a server over SSH, or a WSL distribution), started detached, so it
// keeps going while the editor is closed or the PC sleeps. The runner (src/runner/cloud-runner.ts, one file built by
// scripts/build-runner.cjs) is copied to ~/.my-ai-ide/cloud there. This file is the editor's side of the folder protocol that the
// runner describes: write the task, start it, read the events and the status, answer a command that waits, ask it to stop.

export type CloudPolicy = 'ask' | 'auto' | 'deny'

export interface CloudRun {
  dir: string // the task folder on the server, as its programs write the path
  offset: number // bytes of events.jsonl already read
  policy: CloudPolicy
}

export interface RunnerStatus {
  state: 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
  steps: number
  activity: string
  summary: string
  error: string
  waitId: string
  waitCommand: string
  started: number
  finished: number
}

const HOME = '.my-ai-ide/cloud'

/** The built runner: next to the editor's code (out/runner), or the file MY_AI_IDE_RUNNER_FILE names. */
async function runnerSource(): Promise<string> {
  const candidates = [process.env.MY_AI_IDE_RUNNER_FILE, join(__dirname, '..', 'runner', 'cloud-runner.cjs'), join(app.getAppPath(), 'out', 'runner', 'cloud-runner.cjs')].filter((x): x is string => !!x)
  for (const f of candidates) if (existsSync(f)) return fs.readFile(f, 'utf-8')
  throw new Error('The cloud runner is not part of this build (run npm run build).')
}

const text = (r: { stdout: string; stderr: string }): string => (r.stderr + r.stdout).trim()
const sh = (where: string, script: string, args: string[] = [], opts: { input?: string; timeout?: number } = {}): ReturnType<typeof host.exec> =>
  host.exec(where, ['sh', '-c', script, 'sh', ...args], { timeout: opts.timeout ?? 30_000, input: opts.input })

/** Is the machine reachable, does it have Node.js 18 or newer, and is the runner there (copied if not)? Returns the paths there. */
export async function deploy(where: string): Promise<{ node: string; runner: string; home: string; hasKey: boolean }> {
  const probe = await sh(where, 'printf "%s\\n" "$HOME"; command -v node || exit 3; node -e "process.exit(+process.versions.node.split(\'.\')[0] >= 18 ? 0 : 4)" || exit 4; if [ -n "$ANTHROPIC_API_KEY" ]; then echo key; fi')
  if (probe.code === -1) throw new Error(probe.stderr || 'Could not reach the machine.')
  if (probe.code === 3) throw new Error('Node.js is needed on that machine to run an agent there (version 18 or newer).')
  if (probe.code === 4) throw new Error('The Node.js on that machine is too old: version 18 or newer is needed.')
  if (probe.code !== 0) throw new Error(text(probe) || 'The machine could not be prepared.')
  const lines = probe.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const home = lines[0]
  const node = lines[1]
  const source = await runnerSource()
  const runner = `${home}/${HOME}/runner-${createHash('sha1').update(source).digest('hex').slice(0, 10)}.cjs`
  const have = await sh(where, '[ -f "$1" ]', [runner])
  if (have.code !== 0) {
    const up = await sh(where, 'mkdir -p "$(dirname "$1")" && cat > "$1.part" && mv "$1.part" "$1"', [runner], { input: source, timeout: 120_000 })
    if (up.code !== 0) throw new Error('Could not copy the runner to the machine: ' + text(up))
  }
  return { node, runner, home, hasKey: lines.includes('key') }
}

export interface CloudTaskSpec {
  id: string
  task: string
  model: string
  root: string // where the agent works, as the machine writes the path
  policy: CloudPolicy
  maxSteps: number
  extraSystem: string
  env?: Record<string, string>
}

/** Writes the task folder and starts the runner detached. `key` is given only when the machine has no key of its own. */
export async function startRunner(where: string, d: { node: string; runner: string; home: string }, spec: CloudTaskSpec, key: string | null): Promise<CloudRun> {
  const dir = `${d.home}/${HOME}/tasks/${spec.id}`
  if (process.env.ANTHROPIC_BASE_URL) spec = { ...spec, env: { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } }
  const w = await sh(where, 'mkdir -p "$1/approvals" && cat > "$1/task.json"', [dir], { input: JSON.stringify(spec) })
  if (w.code !== 0) throw new Error('Could not write the task: ' + text(w))
  if (key) {
    const k = await sh(where, 'umask 077 && cat > "$1/key"', [dir], { input: key })
    if (k.code !== 0) throw new Error('Could not write the key: ' + text(k))
  }
  // Detached: its own session (setsid when there is one), no terminal input, all output into runner.log.
  const go = await sh(where, 'cd "$1" && if command -v setsid >/dev/null 2>&1; then setsid nohup "$2" "$3" "$1" >> runner.log 2>&1 < /dev/null & else nohup "$2" "$3" "$1" >> runner.log 2>&1 < /dev/null & fi; echo started', [dir, d.node, d.runner])
  if (go.code !== 0) throw new Error('Could not start the runner: ' + text(go))
  return { dir, offset: 0, policy: spec.policy }
}

/** The runner's status and the events written since `run.offset` (whole lines only). null: the machine could not be reached. */
export async function poll(where: string, run: CloudRun): Promise<{ status: RunnerStatus | null; events: { n: number; t: number; e: AgentEvent }[]; offset: number } | null> {
  const r = await sh(where, 'cd "$1" || exit 9; cat status.json 2>/dev/null; printf "\\n@@EVENTS@@\\n"; tail -c +"$2" events.jsonl 2>/dev/null; exit 0', [run.dir, String(run.offset + 1)])
  if (r.code === -1) return null
  if (r.code === 9) throw new Error('The task folder on the machine is gone.')
  const cut = r.stdout.indexOf('\n@@EVENTS@@\n')
  if (cut < 0) return null
  let status: RunnerStatus | null = null
  try {
    status = JSON.parse(r.stdout.slice(0, cut)) as RunnerStatus
  } catch {
    // not written yet
  }
  const body = r.stdout.slice(cut + '\n@@EVENTS@@\n'.length)
  const lastNl = body.lastIndexOf('\n')
  const whole = lastNl < 0 ? '' : body.slice(0, lastNl + 1)
  const events: { n: number; t: number; e: AgentEvent }[] = []
  for (const line of whole.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // a damaged line is skipped
    }
  }
  return { status, events, offset: run.offset + Buffer.byteLength(whole, 'utf-8') }
}

export const answer = (where: string, run: CloudRun, id: string, ok: boolean): ReturnType<typeof host.exec> => sh(where, 'mkdir -p "$1/approvals" && printf "%s" "$2" > "$1/approvals/$3"', [run.dir, ok ? 'yes' : 'no', id])
export const requestStop = (where: string, run: CloudRun): ReturnType<typeof host.exec> => sh(where, 'touch "$1/stop"', [run.dir])
export const forget = (where: string, run: CloudRun): ReturnType<typeof host.exec> => sh(where, 'rm -rf "$1"', [run.dir])
