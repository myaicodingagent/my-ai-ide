// Pure helpers for terminals that are not a plain local shell: folders inside WSL, and SSH sessions.

export interface WslLocation {
  distro: string
  path: string // Linux path inside the distribution
}

/** `\\wsl$\Ubuntu\home\me\proj` or `\\wsl.localhost\Ubuntu\home\me\proj` -> { distro: 'Ubuntu', path: '/home/me/proj' }. */
export function wslLocation(p: string | null | undefined): WslLocation | null {
  if (!p) return null
  const m = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\/]+)((?:[\\/].*)?)$/i.exec(p.trim())
  if (!m) return null
  const distro = m[1]
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(distro)) return null
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '')
  return { distro, path: rest === '' ? '/' : rest }
}

/** The Windows path of a place inside a WSL distribution. */
export const wslUnc = (distro: string, linuxPath: string): string => `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`

/** Output of `wsl.exe -l -q` (UTF-16, one distribution per line) -> distribution names. */
export function parseWslList(raw: Buffer | string): string[] {
  const text = typeof raw === 'string' ? raw : raw.toString('utf16le')
  return text
    .replace(/\0/g, '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(l))
}

/**
 * `user@host`, `host`, an alias from ~/.ssh/config, or an address. Anything that could be read as an option for ssh
 * (a leading "-") or that contains characters a host never has is refused.
 */
export function validSshTarget(t: string): boolean {
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._:-]+$/.test(t) && !t.startsWith('-') && !t.includes('@-') && t.length <= 200
}

/** Arguments for ssh: the "--" ends the options, so the target can never be taken for one. */
export const sshArgs = (target: string): string[] => ['--', target]

/** `wsl.exe` arguments that run a shell command inside the distribution, in the given folder. */
export const wslCommandArgs = (loc: WslLocation, command: string): string[] => ['-d', loc.distro, '--cd', loc.path, '--', 'bash', '-lc', command]

/** `wsl.exe` arguments for an interactive shell in the given folder. */
export const wslShellArgs = (loc: WslLocation): string[] => ['-d', loc.distro, '--cd', loc.path]
