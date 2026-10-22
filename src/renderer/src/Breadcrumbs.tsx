// The path of the active file, one clickable piece per folder. Clicking a piece shows it in the explorer.
export function Breadcrumbs({
  root,
  path,
  onReveal
}: {
  root: string | null
  path: string
  onReveal: (absPath: string) => void
}): JSX.Element {
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const inside = root !== null && norm(path).toLowerCase().startsWith(norm(root).toLowerCase() + '/')
  const base = inside ? norm(root) : ''
  const parts = (inside ? norm(path).slice(norm(root).length + 1) : norm(path)).split('/').filter(Boolean)

  // The absolute path up to and including part `i`, in the form the rest of the app uses (backslashes).
  const pathTo = (i: number): string => {
    const joined = (base ? [base, ...parts.slice(0, i + 1)] : parts.slice(0, i + 1)).join('/')
    return joined.replace(/\//g, '\\')
  }

  return (
    <div className="breadcrumbs" data-breadcrumbs>
      {parts.map((p, i) => (
        <span key={i} className="crumb-wrap">
          {i > 0 && <span className="crumb-sep">›</span>}
          <span
            className={'crumb' + (i === parts.length - 1 ? ' last' : '')}
            data-crumb={p}
            title={`Show in the explorer`}
            onClick={() => onReveal(pathTo(i))}
          >
            {p}
          </span>
        </span>
      ))}
    </div>
  )
}
