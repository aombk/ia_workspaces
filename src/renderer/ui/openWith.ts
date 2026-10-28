/**
 * The "Open with" submenu: the programs from settings, then the way to add one.
 *
 * Shared by the file tree, which offers it on every file, and the image
 * gallery, so the two can never list different programs. Empty, the submenu
 * is just the second row — which is how anyone finds the setting at all.
 */
import { backend } from '../../backend'
import { store } from '../state'
import type { MenuEntry } from './contextMenu'
import { openSettings } from './settingsPanel'
import { showToast } from './toast'

export function openWithEntries(path: string): MenuEntry[] {
  const apps: MenuEntry[] = store.settings.openWithApps.map((app) => ({
    label: app.name || leafOf(app.program),
    onClick: () => {
      void backend()
        .files.openWith(app.program, path)
        .catch((err: unknown) =>
          showToast(
            `Could not open ${app.name || 'the program'}`,
            `${app.program} — ${err instanceof Error ? err.message : String(err)}`,
            { kind: 'error' }
          )
        )
    },
  }))
  return [
    ...apps,
    ...(apps.length ? (['separator'] as MenuEntry[]) : []),
    { label: 'Choose programs…', onClick: () => void openSettings() },
  ]
}

function leafOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
