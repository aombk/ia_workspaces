import { backend } from '../backend'
import {
  AGENT_SESSION_TTL_MS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_SETTINGS,
  EDITOR_MODES,
  WORKSPACE_COLORS,
  readWireKind,
  shellTargetFor,
  wireKind,
  type AgentSession,
  type BoardPlacement,
  type EditorMode,
  type NotificationRecord,
  type PaneActivity,
  type PaneAgentState,
  type PaneNode,
  MONITOR_BLOCKS,
  type MonitorDock,
  type PaneKind,
  type PaneState,
  type PersistedState,
  type Settings,
  type ShellKind,
  type ShellTarget,
  type TerminalTabState,
  type WeatherPlace,
  type Workspace,
} from '../shared/types'

import { parseWslPath, toWslSharePath } from '../shared/wsl'
import { fallbackCwd } from '../shared/platform'
import {
  IMAGE_FILTERS,
  IMAGE_LAYOUTS,
  IMAGE_SORTS,
  type ImageFilter,
  type ImageLayout,
  type ImageSort,
} from '../shared/images'
import {
  exportWorkspaces,
  importWorkspaces,
  subtreeOf,
  type WorkspaceFile,
} from '../shared/workspaceFile'
import type { InterfaceTheme, TerminalTheme } from '../shared/themes'

/**
 * The row highlighted in a workspace's file tree.
 *
 * `isDir` travels with the path because selecting a folder means something to
 * the images pane — the gallery fills with that folder, without your having to
 * open it — and by the time the selection has reached the store there is
 * nothing left that knows which rows were folders.
 */
export interface TreeSelection {
  path: string
  isDir: boolean
}

/** Shared, and frozen: returned on every miss, so it must not be written to. */
const EMPTY_SELECTION: TreeSelection = Object.freeze({ path: '', isDir: false })

/** One drawn line of the sidebar: a workspace, and how deep it is nested. */
export interface SidebarRow {
  workspace: Workspace
  depth: number
  /** Whether anything is nested under it, so the row can draw a fold. */
  hasChildren: boolean
}

type Listener = () => void

let cachedDefaultCwd: string | null = null

/**
 * Where a pane goes when nothing better is known — a repaired workspace, a
 * folder that has been deleted, the first workspace on a fresh install.
 *
 * Lazy, and that is load-bearing rather than a style choice. ES imports are
 * evaluated before the importing module's body, so `entry.electron.ts` has not
 * reached its `setBackend(...)` line by the time this module is initialised:
 * asking for the backend at module scope throws before the window ever opens.
 * Cached on first use instead, which is also all the memoisation this needs —
 * the platform cannot change while the window is open.
 *
 * `capabilities` is read defensively because the workspace tests drive the
 * store through a minimal backend stub that has no need to describe a host.
 */
function defaultCwd(): string {
  if (cachedDefaultCwd === null) {
    cachedDefaultCwd = fallbackCwd(backend().capabilities?.platform ?? 'windows')
  }
  return cachedDefaultCwd
}

const SCHEMA_VERSION = 4
/** Notification history is bounded so a long session can't grow without end. */
const MAX_NOTIFICATIONS = 200

/** The four edges and "off", for checking what came off disk. */
const MONITOR_DOCKS = new Set<MonitorDock>(['off', 'left', 'right', 'top', 'bottom'])

const EMPTY: PersistedState = {
  version: SCHEMA_VERSION,
  workspaces: [],
  activeWorkspaceId: null,
  sidebarWidth: 230,
  sidebarCollapsed: false,
  treeWidth: 260,
  gitFilesWidth: 300,
  gitHistoryWidth: 420,
  // Checked on the way in rather than trusted: this comes off disk, and a
  // document carrying `monitorDock: "banana"` would otherwise put a CSS class
  // of that name on the layout and hide the terminals behind a panel with no
  // size. Same reason `PANE_KINDS` is checked at runtime.
  // Off until asked for. It starts a small process every few seconds, and that
  // is not a thing to switch on for somebody without being asked — the same
  // judgement the sidebar strip already makes.
  monitorDock: 'off' as MonitorDock,
  monitorDockSize: 300,
  monitorHidden: [] as string[],
  monitorOrder: [] as string[],
  window: { width: 1360, height: 860, maximized: false },
  settings: DEFAULT_SETTINGS,
}

/**
 * The single source of truth for the UI.
 *
 * Normalisation lives here rather than in a host process because the renderer
 * owns the schema and every host must agree — a host store is a plain
 * JSON passthrough, so anything not defaulted here would arrive undefined.
 */
class WorkspaceState {
  private data: PersistedState = structuredClone(EMPTY)
  private listeners = new Set<Listener>()
  private saveTimer: number | null = null

  /** Panes with unseen activity, shown as a dot on the tab and workspace. */
  readonly attention = new Set<string>()
  /** Newest first. Ephemeral: cleared on restart, like the panes themselves. */
  notifications: NotificationRecord[] = []
  /**
   * Live per-pane status. Not persisted: it describes processes, and those do
   * not survive a restart either.
   */
  private readonly activity = new Map<string, PaneActivity>()
  private readonly agents = new Map<string, PaneAgentState>()

  async load(): Promise<void> {
    this.data = normalize(await backend().loadState())
    if (!this.data.workspaces.length) this.seedFirstWorkspace()
    if (!this.data.activeWorkspaceId && this.data.workspaces[0]) {
      this.data.activeWorkspaceId = this.data.workspaces[0].id
    }
    this.emit()

    backend().onExternalStateChange((external) => this.mergeExternal(normalize(external)))
  }

  /**
   * Another ia_workspaces instance rewrote the shared workspace file. We take its
   * structure but keep our own active selection and window state, so the other
   * app's focus doesn't yank this one around.
   */
  private mergeExternal(external: PersistedState): void {
    const keepActive = this.data.activeWorkspaceId
    const keepTabs = new Map(this.data.workspaces.map((w) => [w.id, w.activeTabId]))

    this.data = {
      ...external,
      activeWorkspaceId: external.workspaces.some((w) => w.id === keepActive)
        ? keepActive
        : external.activeWorkspaceId,
      window: this.data.window,
      workspaces: external.workspaces.map((w) => {
        const mine = keepTabs.get(w.id)
        return { ...w, activeTabId: w.tabs.some((t) => t.id === mine) ? mine! : w.activeTabId }
      }),
    }
    this.emit()
  }

  private seedFirstWorkspace(): void {
    this.data.workspaces = [this.makeWorkspace('Home', defaultCwd())]
    this.data.activeWorkspaceId = this.data.workspaces[0].id
  }

  private makeWorkspace(name: string, cwd: string): Workspace {
    const color = WORKSPACE_COLORS[this.data.workspaces.length % WORKSPACE_COLORS.length]
    return { id: crypto.randomUUID(), name, cwd, color, tabs: [], activeTabId: null }
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }

  /** Notify the UI and schedule a write. */
  private commit(): void {
    this.emit()
    this.save()
  }

