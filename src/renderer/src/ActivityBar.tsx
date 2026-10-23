import type { ReactNode } from 'react'

// Line icons for the activity bar (the column of view buttons on the far left).
const svg = (children: ReactNode): JSX.Element => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const Icons = {
  files: svg(
    <>
      <path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 18h9a1.5 1.5 0 0 0 1.5-1.5V6.5z" />
      <path d="M14 3v3.5h3.5" />
      <path d="M9 21h8.5A1.5 1.5 0 0 0 19 19.5V9" />
    </>
  ),
  search: svg(
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5.5 5.5" />
    </>
  ),
  git: svg(
    <>
      <circle cx="6.5" cy="5.5" r="2.2" />
      <circle cx="6.5" cy="18.5" r="2.2" />
      <circle cx="17.5" cy="8.5" r="2.2" />
      <path d="M6.5 7.7v8.6" />
      <path d="M17.5 10.7c0 4-5 3.6-10 6" />
    </>
  ),
  debug: svg(
    <>
      <path d="M8 4.5v15l12-7.5z" />
      <path d="M3.5 9.5h2M3.5 14.5h2M4.5 12h1" />
    </>
  ),
  ext: svg(
    <>
      <rect x="3.5" y="12.5" width="8" height="8" rx="1" />
      <rect x="12.5" y="12.5" width="8" height="8" rx="1" />
      <rect x="3.5" y="3.5" width="8" height="8" rx="1" />
      <rect x="14" y="2.5" width="7" height="7" rx="1" transform="rotate(8 17.5 6)" />
    </>
  ),
  agents: svg(
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </>
  ),
  views: svg(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M9.5 4.5v15M13 9h4.5M13 13h4.5" />
    </>
  ),
  account: svg(
    <>
      <circle cx="12" cy="8.5" r="3.7" />
      <path d="M4.5 20c.8-3.6 3.7-5.5 7.5-5.5s6.7 1.9 7.5 5.5" />
    </>
  ),
  settings: svg(
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8" />
    </>
  ),
  folder: svg(<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />)
}
