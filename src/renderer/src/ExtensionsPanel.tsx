import { useState } from 'react'
import type { ExtRecord, RegistryResult } from '../../main/extensions'
import { refreshExtensions, useExtLog, useExtensions } from './extStore'

function Row({ e }: { e: ExtRecord }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const parts = [
    e.themes ? `${e.themes} theme${e.themes > 1 ? 's' : ''}` : '',
    e.snippets ? `${e.snippets} snippet file${e.snippets > 1 ? 's' : ''}` : '',
    e.commands.length ? `${e.commands.length} command${e.commands.length > 1 ? 's' : ''}` : ''
  ].filter(Boolean)
  return (
    <div className={'ext-row' + (e.enabled ? '' : ' off')} data-ext={e.id}>
      <div className="ext-head">
        <span className="ext-name" title={e.id}>
          {e.displayName}
        </span>
        <span className="ext-version">{e.version}</span>
      </div>
      {e.description && <div className="ext-desc">{e.description}</div>}
      <div className="ext-meta">
        {e.publisher}
        {parts.length > 0 && ` · ${parts.join(', ')}`}
      </div>
      {e.native && <div className="ext-warn" data-ext-runs-code>Runs code on your PC with your permissions.</div>}
      {e.vscode && (
        <div className="ext-warn" data-ext-vscode>
          A VS Code extension: its code runs on your PC with your permissions, against a partial copy of the VS Code API. Some features may not work.
        </div>
      )}
      {e.unsupported.length > 0 && <div className="ext-note">Not used: {e.unsupported.join(', ')}</div>}
      <div className="ext-actions">
        <label>
          <input
            type="checkbox"
            data-ext-enabled
            checked={e.enabled}
            disabled={busy}
            onChange={async (ev) => {
              setBusy(true)
              await window.api.extSetEnabled(e.id, ev.target.checked)
              setBusy(false)
            }}
          />{' '}
          Enabled
        </label>
        <button
          data-ext-uninstall
          disabled={busy}
          onClick={async () => {
            if (!window.confirm(`Uninstall ${e.displayName}?`)) return
            setBusy(true)
            await window.api.extUninstall(e.id)
            setBusy(false)
          }}
        >
          Uninstall
        </button>
      </div>
    </div>
  )
}

export function ExtensionsPanel(): JSX.Element {
  const installed = useExtensions()
  const log = useExtLog()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistryResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)

  const search = async (): Promise<void> => {
    if (!query.trim()) return setResults(null)
    setSearching(true)
    setNote(null)
    const r = await window.api.extSearch(query.trim())
    setSearching(false)
    if (!r.ok) setNote({ kind: 'error', text: r.error ?? 'The search failed.' })
    setResults(r.ok ? r.results : [])
  }

  const afterInstall = (r: { ok: true; ext: ExtRecord } | { ok: false; error: string }): void => {
    if (r.ok) {
      setNote({ kind: 'ok', text: `Installed ${r.ext.displayName} ${r.ext.version}.` })
      void refreshExtensions()
    } else if (r.error !== 'cancelled') setNote({ kind: 'error', text: r.error })
  }

  const installFromRegistry = async (x: RegistryResult): Promise<void> => {
    if (!window.confirm(`Install ${x.displayName} (${x.id}) from the extension registry?\n\nIf it contains code for this editor, that code runs on your PC with your permissions. Themes and snippets are only data.`)) return
    setInstalling(x.id)
    setNote(null)
    afterInstall(await window.api.extInstallRegistry(x))
    setInstalling(null)
  }

  const installedIds = new Set(installed.map((e) => e.id))

  return (
    <div className="ext" data-ext-panel>
      <div className="ext-search">
        <input
          value={query}
          data-ext-query
          placeholder="Search the Open VSX registry (themes, snippets…)"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
        />
        <button data-ext-search onClick={() => void search()} disabled={searching}>
          {searching ? '…' : 'Search'}
        </button>
      </div>
      <div className="ext-tools">
        <button data-ext-install-vsix onClick={async () => afterInstall(await window.api.extInstallVsix())}>
          Install from VSIX…
        </button>
        <button data-ext-install-folder onClick={async () => afterInstall(await window.api.extInstallFolder())}>
          From folder…
        </button>
        <button onClick={() => void window.api.extOpenFolder()}>Open folder</button>
      </div>
      {note && (
        <div className={'git-note ' + note.kind} data-ext-note role={note.kind === 'error' ? 'alert' : 'status'}>
          {note.text}
        </div>
      )}

      {results && (
        <div data-ext-results>
          <div className="dbg-section-head">
            <span>Registry results</span>
            <button className="dbg-x" onClick={() => setResults(null)}>
              ×
            </button>
          </div>
          {results.length === 0 && <div className="dbg-empty">Nothing found.</div>}
          {results.map((x) => (
            <div key={x.id} className="ext-row" data-ext-result={x.id}>
              <div className="ext-head">
                <span className="ext-name">{x.displayName}</span>
                <span className="ext-version">{x.version}</span>
              </div>
              {x.description && <div className="ext-desc">{x.description}</div>}
              <div className="ext-meta">
                {x.id} · {x.downloads.toLocaleString()} downloads
              </div>
              <div className="ext-actions">
                {installedIds.has(x.id) ? (
                  <span className="ext-meta">Installed</span>
                ) : (
                  <button className="primary" data-ext-install disabled={!x.download || installing === x.id} onClick={() => void installFromRegistry(x)}>
                    {installing === x.id ? 'Installing…' : 'Install'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="dbg-section-head">
        <span>
          Installed {installed.length > 0 && <span className="git-count">{installed.length}</span>}
        </span>
      </div>
      {installed.length === 0 && (
        <div className="dbg-empty">
          No extensions yet. Themes and snippets from VS Code extensions work here; so do extensions written for this editor
          (a <code>package.json</code> with <code>"engines": {'{'} "my-ai-ide": "*" {'}'}</code>). Extensions that need the VS Code API itself (language servers, debuggers, webviews) cannot run.
        </div>
      )}
      {installed.map((e) => (
        <Row key={e.id} e={e} />
      ))}

      {log.length > 0 && (
        <>
          <div className="dbg-section-head">
            <span>Extension host log</span>
          </div>
          <pre className="dbg-output" data-ext-log>
            {log.join('\n')}
          </pre>
        </>
      )}
    </div>
  )
}