  save(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void backend().saveState(forDisk(this.data))
    }, 250)
  }

  // ---------------------------------------------------------------- getters

  get state(): PersistedState {
    return this.data
  }

  get settings(): Settings {
    return this.data.settings
  }

  get workspaces(): Workspace[] {
    return this.data.workspaces
  }

  get activeWorkspace(): Workspace | null {
    return this.data.workspaces.find((w) => w.id === this.data.activeWorkspaceId) ?? null
  }

  get activeTab(): TerminalTabState | null {
    const w = this.activeWorkspace
    if (!w) return null
    return w.tabs.find((t) => t.id === w.activeTabId) ?? null
  }

  get activePane(): PaneState | null {
    const tab = this.activeTab
    if (!tab) return null
    return tab.panes.find((p) => p.id === tab.activePaneId) ?? null
  }

  workspaceOfPane(paneId: string): Workspace | null {
    return (
      this.data.workspaces.find((w) => w.tabs.some((t) => t.panes.some((p) => p.id === paneId))) ??
      null
    )
  }

  tabOfPane(paneId: string): TerminalTabState | null {
    for (const w of this.data.workspaces) {
      const tab = w.tabs.find((t) => t.panes.some((p) => p.id === paneId))
      if (tab) return tab
    }
    return null
  }

  pane(paneId: string): PaneState | null {
    for (const w of this.data.workspaces) {
      for (const t of w.tabs) {
        const p = t.panes.find((x) => x.id === paneId)
        if (p) return p
      }
    }
    return null
  }

  tab(tabId: string): TerminalTabState | null {
    for (const w of this.data.workspaces) {
      const t = w.tabs.find((x) => x.id === tabId)
      if (t) return t
    }
    return null
  }

  /** True when the pane is visible and the window has focus. */
  isAttended(paneId: string): boolean {
    if (!document.hasFocus()) return false
    const tab = this.activeTab
    if (!tab || tab.activePaneId !== paneId) return false
    return tab.panes.some((p) => p.id === paneId)
  }

  // ------------------------------------------------------------- workspaces

  addWorkspace(name: string, cwd: string): Workspace {
    const workspace = this.makeWorkspace(name, cwd)
    this.data.workspaces.push(workspace)
    this.data.activeWorkspaceId = workspace.id
    this.commit()
    return workspace
  }

  /**
   * Moves a whole tab, and its panes, into another workspace.
   *
   * The panes come with it and keep running — their shells are already alive
   * and have nothing to do with which list the tab is filed under. Only the
   * two workspaces' active-tab pointers need repairing, since one just lost the
   * tab it was showing and the other should show what it just gained.
   */
  moveTabToWorkspace(tabId: string, targetWorkspaceId: string): boolean {
    const source = this.data.workspaces.find((w) => w.tabs.some((t) => t.id === tabId))
    const target = this.data.workspaces.find((w) => w.id === targetWorkspaceId)
    if (!source || !target || source.id === target.id) return false

    const at = source.tabs.findIndex((t) => t.id === tabId)
    const [tab] = source.tabs.splice(at, 1)
    // Next to where it was, so a workspace it is dropped on lands it at the end
    // rather than in front of whatever you were already looking at.
    target.tabs.push(tab)

    if (source.activeTabId === tabId) {
      source.activeTabId = source.tabs[Math.min(at, source.tabs.length - 1)]?.id ?? null
    }
    target.activeTabId = tabId
    this.data.activeWorkspaceId = target.id
    this.commit()
    return true
  }

  // ---------------------------------------------------------------- tree

  /**
   * The sidebar, flattened into the rows it draws.
   *
   * Children follow their parent immediately, so the flat `workspaces` array
   * stays the single source of order: reordering is still an array move, and a
   * parent cannot drift away from what it holds.
   *
   * `expandAll` ignores every fold — the collapsed rail passes it, because
   * there is no room to draw a twisty there and a shut parent would otherwise
   * take its children off the sidebar with nothing left to reopen them by.
   */
  sidebarRows(expandAll = false): SidebarRow[] {
    const byParent = new Map<string | null, Workspace[]>()
    for (const w of this.data.workspaces) {
      const key = w.parentId ?? null
      const bucket = byParent.get(key)
      if (bucket) bucket.push(w)
      else byParent.set(key, [w])
    }

    const rows: SidebarRow[] = []
    const walk = (parentId: string | null, depth: number): void => {
      for (const workspace of byParent.get(parentId) ?? []) {
        const children = byParent.get(workspace.id) ?? []
        rows.push({ workspace, depth, hasChildren: children.length > 0 })
        if (children.length && (expandAll || !workspace.collapsed)) {
          walk(workspace.id, depth + 1)
        }
      }
    }
    walk(null, 0)
    return rows
  }

  childrenOf(workspaceId: string): Workspace[] {
    return this.data.workspaces.filter((w) => w.parentId === workspaceId)
  }

  toggleCollapsed(workspaceId: string): void {
    const w = this.data.workspaces.find((x) => x.id === workspaceId)
    if (!w) return
    w.collapsed = !w.collapsed
    this.commit()
  }

  /**
   * Nests one workspace under another, or lifts it back to the top level.
   *
   * Refuses to make a workspace its own ancestor — dropping a parent onto its
   * own child would otherwise detach the whole subtree from the tree and it
   * would vanish from the sidebar with no way back.
   *
   * The subtree moves with it, and lands directly after the new parent so the
   * flat array still reads in drawn order.
   */
  setWorkspaceParent(workspaceId: string, parentId: string | null): void {
    const workspace = this.data.workspaces.find((w) => w.id === workspaceId)
    if (!workspace || workspaceId === parentId) return
    if ((workspace.parentId ?? null) === (parentId ?? null)) return
    if (parentId && this.isDescendant(parentId, workspaceId)) return

    const subtree = this.subtreeOf(workspaceId)
    const keep = new Set(subtree.map((w) => w.id))
    const rest = this.data.workspaces.filter((w) => !keep.has(w.id))

    workspace.parentId = parentId
    // After the new parent's *last* descendant, so a dropped workspace joins at
    // the bottom of what is already there. Inserting straight after the parent
    // would silently make it the first child, which is not what dropping onto a
    // row looks like it should do.
    let anchor = rest.length - 1
    if (parentId) {
      anchor = rest.findIndex((w) => w.id === parentId)
      for (let i = anchor + 1; i < rest.length; i++) {
        if (!this.hasAncestor(rest[i], parentId, rest)) break
        anchor = i
      }
    }
    rest.splice(anchor + 1, 0, ...subtree)
    this.data.workspaces = rest

    // A parent that just gained a child while shut would swallow it silently.
    if (parentId) {
      const parent = this.data.workspaces.find((w) => w.id === parentId)
      if (parent?.collapsed) parent.collapsed = false
    }
    this.commit()
  }

  /** Whether `workspace` sits anywhere beneath `ancestor`, within `pool`. */
  private hasAncestor(workspace: Workspace, ancestor: string, pool: Workspace[]): boolean {
    let at: Workspace | undefined = workspace
    for (let i = 0; i < 64 && at; i++) {
      if (at.parentId === ancestor) return true
      at = pool.find((w) => w.id === at!.parentId)
    }
    return false
  }

  /** The workspace and everything beneath it, in drawn order. */
  private subtreeOf(workspaceId: string): Workspace[] {
    const out: Workspace[] = []
    const walk = (id: string) => {
      const self = this.data.workspaces.find((w) => w.id === id)
      if (!self) return
      out.push(self)
      for (const child of this.data.workspaces.filter((w) => w.parentId === id)) walk(child.id)
    }
    walk(workspaceId)
    return out
  }

  private isDescendant(candidate: string, ancestor: string): boolean {
    let at = this.data.workspaces.find((w) => w.id === candidate)
    for (let i = 0; i < 64 && at; i++) {
      if (at.parentId === ancestor) return true
      at = this.data.workspaces.find((w) => w.id === at!.parentId)
    }
    return false
  }

  /** Whether anything nested under this workspace is waiting or shouting. */
  subtreeNeedsInput(workspaceId: string): boolean {
    return this.subtreeOf(workspaceId)
      .slice(1)
      .some((w) => this.workspaceNeedsInput(w.id))
  }

  subtreeHasAttention(workspaceId: string): boolean {
    return this.subtreeOf(workspaceId)
      .slice(1)
      .some((w) => this.workspaceHasAttention(w.id))
  }

  // ------------------------------------------------------------ workspaces

  renameWorkspace(id: string, name: string): void {
    const w = this.data.workspaces.find((x) => x.id === id)
    if (!w) return
    w.name = name.trim() || w.name
    this.commit()
  }

  /**
   * Moves the workspace's root. The docked tree follows, because a tree left
   * pointing inside the folder you just moved away from is never what was
   * meant.
   */
  setWorkspaceCwd(id: string, cwd: string): void {
    const w = this.data.workspaces.find((x) => x.id === id)
    if (!w) return
    w.cwd = cwd
    w.treeCwd = undefined
    this.commit()
  }

  /** Where the docked tree is browsing. Does not touch the workspace root. */
  setTreeCwd(id: string, cwd: string): void {
    const w = this.data.workspaces.find((x) => x.id === id)
    if (!w) return
    w.treeCwd = cwd === w.cwd ? undefined : cwd
    this.commit()
  }

  setWorkspaceColor(id: string, color: string): void {
    const w = this.data.workspaces.find((x) => x.id === id)
    if (!w) return
    w.color = color
    this.commit()
  }

  setWorkspaceBranch(id: string, branch: string | undefined): void {
    const w = this.data.workspaces.find((x) => x.id === id)
    if (!w || w.branch === branch) return
    w.branch = branch
    this.emit() // derived from disk; no need to rewrite the workspace file
  }

  removeWorkspace(id: string): string[] {
    const idx = this.data.workspaces.findIndex((x) => x.id === id)
    if (idx === -1) return []
    const [removed] = this.data.workspaces.splice(idx, 1)
    if (this.data.activeWorkspaceId === id) {
      const next = this.data.workspaces[idx] ?? this.data.workspaces[idx - 1] ?? null
      this.data.activeWorkspaceId = next?.id ?? null
    }
    this.commit()
    return removed.tabs.flatMap((t) => t.panes.map((p) => p.id))
  }

  moveWorkspace(from: number, to: number): void {
    const list = this.data.workspaces
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const [item] = list.splice(from, 1)
    list.splice(to, 0, item)
    this.commit()
  }

  setActiveWorkspace(id: string): void {
    if (this.data.activeWorkspaceId === id) return
    this.data.activeWorkspaceId = id
    this.commit()
  }

  // ------------------------------------------------------------------- tabs

  addTab(
    workspaceId: string,
    cwd?: string,
    kind: PaneState['kind'] = 'terminal',
    shell?: ShellKind,
    target?: ShellTarget
  ): TerminalTabState | null {
    const w = this.data.workspaces.find((x) => x.id === workspaceId)
    if (!w) return null
    return this.pushTab(w, { ...this.makePane(cwd || w.cwd, shell, target), kind })
  }

  /**
   * A new tab whose pane arrives already configured — an editor pointed at a
   * file, a compare holding a pair.
   *
   * Separate from `addTab` because the pane has to be complete *before* the
   * change is announced. Adding a tab renders, and rendering mounts the tab,
   * which builds its pane on the spot: anything set on the line after `addTab`
   * is set one moment too late, into a pane that has already decided what it is
   * showing. That is what made "Edit" on a tree row open the project note — an
   * editor with no file opens the note by design, and the file it was asked for
   * arrived just after it had given up on being asked.
   */
  addTabWith(
    workspaceId: string,
    kind: PaneState['kind'],
    init: Partial<Omit<PaneState, 'id' | 'kind'>>
  ): TerminalTabState | null {
    const w = this.data.workspaces.find((x) => x.id === workspaceId)
    if (!w) return null
    return this.pushTab(w, { ...this.makePane(w.cwd), kind, ...init })
  }

  /** Appends a tab holding one pane, makes it current, and announces it. */
  private pushTab(w: Workspace, pane: PaneState): TerminalTabState {
    const tab: TerminalTabState = {
      id: crypto.randomUUID(),
      customTitle: null,
      panes: [pane],
      layout: { kind: 'leaf', paneId: pane.id },
      activePaneId: pane.id,
    }
    w.tabs.push(tab)
    w.activeTabId = tab.id
    this.commit()
    return tab
  }

  /**
   * A new pane, in the shell it should actually be.
   *
   * `shell` is passed rather than read from settings because the global default
   * is the *last* thing that should decide it. It used to be the only thing:
   * every pane was stamped with `settings.shell` at birth, and the spawn's
   * `pane.shell ?? workspace.shell ?? settings.shell` therefore never reached
   * past the first term — so a workspace set to WSL opened PowerShell panes,
   * and the setting looked like it did nothing.
   */
  private makePane(cwd: string, shell?: ShellKind, target?: ShellTarget): PaneState {
    return {
      id: crypto.randomUUID(),
      kind: 'terminal',
      cwd,
      autoTitle: '',
      // Recorded only when it was asked for. A pane with none inherits, which
      // is what lets a workspace change carry its ordinary tabs along without
      // touching the ones you chose a shell for.
      ...(shell ? { shell } : {}),
      ...shellTargetFor(shell, target),
    }
  }

  /** The tab's file-tree pane, if it already has one. */
  filesPaneOf(tab: TerminalTabState): PaneState | null {
    return tab.panes.find((p) => p.kind === 'files') ?? null
  }

  removeTab(workspaceId: string, tabId: string): string[] {
    const w = this.data.workspaces.find((x) => x.id === workspaceId)
    if (!w) return []
    const idx = w.tabs.findIndex((t) => t.id === tabId)
    if (idx === -1) return []
    const [removed] = w.tabs.splice(idx, 1)
    if (w.activeTabId === tabId) {
      w.activeTabId = (w.tabs[idx] ?? w.tabs[idx - 1])?.id ?? null
    }
    for (const p of removed.panes) {
      this.attention.delete(p.id)
      this.forgetPaneStatus(p.id)
    }
    this.commit()
    return removed.panes.map((p) => p.id)
  }

  renameTab(tabId: string, title: string): void {
    const t = this.tab(tabId)
    if (!t) return
    t.customTitle = title.trim() || null
    this.commit()
  }

  setActiveTab(workspaceId: string, tabId: string): void {
    const w = this.data.workspaces.find((x) => x.id === workspaceId)
    if (!w || w.activeTabId === tabId) return
    w.activeTabId = tabId
    this.commit()
  }

  moveTab(workspaceId: string, from: number, to: number): void {
    const w = this.data.workspaces.find((x) => x.id === workspaceId)
    if (!w || from === to) return
    const [item] = w.tabs.splice(from, 1)
    w.tabs.splice(to, 0, item)
    this.commit()
  }

  /**
   * A workspace and everything nested under it, as a saveable document.
   *
   * The subtree rather than the one row, because that is what "this workspace"
   * means when you are looking at a parent with children folded under it —
   * saving the parent alone would quietly leave them out.
   */
  exportWorkspace(workspaceId: string, now = new Date()): WorkspaceFile | null {
    const subtree = subtreeOf(this.data.workspaces, workspaceId)
    return subtree.length ? exportWorkspaces(subtree, now) : null
  }

  /** Every workspace, nesting intact. */
  exportAll(now = new Date()): WorkspaceFile | null {
    return this.data.workspaces.length ? exportWorkspaces(this.data.workspaces, now) : null
  }

  /**
   * Adds the workspaces from a file, leaving everything already open alone.
   *
   * Ids are minted on the way in, so the same file can be loaded twice and a
   * name that is already taken gains a suffix rather than shadowing what is
   * there. The first one loaded is selected, because loading a workspace and
   * then having to go and find it is most of the work done twice.
   */
  importWorkspaceFile(raw: unknown): { added: number; notes: string[] } | { error: string } {
    const result = importWorkspaces(raw, {
      taken: new Set(this.data.workspaces.map((w) => w.name)),
      fallbackCwd: this.data.workspaces[0]?.cwd ?? '',
      newId: () => crypto.randomUUID(),
    })
    if ('error' in result) return result

    this.data.workspaces.push(...result.workspaces)
    this.data.activeWorkspaceId = result.workspaces[0].id
    this.commit()
    return { added: result.workspaces.length, notes: result.notes }
  }

  /**
   * Drops a whole tab into another tab, beside one of its panes.
   *
   * The tab being dragged stops existing: everything it held moves across,
   * still arranged as it was, and lands on the chosen side of the target pane.
   * Its shells come with it — nothing is respawned, because the panes are the
   * same panes and only the tree they hang off changed.
   *
   * Refused when the target is inside the tab being dragged. That is not a
   * split, it is a tab being asked to contain itself, and the layout it would
   * produce holds the same pane in two places.
   */
  dropTabIntoPane(tabId: string, targetPaneId: string, side: DropSide): boolean {
    const sourceWorkspace = this.data.workspaces.find((w) => w.tabs.some((t) => t.id === tabId))
    const source = sourceWorkspace?.tabs.find((t) => t.id === tabId)
    const targetWorkspace = this.workspaceOfPane(targetPaneId)
    const target = this.tabOfPane(targetPaneId)
    if (!sourceWorkspace || !source || !targetWorkspace || !target) return false
    if (source.id === target.id) return false

    const direction = side === 'left' || side === 'right' ? 'row' : 'column'
    const before = side === 'left' || side === 'top'

    target.panes.push(...source.panes)
    target.layout = graftNode(target.layout, targetPaneId, source.layout, direction, before)
    // Focus what was dragged: you moved it here to look at it.
    target.activePaneId = source.activePaneId

    const at = sourceWorkspace.tabs.findIndex((t) => t.id === tabId)
    sourceWorkspace.tabs.splice(at, 1)
    if (sourceWorkspace.activeTabId === tabId) {
      sourceWorkspace.activeTabId =
        sourceWorkspace.tabs[Math.min(at, sourceWorkspace.tabs.length - 1)]?.id ?? null
    }

    targetWorkspace.activeTabId = target.id
    this.data.activeWorkspaceId = targetWorkspace.id
    this.commit()
    return true
  }

  // ------------------------------------------------------------------ panes

  /** Splits the active pane of a tab, returning the new pane. */
  splitPane(
    tabId: string,
    direction: 'row' | 'column',
    kind: PaneState['kind'] = 'terminal',
    cwd?: string,
    shell?: ShellKind
  ): PaneState | null {
    const tab = this.tab(tabId)
    if (!tab) return null
    const source = tab.panes.find((p) => p.id === tab.activePaneId)
    if (!source) return null

    // Splitting copies the source's *choice*, not its resolved shell: a pane
    // that inherits produces another that inherits, so both still follow the
    // workspace, while a pane you made a WSL pane produces another WSL pane.
    const pane = {
      ...this.makePane(cwd || source.cwd, shell ?? source.shell, {
        wslDistro: source.wslDistro,
        sshHost: source.sshHost,
      }),
      kind,
    }
    tab.panes.push(pane)
    tab.layout = splitNode(tab.layout, source.id, pane.id, direction)
    tab.activePaneId = pane.id
    this.commit()
    return pane
  }

  /**
   * Points a workspace at a shell, and at a WSL distribution when that is the
   * shell.
   *
   * A WSL workspace keeps a Windows `\\wsl.localhost\<distro>\…` path in `cwd`
   * so the tree, git, search and diff all keep working unchanged — only the
   * spawn translates it back. Switching *to* WSL therefore moves the folder
   * into the distribution's share, and switching away moves it back out.
   */
  setWorkspaceShell(
    workspaceId: string,
    shell: ShellKind | undefined,
    target?: ShellTarget
  ): void {
    const w = this.data.workspaces.find((x) => x.id === workspaceId)
    if (!w) return
    const kept = shellTargetFor(shell, target)
    w.shell = shell
    w.wslDistro = kept.wslDistro
    w.sshHost = kept.sshHost

    // An SSH workspace's folder is a path on the far machine, so none of the
    // local relocation below applies — there is nothing here to move it to, and
    // moving it would throw away the directory the user chose to land in.
    // Clearing it is right when arriving from WSL, whose share path means
    // nothing remotely.
    if (shell === 'ssh') {
      if (parseWslPath(w.cwd)) {
        w.cwd = ''
        w.treeCwd = undefined
      }
      this.commit()
      return
    }

    const distro = kept.wslDistro

    // A root that moves takes the tree back to it — whatever folder the tree
    // was browsing was inside the world we just left.
    if (shell === 'wsl' && distro && !parseWslPath(w.cwd)) {
      // No sensible mapping from C:\… to a Linux path, so start at the
      // distribution's root rather than guessing at one.
      w.cwd = toWslSharePath(distro, '/')
      w.treeCwd = undefined
    } else if (shell !== 'wsl') {
      const inside = parseWslPath(w.cwd)
      if (inside) {
        w.cwd = defaultCwd()
        w.treeCwd = undefined
      }
    }

    // Panes that inherit follow, and they do so by having nothing recorded —
    // there is deliberately no loop here rewriting them. A tab you explicitly
    // made a PowerShell tab stays one when its workspace moves to WSL, which is
    // the whole point of being able to choose per tab.
    //
    // Their folders are another matter. A pane sitting in a Linux path is
    // stranded when its workspace becomes a Windows one and vice versa, so an
    // *inheriting* pane is moved to the workspace's folder. A pane with its own
    // shell is left alone: it is still in a world it understands.
    for (const tab of w.tabs) {
      for (const pane of tab.panes) {
        if (pane.shell) continue
        const insidePane = parseWslPath(pane.cwd)
        if (shell === 'wsl' ? !insidePane : Boolean(insidePane)) pane.cwd = w.cwd
      }
    }
    this.commit()
  }

  /**
   * Points one pane at a shell, for reopening a tab as something else.
   *
   * The pane-level counterpart of `setWorkspaceShell`, and it moves the folder
   * for the same reasons: a pane sitting in `\\wsl.localhost\Ubuntu\home\me` is
   * stranded the moment it becomes a PowerShell pane, and a `C:\proj` has
   * nothing to say to a distribution. Recording the shell rather than letting
   * the pane inherit is the point — this one was chosen, so a later change to
   * the workspace's shell must not take it back.
   */
  setPaneShell(paneId: string, shell: ShellKind, target?: ShellTarget): void {
    const pane = this.pane(paneId)
    if (!pane) return
    const kept = shellTargetFor(shell, target)
    pane.shell = shell
    pane.wslDistro = kept.wslDistro
    pane.sshHost = kept.sshHost

    // Becoming remote: the folder is now a path on the far machine. A WSL share
    // path means nothing there, and a local one means nothing either, so the
    // pane starts wherever the remote login shell puts it.
    if (shell === 'ssh') {
      pane.cwd = ''
      this.commit()
      return
    }

    const distro = kept.wslDistro
    if (shell === 'wsl' && distro) {
      // Already inside the distribution it is moving to: the folder is one that
      // distribution understands, so there is nothing to relocate.
      const inside = parseWslPath(pane.cwd)
      if (inside?.distro !== distro) pane.cwd = toWslSharePath(distro, '/')
    } else if (parseWslPath(pane.cwd)) {
      // Leaving WSL. The workspace's folder beats `C:\` when it is a Windows
      // one — landing back in the project is the point of reopening in place.
      const workspace = this.workspaceOfPane(paneId)
      pane.cwd = workspace && !parseWslPath(workspace.cwd) ? workspace.cwd : defaultCwd()
    }
    this.commit()
  }

  /**
   * How an editor pane shows its file.
   *
   * Persisted per pane: a tab you opened to read a rendered document should
   * still be that tab tomorrow, and the pane you are writing notes in should
   * not change under you because another one was switched.
   */
  setEditorMode(paneId: string, mode: EditorMode): void {
    const pane = this.pane(paneId)
    if (!pane || pane.editorMode === mode) return
    pane.editorMode = mode
    this.commit()
  }

  /** Word wrap and line numbers, per editor pane. */
  setEditorView(
    paneId: string,
    view: { wordWrap?: boolean; lineNumbers?: boolean; columnGuide?: boolean; autosave?: boolean }
  ): void {
    const pane = this.pane(paneId)
    if (!pane) return
    if (view.wordWrap !== undefined) pane.wordWrap = view.wordWrap
    if (view.lineNumbers !== undefined) pane.lineNumbers = view.lineNumbers
    if (view.columnGuide !== undefined) pane.columnGuide = view.columnGuide
    if (view.autosave !== undefined) pane.autosave = view.autosave
    this.commit()
  }

  /** Points a reader pane at a file. Set once, when the pane is made. */
  setPaneFile(paneId: string, file: string): void {
    const pane = this.pane(paneId)
    if (!pane) return
    pane.file = file
    this.commit()
  }

  /**
   * Records an images pane's own arrangement.
   *
   * One method taking a patch rather than a setter per field: they are set in
   * combinations — picking Random and reseeding, resetting the board and
   * re-rendering — and six near-identical setters that each commit separately
   * would write the document six times for one click.
   */
  setPaneImageOptions(
    paneId: string,
    patch: Partial<
      Pick<
        PaneState,
        | 'imageLayout'
        | 'imageSort'
        | 'imageSortDesc'
        | 'imageRecursive'
        | 'imageFit'
        | 'imageFilter'
        | 'imageSeed'
        | 'imageBoard'
      >
    >
  ): void {
    const pane = this.pane(paneId)
    if (!pane) return
    Object.assign(pane, patch)
    // An empty board is dropped rather than stored: "reset" should leave the
    // pane as it was before anything was dragged, including in the file.
    if (pane.imageBoard && Object.keys(pane.imageBoard).length === 0) delete pane.imageBoard
    this.commit()
  }

  /**
   * The file selected in a workspace's file tree, if any.
   *
   * Deliberately not persisted and deliberately not on `PaneState`: it is where
   * the pointer last landed, which is worth nothing tomorrow, and writing the
   * workspace document on every arrow-key press through a folder would be
   * absurd. The images pane reads it on the render it already does.
   */
  private readonly treeSelections = new Map<string, TreeSelection>()
  private readonly treeFolders = new Map<string, string>()

  setTreeSelection(workspaceId: string, path: string, isDir: boolean): void {
    const current = this.treeSelections.get(workspaceId)
    if (current?.path === path && current?.isDir === isDir) return
    if (path) this.treeSelections.set(workspaceId, { path, isDir })
    else this.treeSelections.delete(workspaceId)
    // Notifies without persisting — the panes that care re-read it on the next
    // render, and nothing about it belongs on disk.
    this.emit()
  }

  treeSelection(workspaceId: string): TreeSelection {
    return this.treeSelections.get(workspaceId) ?? EMPTY_SELECTION
  }

  /**
   * The folder the workspace's most recently navigated tree is showing.
   *
   * Tracked separately from `treeCwd` because a workspace can hold several
   * trees — the docked one and any number in tabs — and the gallery follows
   * whichever you last moved rather than privileging one of them. Selecting a
   * file counts as using that tree, so clicking around in a tab's tree does not
   * leave the gallery pointed at the docked one.
   */
  setTreeFolder(workspaceId: string, cwd: string): void {
    if (!cwd || this.treeFolders.get(workspaceId) === cwd) return
    this.treeFolders.set(workspaceId, cwd)
    this.emit()
  }

  /** Falls back to the docked tree's folder, then to the workspace root. */
  treeFolder(workspaceId: string): string {
    const tracked = this.treeFolders.get(workspaceId)
    if (tracked) return tracked
    const workspace = this.data.workspaces.find((w) => w.id === workspaceId)
    return workspace?.treeCwd ?? workspace?.cwd ?? ''
  }

  /**
   * Records where a browser pane has navigated to.
   *
   * Unlike a reader's file this changes constantly — every link followed, every
   * redirect — so it writes only on a real change. `commit` persists, and a
   * page that redirects through three hops should not be three saves.
   */
  setPaneUrl(paneId: string, url: string): void {
    const pane = this.pane(paneId)
    if (!pane || pane.url === url) return
    pane.url = url
    this.commit()
  }

  /**
   * Records which of its two views the git pane is showing.
   *
   * The kind *is* the view — `diff` and `history` are the two names the git
   * pane answers to — so switching views writes it back rather than keeping a
   * second field. Two things fall out of that for free: the tab renames itself,
   * because its title is derived from the kind; and the view you left is the
   * view you come back to after a restart, because the kind is persisted.
   *
   * Safe only because both names mount the same class: the pane is cached by
   * id, so nothing is torn down and rebuilt under the change.
   */
  setPaneKind(paneId: string, kind: PaneKind): void {
    const pane = this.pane(paneId)
    if (!pane || pane.kind === kind) return
    pane.kind = kind
    this.commit()
  }

  /** The pair a compare pane is diffing. Both move together or neither does. */
  setCompareFiles(paneId: string, left: string, right: string): void {
    const pane = this.pane(paneId)
    if (!pane || (pane.compareLeft === left && pane.compareRight === right)) return
    pane.compareLeft = left
    pane.compareRight = right
    this.commit()
  }

  closePane(paneId: string): { tabClosed: boolean; workspaceId: string | null } {
    const workspace = this.workspaceOfPane(paneId)
    const tab = this.tabOfPane(paneId)
    if (!workspace || !tab) return { tabClosed: false, workspaceId: null }

    // Last pane in the tab means the tab itself goes away.
    if (tab.panes.length <= 1) {
      this.removeTab(workspace.id, tab.id)
      return { tabClosed: true, workspaceId: workspace.id }
    }

    tab.panes = tab.panes.filter((p) => p.id !== paneId)
    tab.layout = removeNode(tab.layout, paneId) ?? { kind: 'leaf', paneId: tab.panes[0].id }
    if (tab.activePaneId === paneId) tab.activePaneId = firstLeaf(tab.layout) ?? tab.panes[0].id
    this.attention.delete(paneId)
    this.forgetPaneStatus(paneId)
    this.commit()
    return { tabClosed: false, workspaceId: workspace.id }
  }

  /**
   * Lifts a pane out of its split into a tab of its own.
   *
   * The other half of dropping a tab onto a pane, and the reason that gesture
   * is safe to use: a split you made by dragging can be taken apart by dragging
   * the same way, rather than being something you have to close and rebuild.
   *
   * The pane itself is untouched — same object, same id, same shell still
   * running. Only the tree it hangs off changes, and the tab it came from
   * collapses its layout exactly as it does when a pane is closed.
   *
   * Refused for a pane that is already alone in its tab: there is nothing to
   * lift it out of, and doing it anyway would destroy and recreate a tab to
   * produce the arrangement it already had.
   */
  extractPaneToTab(paneId: string, index?: number): boolean {
    const workspace = this.workspaceOfPane(paneId)
    const tab = this.tabOfPane(paneId)
    if (!workspace || !tab || tab.panes.length <= 1) return false

    const pane = tab.panes.find((p) => p.id === paneId)
    if (!pane) return false

    tab.panes = tab.panes.filter((p) => p.id !== paneId)
    tab.layout = removeNode(tab.layout, paneId) ?? { kind: 'leaf', paneId: tab.panes[0].id }
    if (tab.activePaneId === paneId) tab.activePaneId = firstLeaf(tab.layout) ?? tab.panes[0].id

    const created: TerminalTabState = {
      id: crypto.randomUUID(),
      customTitle: null,
      panes: [pane],
      layout: { kind: 'leaf', paneId },
      activePaneId: paneId,
    }
    const at = index === undefined ? workspace.tabs.length : Math.max(0, Math.min(index, workspace.tabs.length))
    workspace.tabs.splice(at, 0, created)
    workspace.activeTabId = created.id
    this.commit()
    return true
  }

  renamePane(paneId: string, title: string): void {
    const pane = this.pane(paneId)
    if (!pane) return
    pane.customTitle = title.trim() || null
    this.commit()
  }

  /**
   * Moves a pane next to another one within the same tab.
   *
   * Done as remove-then-insert so the layout tree stays canonical: removing
   * collapses any split left with a single child, and inserting always creates
   * a fresh two-child split. Anything else accumulates degenerate nodes.
   */
  movePane(tabId: string, sourceId: string, targetId: string, side: DropSide): boolean {
    const tab = this.tab(tabId)
    if (!tab || sourceId === targetId) return false

    const pruned = removeNode(tab.layout, sourceId)
    if (!pruned) return false
    // The target must survive the removal, or there is nothing to attach to.
    if (!leavesOf(pruned).includes(targetId)) return false

    tab.layout = insertBeside(pruned, targetId, sourceId, side)
    tab.activePaneId = sourceId
    this.commit()
    return true
  }

  /** Closes every pane in the tab except one, leaving a single full-size pane. */
  mergePanes(tabId: string, keepId: string): string[] {
    const tab = this.tab(tabId)
    if (!tab || tab.panes.length < 2) return []

    const removed = tab.panes.filter((p) => p.id !== keepId).map((p) => p.id)
    tab.panes = tab.panes.filter((p) => p.id === keepId)
    tab.layout = { kind: 'leaf', paneId: keepId }
    tab.activePaneId = keepId
    for (const id of removed) {
      this.attention.delete(id)
      this.forgetPaneStatus(id)
    }
    this.commit()
    return removed
  }

  setActivePane(tabId: string, paneId: string): void {
    const tab = this.tab(tabId)
    if (!tab || tab.activePaneId === paneId) return
    tab.activePaneId = paneId
    this.attention.delete(paneId)
    this.commit()
  }

  setSplitSizes(tabId: string, path: number[], sizes: number[]): void {
    const tab = this.tab(tabId)
    if (!tab) return
    const node = nodeAt(tab.layout, path)
    if (!node || node.kind !== 'split') return
    node.sizes = sizes
    this.save() // no re-render: the DOM already moved with the drag
  }

  /** Applied from OSC updates; writes through so a restart lands in place. */
  updatePaneMeta(
    paneId: string,
    meta: { cwd?: string; title?: string; agentSession?: AgentSession; lastCommand?: string }
  ): void {
    const p = this.pane(paneId)
    if (!p) return
    let changed = false
    if (meta.cwd && meta.cwd !== p.cwd) {
      p.cwd = meta.cwd
      changed = true
    }
    if (meta.title !== undefined && meta.title !== p.autoTitle) {
      p.autoTitle = meta.title
      changed = true
    }
    // A re-reported id is not nothing: `SessionStart` fires again every time you
    // resume, and `at` is what the fortnight TTL is measured from. Without the
    // second clause a conversation you have been in daily for two weeks quietly
    // stops being resumable, timed out from the day it began.
    //
    // The third is the held claim, which changes neither of the other two and is
    // the whole of what a new conversation looks like when it first reports —
    // dropped on the floor here, it would never reach the file that outlives the
    // app, and the pane would open on the conversation before it.
    if (
      meta.agentSession &&
      (meta.agentSession.id !== p.agentSession?.id ||
        meta.agentSession.at > p.agentSession.at ||
        meta.agentSession.pending?.id !== p.agentSession?.pending?.id)
    ) {
      p.agentSession = meta.agentSession
      changed = true
    }
    if (meta.lastCommand !== undefined && meta.lastCommand !== p.lastCommand) {
      p.lastCommand = meta.lastCommand
      changed = true
    }
    if (changed) this.commit()
  }

  // ---------------------------------------------------------- notifications

  recordNotification(record: NotificationRecord): void {
    this.notifications.unshift(record)
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications.length = MAX_NOTIFICATIONS
    }
    this.emit()
  }

  get unreadCount(): number {
    return this.notifications.reduce((n, r) => n + (r.read ? 0 : 1), 0)
  }

  markNotificationRead(id: string): void {
    const record = this.notifications.find((r) => r.id === id)
    if (!record || record.read) return
    record.read = true
    this.emit()
  }

  markPaneNotificationsRead(paneId: string): void {
    let changed = false
    for (const r of this.notifications) {
      if (r.paneId === paneId && !r.read) {
        r.read = true
        changed = true
      }
    }
    if (changed) this.emit()
  }

  markAllNotificationsRead(): void {
    if (!this.unreadCount) return
    for (const r of this.notifications) r.read = true
    this.emit()
  }

  clearNotifications(): void {
    if (!this.notifications.length) return
    this.notifications = []
    this.emit()
  }

  /** Oldest unread, so repeated jumps walk forward through the backlog. */
  oldestUnread(): NotificationRecord | null {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      if (!this.notifications[i].read) return this.notifications[i]
    }
    return null
  }

  // -------------------------------------------------------------- pane status

  setPaneActivity(paneId: string, activity: PaneActivity): void {
    if (this.activity.get(paneId) === activity) return
    this.activity.set(paneId, activity)
    this.emit()
  }

  setPaneAgent(paneId: string, agent: PaneAgentState): void {
    if (agent.state === 'unknown') this.agents.delete(paneId)
    else this.agents.set(paneId, agent)
    this.emit()
  }

  paneActivity(paneId: string): PaneActivity {
    return this.activity.get(paneId) ?? 'idle'
  }

  paneAgent(paneId: string): PaneAgentState | null {
    return this.agents.get(paneId) ?? null
  }

  /**
   * What a pane's indicator should say, most urgent first.
   *
   * A declared state always beats an observed one: "blocked" is a fact the
   * agent stated, while "active" is only our reading of the byte rate.
   */
  paneIndicator(paneId: string): 'blocked' | 'working' | 'active' | null {
    const agent = this.agents.get(paneId)
    if (agent?.state === 'blocked') return 'blocked'
    if (agent?.state === 'working') return 'working'
    return this.activity.get(paneId) === 'active' ? 'active' : null
  }

  /** Every pane parked on a human, for the notification panel's inbox. */
  blockedPanes(): PaneAgentState[] {
    return [...this.agents.values()].filter((a) => a.state === 'blocked')
  }

  forgetPaneStatus(paneId: string): void {
    this.activity.delete(paneId)
    this.agents.delete(paneId)
  }

  markAttention(paneId: string): void {
    if (this.attention.has(paneId)) return
    this.attention.add(paneId)
    this.emit()
  }

  clearAttention(paneId: string): void {
    if (!this.attention.delete(paneId)) return
    this.emit()
  }

  tabHasAttention(tab: TerminalTabState): boolean {
    return tab.panes.some((p) => this.attention.has(p.id))
  }

  workspaceHasAttention(workspaceId: string): boolean {
    const w = this.data.workspaces.find((x) => x.id === workspaceId)
    return Boolean(w?.tabs.some((t) => this.tabHasAttention(t)))
  }

  /**
   * Whether anything in here is parked on a human.
   *
   * Deliberately read off the declared agent state rather than `attention`.
   * Attention means "something happened here you have not seen", so looking at
   * the pane settles it — which is right for a bell and wrong for a question,
   * because reading a question is not answering it. This one only goes away
   * when the agent itself says it is no longer waiting.
   */
  paneNeedsInput(paneId: string): boolean {
    return this.agents.get(paneId)?.state === 'blocked'
  }

  tabNeedsInput(tab: TerminalTabState): boolean {
    return tab.panes.some((p) => this.paneNeedsInput(p.id))
  }

  workspaceNeedsInput(workspaceId: string): boolean {
    const w = this.data.workspaces.find((x) => x.id === workspaceId)
    return Boolean(w?.tabs.some((t) => this.tabNeedsInput(t)))
  }

  // --------------------------------------------------------------- settings

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch }
    this.commit()
  }

  updateNotifications(patch: Partial<Settings['notifications']>): void {
    this.data.settings.notifications = { ...this.data.settings.notifications, ...patch }
    this.commit()
  }

  upsertCustomTheme(theme: InterfaceTheme): void {
    const list = [...(this.data.settings.customThemes ?? [])]
    const idx = list.findIndex((t) => t.id === theme.id)
    if (idx === -1) list.push(theme)
    else list[idx] = theme
    this.data.settings = { ...this.data.settings, customThemes: list }
    this.commit()
  }

  removeCustomTheme(id: string): void {
    const list = (this.data.settings.customThemes ?? []).filter((t) => t.id !== id)
    const themeId = this.data.settings.themeId === id ? 'graphite' : this.data.settings.themeId
    this.data.settings = { ...this.data.settings, customThemes: list, themeId }
    this.commit()
  }

  upsertCustomTerminalTheme(theme: TerminalTheme): void {
    const list = [...(this.data.settings.customTerminalThemes ?? [])]
    const idx = list.findIndex((t) => t.id === theme.id)
    if (idx === -1) list.push(theme)
    else list[idx] = theme
    this.data.settings = { ...this.data.settings, customTerminalThemes: list }
    this.commit()
  }

  removeCustomTerminalTheme(id: string): void {
    const list = (this.data.settings.customTerminalThemes ?? []).filter((t) => t.id !== id)
    // Falls back to the built-in of the same name rather than to whatever the
    // interface happens to be wearing: the two are unrelated now, and picking
    // the interface's palette would be a coincidence dressed as a default.
    const terminalThemeId =
      this.data.settings.terminalThemeId === id ? 'graphite' : this.data.settings.terminalThemeId
    this.data.settings = { ...this.data.settings, customTerminalThemes: list, terminalThemeId }
    this.commit()
  }

  setSidebar(width: number, collapsed: boolean): void {
    this.data.sidebarWidth = width
    this.data.sidebarCollapsed = collapsed
    this.commit()
  }

  /** Whether the *active* workspace shows the docked tree. */
  get treeVisible(): boolean {
    return this.activeWorkspace?.treeVisible ?? false
  }

  get treeWidth(): number {
    return this.data.treeWidth
  }

  /** Visibility belongs to the workspace; the width is shared. */
  setTree(visible: boolean, width = this.data.treeWidth): void {
    const workspace = this.activeWorkspace
    if (workspace) workspace.treeVisible = visible
    this.data.treeWidth = width
    this.commit()
  }

  /**
   * Where the grip sits in a git pane. Shared rather than per-pane: a split you
   * dragged wide once is a preference, and re-dragging it in the next pane is
   * the app forgetting something you already said.
   */
  get gitFilesWidth(): number {
    return this.data.gitFilesWidth
  }

  get gitHistoryWidth(): number {
    return this.data.gitHistoryWidth
  }

  setGitSplit(which: 'files' | 'history', width: number): void {
    if (which === 'files') this.data.gitFilesWidth = width
    else this.data.gitHistoryWidth = width
    this.commit()
  }

  get monitorDock(): MonitorDock {
    return this.data.monitorDock
  }

  get monitorDockSize(): number {
    return this.data.monitorDockSize
  }

  /**
   * Where the machine monitor sits, and how big.
   *
   * The size is kept when it is switched off rather than reset, so turning it
   * back on gives you the panel you had rather than the default one — and it is
   * remembered across sides for the same reason a sidebar width is: a panel
   * dragged wide once is a preference.
   */
  /**
   * The monitor's blocks in the order to draw them.
   *
   * The saved order first, then anything it does not mention in the built-in
   * order — which is what makes a new block appear at the bottom of a panel
   * somebody has rearranged, instead of not appearing at all.
   */
  get monitorBlocks(): Array<{ id: string; label: string }> {
    const known = new Map(MONITOR_BLOCKS.map((b) => [b.id as string, { id: b.id as string, label: b.label as string }]))
    const ordered = this.data.monitorOrder.map((id) => known.get(id)).filter((b): b is { id: string; label: string } => !!b)
    const seen = new Set(ordered.map((b) => b.id))
    return [...ordered, ...[...known.values()].filter((b) => !seen.has(b.id))]
  }

  /** Moves one block to sit at `index` in the drawn order. */
  moveMonitorBlock(id: string, index: number): void {
    const ids = this.monitorBlocks.map((b) => b.id)
    const from = ids.indexOf(id)
    if (from < 0 || from === index) return
    ids.splice(from, 1)
    ids.splice(Math.max(0, Math.min(ids.length, index)), 0, id)
    this.data.monitorOrder = ids
    this.commit()
  }

  /** True when a block of the system monitor is switched on. */
  monitorShows(id: string): boolean {
    return !this.data.monitorHidden.includes(id)
  }

  setMonitorBlock(id: string, shown: boolean): void {
    const hidden = new Set(this.data.monitorHidden)
    if (shown) hidden.delete(id)
    else hidden.add(id)
    this.data.monitorHidden = [...hidden]
    this.commit()
  }

  setMonitorDock(dock: MonitorDock, size?: number): void {
    this.data.monitorDock = dock
    if (size !== undefined && Number.isFinite(size)) this.data.monitorDockSize = Math.round(size)
    this.commit()
  }

}

