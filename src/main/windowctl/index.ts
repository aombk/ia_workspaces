/**
 * Which window driver this machine gets.
 *
 * Three of them, and they have almost nothing in common below the interface:
 * `user32` through a PowerShell helper, the Accessibility API through
 * `osascript`, and X11 through `xdotool`. What they share is three questions
 * and one rule — nothing is reparented, everything is show, hide or move.
 *
 * The choice is made once, here, so nothing above this file contains the word
 * `process.platform`.
 */
import { isWindows, platformKind } from '../../shared/platform'
import { NoWindowDriver, type WindowDriver } from './types'
import { Win32Driver } from './win32'
import { MacDriver } from './macos'
import { X11Driver } from './x11'

export type { ForeignWindow, ScreenRect, WindowAction, WindowDriver } from './types'

export function createWindowDriver(
  writeScript: (text: string) => string | null,
  env: NodeJS.ProcessEnv = process.env
): WindowDriver {
  const platform = platformKind(process.platform)
  if (isWindows(platform)) return new Win32Driver(writeScript)
  if (platform === 'macos') return new MacDriver()

  // Linux, and which session it is decides everything. `WAYLAND_DISPLAY` is the
  // one reliable signal; a session with both set is XWayland, where our own
  // window and the X11 tools agree with each other, so it is treated as X11.
  const wayland = Boolean(env.WAYLAND_DISPLAY) && !env.DISPLAY
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return new NoWindowDriver('There is no graphical session here to move windows in.')
  }
  return new X11Driver(wayland)
}
