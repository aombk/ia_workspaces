import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { hasQuirk, platformKind } from '../shared/platform'

const PLATFORM = platformKind(process.platform)

/**
 * "Open in ia_workspaces" on the Explorer right-click menu.
 *
 * Written under HKCU so it needs no elevation and cannot affect other accounts.
 * Three keys, because Explorer treats them as three different things: a folder
 * you right-click, the empty space *inside* a folder, and a drive root.
 *
 * Windows 11 shows this under "Show more options" rather than in the compact
 * menu. The compact menu only accepts entries from a signed MSIX package, which
 * an unsigned build cannot produce — so this is the whole of what is available,
 * not a first step toward something better.
 */

const KEYS = [
  'HKCU\\Software\\Classes\\Directory\\shell\\ia_workspaces',
  'HKCU\\Software\\Classes\\Directory\\Background\\shell\\ia_workspaces',
  'HKCU\\Software\\Classes\\Drive\\shell\\ia_workspaces',
]

const LABEL = 'Open in ia_workspaces'

function reg(args: string[]): void {
  execFileSync('reg.exe', args, { windowsHide: true, stdio: 'ignore', timeout: 8000 })
}

export function isContextMenuInstalled(): boolean {
  // False rather than an error, because this answer drives a settings toggle:
  // "not installed" hides the row, where a throw would need handling at a call
  // site that has nothing useful to do with it.
  if (!hasQuirk(PLATFORM, 'explorerMenu')) return false
  try {
    reg(['query', KEYS[0]])
    return true
  } catch {
    return false
  }
}

/**
 * @param launchCommand the full command line, already quoted, that opens the
 * app. `%V` is appended — Explorer substitutes the folder, and it is the only
 * verb argument that is correct for both a selected folder and a background
 * click.
 */
export function setContextMenu(enabled: boolean, launchCommand: string, iconPath: string): { ok: boolean; error?: string } {
  // The macOS equivalent is a Finder service and the Linux one a .desktop
  // action — different mechanisms with their own install stories, not a branch
  // of this one. Until someone wants them, saying so plainly beats pretending.
  if (!hasQuirk(PLATFORM, 'explorerMenu')) {
    return { ok: false, error: 'The Explorer context menu is a Windows feature.' }
  }
  try {
    for (const key of KEYS) {
      if (enabled) {
        reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', LABEL, '/f'])
        if (iconPath) reg(['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', iconPath, '/f'])
        reg(['add', `${key}\\command`, '/ve', '/t', 'REG_SZ', '/d', `${launchCommand} "%V"`, '/f'])
      } else {
        try {
          reg(['delete', key, '/f'])
        } catch {
          /* already absent */
        }
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The folder the app was launched with, if any.
 *
 * Explorer passes it as a bare trailing argument. Anything that isn't an
 * existing directory is ignored rather than guessed at — a stray argument
 * should not silently open a workspace somewhere unexpected.
 */
export function directoryFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    // Absolute only. Explorer always passes a full path, and a relative one is
    // never what was meant: `npm start` runs `electron .`, and that `.` is an
    // existing directory, so a dev launch used to open a workspace whose folder
    // was the literal string `.` — resolved against whatever directory the
    // process happened to start in, by every pane that later read it.
    if (!path.isAbsolute(arg)) continue
    try {
      if (existsSync(arg) && statSync(arg).isDirectory()) return arg
    } catch {
      /* not a path */
    }
  }
  return null
}