// ------------------------------------------------------------ layout helpers

/** Which edge of a pane a dragged pane was dropped on. */
export type DropSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * Splits `targetPaneId` and puts `newPaneId` on the requested side of it.
 *
 * Always produces a two-child split rather than appending to an existing one,
 * which keeps sibling sizes predictable after a move.
 */
function insertBeside(
  node: PaneNode,
  targetPaneId: string,
  newPaneId: string,
  side: DropSide
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.paneId !== targetPaneId) return node
    const direction = side === 'left' || side === 'right' ? 'row' : 'column'
    const before = side === 'left' || side === 'top'
    const target: PaneNode = { kind: 'leaf', paneId: targetPaneId }
    const moved: PaneNode = { kind: 'leaf', paneId: newPaneId }
    return {
      kind: 'split',
      direction,
      sizes: [0.5, 0.5],
      children: before ? [moved, target] : [target, moved],
    }
  }
  return {
    ...node,
    children: node.children.map((c) => insertBeside(c, targetPaneId, newPaneId, side)),
  }
}

/**
 * Puts a whole layout beside one pane, on the given side.
 *
 * `splitNode`'s bigger sibling: that one inserts a fresh leaf, this one grafts
 * an existing arrangement in. Dragging a tab with three panes in it into
 * another tab has to bring all three, still arranged the way they were —
 * flattening them into one pane would be losing work, and inserting them one at
 * a time would give an order nobody chose.
 *
 * `before` is which side of the target the graft lands on, so dropping on the
 * left edge puts it on the left rather than always appending.
 */
