import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ManagerBase } from '@jupyter-widgets/base-manager'
import { DOMWidgetModel, DOMWidgetView, ErrorWidgetView, createErrorWidgetModel } from '@jupyter-widgets/base'
import type { IClassicComm, WidgetModel, WidgetView } from '@jupyter-widgets/base'
import { Widget } from '@lumino/widgets'
import '@fortawesome/fontawesome-free/css/all.min.css'

// Jupyter widgets (ipywidgets): the widget library draws them here, and every widget talks to its twin in the kernel
// through "comms", which the main process carries to and from the kernel (see jupyter.ts).

export const WIDGET_MIME = 'application/vnd.jupyter.widget-view+json'

type Callbacks = { iopub?: { status?: (msg: unknown) => void } } | undefined
type Buf = ArrayBuffer | ArrayBufferView

const toBytes = (b: Buf): Uint8Array => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
const toView = (u: Uint8Array): DataView => new DataView(u.buffer, u.byteOffset, u.byteLength)

class IdeComm implements IClassicComm {
  onMsg: ((msg: unknown) => void) | null = null
  onClose: ((msg: unknown) => void) | null = null
  constructor(
    private readonly manager: IdeWidgetManager,
    readonly comm_id: string,
    readonly target_name: string
  ) {}

  private post(type: 'comm_open' | 'comm_msg' | 'comm_close', data: unknown, callbacks: Callbacks, metadata?: unknown, buffers?: Buf[]): string {
    if (this.manager.session < 0) {
      callbacks?.iopub?.status?.({ content: { execution_state: 'idle' } }) // widgets without a kernel: nobody to tell
      return this.comm_id
    }
    const content: Record<string, unknown> = { comm_id: this.comm_id, data: data ?? {} }
    if (type === 'comm_open') content.target_name = this.target_name
    void window.api.nbComm(this.manager.session, type, content, (buffers ?? []).map(toBytes)).then((id) => {
      // The widget library counts messages the kernel has not answered yet; "idle" is the answer.
      if (callbacks?.iopub?.status) {
        if (id) this.manager.pending.set(id, callbacks)
        else callbacks.iopub.status({ content: { execution_state: 'idle' } })
      }
    })
    void metadata
    return this.comm_id
  }

  open(data: unknown, callbacks?: unknown, metadata?: unknown, buffers?: Buf[]): string {
    return this.post('comm_open', data, callbacks as Callbacks, metadata, buffers)
  }
  send(data: unknown, callbacks?: unknown, metadata?: unknown, buffers?: Buf[]): string {
    return this.post('comm_msg', data, callbacks as Callbacks, metadata, buffers)
  }
  close(data?: unknown, callbacks?: unknown, metadata?: unknown, buffers?: Buf[]): string {
    this.manager.comms.delete(this.comm_id)
    return this.post('comm_close', data, callbacks as Callbacks, metadata, buffers)
  }
  on_msg(cb: (msg: unknown) => void): void {
    this.onMsg = cb
  }
  on_close(cb: (msg: unknown) => void): void {
    this.onClose = cb
  }
}

// The Output widget (what interact() and `with out:` fill): the kernel keeps its `outputs` list up to date and the
// view draws them.
class OutputModel extends DOMWidgetModel {
  /** Output that the kernel produced for the message this widget is capturing. */
  capture(msgType: string, c: Record<string, any>): void {
    const outputs = [...((this.get('outputs') ?? []) as Record<string, any>[])]
    if (msgType === 'clear_output') outputs.length = 0
    else if (msgType === 'stream') {
      const last = outputs[outputs.length - 1]
      if (last?.output_type === 'stream' && last.name === c.name) outputs[outputs.length - 1] = { ...last, text: text(last.text) + text(c.text) }
      else outputs.push({ output_type: 'stream', name: c.name, text: text(c.text) })
    } else if (msgType === 'error') outputs.push({ output_type: 'error', ename: c.ename, evalue: c.evalue, traceback: c.traceback })
    else outputs.push({ output_type: msgType, data: c.data ?? {}, metadata: c.metadata ?? {}, ...(msgType === 'execute_result' ? { execution_count: c.execution_count } : {}) })
    this.set('outputs', outputs)
    this.save_changes()
  }

