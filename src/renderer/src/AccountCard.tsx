import { useEffect, useRef, useState } from 'react'
import { planSummary, useAuth } from './authStore'
import { useFocusTrap } from './a11y'

// Shown where the AI features are used while nobody is signed in: sign in with the website account, in the browser.
export function SignInCard(): JSX.Element {
  const auth = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const signing = auth.state.state === 'signing-in' ? auth.state : null

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.api.authStart()
    if (!r.ok) setError(r.error)
    setBusy(false)
  }

  return (
    <div className="chat-key" data-signin-card>
      {signing ? (
        <>
          <p>Confirm this code on the website that just opened:</p>
          <p className="signin-code" data-signin-code>
            {signing.userCode}
          </p>
          <p className="qp-detail">Waiting for you to confirm… The page did not open? Go to {signing.url}</p>
          <div>
            <button onClick={() => void window.api.authCancel()}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p>Sign in to use the AI features. Your plan and today's allowance come with your account.</p>
          <div>
            <button className="primary" data-signin-start disabled={busy} onClick={() => void start()}>
              Sign in with your browser
            </button>
          </div>
        </>
      )}
      {error && <p className="chat-error" role="alert">{error}</p>}
    </div>
  )
}

// The account dialog: who is signed in, the plan, the allowance, and sign out.
export function AccountDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const auth = useAuth()
  const boxRef = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState('')
  const [urlNote, setUrlNote] = useState<string | null>(null)
  useFocusTrap(boxRef)
  useEffect(() => {
    void window.api.authMe()
    void window.api.authGetUrl().then(setUrl)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const me = auth.state.state === 'signed-in' ? auth.state.me : null
  const saveUrl = async (): Promise<void> => {
    const r = await window.api.authSetUrl(url)
    setUrlNote(r.ok ? 'Saved. Sign in again.' : r.error)
  }

  return (
    <div className="qp-backdrop" onMouseDown={onClose}>
      <div className="qp input-dialog" ref={boxRef} role="dialog" aria-modal="true" aria-label="Account" data-account-dialog onMouseDown={(e) => e.stopPropagation()}>
        <div className="ie-status">Account</div>
        {auth.direct ? (
          <p className="qp-detail">Development build: the app uses its own API key and no account.</p>
        ) : auth.state.state === 'signed-in' ? (
          <>
            <p data-account-plan>{me ? planSummary(me) : 'Signed in'}</p>
            {me?.teamName && <p className="qp-detail">Team: {me.teamName}</p>}
            {me && me.completionCap ? <p className="qp-detail">Suggestions today: {me.completionsToday ?? 0} of {me.completionCap}</p> : null}
            {me && (me.credits ?? 0) > 0 && <p className="qp-detail">Extra credits: {me.credits}</p>}
            <div className="ie-actions">
              <button data-account-signout onClick={() => void window.api.authSignOut().then(onClose)}>
                Sign out
              </button>
              <button onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <SignInCard />
        )}
        {!auth.direct && (
          <details>
            <summary>Service address</summary>
            <input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Service address" />
            <button onClick={() => void saveUrl()}>Save</button>
            {urlNote && <span className="qp-detail"> {urlNote}</span>}
          </details>
        )}
      </div>
    </div>
  )
}