export function graftNode(
  node: PaneNode,
  targetPaneId: string,
  graft: PaneNode,
  direction: 'row' | 'column',
  before: boolean
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.paneId !== targetPaneId) return node
    const target: PaneNode = { kind: 'leaf', paneId: targetPaneId }
    return {
      kind: 'split',
      direction,
      sizes: [0.5, 0.5],
      children: before ? [graft, target] : [target, graft],
    }
  }
  return {
    ...node,
    children: node.children.map((c) => graftNode(c, targetPaneId, graft, direction, before)),
  }
}

function splitNode(
  node: PaneNode,
  targetPaneId: string,
  newPaneId: string,
  direction: 'row' | 'column'
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.paneId !== targetPaneId) return node
    return {
      kind: 'split',
      direction,
      sizes: [0.5, 0.5],
      children: [{ kind: 'leaf', paneId: targetPaneId }, { kind: 'leaf', paneId: newPaneId }],
    }
  }
  return { ...node, children: node.children.map((c) => splitNode(c, targetPaneId, newPaneId, direction)) }
}

/** Returns null when the node itself was the pane being removed. */
function removeNode(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.paneId === paneId ? null : node

  const kept: PaneNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, i) => {
    const next = removeNode(child, paneId)
    if (next) {
      kept.push(next)
      sizes.push(node.sizes[i] ?? 1 / node.children.length)
    }
  })

  if (!kept.length) return null
  // A split with one child collapses back into that child.
  if (kept.length === 1) return kept[0]

  const total = sizes.reduce((a, b) => a + b, 0) || 1
  return { ...node, children: kept, sizes: sizes.map((s) => s / total) }
}

