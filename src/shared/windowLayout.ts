/**
 * Which window each tab lives in, as edits to the workspace document.
 *
 * Main makes these, not the windows: opening a window, closing one and sending
 * tabs between them all happen to two windows at once, and only main can see
 * both. Each is a plain function from one document to the next, so the rules —
 * a closed window's tabs come home, a tab never points at a window that is not
 * there — can be tested without a window in sight.
 *
 * The documents here are the raw JSON as stored, not the renderer's typed copy:
 * main never normalizes, and these have to leave alone every field they do not
 * know about.
 */
import type { WindowRecord, WindowView } from './types'

type Doc = Record<string, unknown>
type Raw = Record<string, unknown>

/** The id of the window that is not in the window list because it is always there. */
export const MAIN_WINDOW = 'main'

function workspacesOf(doc: Doc): Raw[] {
  return Array.isArray(doc.workspaces) ? (doc.workspaces as Raw[]) : []
}

function tabsOf(workspace: Raw): Raw[] {
  return Array.isArray(workspace.tabs) ? (workspace.tabs as Raw[]) : []
}

/** The window a tab is shown in. */
export function ownerOfTab(tab: { windowId?: unknown }): string {
  return typeof tab.windowId === 'string' && tab.windowId ? tab.windowId : MAIN_WINDOW
}

/** Every tab of a workspace, by id — the tabs a "move this workspace" moves. */
export function tabIdsOfWorkspace(doc: Doc, workspaceId: string): string[] {
  const workspace = workspacesOf(doc).find((w) => w.id === workspaceId)
  return workspace ? tabsOf(workspace).map((t) => String(t.id)) : []
}

/** The workspace a tab is in, or null. */
export function workspaceOfTab(doc: Doc, tabId: string): string | null {
  const workspace = workspacesOf(doc).find((w) => tabsOf(w).some((t) => t.id === tabId))
  return workspace ? String(workspace.id) : null
}

function mapTabs(doc: Doc, fn: (tab: Raw) => Raw): Doc {
  return {
    ...doc,
    workspaces: workspacesOf(doc).map((w) => ({ ...w, tabs: tabsOf(w).map(fn) })),
  }
}

/**
 * The window a workspace lives in: the one whose sidebar lists it.
 *
 * Separate from where its tabs are, because a workspace can be spread over two
 * screens and still belong to one of them — and because a workspace with no
 * tabs open still has to be listed somewhere.
 */
export function homeOfWorkspace(workspace: { windowId?: unknown }): string {
  return ownerOfTab(workspace)
}

/** Whether the windows follow one list. See `WindowMode`. */
export function isLinked(doc: Doc): boolean {
  return doc.windowMode === 'linked'
}

function viewsOf(doc: Doc): Record<string, WindowView> {
  return { ...((doc.views as Record<string, WindowView> | undefined) ?? {}) }
}

/**
 * Has a window show a workspace, as the document records it.
 *
 * With windows linked, a window that is not pinned shows whatever the list
 * does, so showing it something means the list showing it too: every window
 * switches. That is what sending a tab of another workspace to a pane window
 * has to mean, or the tab would arrive somewhere that is not showing it.
 */
function showIn(doc: Doc, windowId: string, workspaceId: string, tabId?: string): Doc {
  if (windowId === MAIN_WINDOW) {
    return {
      ...doc,
      activeWorkspaceId: workspaceId,
      workspaces: tabId
        ? workspacesOf(doc).map((w) => (w.id === workspaceId ? { ...w, activeTabId: tabId } : w))
        : workspacesOf(doc),
    }
  }
  const views = viewsOf(doc)
  const view = views[windowId] ?? { activeWorkspaceId: null, activeTabs: {} }
  views[windowId] = {
    ...view,
    activeWorkspaceId: workspaceId,
    activeTabs: tabId ? { ...view.activeTabs, [workspaceId]: tabId } : view.activeTabs,
  }
  const next = { ...doc, views }
  return isLinked(doc) && !view.pinned ? { ...next, activeWorkspaceId: workspaceId } : next
}

