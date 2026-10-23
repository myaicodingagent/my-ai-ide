import { useEffect, useState } from 'react'
import type { AuthState, Me } from '../../main/backend'

export type { AuthState, Me }

export interface AuthInfo {
  state: AuthState
  direct: boolean // development: the app uses its own key and no account
  loaded: boolean
}

let current: AuthInfo = { state: { state: 'signed-out' }, direct: false, loaded: false }
const listeners = new Set<(a: AuthInfo) => void>()
let started = false

function set(next: Partial<AuthInfo>): void {
  current = { ...current, ...next }
  for (const l of listeners) l(current)
}

function start(): void {
  if (started) return
  started = true
  void Promise.all([window.api.authState(), window.api.authMode()]).then(([state, mode]) => set({ state, direct: mode.direct, loaded: true }))
  window.api.onAuthState((state) => set({ state }))
}

/** The account state: signed out, signing in (a code to confirm on the website), or signed in with the plan and allowance. */
export function useAuth(): AuthInfo {
  const [a, setA] = useState(current)
  useEffect(() => {
    start()
    listeners.add(setA)
    setA(current)
    return () => void listeners.delete(setA)
  }, [])
  return a
}

/** One short line for the status bar and the account dialog. */
export function planSummary(me: Me | null): string {
  if (!me) return ''
  if (!me.active) return 'No active plan'
  const left = me.dailyRequestCap > 0 ? Math.max(0, me.dailyRequestCap - (me.requestsToday ?? 0)) : null
  return `${me.plan ?? 'Plan'}${left === null ? '' : ` · ${left} request${left === 1 ? '' : 's'} left today`}`
}
