/**
 * Workspaces as a file you can keep.
 *
 * The app already remembers everything, and that is not the same thing: it
 * remembers *the* arrangement, the live one, and every change overwrites what
 * was there before. This is the other kind of memory — a named arrangement you
 * can come back to, put in the project it belongs to, commit next to the code,
 * or send to someone else.
 *
 * **Layout only, deliberately.** Names, folders, colours, shells, tabs, the
 * split tree and where each pane was pointing. Not the scrollback, not the
 * recorded agent conversations, not the last command. Those are facts about one
 * machine at one moment — an agent session id means nothing on your colleague's
 * laptop, and a screen dump is megabytes of something nobody wants in a repo.
 * What survives is what would still be true tomorrow on a different computer.
 *
 * Nothing here imports anything: it is pure data in, pure data out, so the
 * round trip can be tested without a window, a filesystem or a backend.
 */

import { readWireKind, wireKind } from './types'
import {
  IMAGE_FILTERS,
  IMAGE_LAYOUTS,
  IMAGE_SORTS,
  type ImageFilter,
  type ImageLayout,
  type ImageSort,
} from './images'
import type { PaneKind, PaneNode, ShellKind, TerminalTabState, Workspace } from './types'

/** Bumped only when an older build could not read a newer file correctly. */
export const WORKSPACE_FILE_VERSION = 1

/** What we write. `kind` is a sanity check, not a security measure. */
export interface WorkspaceFile {
  kind: 'ia_workspaces/workspaces'
  version: number
  /** When it was written, for the human reading the file. Never read back. */
  savedAt: string
  workspaces: SavedWorkspace[]
}

export interface SavedWorkspace {
  name: string
  cwd: string
  color: string
  shell?: ShellKind
  wslDistro?: string
  /** Which SSH host, when the workspace's shell is `ssh`. */
  sshHost?: string
  notesFile?: string
  treeVisible?: boolean
  collapsed?: boolean
  /**
   * Position of this workspace's parent within the same file, or absent for a
   * top-level one.
   *
   * An index rather than an id, because ids are minted fresh on load — a saved
   * id would either collide with something already open or have to be rewritten
   * anyway. An index is meaningful inside the file and meaningless outside it,
   * which is exactly the right scope.
   */
  parent?: number
  tabs: SavedTab[]
}

export interface SavedTab {
  customTitle: string | null
  panes: SavedPane[]
  layout: PaneNode
  /** Index into `panes` of the focused one. */
  activePane: number
}

export interface SavedPane {
  kind: PaneKind
  cwd: string
  /** Absent means the pane inherits its workspace's shell. */
  shell?: ShellKind
  /** Which WSL distribution, when the pane names its own shell. */
  wslDistro?: string
  /** Which SSH host, when the pane names its own shell. */
  sshHost?: string
  customTitle?: string | null
  /** A `reader` pane's file, a `browser` pane's page. */
  file?: string
  url?: string
  /**
   * How an `images` pane was arranged.
   *
   * Positions dragged on the board are deliberately *not* here. They are keyed
   * by absolute path, and this file is meant to be committed next to the code
   * it opens and read on someone else's machine — where those paths mean
   * nothing. The arrangement itself is portable, so it travels; the hand
   * placement is a fact about one folder on one computer, so it stays in the
   * live document and out of the file.
   */
  imageLayout?: ImageLayout
  imageSort?: ImageSort
  imageSortDesc?: boolean
  imageRecursive?: boolean
  imageFit?: boolean
  imageFilter?: ImageFilter
  imageSeed?: number
}

// ------------------------------------------------------------------- writing

/**
 * Turns workspaces into a document.
 *
 * `chosen` is what the caller wants saved; anything nested underneath those is
 * expected to be in the list already — `subtreeOf` is what builds that, and
 * saving "this workspace" means the whole subtree because that is what the word
 * means when you are looking at the sidebar.
 *
 * Pane ids become indices into the tab's own pane list, so the layout tree in
 * the file refers to positions rather than to ids that will not exist on load.
 */