  defaults(): Record<string, unknown> {
    return { ...super.defaults(), _model_name: 'OutputModel', _view_name: 'OutputView', _model_module: '@jupyter-widgets/output', _view_module: '@jupyter-widgets/output', _model_module_version: '1.0.0', _view_module_version: '1.0.0', msg_id: '', outputs: [] }
  }
}

const stripAnsi = (t: string): string => t.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g'), '')
const text = (v: unknown): string => (Array.isArray(v) ? v.join('') : String(v ?? ''))

class OutputView extends DOMWidgetView {
  render(): void {
    this.el.classList.add('nb-widget-output')
    this.model.on('change:outputs', this.update, this)
    this.update()
  }

  update(): void {
    this.el.textContent = ''
    for (const o of (this.model.get('outputs') ?? []) as Record<string, any>[]) {
      const kind = o.output_type
      if (kind === 'stream' || kind === 'error') {
        const pre = document.createElement('pre')
        pre.className = kind === 'error' || o.name === 'stderr' ? 'nb-stream err' : 'nb-stream'
        pre.textContent = stripAnsi(kind === 'error' ? text(o.traceback) || `${o.ename}: ${o.evalue}` : text(o.text))
        this.el.appendChild(pre)
        continue
      }
      const data = (o.data ?? {}) as Record<string, unknown>
      if (data['image/png'] || data['image/jpeg']) {
        const img = document.createElement('img')
        img.className = 'nb-img'
        img.alt = 'Output'
        const mime = data['image/png'] ? 'image/png' : 'image/jpeg'
        img.src = `data:${mime};base64,${text(data[mime]).replace(/\s/g, '')}`
        this.el.appendChild(img)
      } else if (data['text/html']) {
        // Markup from a kernel is shown in a frame that may not run scripts, like any other HTML output.
        const f = document.createElement('iframe')
        f.className = 'nb-html'
        f.setAttribute('sandbox', 'allow-same-origin')
        f.srcdoc = '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px system-ui,sans-serif;padding:4px 8px}</style>' + text(data['text/html'])
        f.onload = () => {
          const d = f.contentDocument
          if (d?.documentElement) f.style.height = Math.min(600, d.documentElement.scrollHeight + 4) + 'px'
        }
        this.el.appendChild(f)
      } else if (data['text/plain']) {
        const pre = document.createElement('pre')
        pre.className = 'nb-stream'
        pre.textContent = text(data['text/plain'])
        this.el.appendChild(pre)
      }
    }
  }
}

const outputModule = { OutputModel, OutputView }

export class IdeWidgetManager extends ManagerBase {
  comms = new Map<string, IdeComm>()
  pending = new Map<string, Callbacks>()
  queue: Promise<unknown> = Promise.resolve()
  private views = new Set<WidgetView>()

  /** Called when the state of any widget changes, so the notebook can save it. */
  onModelChange: (() => void) | null = null
  /** Resolves when the state read from a notebook has been turned into models. */
  restored: Promise<unknown> = Promise.resolve()

  // A manager with a negative session shows the widgets saved in a notebook: there is no kernel behind them.
  constructor(readonly session: number) {
    super()
  }

  register_model(modelId: string, modelPromise: Promise<WidgetModel>): void {
    super.register_model(modelId, modelPromise)
    void modelPromise.then((m) => m.on('change', () => this.onModelChange?.()), () => undefined)
  }

  // A widget made in the notebook (rare: most come from the kernel) gets a comm of its own.
  protected _create_comm(target: string, modelId?: string, data?: unknown, metadata?: unknown, buffers?: Buf[]): Promise<IClassicComm> {
    const comm = new IdeComm(this, modelId ?? crypto.randomUUID(), target)
    this.comms.set(comm.comm_id, comm)
    if (data !== undefined) comm.open(data, undefined, metadata, buffers)
    return Promise.resolve(comm as unknown as IClassicComm)
  }

  protected _get_comm_info(): Promise<Record<string, never>> {
    return Promise.resolve({})
  }

  async display_view(view: Promise<WidgetView> | WidgetView, el: HTMLElement): Promise<void> {
    let v: WidgetView
    try {
      v = await view
    } catch (error) {
      console.error('Could not create a view for a widget:', error)
      const Model = createErrorWidgetModel(error, 'Could not create a view for the widget')
      v = new ErrorWidgetView({ model: new Model() } as never)
      v.render()
    }
    const lumino = (v as unknown as { luminoWidget?: Widget; pWidget?: Widget }).luminoWidget ?? (v as unknown as { pWidget: Widget }).pWidget
    Widget.attach(lumino, el)
    this.views.add(v)
    v.once('remove', () => this.views.delete(v))
  }

