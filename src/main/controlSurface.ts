/**
 * The read-only half of the control channel: what this app currently has open.
 *
 * `iaw` started as a way for a pane to talk about *itself* — notify me, here is
 * what I am doing, here is the conversation I am in. That is enough for an
 * agent that only ever acts on its own pane, and not enough for anything that
 * wants to look around: a script that walks the workspaces, a status line, an
 * agent asked to check on a build it started in another tab. Every comparable
 * app has answered that question for years; we had six verbs and no way to see
 * anything.
 *
 * The projection here is deliberately shallow. The renderer owns the persisted
 * schema and normalises it on load — that is what lets a newer build write a
 * document an older host can still carry — so the main process reads it as
 * loosely as it can get away with: everything is optional, anything unexpected
 * is skipped, and a shape we do not recognise produces an empty list rather
 * than an error. Nothing here may make the document harder to change.
 */

/** One pane, as reported to a caller. */
export interface PaneSummary {
  id: string
  workspaceId: string
  tabId: string
  /** `terminal`, `files`, `diff`, … — the panes without shells are listed too. */
  kind: string
  cwd: string
  /** The pane's own name if it has one, otherwise the shell's reported title. */
  title: string
  shell: string
  /** Whether a shell is running behind it right now. */
  live: boolean
  /** Whether it is the pane its tab is focused on. */
  active: boolean
}

export interface TabSummary {
  id: string
  title: string
  active: boolean
  panes: PaneSummary[]
}

export interface WorkspaceSummary {
  id: string
  name: string
  cwd: string
  branch: string
  active: boolean
  /** The workspace this one is nested under, when it is nested. */
  parentId: string | null
  tabs: TabSummary[]
}

export interface TreeSnapshot {
  workspaces: WorkspaceSummary[]
}

/** Anything at all, read one optional field at a time. */
type Loose = Record<string, unknown>

function obj(value: unknown): Loose | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Projects the persisted document into the shape callers see.
 *
 * `isLive` is asked per pane rather than baked into the document, because
 * whether a shell is running is a fact about this moment and the document is
 * only a record of what was arranged.
 */
export function buildTree(state: unknown, isLive: (paneId: string) => boolean): TreeSnapshot {
  const root = obj(state)
  if (!root) return { workspaces: [] }
  const activeWorkspaceId = str(root.activeWorkspaceId)

  const workspaces: WorkspaceSummary[] = []
  for (const rawWorkspace of arr(root.workspaces)) {
    const workspace = obj(rawWorkspace)
    const workspaceId = str(workspace?.id)
    if (!workspace || !workspaceId) continue

    const activeTabId = str(workspace.activeTabId)
    const tabs: TabSummary[] = []

    for (const rawTab of arr(workspace.tabs)) {
      const tab = obj(rawTab)
      const tabId = str(tab?.id)
      if (!tab || !tabId) continue

      const activePaneId = str(tab.activePaneId)
      const panes: PaneSummary[] = []

      for (const rawPane of arr(tab.panes)) {
        const pane = obj(rawPane)
        const paneId = str(pane?.id)
        if (!pane || !paneId) continue
        panes.push({
          id: paneId,
          workspaceId,
          tabId,
          // A pane written before there were kinds is a terminal.
          kind: str(pane.kind, 'terminal'),
          cwd: str(pane.cwd),
          title: str(pane.customTitle) || str(pane.autoTitle),
          shell: str(pane.shell),
          live: isLive(paneId),
          active: paneId === activePaneId,
        })
      }

      tabs.push({
        id: tabId,
        // A tab with no name of its own is shown by its active pane, so that is
        // the honest answer rather than an invented "Tab 3".
        title: str(tab.customTitle) || panes.find((p) => p.active)?.title || '',
        active: tabId === activeTabId,
        panes,
      })
    }

    workspaces.push({
      id: workspaceId,
      name: str(workspace.name),
      cwd: str(workspace.cwd),
      branch: str(workspace.branch),
      active: workspaceId === activeWorkspaceId,
      parentId: str(workspace.parentId) || null,
      tabs,
    })
  }

  return { workspaces }
}

/** Every pane in the document, flattened — `iaw list-panes`. */
export function flattenPanes(tree: TreeSnapshot): PaneSummary[] {
  return tree.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes))
}