function withWindowId(item: Raw, windowId: string): Raw {
  const next = { ...item }
  if (windowId === MAIN_WINDOW) delete next.windowId
  else next.windowId = windowId
  return next
}

/**
 * Puts tabs in a window, and has that window show them.
 *
 * The receiving window's selection moves to the first of them, so a tab sent to
 * a window is the tab that window is showing — sending one somewhere it then
 * sits behind another is not what anybody dragging it meant. The main window's
 * selection is the document's own; any other's is its `views` entry.
 */
export function assignTabs(doc: Doc, tabIds: readonly string[], windowId: string): Doc {
  const moving = new Set(tabIds)
  if (!moving.size) return doc
  // Tabs only. Where the workspace is listed stays put even when its last tab
  // leaves: one window can be the list and the tree, with the panes on the
  // other monitors. Moving the workspace itself is `assignWorkspace`.
  let next = mapTabs(doc, (tab) => (moving.has(String(tab.id)) ? withWindowId(tab, windowId) : tab))

  const first = tabIds[0]
  const workspaceId = workspaceOfTab(next, first)
  if (!workspaceId) return next
  return showIn(next, windowId, workspaceId, first)
}

/**
 * A window is going away for good: its tabs come back to the main window, and
 * nothing about it is kept.
 *
 * Its tabs are not closed. Shutting a window you were using as a second screen
 * must not end the agents running in it — they are still somewhere you can
 * reach, in the window that cannot be closed without quitting.
 */
export function releaseWindow(doc: Doc, windowId: string): Doc {
  const tabsHome = mapTabs(doc, (tab) => (ownerOfTab(tab) === windowId ? withWindowId(tab, MAIN_WINDOW) : tab))
  const next = {
    ...tabsHome,
    workspaces: workspacesOf(tabsHome).map((w) => (homeOfWorkspace(w) === windowId ? withWindowId(w, MAIN_WINDOW) : w)),
  }
  const views = viewsOf(doc)
  delete views[windowId]
  const windows = ((doc.windows as WindowRecord[] | undefined) ?? []).filter((w) => w.id !== windowId)
  return { ...next, views, windows }
}

/**
 * Brings home every tab whose window is not open, and forgets views of windows
 * that are not either.
 *
 * Run as the windows are restored at launch, so no tab is left pointing at a
 * window that never came back — it would belong to nobody and be shown nowhere.
 */
export function keepOnlyWindows(doc: Doc, live: ReadonlySet<string>): Doc {
  const keep = (item: Raw) => {
    const owner = ownerOfTab(item)
    return owner === MAIN_WINDOW || live.has(owner) ? item : withWindowId(item, MAIN_WINDOW)
  }
  const tabsKept = mapTabs(doc, keep)
  const next = { ...tabsKept, workspaces: workspacesOf(tabsKept).map(keep) }
  const views: Record<string, WindowView> = {}
  for (const [id, view] of Object.entries((doc.views as Record<string, WindowView> | undefined) ?? {})) {
    if (live.has(id)) views[id] = view
  }
  return { ...next, views }
}

/**
 * A whole workspace into a window: where it is listed, every tab of it, and
 * that window showing it. Works for a workspace with no tabs too, which moving
 * its tabs alone could not.
 */
export function assignWorkspace(doc: Doc, workspaceId: string, windowId: string): Doc {
  const tabIds = tabIdsOfWorkspace(doc, workspaceId)
  const next: Doc = {
    ...doc,
    workspaces: workspacesOf(doc).map((w) => (w.id === workspaceId ? withWindowId(w, windowId) : w)),
  }
  if (tabIds.length) return assignTabs(next, tabIds, windowId)
  return showIn(next, windowId, workspaceId)
}

/** The document with one window's record added or replaced. */
export function recordWindow(doc: Doc, record: WindowRecord): Doc {
  const windows = ((doc.windows as WindowRecord[] | undefined) ?? []).filter((w) => w.id !== record.id)
  return { ...doc, windows: [...windows, record] }
}
