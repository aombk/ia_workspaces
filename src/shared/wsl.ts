/**
 * Translating between a WSL distribution's Windows share and its Linux paths.
 *
 * The whole reason a WSL workspace is tractable: everything in this app speaks
 * Windows paths — the file tree, git status, search, the diff — and Windows
 * exposes every running distribution at `\\wsl.localhost\<distro>\…`. So a WSL
 * workspace stores the share path like any other folder, and only the moment a
 * shell is spawned does it need to become `/home/you/project`.
 *
 * `\\wsl$\` is the older spelling of the same share and still works, so both are
 * recognised on the way in; the newer one is what gets written.
 */

const PREFIXES = ['\\\\wsl.localhost\\', '\\\\wsl$\\']

/** The distro and Linux path behind a share path, or null if it is not one. */
export function parseWslPath(windowsPath: string): { distro: string; path: string } | null {
  for (const prefix of PREFIXES) {
    if (!windowsPath.toLowerCase().startsWith(prefix.toLowerCase())) continue
    const rest = windowsPath.slice(prefix.length)
    const cut = rest.indexOf('\\')
    const distro = cut === -1 ? rest : rest.slice(0, cut)
    if (!distro) return null
    const tail = cut === -1 ? '' : rest.slice(cut).replace(/\\/g, '/')
    return { distro, path: tail || '/' }
  }
  return null
}

/** The share path for a Linux path inside a distribution. */
export function toWslSharePath(distro: string, linuxPath: string): string {
  const tail = linuxPath.replace(/\//g, '\\')
  return `\\\\wsl.localhost\\${distro}${tail.startsWith('\\') ? tail : `\\${tail}`}`
}

/** True when this folder lives inside some distribution's share. */
export function isWslPath(windowsPath: string): boolean {
  return parseWslPath(windowsPath) !== null
}
