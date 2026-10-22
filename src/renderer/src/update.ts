import { useEffect, useState } from 'react'

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error' | 'unconfigured' | 'dev'
  current: string
  version?: string
  percent?: number
  error?: string
}

/** React hook: the updater's state, kept in the main process and pushed here as it changes. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle', current: '' })
  useEffect(() => {
    let live = true
    void window.api.updateState().then((s) => live && setState(s))
    const off = window.api.onUpdateState(setState)
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

/** What to show for a state, in plain words. */
export function describeUpdate(s: UpdateState): string {
  switch (s.status) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${s.version} is available.`
    case 'none':
      return 'You are on the latest version.'
    case 'downloading':
      return `Downloading version ${s.version ?? ''}… ${s.percent ?? 0}%`
    case 'ready':
      return `Version ${s.version} is downloaded. Restart to install it.`
    case 'error': {
      // The raw error can be several lines with URLs and hashes; keep the first line, and explain checksums.
      const first = (s.error ?? 'unknown error').split(/\r?\n/)[0]
      if (/sha512|checksum/i.test(first)) {
        return 'The downloaded update failed its integrity check and was discarded. Try again later.'
      }
      return `Could not check for updates: ${first.slice(0, 160)}`
    }
    case 'unconfigured':
      return 'Updates are not set up in this build (no update source configured).'
    case 'dev':
      return 'Updates only work in the installed app.'
    default:
      return ''
  }
}