function firstLeaf(node: PaneNode): string | null {
  if (node.kind === 'leaf') return node.paneId
  for (const child of node.children) {
    const found = firstLeaf(child)
    if (found) return found
  }
  return null
}

function nodeAt(node: PaneNode, path: number[]): PaneNode | null {
  let current: PaneNode = node
  for (const index of path) {
    if (current.kind !== 'split') return null
    const next = current.children[index]
    if (!next) return null
    current = next
  }
  return current
}

export function leavesOf(node: PaneNode): string[] {
  if (node.kind === 'leaf') return [node.paneId]
  return node.children.flatMap(leavesOf)
}

// --------------------------------------------------------------- migration

/**
 * Brings any document up to the current schema.
 *
 * v1 called workspaces "projects" and gave each tab exactly one shell; v2
 * introduces panes. Both shapes are accepted so an existing workspace.json
 * keeps working, and so two copies of the app can share a file even
 * when one of them is a build behind.
 */
/**
 * A pane's own shell, or nothing when it should inherit its workspace's.
 *
 * Everything written before v4 has a shell on every pane, because the old code
 * stamped the global default onto each one as it was made — that *was* the bug
 * where a WSL workspace opened PowerShell. None of those values is a decision
 * anybody took: choosing a shell per tab did not exist, so there is nothing to
 * preserve. They are dropped, and those panes go back to following their
 * workspace, which is what they always looked like they were doing.
 */