export function exportWorkspaces(chosen: Workspace[], now: Date): WorkspaceFile {
  const position = new Map(chosen.map((w, i) => [w.id, i]))

  return {
    kind: 'ia_workspaces/workspaces',
    version: WORKSPACE_FILE_VERSION,
    savedAt: now.toISOString(),
    workspaces: chosen.map((w) => {
      const parent = w.parentId ? position.get(w.parentId) : undefined
      const saved: SavedWorkspace = {
        name: w.name,
        cwd: w.cwd,
        color: w.color,
        tabs: w.tabs.map(exportTab),
      }
      // Only what was actually set, so a file stays readable and a default
      // never gets frozen into one.
      if (w.shell) saved.shell = w.shell
      if (w.wslDistro) saved.wslDistro = w.wslDistro
      if (w.sshHost) saved.sshHost = w.sshHost
      if (w.notesFile) saved.notesFile = w.notesFile
      if (w.treeVisible) saved.treeVisible = true
      if (w.collapsed) saved.collapsed = true
      // A parent outside the chosen set is dropped rather than dangling: the
      // workspace lands at the top level, which is where it will have to go.
      if (parent !== undefined) saved.parent = parent
      return saved
    }),
  }
}

function exportTab(tab: TerminalTabState): SavedTab {
  const index = new Map(tab.panes.map((p, i) => [p.id, i]))
  return {
    customTitle: tab.customTitle,
    activePane: Math.max(0, index.get(tab.activePaneId) ?? 0),
    panes: tab.panes.map((p) => {
      const saved: SavedPane = { kind: wireKind(p.kind) as PaneKind, cwd: p.cwd }
      // Only a pane that chose a shell records one, so a saved file keeps the
      // difference between "this tab is WSL" and "this tab follows its
      // workspace" rather than freezing every tab at whatever it resolved to.
      if (p.shell) saved.shell = p.shell
      if (p.wslDistro) saved.wslDistro = p.wslDistro
      if (p.sshHost) saved.sshHost = p.sshHost
      if (p.customTitle) saved.customTitle = p.customTitle
      if (p.file) saved.file = p.file
      if (p.url) saved.url = p.url
      // Only what was actually chosen. A pane that never had its arrangement
      // touched follows the setting, and writing the resolved value would
      // freeze it at whatever the setting happened to be that afternoon.
      if (p.imageLayout) saved.imageLayout = p.imageLayout
      if (p.imageSort) saved.imageSort = p.imageSort
      if (p.imageSortDesc !== undefined) saved.imageSortDesc = p.imageSortDesc
      if (p.imageRecursive !== undefined) saved.imageRecursive = p.imageRecursive
      if (p.imageFit !== undefined) saved.imageFit = p.imageFit
      if (p.imageFilter) saved.imageFilter = p.imageFilter
      if (p.imageSeed !== undefined) saved.imageSeed = p.imageSeed
      return saved
    }),
    layout: exportLayout(tab.layout, index),
  }
}

/** The same tree with pane ids replaced by their index, as `p0`, `p1`, … */
function exportLayout(node: PaneNode, index: Map<string, number>): PaneNode {
  if (node.kind === 'leaf') {
    return { kind: 'leaf', paneId: `p${index.get(node.paneId) ?? 0}` }
  }
  return {
    kind: 'split',
    direction: node.direction,
    sizes: [...node.sizes],
    children: node.children.map((c) => exportLayout(c, index)),
  }
}

/** A workspace and everything nested under it, in sidebar order. */
export function subtreeOf(all: Workspace[], rootId: string): Workspace[] {
  const out: Workspace[] = []
  const walk = (id: string) => {
    const found = all.find((w) => w.id === id)
    if (!found || out.includes(found)) return
    out.push(found)
    for (const child of all.filter((w) => w.parentId === id)) walk(child.id)
  }
  walk(rootId)
  return out
}

// ------------------------------------------------------------------- reading

/**
 * What a file turned into, and what had to be changed to accept it.
 *
 * `notes` is not an error list — a file that needed adjusting still loads. It
 * is what to tell the user afterwards, because silently renaming their
 * workspace is worse than saying so.
 */
export interface ImportResult {
  workspaces: Workspace[]
  notes: string[]
}

/**
 * Reads a document into workspaces ready to be added.
 *
 * Every id is minted here rather than carried in the file. That is what makes
 * loading the same file twice work, and it is why a saved parent link is an
 * index: the relationships are rebuilt against the new ids.
 *
 * Hostile input is assumed. This is a file from disk that a person may have
 * hand-edited or been sent, so every field is checked and anything unusable is
 * replaced rather than trusted — a bad `cwd` becomes the fallback, an unknown
 * pane kind becomes a terminal, a layout that does not match its panes is
 * rebuilt from them.
 */
