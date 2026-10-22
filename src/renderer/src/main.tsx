import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initSettings } from './settings'
import { initTheme } from './theme'
import './styles.css'

// Monaco cancels in-flight work (a closed quick-pick box, a superseded request) by rejecting a promise with
// "Canceled". That is normal control flow, not an error, so it is marked as handled.
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { name?: string; message?: string } | undefined
  if (reason?.name === 'Canceled' || reason?.message === 'Canceled') e.preventDefault()
})

// Apply saved settings and the saved theme (which may be a custom one that has to be read from disk)
// before the first paint, so nothing flashes or jumps.
initSettings()
void initTheme().then(() => {
  createRoot(document.getElementById('root')!).render(<App />)
})