/**
 * Carries terminal palettes over from before the themes were split.
 *
 * A custom theme used to hold both halves in one object. Reading it now as an
 * `InterfaceTheme` keeps its chrome and silently drops its `terminal` — which
 * is somebody's hand-tuned palette. So on the first load after the split, every
 * old theme donates its terminal half to the new list under the same id and
 * name, and the pair go on looking exactly as they did.
 *
 * Runs once: as soon as `customTerminalThemes` exists it is authoritative, even
 * when empty, because an empty list is a user who deleted them all.
 */
function adoptTerminalThemes(settings: Partial<Settings>): TerminalTheme[] {
  if (settings.customTerminalThemes) return settings.customTerminalThemes
  const legacy = (settings.customThemes ?? []) as unknown as {
    id?: string
    name?: string
    terminal?: unknown
  }[]
  return legacy
    .filter((t) => t?.id && t.terminal && typeof t.terminal === 'object')
    .map((t) => ({
      id: t.id as string,
      name: (t.name as string) ?? 'Imported',
      builtin: false,
      terminal: t.terminal as TerminalTheme['terminal'],
    }))
}

function readPaneShell(raw: unknown, docVersion: number): ShellKind | undefined {
  if (docVersion < 4) return undefined
  return typeof raw === 'string' && SHELL_KINDS.has(raw as ShellKind)
    ? (raw as ShellKind)
    : undefined
}

/**
 * The saved weather places, with anything that is not one dropped.
 *
 * Read rather than trusted for the same reason the rest of this file reads
 * rather than trusts: the document is a file somebody can edit, and a place
 * missing half a coordinate would leave a chip in the menu that switches the
 * blocks to nowhere. A name is required because the name is how a place is
 * chosen and how the list is kept unique.
 */
function readWeatherPlaces(raw: unknown): WeatherPlace[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const places: WeatherPlace[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { place, lat, lon } = entry as Record<string, unknown>
    if (typeof place !== 'string' || typeof lat !== 'string' || typeof lon !== 'string') continue
    const name = place.trim()
    if (!name || !lat.trim() || !lon.trim()) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    places.push({ place: name, lat: lat.trim(), lon: lon.trim() })
  }
  return places
}

