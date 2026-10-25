// A background agent that keeps running on a server when the editor is closed or the PC sleeps. The editor copies this file to the
// server, writes a task folder and starts it detached:  node cloud-runner.cjs <task folder>
//
// The task folder is the whole protocol:
//   task.json    what to do (written by the editor): id, task, model, root (the agent's folder), policy, maxSteps, extraSystem
//   key          the Anthropic API key, when the editor was asked to bring it (deleted when the task ends)
//   events.jsonl one line per agent event, appended as it happens ({ n, t, e })
//   status.json  state (running | waiting | done | failed | stopped), pid, steps, activity, summary, error, started, finished
//   approvals/<id>   "yes" or "no": the answer to a command that waits for permission
//   stop         create this file to stop the task
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { handlers } from './electron-stub'
import { registerAgentHandlers, runAgentTask, type AgentEvent } from '../main/agent'

const dir = process.argv[2]
if (!dir || !existsSync(join(dir, 'task.json'))) {
  console.error('usage: node cloud-runner.cjs <task folder>')
  process.exit(2)
}

interface TaskFile {
  id: string
  task: string
  model: string
  root: string
  policy: 'ask' | 'auto' | 'deny' // what to do with a command the agent wants to run
  maxSteps?: number
  extraSystem?: string
  env?: Record<string, string> // only ANTHROPIC_BASE_URL is passed on (a gateway or proxy the editor was told to use)
}
const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf-8')) as TaskFile

// Direct mode: the model is called from here with the API key (the editor's account service is not reachable from a server).
process.env.MY_AI_IDE_DIRECT = '1'
if (task.env?.ANTHROPIC_BASE_URL) process.env.ANTHROPIC_BASE_URL = task.env.ANTHROPIC_BASE_URL
const keyFile = join(dir, 'key')
if (existsSync(keyFile)) process.env.ANTHROPIC_API_KEY = readFileSync(keyFile, 'utf-8').trim()

const statusFile = join(dir, 'status.json')
const status = { state: 'running', pid: process.pid, steps: 0, activity: 'Starting…', summary: '', error: '', started: Date.now(), finished: 0, waitId: '', waitCommand: '' }
const writeStatus = (): void => writeFileSync(statusFile, JSON.stringify(status))
let n = 0
const log = (e: AgentEvent): void => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ n: ++n, t: Date.now(), e }) + '\n')
writeStatus()

const RUN_ID = 1
registerAgentHandlers(() => null) // gives us the 'agent:approve' handler
const approve = (id: string, ok: boolean): void => void handlers.get('agent:approve')?.({}, RUN_ID, id, ok)

const controller = new AbortController()
mkdirSync(join(dir, 'approvals'), { recursive: true })
let current = ''
const send = (e: AgentEvent): void => {
  if (e.type === 'tool_output') return // long command output stays out of the log; the tool's final result is in tool_end
  log(e)
  if (e.type === 'text') {
    current += e.text
    status.summary = current.slice(-1200)
  } else if (e.type === 'tool_start') {
    status.steps++
    current = ''
    status.activity = e.name
    if (status.state === 'waiting') status.state = 'running'
  } else if (e.type === 'command_request') {
    if (task.policy === 'auto') return void setImmediate(() => approve(e.id, true))
    if (task.policy === 'deny') return void setImmediate(() => approve(e.id, false))
    status.state = 'waiting'
    status.waitId = e.id
    status.waitCommand = e.command
    // wait for the editor's answer in approvals/<id>
    const file = join(dir, 'approvals', e.id)
    const timer = setInterval(() => {
      if (!existsSync(file)) return
      const yes = readFileSync(file, 'utf-8').trim() === 'yes'
      clearInterval(timer)
      approve(e.id, yes)
    }, 400)
    controller.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  } else if (e.type === 'tool_end') {
    status.state = 'running'
    status.waitId = ''
    status.waitCommand = ''
  } else if (e.type === 'error') status.error = e.message
  writeStatus()
}

const stopTimer = setInterval(() => {
  if (existsSync(join(dir, 'stop'))) controller.abort()
}, 700)

void (async () => {
  let aborted = false
  try {
    await runAgentTask(
      { runId: RUN_ID, sessionId: 'cloud-' + task.id, model: task.model, root: task.root, task: task.task, autoApproveEdits: true, maxSteps: task.maxSteps ?? 40, extraSystem: task.extraSystem },
      send,
      controller.signal
    )
    aborted = controller.signal.aborted
  } catch (e) {
    status.error = e instanceof Error ? e.message : String(e)
  }
  clearInterval(stopTimer)
  status.state = status.error ? 'failed' : aborted ? 'stopped' : 'done'
  status.finished = Date.now()
  status.activity = ''
  status.waitId = ''
  status.waitCommand = ''
  writeStatus()
  rmSync(keyFile, { force: true })
  process.exit(0)
})()
