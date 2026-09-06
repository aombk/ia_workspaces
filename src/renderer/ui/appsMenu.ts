/**
 * The workspace's programs, as a menu.
 *
 * One submenu per workspace listing the GUI programs it owns, what each one is
 * doing, and the two decisions worth taking about it — whether its window
 * follows this workspace, and how it leaves the screen when it does. Adding one
 * is a file picker; there is no dialog, because the only field that has no
 * sensible default is the program itself.
 *
 * The options live here rather than in Settings for the same reason the sidebar
 * ones do: they are decisions about *this program in this workspace*, taken
 * while looking at it. A settings panel listing every program in every
 * workspace would be a second place to keep the same list.
 */
import { backend } from '../../backend'
import { store } from '../state'
import { showToast } from './toast'
import { appsReason, appsSupported, refreshAppReason, syncApps } from './externalApps'
import type { MenuEntry } from './contextMenu'
import type {
  AttachableWindow,
  ExternalApp,
  ExternalAppAway,
  ExternalAppMode,
  RunningApp,
} from '../../shared/types'

/**
 * What is running, refreshed when a menu is built.
 *
 * A menu is built on a click and read for a second, so a snapshot taken as it
 * opens is fresh enough; asking the host inside the click handler would mean
 * an async menu, which is a menu that appears late.
 */
let running: RunningApp[] = []

/** Keeps the snapshot current. Called wherever the sidebar is about to draw. */
export async function refreshRunningApps(): Promise<void> {
  // The reason comes with it, and both are cheap. On macOS the Accessibility
  // permission can be granted while the app is running, and on Linux the
  // missing package can be installed — so "off" is a state that fixes itself
  // and asking once at startup would leave the menu wrong until a restart.
  await refreshAppReason()
  if (!appsSupported()) {
    running = []
    return
  }
  try {
    running = await backend().apps.running()
  } catch {
    running = []
  }
}

function isRunning(appId: string): RunningApp | undefined {
  return running.find((r) => r.appId === appId)
}

/** The executable's own name, which is what the program is called until renamed. */
function stemOf(command: string): string {
  const leaf = command.split(/[\\/]/).pop() ?? command
  return leaf.replace(/\.[^.]+$/, '') || leaf
}

const MODES: Array<{ mode: ExternalAppMode; label: string; hint: string }> = [
  {
    mode: 'follow',
    label: 'follow this workspace',
    hint: 'Off screen while you are in another workspace, back when you return. Where you put the window is where it stays.',
  },
  {
    mode: 'snap',
    label: 'snap to a pane',
    hint: 'Follows the workspace, and is kept over one pane while you are here.',
  },
  {
    mode: 'free',
    label: 'leave it alone',
    hint: 'Launched and then untouched, like a program started from any terminal.',
  },
]

/**
 * The submenu for one program.
 *
 * Ordered as it is read: what it is doing now, then what to do with it, then
 * how it should behave, then the destructive one at the bottom.
 */