export function importWorkspaces(
  raw: unknown,
  opts: {
    /** Names already in the sidebar, so a load cannot silently shadow one. */
    taken: ReadonlySet<string>
    /** Used for any workspace or pane whose folder is unusable. */
    fallbackCwd: string
    newId: () => string
  }
): ImportResult | { error: string } {
  const doc = asObject(raw)
  if (!doc) return { error: 'That file is not a workspace file.' }
  if (doc.kind !== 'ia_workspaces/workspaces') {
    return { error: 'That file is not a workspace file.' }
  }
  const version = typeof doc.version === 'number' ? doc.version : 0
  if (version > WORKSPACE_FILE_VERSION) {
    return {
      error: `That file was written by a newer build (format ${version}, this one reads ${WORKSPACE_FILE_VERSION}).`,
    }
  }
  const list = Array.isArray(doc.workspaces) ? doc.workspaces : null
  if (!list || !list.length) return { error: 'That file has no workspaces in it.' }

  const notes: string[] = []
  const taken = new Set(opts.taken)
  const ids = list.map(() => opts.newId())
  const workspaces: Workspace[] = []

  list.forEach((rawWorkspace, i) => {
    const w = asObject(rawWorkspace)
    if (!w) return

    const wanted = text(w.name) || 'Workspace'
    const name = uniqueName(wanted, taken)
    if (name !== wanted) notes.push(`"${wanted}" was already open, so it loaded as "${name}".`)
    taken.add(name)

    // A parent index has to point backwards into this same file. Anything else
    // — out of range, pointing at itself, pointing forwards — is not a tree we
    // can build, so the workspace lands at the top level.
    const parentIndex = typeof w.parent === 'number' ? w.parent : -1
    const parentId =
      Number.isInteger(parentIndex) && parentIndex >= 0 && parentIndex < list.length && parentIndex !== i
        ? ids[parentIndex]
        : null

    const cwd = text(w.cwd) || opts.fallbackCwd
    const tabs = (Array.isArray(w.tabs) ? w.tabs : [])
      .map((t) => importTab(t, cwd, opts.newId))
      .filter((t): t is TerminalTabState => t !== null)

    workspaces.push({
      id: ids[i],
      name,
      cwd,
      color: text(w.color) || '#8f8f8f',
      parentId,
      tabs,
      activeTabId: tabs[0]?.id ?? null,
      ...(isShell(w.shell) ? { shell: w.shell } : {}),
      ...(text(w.wslDistro) ? { wslDistro: text(w.wslDistro) } : {}),
      ...(text(w.sshHost) ? { sshHost: text(w.sshHost) } : {}),
      ...(text(w.notesFile) ? { notesFile: text(w.notesFile) } : {}),
      ...(w.treeVisible === true ? { treeVisible: true } : {}),
      ...(w.collapsed === true ? { collapsed: true } : {}),
    })
  })

  if (!workspaces.length) return { error: 'That file has no workspaces we could read.' }

  // A parent link is only broken by a cycle if the file was hand-edited, but a
  // cycle makes the sidebar undrawable, so it is cut here rather than there.
  for (const w of workspaces) {
    if (w.parentId && hasCycle(w, workspaces)) {
      w.parentId = null
      notes.push(`"${w.name}" was nested in a loop, so it loaded at the top level.`)
    }
  }

  return { workspaces, notes }
}