  // The widget library is bundled; modules of widgets from other packages are not available.
  protected async loadClass(className: string, moduleName: string, moduleVersion: string): Promise<typeof WidgetModel | typeof WidgetView> {
    let mod: Record<string, unknown> | undefined
    // The library for ipywidgets 8 draws the widgets of ipywidgets 7 as well (their models are alike); the 7 library needs jQuery UI as a global.
    if (moduleName === '@jupyter-widgets/base') {
      mod = await import('@jupyter-widgets/base')
    } else if (moduleName === '@jupyter-widgets/controls') {
      await import('@jupyter-widgets/controls/css/widgets-base.css')
      if (getComputedStyle(document.documentElement).getPropertyValue('--jp-layout-color0') === '') await import('@jupyter-widgets/controls/css/labvariables.css')
      mod = await import('@jupyter-widgets/controls')
    } else if (moduleName === '@jupyter-widgets/output') {
      mod = outputModule
    }
    if (!mod) throw new Error(`The widget needs the module ${moduleName}@${moduleVersion}, which this editor does not include.`)
    const cls = mod[className]
    if (!cls) throw new Error(`Class ${className} not found in ${moduleName}@${moduleVersion}`)
    return cls as typeof WidgetModel
  }
}

const managers = new Map<number, IdeWidgetManager>()
let listening = false

export const widgetManager = (session: number | null): IdeWidgetManager | null => (session === null ? null : (managers.get(session) ?? null))

/** Listens for the kernels' comm messages once; a manager is made the first time a kernel talks about widgets. */
export function initWidgets(): void {
  if (listening) return
  listening = true
  window.api.onNbComm((session, type, content, buffers, parent, metadata) => {
    let m = managers.get(session)
    if (type === 'idle') {
      const cb = parent ? m?.pending.get(parent) : undefined
      if (parent) m?.pending.delete(parent)
      cb?.iopub?.status?.({ content: { execution_state: 'idle' } })
      return
    }
    if (!m) {
      m = new IdeWidgetManager(session)
      managers.set(session, m)
    }
    const views = buffers.map(toView)
    const msg = { content, buffers: views, metadata: metadata ?? {}, header: { msg_type: type } }
    const manager = m
    // One message at a time, each finished before the next: a widget's state mentions other widgets (a box and its
    // children), and those must exist by the time the message about them is handled.
    manager.queue = manager.queue.then(async () => {
      if (type === 'capture') {
        // Output a widget asked for (its comm ids come with it: its msg_id may not have reached its model yet).
        for (const id of (content.widgets ?? []) as string[]) await manager.get_model(id).then((model) => (model as OutputModel).capture(String(content.msg_type), content), () => undefined)
      } else if (type === 'comm_open') {
        const comm = new IdeComm(manager, String(content.comm_id), String(content.target_name))
        manager.comms.set(comm.comm_id, comm)
        if (content.target_name === 'jupyter.widget') await manager.handle_comm_open(comm as unknown as IClassicComm, msg as never)
      } else if (type === 'comm_msg') {
        manager.comms.get(String(content.comm_id))?.onMsg?.(msg)
        await manager.get_model(String(content.comm_id)).then((model) => (model as unknown as { state_change?: Promise<unknown> }).state_change, () => undefined)
      } else if (type === 'comm_close') {
        const comm = manager.comms.get(String(content.comm_id))
        manager.comms.delete(String(content.comm_id))
        comm?.onClose?.(msg)
      }
    }).catch((e) => console.error('widget message', type, e))
  })
}

export const WIDGET_STATE_MIME = 'application/vnd.jupyter.widget-state+json'
type SavedModel = { model_name: string; model_module: string; model_module_version: string; state: Record<string, unknown>; buffers?: unknown }
export interface WidgetState {
  version_major: number
  version_minor: number
  state: Record<string, SavedModel>
}

/** The widgets that the editor can draw itself (the same list as `loadClass`); others are kept in the file as they were. */
const KNOWN_MODULES = new Set(['@jupyter-widgets/base', '@jupyter-widgets/controls', '@jupyter-widgets/output'])

