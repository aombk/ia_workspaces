/**
 * Keeping other programs' windows in step with what is on screen.
 *
 * The host owns the windows — see `main/externalApps.ts` — and knows nothing
 * about workspaces, tabs or panes. This is the half that does: which workspace
 * you are looking at, and where a snapping program's pane currently is. One
 * message carries both, on every change that could move either.
 *
 * **Rectangles are measured, not calculated.** A pane's position is the result
 * of a flex layout, a divider somebody dragged, a UI scale and a title bar, and
 * the only thing that knows all of it is the browser. So the element is asked,
 * and what it answers — CSS pixels inside the content area — is what gets sent;
 * the host turns that into screen pixels, because only the host knows where its
 * window is.
 *
 * **Coalesced, because layout changes arrive in bursts.** Dragging a divider
 * fires on every frame, and a round trip per frame to a PowerShell helper is
 * both wasteful and pointless — only the last one is true. Sync is queued to
 * the next frame and collapses.
 */
import { store } from '../state'
import { backend } from '../../backend'
import type { ExternalApp, ExternalAppSync, PixelRect } from '../../shared/types'

/** Where a snapping app's pane is right now, or null when it has none. */
export type RectOf = (paneId: string) => PixelRect | null

let queued = false
let rectOf: RectOf = () => null
/**
 * Whether the host can do any of this.
 *
 * Asked once and remembered. A host that has not ported the channels rejects
 * rather than answering false, and a rejection means the same thing here: no
 * menu, no sync, no cost.
 */
let supported: boolean | null = null
/** Why not, when it is off. Refreshed with the running list. */
let reason = ''

export function setRectSource(source: RectOf): void {
  rectOf = source
}

/** Whether to offer any of this — false until the host has been asked. */
export function appsSupported(): boolean {
  return supported === true
}

/**
 * Why the feature is off, when it is off for a reason worth saying.
 *
 * Two of the three platforms can be *made* to work — a permission on macOS, a
 * package on Linux — so "not available" would be the wrong thing to show and
 * showing nothing at all would be worse.
 */
export function appsReason(): string {
  return reason
}

/** Kept current alongside the running list, which the sidebar refreshes. */
export async function refreshAppReason(): Promise<void> {
  try {
    const [ok, why] = await Promise.all([backend().apps.supported(), backend().apps.reason()])
    supported = ok
    reason = why
  } catch {
    supported = false
  }
}

/** Asks the host once, at startup. */
export async function checkAppSupport(): Promise<boolean> {
  if (supported !== null) return supported
  try {
    supported = await backend().apps.supported()
  } catch {
    supported = false
  }
  return supported
}

/**
 * Tells the host what is on screen, at most once per frame.
 *
 * Safe to call from anywhere that changes the layout, which is the point: every
 * caller can be a one-liner next to the thing it already does, and none of them
 * has to know whether five other callers fired in the same tick.
 */
export function syncApps(): void {
  if (supported === false || queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    void send()
  })
}

async function send(): Promise<void> {
  if (!(await checkAppSupport())) return

  const apps: Record<string, ExternalApp> = {}
  const owners: Record<string, string> = {}
  const rects: Record<string, PixelRect> = {}
  for (const { workspaceId, app } of store.allApps()) {
    apps[app.id] = app
    owners[app.id] = workspaceId
    if (app.mode !== 'snap' || !app.paneId) continue
    const rect = rectOf(app.paneId)
    // A pane that is not on screen — another tab, a closed split — gets no
    // rectangle, and the host leaves that window where it is rather than
    // stacking it on the last place its pane happened to be.
    if (rect) rects[app.id] = rect
  }

  const request: ExternalAppSync = {
    activeWorkspaceId: store.activeWorkspace?.id ?? null,
    rects,
    apps,
    owners,
  }
  try {
    await backend().apps.sync(request)
  } catch {
    // The host is gone or does not do this. Either way there is nothing to say
    // about it here — the windows stay where they are.
  }
}