function importTab(raw: unknown, cwd: string, newId: () => string): TerminalTabState | null {
  const t = asObject(raw)
  if (!t) return null

  const rawPanes = Array.isArray(t.panes) ? t.panes : []
  const panes = rawPanes.map((rawPane) => {
    const p = asObject(rawPane) ?? {}
    return {
      id: newId(),
      // Translated rather than taken at face value: `notes` is the editor
      // pane's name on disk, and a kind this build has never heard of becomes a
      // terminal rather than a pane nothing knows how to mount.
      kind: readWireKind(p.kind) ?? ('terminal' as PaneKind),
      cwd: text(p.cwd) || cwd,
      autoTitle: '',
      customTitle: text(p.customTitle) || null,
      ...(isShell(p.shell) ? { shell: p.shell } : {}),
      ...(text(p.wslDistro) ? { wslDistro: text(p.wslDistro) } : {}),
      ...(text(p.sshHost) ? { sshHost: text(p.sshHost) } : {}),
      ...(text(p.file) ? { file: text(p.file) } : {}),
      ...(text(p.url) ? { url: text(p.url) } : {}),
      // Checked against the known values rather than cast: this is a file a
      // person may have edited, and an arrangement nothing recognises would
      // leave the pane unable to draw itself.
      ...(oneOf(p.imageLayout, IMAGE_LAYOUTS) ? { imageLayout: p.imageLayout } : {}),
      ...(oneOf(p.imageSort, IMAGE_SORTS) ? { imageSort: p.imageSort } : {}),
      ...(typeof p.imageSortDesc === 'boolean' ? { imageSortDesc: p.imageSortDesc } : {}),
      ...(typeof p.imageRecursive === 'boolean' ? { imageRecursive: p.imageRecursive } : {}),
      ...(typeof p.imageFit === 'boolean' ? { imageFit: p.imageFit } : {}),
      ...(oneOf(p.imageFilter, IMAGE_FILTERS) ? { imageFilter: p.imageFilter } : {}),
      ...(typeof p.imageSeed === 'number' && Number.isFinite(p.imageSeed)
        ? { imageSeed: p.imageSeed }
        : {}),
    }
  })
  // A tab with no panes is not a tab.
  if (!panes.length) return null

  const activeIndex = typeof t.activePane === 'number' ? t.activePane : 0
  const active = panes[Number.isInteger(activeIndex) ? activeIndex : 0] ?? panes[0]

  return {
    id: newId(),
    customTitle: text(t.customTitle) || null,
    panes,
    layout: importLayout(t.layout, panes.map((p) => p.id)),
    activePaneId: active.id,
  }
}

/**
 * Rebuilds the split tree against the panes that actually loaded.
 *
 * The file refers to panes as `p0`, `p1`, … so anything that does not resolve
 * — a hand-edited file, a pane we dropped — is left out. If what survives does
 * not account for every pane, the tree is thrown away and rebuilt as a plain
 * row: a pane missing from the layout would be invisible and unreachable,
 * which is a worse outcome than losing the arrangement.
 */
function importLayout(raw: unknown, paneIds: string[]): PaneNode {
  const fallback = (): PaneNode =>
    paneIds.length === 1
      ? { kind: 'leaf', paneId: paneIds[0] }
      : {
          kind: 'split',
          direction: 'row',
          sizes: paneIds.map(() => 1 / paneIds.length),
          children: paneIds.map((paneId) => ({ kind: 'leaf' as const, paneId })),
        }

  const seen = new Set<string>()
  const convert = (node: unknown): PaneNode | null => {
    const n = asObject(node)
    if (!n) return null

    if (n.kind === 'leaf') {
      const match = /^p(\d+)$/.exec(text(n.paneId))
      const paneId = match ? paneIds[Number(match[1])] : undefined
      if (!paneId || seen.has(paneId)) return null
      seen.add(paneId)
      return { kind: 'leaf', paneId }
    }

    if (n.kind !== 'split' || !Array.isArray(n.children)) return null
    const children = n.children.map(convert).filter((c): c is PaneNode => c !== null)
    if (!children.length) return null
    if (children.length === 1) return children[0]

    const sizes = Array.isArray(n.sizes) && n.sizes.length === children.length
      ? (n.sizes as unknown[]).map((s) => (typeof s === 'number' && s > 0 ? s : 1 / children.length))
      : children.map(() => 1 / children.length)
    return {
      kind: 'split',
      direction: n.direction === 'column' ? 'column' : 'row',
      sizes,
      children,
    }
  }

  const built = convert(raw)
  if (!built || seen.size !== paneIds.length) return fallback()
  return built
}

// ------------------------------------------------------------------- helpers

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// Every platform's kinds, not this platform's: a workspace file written on
// Windows has to survive being read on a Mac with its `shell` intact, so that
// carrying it back to Windows still opens PowerShell. Dropping the value here
// would quietly rewrite the file on next save.
const SHELLS = new Set([
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
function isShell(value: unknown): value is ShellKind {
  return typeof value === 'string' && SHELLS.has(value)
}

/** Membership in one of the small closed unions, for a value off disk. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}


/** `name`, or `name (2)`, `name (3)` … until it is not already in use. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`
    if (!taken.has(candidate)) return candidate
  }
}

function hasCycle(start: Workspace, all: Workspace[]): boolean {
  const seen = new Set<string>([start.id])
  let current = start.parentId
  while (current) {
    if (seen.has(current)) return true
    seen.add(current)
    current = all.find((w) => w.id === current)?.parentId ?? null
  }
  return false
}
