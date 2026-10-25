import logo from './assets/logo.png'

const SHORTCUTS: [string, string][] = [
  ['Go to file', 'Ctrl+P'],
  ['Find in files', 'Ctrl+Shift+F'],
  ['Command palette', 'Ctrl+Shift+P'],
  ['Source control', 'Ctrl+Shift+G'],
  ['Ask the AI', 'Ctrl+L'],
  ['Edit selection with AI', 'Ctrl+K'],
  ['Terminal', 'Ctrl+`'],
  ['Toggle sidebar', 'Ctrl+B']
]

const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// Shown over the editor while no file is open.
export function Welcome({
  hasFolder,
  recent,
  onOpenFolder,
  onOpenRecent,
  onThemes
}: {
  hasFolder: boolean
  recent: string[]
  onOpenFolder: () => void
  onOpenRecent: (folder: string) => void
  onThemes: () => void
}): JSX.Element {
  return (
    <div className="welcome" role="document" aria-label="Welcome">
      <img className="welcome-logo" src={logo} alt="" />
      <h1>My AI IDE</h1>
      <p className="welcome-sub">
        {hasFolder ? 'Pick a file from the explorer, or press Ctrl+P.' : 'A code editor with Claude built in.'}
      </p>
      <div className="welcome-actions">
        {!hasFolder && (
          <button className="primary" onClick={onOpenFolder}>
            Open Folder
          </button>
        )}
        <button onClick={onThemes}>Change color theme</button>
      </div>
      {recent.length > 0 && (
        <div className="welcome-recent" data-welcome-recent>
          <div className="welcome-recent-title">Recent</div>
          {recent.slice(0, 5).map((f) => (
            <div key={f} className="welcome-recent-item" data-recent={f} onClick={() => onOpenRecent(f)} title={f}>
              <span>{folderName(f)}</span>
              <span className="welcome-recent-path">{f}</span>
            </div>
          ))}
        </div>
      )}
      <div className="welcome-keys">
        {SHORTCUTS.map(([label, keys]) => (
          <div key={label} className="welcome-key">
            <span>{label}</span>
            <kbd>{keys}</kbd>
          </div>
        ))}
      </div>
    </div>
  )
}