function normalize(raw: unknown): PersistedState {
  const doc = (raw ?? {}) as Record<string, unknown>
  const docVersion = typeof doc.version === 'number' ? doc.version : 0

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...((doc.settings as Partial<Settings>) ?? {}),
    notifications: {
      ...DEFAULT_NOTIFICATIONS,
      ...(((doc.settings as Partial<Settings>) ?? {}).notifications ?? {}),
    },
    customThemes: (((doc.settings as Partial<Settings>) ?? {}).customThemes ?? []) as InterfaceTheme[],
    customTerminalThemes: adoptTerminalThemes((doc.settings as Partial<Settings>) ?? {}),
    weatherPlaces: readWeatherPlaces(((doc.settings as Partial<Settings>) ?? {}).weatherPlaces),
  }

  // 1.2 was the old default and it splits box-drawing borders into dashes.
  // Nobody chose it deliberately, so carry those files onto the new default;
  // any other value is a real preference and is left alone.
  if (settings.lineHeight === 1.2) settings.lineHeight = DEFAULT_SETTINGS.lineHeight

  // A v1 file used `terminalTheme` with different ids than v2's `themeId`.
  const legacyTheme = (doc.settings as Record<string, unknown> | undefined)?.terminalTheme
  if (typeof legacyTheme === 'string' && !(doc.settings as Record<string, unknown>)?.themeId) {
    settings.themeId = legacyTheme === 'github-dark' ? 'graphite' : legacyTheme
  }

  const rawWorkspaces = (doc.workspaces ?? doc.projects ?? []) as Record<string, unknown>[]
  // v2 kept tree visibility global. Fall back to it for any workspace that
  // predates the per-workspace field, then it is owned by the workspace.
  const legacyTreeVisible = Boolean(doc.treeVisible)

  const workspaces: Workspace[] = rawWorkspaces.map((rawWorkspace, index) => {
    const cwd = sanitizeCwd(String(rawWorkspace.cwd ?? defaultCwd()), defaultCwd())
    const rawTabs = (rawWorkspace.tabs ?? rawWorkspace.terminals ?? []) as Record<string, unknown>[]

    const tabs: TerminalTabState[] = rawTabs.map((rawTab) => {
      const id = String(rawTab.id ?? crypto.randomUUID())

      // v2 shape.
      if (Array.isArray(rawTab.panes) && rawTab.panes.length && rawTab.layout) {
        const panes = (rawTab.panes as Record<string, unknown>[]).map((p) => ({
          id: String(p.id ?? crypto.randomUUID()),
          kind: readPaneKind(p.kind),
          cwd: sanitizeCwd(String(p.cwd ?? cwd), cwd),
          autoTitle: String(p.autoTitle ?? ''),
          shell: readPaneShell(p.shell, docVersion),
          agentSession: readAgentSession(p.agentSession),
          lastCommand: readLastCommand(p.lastCommand),
          file: typeof p.file === 'string' ? p.file : undefined,
          editorMode: EDITOR_MODES.includes(p.editorMode as EditorMode)
            ? (p.editorMode as EditorMode)
            : undefined,
          wordWrap: typeof p.wordWrap === 'boolean' ? p.wordWrap : undefined,
          lineNumbers: typeof p.lineNumbers === 'boolean' ? p.lineNumbers : undefined,
          autosave: typeof p.autosave === 'boolean' ? p.autosave : undefined,
          url: typeof p.url === 'string' ? p.url : undefined,
          wslDistro: typeof p.wslDistro === 'string' ? p.wslDistro : undefined,
          sshHost: typeof p.sshHost === 'string' ? p.sshHost : undefined,
          imageLayout: IMAGE_LAYOUTS.includes(p.imageLayout as ImageLayout)
            ? (p.imageLayout as ImageLayout)
            : undefined,
          imageSort: IMAGE_SORTS.includes(p.imageSort as ImageSort)
            ? (p.imageSort as ImageSort)
            : undefined,
          imageSortDesc: typeof p.imageSortDesc === 'boolean' ? p.imageSortDesc : undefined,
          imageRecursive: typeof p.imageRecursive === 'boolean' ? p.imageRecursive : undefined,
          imageFit: typeof p.imageFit === 'boolean' ? p.imageFit : undefined,
          imageFilter: IMAGE_FILTERS.includes(p.imageFilter as ImageFilter)
            ? (p.imageFilter as ImageFilter)
            : undefined,
          imageSeed:
            typeof p.imageSeed === 'number' && Number.isFinite(p.imageSeed)
              ? p.imageSeed
              : undefined,
          imageBoard: readBoard(p.imageBoard),
        }))
        const known = new Set(panes.map((p) => p.id))
        const layout = pruneLayout(rawTab.layout as PaneNode, known) ?? {
          kind: 'leaf' as const,
          paneId: panes[0].id,
        }
        const activePaneId = known.has(String(rawTab.activePaneId))
          ? String(rawTab.activePaneId)
          : (firstLeaf(layout) ?? panes[0].id)
        return {
          id,
          customTitle: (rawTab.customTitle as string | null) ?? null,
          panes,
          layout,
          activePaneId,
        }
      }

      // v1 shape: the tab *was* the shell. Promote it to a single pane.
      const pane: PaneState = {
        id: crypto.randomUUID(),
        cwd: sanitizeCwd(String(rawTab.cwd ?? cwd), cwd),
        autoTitle: typeof rawTab.autoTitle === 'string' ? rawTab.autoTitle : '',
        shell: (rawTab.shell as PaneState['shell']) ?? settings.shell,
      }
      return {
        id,
        customTitle: (rawTab.customTitle as string | null) ?? null,
        panes: [pane],
        layout: { kind: 'leaf', paneId: pane.id },
        activePaneId: pane.id,
      }
    })

    return {
      id: String(rawWorkspace.id ?? crypto.randomUUID()),
      name: String(rawWorkspace.name ?? `Workspace ${index + 1}`),
      // A v1 `groupId` is read straight in as the parent id: the group's own id
      // becomes the id of the workspace that stands in for it below.
      parentId:
        typeof rawWorkspace.parentId === 'string'
          ? rawWorkspace.parentId
          : typeof rawWorkspace.groupId === 'string'
            ? rawWorkspace.groupId
            : null,
      collapsed: Boolean(rawWorkspace.collapsed),
      notesFile:
        typeof rawWorkspace.notesFile === 'string' && rawWorkspace.notesFile
          ? rawWorkspace.notesFile
          : undefined,
      shell: SHELL_KINDS.has(rawWorkspace.shell as ShellKind)
        ? (rawWorkspace.shell as ShellKind)
        : undefined,
      wslDistro:
        typeof rawWorkspace.wslDistro === 'string' && rawWorkspace.wslDistro
          ? rawWorkspace.wslDistro
          : undefined,
      sshHost:
        typeof rawWorkspace.sshHost === 'string' && rawWorkspace.sshHost
          ? rawWorkspace.sshHost
          : undefined,
      cwd,
      treeCwd:
        typeof rawWorkspace.treeCwd === 'string' && rawWorkspace.treeCwd
          ? sanitizeCwd(rawWorkspace.treeCwd, cwd)
          : undefined,
      color: String(rawWorkspace.color ?? WORKSPACE_COLORS[index % WORKSPACE_COLORS.length]),
      tabs,
      treeVisible:
        typeof rawWorkspace.treeVisible === 'boolean'
          ? rawWorkspace.treeVisible
          : legacyTreeVisible,
      activeTabId:
        (rawWorkspace.activeTabId as string | null) ??
        (rawWorkspace.activeTerminalId as string | null) ??
        tabs[0]?.id ??
        null,
    }
  })

  const activeWorkspaceId =
    (doc.activeWorkspaceId as string | null) ??
    (doc.activeProjectId as string | null) ??
    workspaces[0]?.id ??
    null

  adoptLegacyGroups(doc, workspaces)
  pruneParents(workspaces)

  return {
    version: SCHEMA_VERSION,
    workspaces,
    activeWorkspaceId: workspaces.some((w) => w.id === activeWorkspaceId)
      ? activeWorkspaceId
      : (workspaces[0]?.id ?? null),
    sidebarWidth: Number(doc.sidebarWidth ?? EMPTY.sidebarWidth),
    sidebarCollapsed: Boolean(doc.sidebarCollapsed),
    treeWidth: Number(doc.treeWidth ?? EMPTY.treeWidth),
    gitFilesWidth: Number(doc.gitFilesWidth ?? EMPTY.gitFilesWidth),
    gitHistoryWidth: Number(doc.gitHistoryWidth ?? EMPTY.gitHistoryWidth),
    monitorDock: MONITOR_DOCKS.has(doc.monitorDock as MonitorDock)
      ? (doc.monitorDock as MonitorDock)
      : EMPTY.monitorDock,
    monitorDockSize: Number(doc.monitorDockSize) || EMPTY.monitorDockSize,
    // Checked against the known ids, so a document naming a block that no
    // longer exists cannot hide one that does.
    monitorHidden: Array.isArray(doc.monitorHidden)
      ? (doc.monitorHidden as unknown[]).filter(
          (id): id is string => typeof id === 'string' && MONITOR_BLOCKS.some((b) => b.id === id)
        )
      : [],
    monitorOrder: Array.isArray(doc.monitorOrder)
      ? (doc.monitorOrder as unknown[]).filter(
          (id): id is string => typeof id === 'string' && MONITOR_BLOCKS.some((b) => b.id === id)
        )
      : [],
    window: { ...EMPTY.window, ...((doc.window as object) ?? {}) },
    settings,
  }
}

/** Drops layout references to panes that no longer exist. */
function pruneLayout(node: PaneNode | undefined, known: Set<string>): PaneNode | null {
  if (!node || typeof node !== 'object') return null
  if (node.kind === 'leaf') return known.has(node.paneId) ? node : null
  if (!Array.isArray(node.children)) return null

  const kept: PaneNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, i) => {
    const next = pruneLayout(child, known)
    if (next) {
      kept.push(next)
      sizes.push(node.sizes?.[i] ?? 1 / node.children.length)
    }
  })
  if (!kept.length) return null
  if (kept.length === 1) return kept[0]
  const total = sizes.reduce((a, b) => a + b, 0) || 1
  return { kind: 'split', direction: node.direction, children: kept, sizes: sizes.map((s) => s / total) }
}

/**
 * Reads a persisted agent session back, dropping anything malformed or stale.
 *
 * The id ends up on a command line, so it is validated on the way in as well as
 * on the way out — a workspace file is editable, and shared with two other
 * builds that may write a shape this one has not seen.
 */
function readAgentSession(raw: unknown): AgentSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { tool, id, at, transcript } = raw as Record<string, unknown>
  if (tool !== 'claude' || typeof id !== 'string' || typeof at !== 'number') return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(id)) return undefined
  // A held claim is a conversation this pane may turn out to be having, so the
  // record is only stale when *both* halves are — dropping it on the accepted
  // id's age alone would throw away a claim made an hour ago because the id it
  // was refused by is a fortnight old.
  const claim = readPendingSession((raw as Record<string, unknown>).pending)
  if (Date.now() - Math.max(at, claim?.at ?? 0) > AGENT_SESSION_TTL_MS) return undefined
  // The transcript is what makes the id checkable at the moment it would be
  // resumed; a file that has since gone means a conversation that has gone.
  // Absent on records written by an older build, and absence is honest — it
  // means unknown, and an unknown transcript is taken at its word.
  return {
    tool,
    id,
    at,
    ...(typeof transcript === 'string' && transcript ? { transcript } : {}),
    ...(claim ? { pending: claim } : {}),
  }
}

/**
 * The unproven id held beside a record, read back with the same suspicion.
 *
 * Held to a stricter rule than the record itself: a claim with no transcript
 * can never be settled, so it is nothing but a stale id waiting to be typed at
 * a shell. See `AgentSession.pending`.
 */
function readPendingSession(raw: unknown): AgentSession['pending'] {
  if (!raw || typeof raw !== 'object') return undefined
  const { id, at, transcript } = raw as Record<string, unknown>
  if (typeof id !== 'string' || typeof at !== 'number') return undefined
  if (typeof transcript !== 'string' || !transcript) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(id)) return undefined
  return { id, at, transcript }
}

/**
 * Turns the short-lived `groups` array into real workspaces.
 *
 * Groups were a separate entity for one release; they are now just workspaces
 * that happen to have children. Each becomes a workspace of its own, keeping
 * its name and its fold, so a sidebar that was arranged one way comes back
 * arranged the same way — it just has one concept in it instead of two.
 *
 * The stand-in gets its first child's folder, because a group had none and a
 * workspace needs somewhere for its terminals to start.
 */