/** The notebook's saved widget state (`metadata.widgets`), if it is one we understand. */
export function savedWidgetState(metadata: Record<string, unknown>): WidgetState | null {
  const w = (metadata.widgets as Record<string, unknown> | undefined)?.[WIDGET_STATE_MIME] as Partial<WidgetState> | undefined
  return w && typeof w === 'object' && typeof w.version_major === 'number' && w.version_major <= 2 && w.state && typeof w.state === 'object' ? (w as WidgetState) : null
}

/** Makes models of the widgets saved in a notebook; they are drawn without a kernel (they respond locally, nothing runs). */
export function restoreWidgets(state: WidgetState): IdeWidgetManager {
  const m = new IdeWidgetManager(-1)
  const known: WidgetState = { ...state, state: Object.fromEntries(Object.entries(state.state).filter(([, v]) => v && KNOWN_MODULES.has(v.model_module))) }
  m.restored = m.set_state(known as never).catch((e) => console.error('could not restore the widgets', e))
  return m
}

/**
 * The state to save with a notebook: what was saved before, updated with the models of the managers (the restored ones and the
 * kernel's), and cut down to the widgets that the outputs show, together with the widgets those refer to.
 */
export async function collectWidgetState(before: WidgetState | null, managers: (IdeWidgetManager | null)[], shown: Set<string>): Promise<WidgetState | null> {
  const all: Record<string, SavedModel> = { ...(before?.state ?? {}) }
  for (const m of managers) {
    if (!m) continue
    await m.restored
    const s = (await m.get_state({ drop_defaults: true })) as unknown as WidgetState
    for (const [id, v] of Object.entries(s.state)) if (KNOWN_MODULES.has(v.model_module)) all[id] = v
  }
  const keep: Record<string, SavedModel> = {}
  const visit = (id: string): void => {
    const v = all[id]
    if (!v || keep[id]) return
    keep[id] = v
    for (const ref of JSON.stringify(v.state).matchAll(/IPY_MODEL_([0-9A-Za-z-]+)/g)) visit(ref[1])
  }
  for (const id of shown) visit(id)
  return Object.keys(keep).length ? { version_major: 2, version_minor: 0, state: keep } : null
}

export const StaticWidgets = createContext<IdeWidgetManager | null>(null)

/** A kernel that is gone takes its widgets with it. */
export function forgetWidgets(session: number): void {
  managers.delete(session)
}

/** One widget, drawn into the output of a cell. */
export function WidgetOutput({ session, modelId }: { session: number | null; modelId: string }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const restored = useContext(StaticWidgets)
  useEffect(() => {
    const live = widgetManager(session)
    // The kernel's messages about this widget came first; wait until they have all been handled. A widget that the kernel
    // does not have (the cell was not run since the notebook was opened) comes from the state saved in the notebook.
    const pick = async (): Promise<{ m: IdeWidgetManager; mod: WidgetModel } | null> => {
      if (live) {
        await live.queue
        if (live.has_model(modelId)) return { m: live, mod: await live.get_model(modelId) }
      }
      if (restored) {
        await restored.restored
        if (restored.has_model(modelId)) return { m: restored, mod: await restored.get_model(modelId) }
      }
      return null
    }
    if (!host.current) return
    setErr(null)
    let view: { remove?: () => void } | null = null
    let gone = false
    pick()
      .then((found) => {
        if (!found) throw new Error('This widget is not saved in the notebook. Run the cell again to show it.')
        return found.m.create_view(found.mod).then((v) => ({ m: found.m, v }))
      })
      .then(async ({ m, v }) => {
        if (gone) return void v.remove()
        view = v
        if (host.current) await m.display_view(v, host.current)
      })
      .catch((e: unknown) => setErr(e instanceof Error && /not saved/.test(e.message) ? e.message : 'The widget could not be shown: ' + (e instanceof Error ? e.message : String(e))))
    return () => {
      gone = true
      try {
        view?.remove?.()
      } catch {
        // already gone
      }
    }
  }, [session, modelId, restored])
  return (
    <div className="nb-widget" data-nb-widget={modelId}>
      <div ref={host} />
      {err ? <div className="nb-widget-err">{err}</div> : null}
    </div>
  )
}