function appMenu(workspaceId: string, app: ExternalApp, cwd: string): MenuEntry {
  const live = isRunning(app.id)
  const panes = store.workspaces
    .find((w) => w.id === workspaceId)
    ?.tabs.flatMap((tab) => tab.panes.map((pane) => ({ tab, pane }))) ?? []

  const state = live
    ? `Managed${live.pid ? ` · pid ${live.pid}` : ''}${live.away ? ' · off screen' : ''}`
    : app.attached
      ? 'Not attached — pick its window again'
      : 'Not running'

  const submenu: MenuEntry[] = [
    { label: state, disabled: true },
    'separator',
    // Both rows always, and the one that does not apply is greyed rather than
    // absent: a menu whose items move about depending on how the entry was made
    // is a menu you have to read twice.
    {
      label: 'Launch',
      disabled: Boolean(live) || !app.command,
      onClick: () => void launchApp(workspaceId, app, cwd),
    },
    {
      label: app.attached ? 'Attach its window…' : 'Attach a window instead…',
      disabled: Boolean(live),
      submenu: [{ label: 'Looking…', disabled: true }],
      onOpen: () => attachSubmenu(workspaceId, app),
    },
    ...(live
      ? [
          {
            label: 'Stop managing its window',
            onClick: () => {
              void backend().apps.release(app.id)
              void refreshRunningApps()
            },
          },
        ]
      : []),
    'separator',
    ...MODES.map(({ mode, label, hint }) => ({
      label,
      checked: app.mode === mode,
      onClick: () => {
        store.updateApp(workspaceId, app.id, { mode })
        if (mode === 'snap' && !app.paneId) showToast('Pick a pane', hint)
        syncApps()
      },
    })),
    // Only where it means something. A pane list under a program set to
    // `follow` is a list of answers to a question nobody asked.
    ...(app.mode === 'snap'
      ? [
          {
            label: 'Pane to cover',
            submenu: panes.length
              ? panes.map(({ tab, pane }) => ({
                  label: `${tab.customTitle ?? 'tab'} · ${pane.customTitle ?? pane.autoTitle ?? pane.id.slice(0, 6)}`,
                  checked: app.paneId === pane.id,
                  onClick: () => {
                    store.updateApp(workspaceId, app.id, { paneId: pane.id })
                    syncApps()
                  },
                }))
              : [{ label: 'No panes in this workspace', disabled: true }],
          } satisfies MenuEntry,
        ]
      : []),
    'separator',
    ...(['minimize', 'hide'] as ExternalAppAway[]).map((away) => ({
      label: away === 'minimize' ? 'leaves by minimising' : 'leaves by hiding',
      checked: app.away === away,
      disabled: app.mode === 'free',
      onClick: () => {
        store.updateApp(workspaceId, app.id, { away })
        syncApps()
      },
    })),
    {
      // Off by default, and the label says what it does rather than which case
      // it exists for. A program that hands your launch to a copy already
      // running — most single-instance apps — owns no window under the process
      // we started, and this is the only way to find the one it does own.
      label: 'adopt any window of this program',
      checked: app.adopt === 'name',
      disabled: app.mode === 'free',
      onClick: () => {
        store.updateApp(workspaceId, app.id, {
          adopt: app.adopt === 'name' ? 'pid' : 'name',
        })
        syncApps()
      },
    },
    'separator',
    {
      label: 'Remove from this workspace',
      danger: true,
      onClick: () => {
        void backend().apps.release(app.id)
        store.removeApp(workspaceId, app.id)
        void refreshRunningApps()
      },
    },
  ]

  return { label: `${app.name}${live ? ' ·' : ''}`, submenu }
}

async function launchApp(workspaceId: string, app: ExternalApp, cwd: string): Promise<void> {
  try {
    const pid = await backend().apps.launch(app, workspaceId, app.cwd || cwd)
    if (!pid) {
      showToast('Could not start it', `${app.command} did not launch.`, { kind: 'error' })
      return
    }
    await refreshRunningApps()
    syncApps()
  } catch (err) {
    showToast('Could not start it', err instanceof Error ? err.message : String(err), {
      kind: 'error',
    })
  }
}

