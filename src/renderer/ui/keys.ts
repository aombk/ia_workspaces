/**
 * Which modifier means "the app", on this machine.
 *
 * One import for the renderer so that no component has to know what platform it
 * is on — they ask `isPrimary(e)` and get Ctrl on Windows and Linux, Command on
 * a Mac. The alternative is `e.ctrlKey || e.metaKey` sprinkled everywhere, which
 * reads like tolerance and is actually a bug: it makes Ctrl+W close a tab on a
 * Mac, where Ctrl+W is the readline binding for delete-word-backwards and a
 * terminal user presses it constantly.
 *
 * Read once. The platform cannot change while the window is open, and going
 * through `backend()` on every keystroke would be a call per event.
 */
import { backend } from '../../backend'
import { hasPrimaryModifier, type PlatformKind } from '../../shared/platform'

let cached: PlatformKind | null = null

function platform(): PlatformKind {
  if (!cached) cached = backend().capabilities.platform
  return cached
}

/**
 * The app's own modifier: Command on macOS, Control elsewhere.
 *
 * Deliberately exclusive. On a Mac, `Cmd+C` is copy and `Ctrl+C` is interrupt —
 * two different keys doing two different jobs, which is the arrangement every
 * Mac terminal has and the reason the Windows build has to disambiguate `Ctrl+C`
 * by checking whether a selection exists. Accepting either modifier here would
 * throw that away.
 */
export function isPrimary(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return hasPrimaryModifier(platform(), e)
}

/**
 * For the handful of places where the difference is not "which modifier" but
 * "does this rule apply at all" — the terminal's Ctrl+C disambiguation being
 * the one that matters, since on a Mac there is nothing to disambiguate.
 */
export function isMac(): boolean {
  return platform() === 'macos'
}

/**
 * The combination that moves between panes and workspaces.
 *
 * Windows and Linux use bare Alt, and always have. macOS cannot: Option is a
 * *composing* modifier there, so Option+Left is the readline word-jump every
 * shell user leans on and Option+3 types `£`. An app that swallowed those would
 * be taking keys out of the terminal it exists to host.
 *
 * So the Mac needs Command as well — which is also what iTerm2 settled on for
 * the same reason, and means the muscle memory transfers for anyone arriving
 * from there.
 */
export function isNavigation(e: {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): boolean {
  if (!e.altKey) return false
  return platform() === 'macos' ? e.metaKey : !e.ctrlKey
}
