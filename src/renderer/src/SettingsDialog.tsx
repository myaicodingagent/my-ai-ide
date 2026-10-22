import { useEffect, useState } from 'react'
import { MODELS } from './models'
import { LIMITS, Settings, resetSettings, updateSettings, useSettings } from './settings'
import { describeUpdate, useUpdateState } from './update'
import {
  applyTheme,
  getTheme,
  getThemeErrors,
  getThemes,
  loadCustomThemes,
  subscribeTheme,
  themeToJson
} from './theme'

const FONTS = ['Cascadia Code', 'Cascadia Mono', 'Consolas', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Courier New']

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-label">
        {label}
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Stepper({
  setting,
  value,
  step,
  limits,
  format = String,
  onChange
}: {
  setting: string
  value: number
  step: number
  limits: readonly [number, number]
  format?: (n: number) => string
  onChange: (n: number) => void
}): JSX.Element {
  const round = (n: number): number => Math.round(n * 10) / 10
  return (
    <span className="stepper" data-setting={setting}>
      <button aria-label="Decrease" disabled={value <= limits[0]} onClick={() => onChange(round(value - step))}>
        −
      </button>
      <span className="stepper-value">{format(value)}</span>
      <button aria-label="Increase" disabled={value >= limits[1]} onClick={() => onChange(round(value + step))}>
        +
      </button>
    </span>
  )
}

function Check({ setting, keyName, s }: { setting: string; keyName: keyof Settings; s: Settings }): JSX.Element {
  return (
    <input
      type="checkbox"
      data-setting={setting}
      checked={s[keyName] as boolean}
      onChange={(e) => updateSettings({ [keyName]: e.target.checked })}
    />
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const s = useSettings()
  const update = useUpdateState()
  const [themeId, setThemeId] = useState(getTheme().id)
  const [shells, setShells] = useState<{ id: string; label: string }[]>([])
  useEffect(() => {
    void window.api.termShells().then(setShells)
  }, [])
  const [, refresh] = useState(0) // re-render when the theme list changes
  const [note, setNote] = useState<string | null>(null)
  useEffect(
    () =>
      subscribeTheme(() => {
        setThemeId(getTheme().id)
        refresh((n) => n + 1)
      }),
    []
  )
  const themes = getThemes()
  const custom = themes.filter((t) => t.custom)
  const errors = getThemeErrors()

  const reload = async (message = 'Reloaded the themes folder.'): Promise<void> => {
    await loadCustomThemes()
    setNote(message)
  }
  const openFolder = async (): Promise<void> => {
    const err = await window.api.themesOpenFolder()
    setNote(err ? `Could not open the folder: ${err}` : 'Opened the themes folder. Edit or add .json files, then press Reload.')
  }
  const importTheme = async (): Promise<void> => {
    const r = await window.api.themesImport()
    if (r.ok) await reload(`Imported ${r.file}.`)
    else if (r.error !== 'cancelled') setNote(r.error)
  }
  // Writes the current theme out as a complete file and switches to the copy, ready to edit.
  const duplicate = async (): Promise<void> => {
    const t = getTheme()
    const file = await window.api.themesSave(`${t.label} copy`, themeToJson(t))
    await loadCustomThemes()
    applyTheme(`custom:${file}`, true)
    setNote(`Saved ${file} in the themes folder and switched to it. Edit the file, then press Reload.`)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="qp-backdrop" onMouseDown={onClose}>
      <div className="qp settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="set-header">
          <span>Settings</span>
          <button className="set-close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="set-body">
          <div className="set-group">Appearance</div>
          <Row label="Color theme">
            <select data-setting="theme" value={themeId} onChange={(e) => applyTheme(e.target.value, true)}>
              <optgroup label="Built-in">
                {themes
                  .filter((t) => !t.custom)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
              </optgroup>
              {custom.length > 0 && (
                <optgroup label="Custom">
                  {custom.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Row>
          <Row label="Custom themes" hint={`JSON files in the themes folder (${custom.length} loaded). A file lists colors; anything left out comes from a built-in theme.`}>
            <span className="set-buttons">
              <button data-setting="themesOpen" onClick={() => void openFolder()}>
                Open folder
              </button>
              <button data-setting="themesImport" onClick={() => void importTheme()}>
                Import…
              </button>
              <button data-setting="themesDuplicate" title="Save the current theme as a file you can edit" onClick={() => void duplicate()}>
                Duplicate current
              </button>
              <button data-setting="themesReload" onClick={() => void reload()}>
                Reload
              </button>
            </span>
          </Row>
          {(note || errors.length > 0) && (
            <div className="set-themes-note" data-setting="themeNote">
              {note && <div>{note}</div>}
              {errors.map((e) => (
                <div key={e} className="set-theme-error">
                  {e}
                </div>
              ))}
            </div>
          )}
          <Row label="UI zoom" hint="Scales the whole interface">
            <Stepper
              setting="uiZoom"
              value={s.uiZoom}
              step={0.1}
              limits={LIMITS.uiZoom}
              format={(n) => `${Math.round(n * 100)}%`}
              onChange={(n) => updateSettings({ uiZoom: n })}
            />
          </Row>

          <div className="set-group">Editor</div>
          <Row label="Font family" hint="Must be installed on this PC; falls back to Cascadia Mono / Consolas">
            <input
              className="set-text"
              data-setting="fontFamily"
              list="font-list"
              value={s.fontFamily}
              onChange={(e) => updateSettings({ fontFamily: e.target.value })}
            />
            <datalist id="font-list">
              {FONTS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Row>
          <Row label="Font size">
            <Stepper
              setting="fontSize"
              value={s.fontSize}
              step={1}
              limits={LIMITS.fontSize}
              format={(n) => `${n} px`}
              onChange={(n) => updateSettings({ fontSize: n })}
            />
          </Row>
          <Row label="Minimap">
            <Check setting="minimap" keyName="minimap" s={s} />
          </Row>
          <Row label="Word wrap">
            <Check setting="wordWrap" keyName="wordWrap" s={s} />
          </Row>
          <Row label="Font ligatures" hint="Joins symbols like => and !== (fonts that support it)">
            <Check setting="ligatures" keyName="ligatures" s={s} />
          </Row>
          <Row label="Auto save" hint="Saves edited files by itself. Files changed on disk by something else are never overwritten automatically.">
            <select
              data-setting="autoSave"
              value={s.autoSave}
              onChange={(e) => updateSettings({ autoSave: e.target.value as Settings['autoSave'] })}
            >
              <option value="off">Off</option>
              <option value="afterDelay">After a short delay (1 s)</option>
              <option value="onBlur">When the window loses focus</option>
            </select>
          </Row>
          <Row label="Format on save" hint="Formats the file you save first. Works for JavaScript, TypeScript, JSON, CSS and HTML.">
            <Check setting="formatOnSave" keyName="formatOnSave" s={s} />
          </Row>

          <div className="set-group">Terminal</div>
          <Row label="Default shell" hint="Used by new terminals. Others are in the ▾ menu next to + in the terminal panel.">
            <select
              data-setting="terminalShell"
              value={s.terminalShell}
              onChange={(e) => updateSettings({ terminalShell: e.target.value })}
            >
              {/* A saved shell that is not installed any more is still shown, and falls back to PowerShell. */}
              {!shells.some((x) => x.id === s.terminalShell) && <option value={s.terminalShell}>{s.terminalShell} (not found)</option>}
              {shells.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Font size">
            <Stepper
              setting="terminalFontSize"
              value={s.terminalFontSize}
              step={1}
              limits={LIMITS.terminalFontSize}
              format={(n) => `${n} px`}
              onChange={(n) => updateSettings({ terminalFontSize: n })}
            />
          </Row>

          <div className="set-group">AI</div>
          <Row label="Default model" hint="Used by chat, the agent and inline edit">
            <select
              data-setting="defaultModel"
              value={s.defaultModel}
              onChange={(e) => updateSettings({ defaultModel: e.target.value })}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Autocomplete" hint="Ghost-text suggestions as you type (Haiku 5.5, uses API credits)">
            <Check setting="autocomplete" keyName="autocomplete" s={s} />
          </Row>

          <div className="set-group">Updates</div>
          <Row label={`Version ${update.current}`}>
            <span className="set-update-text" data-setting="updateText">
              {describeUpdate(update)}
            </span>
            {update.status === 'available' ? (
              <button className="primary" data-setting="updateDownload" onClick={() => void window.api.updateDownload()}>
                Download
              </button>
            ) : update.status === 'ready' ? (
              <button className="primary" data-setting="updateInstall" onClick={() => window.api.updateInstall()}>
                Restart to update
              </button>
            ) : (
              <button
                data-setting="updateCheck"
                disabled={update.status === 'checking' || update.status === 'downloading'}
                onClick={() => void window.api.updateCheck()}
              >
                Check for updates
              </button>
            )}
          </Row>
          <Row label="Check automatically" hint="At startup and every few hours. Downloading and installing always wait for you.">
            <Check setting="autoCheckUpdates" keyName="autoCheckUpdates" s={s} />
          </Row>
        </div>
        <div className="ie-actions set-footer">
          <button
            data-setting="reset"
            onClick={() => {
              resetSettings()
              applyTheme('dark-modern', true)
            }}
          >
            Reset to defaults
          </button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
