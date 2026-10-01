/**
 * What this platform calls its file manager, for menu labels.
 *
 * The app grew up on Windows, and "Reveal in Explorer" was written into every
 * menu that opens a folder — which on a Mac names a program that does not
 * exist. Each platform's own phrase, so the menu reads the way the rest of the
 * system does: Finder's is "Show in Finder", the one every Mac app uses.
 */
import type { PlatformKind } from './platform'

/** The program's name: `Finder`, `Explorer`, or a generic phrase on Linux. */
export function fileManagerName(platform: PlatformKind): string {
  if (platform === 'macos') return 'Finder'
  if (platform === 'windows') return 'Explorer'
  // Linux has no single answer — Files, Dolphin, Thunar — and naming the wrong
  // one is worse than naming none.
  return 'file manager'
}

/** "Show in Finder" / "Reveal in Explorer" / "Show in file manager". */
export function revealLabel(platform: PlatformKind): string {
  if (platform === 'windows') return 'Reveal in Explorer'
  return `Show in ${fileManagerName(platform)}`
}

/**
 * Opening a file with whatever the system would open it with.
 *
 * "Open with Windows" was the Windows phrase; elsewhere it names nothing.
 */
export function openWithSystemLabel(platform: PlatformKind): string {
  if (platform === 'windows') return 'Open with Windows'
  return 'Open with default app'
}
