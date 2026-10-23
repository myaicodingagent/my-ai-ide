import { useEffect, useRef } from 'react'
import { onWebviewPost, WebviewPanelInfo } from './webviewStore'

// One extension web page. It is loaded from the vscode-webview-resource protocol, so it has an address and security
// rules of its own, and it runs in a sandboxed frame: scripts and forms, nothing else. Messages go through the editor,
// which only passes on what comes from this frame.
export function WebviewFrame({ panel, visible }: { panel: WebviewPanelInfo; visible: boolean }): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  const loaded = useRef(false)
  const pending = useRef<unknown[]>([])
  const src = `vscode-webview-resource://w/page/${encodeURIComponent(panel.id)}?v=${panel.version}`

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== ref.current?.contentWindow || !e.data || e.data.__vscodeWebview !== true) return
      void window.api.extProvide(panel.id, 'webviewMessage', { id: panel.id, message: e.data.message })
    }
    window.addEventListener('message', onMessage)
    const off = onWebviewPost(panel.id, (m) => {
      if (loaded.current) ref.current?.contentWindow?.postMessage(m, '*')
      else pending.current.push(m)
    })
    return () => {
      window.removeEventListener('message', onMessage)
      off()
    }
  }, [panel.id])

  return (
    <iframe
      ref={ref}
      className="webview-frame"
      data-webview-frame={panel.id}
      title={panel.title}
      sandbox="allow-scripts allow-forms"
      src={src}
      style={{ display: visible ? 'block' : 'none' }}
      onLoad={() => {
        loaded.current = true
        for (const m of pending.current.splice(0)) ref.current?.contentWindow?.postMessage(m, '*')
      }}
    />
  )
}
