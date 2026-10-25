import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initSettings, setScreenReaderDetected } from './settings'
import { initTheme } from './theme'
import './styles.css'

// Monaco cancels in-flight work (a closed quick-pick box, a superseded request) by rejecting a promise with
// "Canceled". That is normal control flow, not an error, so it is marked as handled.
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { name?: string; message?: string } | undefined
  if (reason?.name === 'Canceled' || reason?.message === 'Canceled') e.preventDefault()
  // The diff editor asks a worker to compare two texts; if a diff is closed before the answer arrives the texts are
  // gone and it complains. Nothing is lost, the diff is no longer shown.
  if (reason?.message === 'no diff result available') e.preventDefault()
})

// Apply saved settings and the saved theme (which may be a custom one that has to be read from disk)
// before the first paint, so nothing flashes or jumps.
initSettings()
// A screen reader that is running (or starts later) puts the editor and the terminal into their screen reader mode.
void window.api.screenReaderActive().then(setScreenReaderDetected)
window.api.onScreenReader(setScreenReaderDetected)
void initTheme().then(() => {
  createRoot(document.getElementById('root')!).render(<App />)
})
