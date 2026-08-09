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
import { hasPrimaryModifier, modifierLabel, type PlatformKind } from '../../shared/platform'

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

/** The primary modifier *and* nothing else that would change the meaning. */
export function isPrimaryOnly(e: {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): boolean {
  return isPrimary(e) && !e.altKey && !e.shiftKey
}

/**
 * True when this event carries the *other* platform's modifier and no more.
 *
 * The one thing worth keeping from `ctrlKey || metaKey`: a Mac user who has
 * spent years on the Windows build will press Ctrl. Rather than silently doing
 * nothing, callers that want to be forgiving can check this and act — but they
 * have to opt in, so the terminal (where Ctrl genuinely means something else)
 * does not.
 */
export function isForeignPrimary(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return platform() === 'macos' ? e.ctrlKey && !e.metaKey : e.metaKey && !e.ctrlKey
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

/**
 * How to write a shortcut for this platform: `⌘⇧K` on a Mac, `Ctrl+Shift+K`
 * elsewhere. Used by the command palette and the settings panel so the hints
 * match the keys that actually work.
 */
export function shortcutLabel(parts: { shift?: boolean; alt?: boolean; key: string }): string {
  const m = modifierLabel(platform())
  const bits = [m.primary]
  if (parts.alt) bits.push(m.alt)
  if (parts.shift) bits.push(m.shift)
  bits.push(parts.key.toUpperCase())
  return bits.join(m.joiner)
}
