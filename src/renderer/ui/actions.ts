import type { ShellKind, ShellTarget } from '../../shared/types'

/** Operations the UI components need from the app shell. */
export interface UiActions {
  selectWorkspace(workspaceId: string): void
  /** `parentId` nests the new workspace inside that one. */
  addWorkspace(parentId?: string): void
  changeWorkspaceFolder(workspaceId: string): void
  removeWorkspace(workspaceId: string): void

  selectTab(workspaceId: string, tabId: string): void
  newTab(workspaceId: string, cwd?: string): void
  /** A whole tab that is a file tree, rather than a pane beside terminals. */
  newFileTab(workspaceId: string, cwd?: string): void
  /** Show or hide the app-wide "waiting for you" panel. */
  openInbox(workspaceId: string): void
  /** Focus this workspace's working-tree diff, opening it if it isn't already. */
  openDiff(workspaceId: string): void
  /**
   * Open a compare tab. Files can be given, or dropped onto the pane after.
   *
   * Always a new tab: a compare is about one specific pair, so reusing an open
   * one would discard the comparison you were reading.
   */
  openCompare(workspaceId: string, left?: string, right?: string): void
  /** Focus this workspace's search tab, opening it if it isn't already. */
  openSearch(workspaceId: string): void
  /** Focus the running-processes pane, opening it if none is open. */
  openPorts(workspaceId: string): void
  /**
   * Focus this workspace's images tab, opening it if it isn't already.
   *
   * One per workspace, like the diff and the search: it shows whatever the file
   * tree is pointed at, so a second one would show exactly the same thing.
   */
  openImages(workspaceId: string): void
  /**
   * Ends this pane's shell and starts a named one in its place.
   *
   * Destructive by nature — a running shell cannot be converted — so the menu
   * that offers it says "Reopen as" rather than anything that sounds like a
   * setting. `distro` only means anything for WSL, where it picks which
   * distribution.
   */
  reopenPaneAs(paneId: string, shell: ShellKind, target?: ShellTarget): void
  /** Asks for a host, then reopens the pane on it. Cancelling changes nothing. */
  reopenPaneAsSshHost(paneId: string): Promise<void>
  /** Writes a workspace and everything nested under it to a file you pick. */
  saveWorkspace(workspaceId: string): void
  /** The same, for every workspace at once. */
  saveAllWorkspaces(): void
  /** Reads a workspace file, adding what it holds beside what is already open. */
  loadWorkspaces(): void
  /** A web page in a tab. Only where `Backend.capabilities.browser` is true. */
  openBrowser(workspaceId: string): void
  /** Show a file read-only, as a split beside the current pane. */
  openReader(path: string): void
  /**
   * Open a file in a new editor tab.
   *
   * A *new* tab every time, unless that exact file is already open in one — an
   * editor you can only have one of is a viewer. Called with no file, it opens
   * the workspace's `NOTES.md`, which is the tab most people want most often.
   */
  openEditor(workspaceId: string, file?: string): void
  closeTab(workspaceId: string, tabId: string): void
  closeOtherTabs(workspaceId: string, keepId: string): void

  splitPane(direction: 'row' | 'column'): void
  closePane(paneId: string): void
  /** Show or hide the file tree docked beside every tab in the workspace. */
  toggleFileTree(): void
  /** Add or remove a file tree pane inside the current tab only. */
  splitWithFileTree(): void

  openSettings(): void
  openInExplorer(target: string): void
  jumpToPane(workspaceId: string, paneId: string): void
}