async function addApp(workspaceId: string): Promise<void> {
  const chosen = await backend().pickOpenFile({
    title: 'Choose a program',
    filters: [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk'] }],
  })
  if (!chosen) return
  store.addApp(workspaceId, {
    id: crypto.randomUUID(),
    name: stemOf(chosen),
    command: chosen,
    // The safe pair, deliberately. Following is what the feature is for, and
    // minimising is the half of it that cannot lose a window.
    mode: 'follow',
    away: 'minimize',
  })
  syncApps()
}

/**
 * The windows on screen, as a menu you pick one from.
 *
 * Built when the submenu opens rather than with its parent: this is a list of
 * what is on screen *now*, and one assembled when the workspace menu was built
 * would be a list of what was on it when you right-clicked.
 *
 * Grouped by program, because that is how the window is looked for — you know
 * which application it belongs to, then which of its three you meant.
 */
async function attachSubmenu(workspaceId: string, app: ExternalApp): Promise<MenuEntry[]> {
  let windows: AttachableWindow[] = []
  try {
    windows = await backend().apps.attachable()
  } catch {
    windows = []
  }
  if (!windows.length) return [{ label: 'No windows to attach', disabled: true }]

  const byProgram = new Map<string, AttachableWindow[]>()
  for (const window of windows) {
    const key = window.executable || 'other'
    byProgram.set(key, [...(byProgram.get(key) ?? []), window])
  }

  return [...byProgram.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([executable, group]) => ({
      label: executable,
      submenu: group.map((window) => ({
        label: window.title.length > 60 ? `${window.title.slice(0, 57)}…` : window.title,
        onClick: () => void attachWindow(workspaceId, app, window),
      })),
    }))
}

/**
 * Binds a window to an entry, and remembers enough to find it again.
 *
 * The handle is this session's; the program and the title are what survive a
 * restart. See `ExternalApp.attached` for why that pair and not the handle.
 */
async function attachWindow(
  workspaceId: string,
  app: ExternalApp,
  window: AttachableWindow
): Promise<void> {
  const attached = { executable: window.executable, title: window.title }
  store.updateApp(workspaceId, app.id, { attached, name: app.name || window.title })
  const ok = await backend().apps.attach(
    { ...app, attached },
    workspaceId,
    window.hwnd,
    window.pid
  )
  if (!ok) {
    showToast('Already taken', 'That window belongs to another entry. Remove that one first.')
    return
  }
  await refreshRunningApps()
  syncApps()
}

/**
 * Attaching with no entry yet — the short path from "that window" to "that
 * window belongs to this workspace", which is what the feature is for.
 *
 * The entry is created by the pick rather than before it, so a menu opened out
 * of curiosity and dismissed leaves nothing behind.
 */
async function attachNew(workspaceId: string): Promise<MenuEntry[]> {
  const app: ExternalApp = {
    id: crypto.randomUUID(),
    name: '',
    mode: 'follow',
    away: 'minimize',
  }
  const groups = await attachSubmenu(workspaceId, app)
  return groups.map((group) => {
    if (typeof group === 'string' || !('submenu' in group) || !group.submenu) return group
    return {
      ...group,
      submenu: group.submenu.map((leaf) => {
        if (typeof leaf === 'string' || !('onClick' in leaf) || !leaf.onClick) return leaf
        const pick = leaf.onClick
        return {
          ...leaf,
          onClick: () => {
            store.addApp(workspaceId, { ...app, name: leaf.label })
            pick()
          },
        }
      }),
    }
  })
}

/**
 * The workspace menu's entry, or nothing at all where the host cannot place
 * another program's window. An entry that opens onto "not supported here" is a
 * line spent saying no.
 */
export function programsMenu(workspaceId: string, cwd: string): MenuEntry[] {
  const why = appsReason()
  // Off with nothing to say means a platform that simply cannot — Wayland, a
  // host with no window driver — and there the entry is not offered at all. Off
  // *with* a reason means something the user can fix, and that is worth a menu
  // whose first line says what.
  if (!appsSupported() && !why) return []
  const workspace = store.workspaces.find((w) => w.id === workspaceId)
  const apps = workspace?.apps ?? []

  if (!appsSupported()) {
    return [{ label: 'Programs', submenu: [{ label: why, disabled: true }] }]
  }

  return [
    {
      label: 'Programs',
      submenu: [
        ...apps.map((app) => appMenu(workspaceId, app, cwd)),
        ...(apps.length ? (['separator'] as MenuEntry[]) : []),
        {
          label: 'Attach a running window…',
          submenu: [{ label: 'Looking…', disabled: true }],
          onOpen: () => attachNew(workspaceId),
        },
        { label: 'Add a program to launch…', onClick: () => void addApp(workspaceId) },
        // The escape hatch for the one failure hiding can cause, and it is in
        // the menu rather than in a help page because that is where somebody
        // looking for a lost window will be.
        {
          label: 'Show every program window',
          onClick: () => {
            void backend().apps.showAll()
            void refreshRunningApps()
          },
        },
      ],
    },
  ]
}
