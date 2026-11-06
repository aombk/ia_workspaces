/**
 * Workspace presets: the tabs you set up in every new workspace, saved once.
 *
 * The same shape a workspace file uses for its tabs — names, the split tree,
 * pane kinds and titles — with every folder and file written relative to the
 * workspace's own folder, so a preset made in one project lays out the same
 * tabs in the next one, pointing at that project's folders instead. A path
 * outside the workspace's folder stays absolute.
 *
 * Pure data in, pure data out, like `workspaceFile.ts`, so it can be tested
 * without a window.
 */

import { exportWorkspaces, importWorkspaces, WORKSPACE_FILE_VERSION, type SavedTab } from './workspaceFile'
import type { TerminalTabState, Workspace } from './types'

export interface WorkspacePreset {
  name: string
  /** Whether it docks the file tree. */
  treeVisible?: boolean
  /** Folders and files relative to the workspace's folder, `.` for the folder itself. */
  tabs: SavedTab[]
}

const isAbsolute = (path: string): boolean => /^([a-zA-Z]:([\\/]|$)|[\\/]|~)/.test(path)
const slashes = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')
/** Windows paths (a drive or a share) compare without case. */
const foldsCase = (path: string): boolean => /^([a-zA-Z]:|\/\/)/.test(path)

/** `path` relative to `root` when it is inside it, otherwise as it was. */
export function toRelative(path: string, root: string): string {
  if (!path || !root) return path
  const p = slashes(path)
  const r = slashes(root)
  const fold = foldsCase(r)
  const P = fold ? p.toLowerCase() : p
  const R = fold ? r.toLowerCase() : r
  if (P === R) return '.'
  if (R && P.startsWith(R + '/')) return p.slice(r.length + 1)
  return path
}

/** A preset's path made absolute again under `root`, in `root`'s own slashes. */
export function fromRelative(path: string, root: string): string {
  if (!path || isAbsolute(path) || !root) return path
  if (path === '.') return root
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]+$/, '') + sep + path.split('/').join(sep)
}

function mapPaths(tabs: SavedTab[], map: (path: string) => string): SavedTab[] {
  return tabs.map((tab) => ({
    ...tab,
    panes: tab.panes.map((pane) => ({
      ...pane,
      cwd: map(pane.cwd),
      ...(pane.file ? { file: map(pane.file) } : {}),
    })),
  }))
}

/** A workspace's tabs as a preset. */
export function makePreset(name: string, workspace: Workspace): WorkspacePreset {
  const saved = exportWorkspaces([workspace], new Date()).workspaces[0]
  return {
    name,
    ...(workspace.treeVisible ? { treeVisible: true } : {}),
    tabs: mapPaths(saved.tabs, (path) => toRelative(path, workspace.cwd)),
  }
}

/** A preset's tabs, ready to add to a workspace in `cwd`: fresh ids, absolute paths. */
export function presetTabs(preset: WorkspacePreset, cwd: string, newId: () => string): TerminalTabState[] {
  const result = importWorkspaces(
    {
      kind: 'ia_workspaces/workspaces',
      version: WORKSPACE_FILE_VERSION,
      workspaces: [{ name: preset.name, cwd, tabs: mapPaths(preset.tabs, (path) => fromRelative(path, cwd)) }],
    },
    { taken: new Set(), fallbackCwd: cwd, newId }
  )
  return 'error' in result ? [] : (result.workspaces[0]?.tabs ?? [])
}

/** Presets off disk: anything without a name or tabs dropped, one per name. */
export function readPresets(raw: unknown): WorkspacePreset[] {
  if (!Array.isArray(raw)) return []
  const out: WorkspacePreset[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Partial<WorkspacePreset>
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    if (!name || !Array.isArray(p.tabs) || out.some((x) => x.name === name)) continue
    out.push({ name, ...(p.treeVisible === true ? { treeVisible: true } : {}), tabs: p.tabs })
  }
  return out
}