function adoptLegacyGroups(doc: Record<string, unknown>, workspaces: Workspace[]): void {
  const groups = doc.groups
  if (!Array.isArray(groups) || !groups.length) return

  for (const [index, raw] of groups.entries()) {
    const group = raw as Record<string, unknown>
    if (!group || typeof group.id !== 'string') continue
    const members = workspaces.filter((w) => w.parentId === group.id)
    if (!members.length) continue

    const stand: Workspace = {
      id: String(group.id),
      name: String(group.name ?? `Group ${index + 1}`),
      cwd: members[0].cwd,
      color: members[0].color,
      tabs: [],
      activeTabId: null,
      parentId: null,
      collapsed: Boolean(group.collapsed),
    }
    // In front of its members, so the drawn order survives the conversion.
    workspaces.splice(workspaces.indexOf(members[0]), 0, stand)
  }
}

/**
 * Drops a parent link that points nowhere, or into a cycle.
 *
 * Either would take the workspace off the sidebar entirely — an unknown parent
 * is never walked, and a cycle never terminates — so both are cut back to the
 * top level where the workspace is at least reachable.
 */
function pruneParents(workspaces: Workspace[]): void {
  const known = new Set(workspaces.map((w) => w.id))
  for (const w of workspaces) {
    if (w.parentId && !known.has(w.parentId)) w.parentId = null
  }
  for (const w of workspaces) {
    const seen = new Set<string>([w.id])
    let at = workspaces.find((x) => x.id === w.parentId)
    while (at) {
      if (seen.has(at.id)) {
        w.parentId = null
        break
      }
      seen.add(at.id)
      at = workspaces.find((x) => x.id === at!.parentId)
    }
  }
}

// Every platform's kinds, not this platform's. A workspace file written on
// Windows has to survive being read on a Mac with its `shell` intact — see the
// matching set in `shared/workspaceFile.ts`, and `resolveShell`, which falls
// back to something that exists rather than requiring the value to be runnable.
const SHELL_KINDS = new Set<ShellKind>([
  'powershell',
  'pwsh',
  'cmd',
  'wsl',
  'ssh',
  'zsh',
  'bash',
  'fish',
  'sh',
  'custom',
])


/**
 * An unknown kind becomes a terminal.
 *
 * The three builds share one workspace file, and a newer build may have written
 * a pane kind this one has never heard of. A terminal is the honest fallback:
 * the pane stays where it was, and you get a shell rather than an empty box.
 */
/**
 * The state as the *other builds* must be able to read it.
 *
 * One workspace file is shared by all three, and a build that meets a pane kind
 * it does not know rewrites it as a terminal — permanently, since it saves
 * afterwards. So the editor pane goes to disk under the name it has always had
 * there, and `readPaneKind` translates on the way back in. Everything else is
 * an untouched clone.
 */
function forDisk(data: PersistedState): PersistedState {
  const clone = structuredClone(data)
  for (const workspace of clone.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        pane.kind = wireKind(pane.kind) as PaneState['kind']
      }
    }
  }
  return clone
}

function readPaneKind(raw: unknown): PaneState['kind'] {
  // `readWireKind` owns both the `notes` translation and the list of what this
  // build knows. An unknown kind becomes a terminal rather than a pane nothing
  // can mount — see the note on `readWireKind` for why this is not three lists.
  return readWireKind(raw) ?? 'terminal'
}

/**
 * Reads back a persisted command line.
 *
 * The file is ours but it is plain JSON on disk, and this string is typed
 * straight into a shell — anything with a control character in it is dropped
 * rather than cleaned up, since a CR would submit a line nobody chose to run.
 */
function readLastCommand(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return undefined
  return value
}

/**
 * Repairs paths written by builds whose shell-integration script leaked its
 * quote escaping into the reported directory (values like `\"C:\\"`).
 */
function sanitizeCwd(cwd: string, fallback: string): string {
  const cleaned = (cwd ?? '')
    .trim()
    .replace(/^\\?"/, '')
    .replace(/\\?"$/, '')
  return cleaned || fallback
}

/**
 * Which shell a pane actually runs, and in which WSL distribution.
 *
 * The one place that knows the rule, so the spawn and anything that displays it
 * cannot drift apart: the pane's own choice, else its workspace's, else the
 * global default. A pane records a shell only when one was chosen for it, which
 * is what makes the middle term reachable — it was not, once, and a workspace
 * set to WSL opened PowerShell for it.
 */
export function shellFor(
  pane: Pick<PaneState, 'shell' | 'wslDistro' | 'sshHost'>,
  workspace: Pick<Workspace, 'shell' | 'wslDistro' | 'sshHost'> | null | undefined,
  settings: Pick<Settings, 'shell'>
): { shell: ShellKind } & ShellTarget {
  const shell = pane.shell ?? workspace?.shell ?? settings.shell
  // A target belongs to whichever level chose the remote shell. A pane that
  // named its own shell names its own distribution or host; one that inherited
  // the shell inherits the target with it.
  const target: ShellTarget = pane.shell
    ? { wslDistro: pane.wslDistro, sshHost: pane.sshHost }
    : {
        wslDistro: pane.wslDistro ?? workspace?.wslDistro,
        sshHost: pane.sshHost ?? workspace?.sshHost,
      }
  return { shell, ...shellTargetFor(shell, target) }
}

/**
 * The machine a pane's workspace runs its shells on, or null for this one.
 *
 * The question the file tree, the changes pane and the search pane have to ask
 * before they use a workspace folder. Those three read the local filesystem —
 * `readdir`, `git diff`, a recursive grep — and an SSH workspace's folder is a
 * path on another computer, so the honest answer is to say whose it is rather
 * than to list whatever happens to sit at the same path here.
 *
 * WSL deliberately answers null. Its folders are real local paths under
 * `\\wsl.localhost\…`, which is the whole reason those panes work inside a WSL
 * workspace without knowing what WSL is.
 */
export function remoteHostOfPane(paneId: string): string | null {
  const workspace = store.workspaceOfPane(paneId)
  const pane = store.pane(paneId)
  if (!pane) return null
  const resolved = shellFor(pane, workspace, store.settings)
  return resolved.shell === 'ssh' ? (resolved.sshHost ?? 'another machine') : null
}

export const store = new WorkspaceState()

/**
 * PowerShell sets the window title to its own executable path, which makes a
 * useless label. Titles a program sets deliberately — "✳ Claude Code", an npm
 * script name — are the ones worth showing.
 */
function isNoiseTitle(title: string): boolean {
  return /\.exe\b/i.test(title) || /^[A-Za-z]:[\\/]/.test(title)
}

/**
 * Hand-placed board positions, from a document that may have been edited.
 *
 * Every coordinate is checked and any entry that is not three finite numbers is
 * dropped. A NaN here would place an image nowhere and take the rest of the
 * board's layout with it, and the file is one people are invited to read and
 * commit — so it is one people will eventually edit by hand.
 */
function readBoard(raw: unknown): Record<string, BoardPlacement> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, BoardPlacement> = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Record<string, unknown>
    if (!v || typeof v !== 'object') continue
    const x = Number(v.x)
    const y = Number(v.y)
    const w = Number(v.w)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || w <= 0) continue
    out[path] = { x, y, w }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function paneLabel(pane: PaneState): string {
  if (pane.customTitle) return pane.customTitle
  // `[\\/]`, not `[\/]`: the second is a class holding one escaped forward
  // slash, so a Windows path has nothing to split on and the "file name" comes
  // back as the whole path.
  // Lower case throughout, deliberately. These are labels on the app's own
  // furniture rather than sentences, several of them are the commands you would
  // type — `git`, `search` — and the monitor's rows have always been `cpu` and
  // `memory`. A strip mixing "Changes" with "cpu" reads as two apps.
  if (pane.kind === 'reader') return fileName(pane.file) || 'file'
  if (pane.kind === 'editor') return `e: ${fileName(pane.file) || 'untitled'}`
  // One name for both kinds, because they are one pane: the kind records which
  // of its two views is showing, and a tab that renamed itself every time you
  // pressed the switch inside it would read as a second tab appearing.
  if (pane.kind === 'diff' || pane.kind === 'history') return 'git'
  // Both names, because which two files this pane holds is the whole of what it
  // is — and a workspace can hold several compares at once.
  if (pane.kind === 'compare') {
    const left = fileName(pane.compareLeft ?? '')
    const right = fileName(pane.compareRight ?? '')
    return left && right ? `${left} → ${right}` : 'compare'
  }
  if (pane.kind === 'search') return 'search'
  if (pane.kind === 'ports') return 'running'
  if (pane.kind === 'tokens') return 'token stats'
  if (pane.kind === 'monitor') return 'system'
  if (pane.kind === 'images') return 'images'
  if (pane.kind === 'browser') return browserLabel(pane.url)
  const leaf = pane.cwd.split(/[\\/]/).filter(Boolean).pop() || 'Terminal'
  if (pane.kind === 'files') return `${leaf} tree`
  const auto = pane.autoTitle?.trim()
  if (auto && !isNoiseTitle(auto)) return auto
  return leaf
}

/**
 * A browser pane's label: the site it is on.
 *
 * The host and nothing else. A full URL is far too long for a tab, and the page
 * title — which is what a real browser shows — is somebody else's marketing
 * copy and changes under you as the page loads. "localhost:5173" says which
 * pane this is; "Vite + React + TS" does not.
 */
function browserLabel(url: string | undefined): string {
  if (!url) return 'Browser'
  try {
    const { hostname, port } = new URL(url)
    if (!hostname) return 'Browser'
    return port ? `${hostname}:${port}` : hostname
  } catch {
    return 'Browser'
  }
}

/** Display title for a tab: a manual rename wins, else the active pane. */
export function tabLabel(tab: TerminalTabState): string {
  if (tab.customTitle) return tab.customTitle

  const pane = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0]
  if (!pane) return 'Terminal'

  // A file tree says so, and follows the folder as you navigate.
  const base = pane.kind === 'files' ? `${folderName(pane.cwd)} tree` : paneLabel(pane)
  return tab.panes.length > 1 ? `${base} (${tab.panes.length})` : base
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd
}

/** The last segment of a path, under either separator. */
export function fileName(file: string | undefined): string {
  return file?.split(/[\\/]/).filter(Boolean).pop() ?? ''
}
