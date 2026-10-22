import { useEffect, useState } from 'react'

// Shows that the project has rules (AGENTS.md and friends) which the AI features are following.
// Clicking it opens the file so the rules can be read or edited.
export function RulesChip({ root, onOpen }: { root: string | null; onOpen: (path: string) => void }): JSX.Element | null {
  const [files, setFiles] = useState<{ name: string; path: string }[]>([])

  useEffect(() => {
    if (!root) return setFiles([])
    let live = true
    const load = (): void => void window.api.rulesLoad(root).then((r) => live && setFiles(r.files))
    load()
    window.addEventListener('focus', load) // the file may have been created or edited elsewhere
    const timer = setInterval(load, 15000)
    return () => {
      live = false
      window.removeEventListener('focus', load)
      clearInterval(timer)
    }
  }, [root])

  if (files.length === 0) return null
  return (
    <button
      className="rules-chip"
      data-rules-chip
      title={`Project rules in use (click to open):\n${files.map((f) => f.name).join('\n')}`}
      onClick={() => onOpen(files[0].path)}
    >
      Rules · {files.length}
    </button>
  )
}
