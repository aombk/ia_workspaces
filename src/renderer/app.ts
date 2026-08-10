import './styles.css'
import { backend } from '../backend'
import { store, paneLabel, tabLabel } from './state'
import { attachZoomWheel, TerminalManager } from './terminals'
import { FilesPane } from './filesPane'
import { loadShells } from './shells'
import { playSound } from './sound'
import { activeTheme, applyChrome, isTranslucent, setRealTransparency } from './themes'
import { checkForUpdatesAtStartup } from './updates'
import { initSidebar, renderSidebar, startRename, toggleCollapsed } from './ui/sidebar'
import { initTabstrip, renderTabstrip, startRenameTab } from './ui/tabstrip'
import {
  initSettingsPanel,
  openSettings,
  closeSettings,
  isSettingsOpen,
  refreshSettings,
} from './ui/settingsPanel'
import { initThemeEditor } from './ui/themeEditor'
import {
  initNotificationPanel,
  renderNotifications,
  togglePanel,
  closePanel,
  isPanelOpen,
  jumpToOldestUnread,
} from './ui/notificationPanel'
import { hideContextMenu, setMenuAccent } from './ui/contextMenu'
import { confirmDialog, promptDialog } from './ui/confirm'
import { showToast } from './ui/toast'
import type { WorkspaceFile } from '../shared/workspaceFile'
import type { UiActions } from './ui/actions'
import { DEFAULT_SETTINGS, isTerminalPane } from '../shared/types'
import type { NotificationRecord, PaneState, TerminalAlert } from '../shared/types'
import {
  initPalette,
  hidePalette,
  paletteIsOpen,
  showHistory,
  showVault,
  togglePalette,
} from './ui/palette'
import { isNavigation, isPrimary } from './ui/keys'
import { fallbackCwd } from '../shared/platform'
import { DomZoom } from './auxPane'
import { initUsageMonitor, renderUsage } from './ui/usageMonitor'
import { initInbox, renderInbox, toggleInbox, closeInbox } from './ui/inboxPanel'

let terminals: TerminalManager
/** Guards against re-entrant mounts while a spawn is in flight. */
let mounting = false
/** Fallback folder for workspaces created without picking one. */
// Empty rather than a platform default, because this module is evaluated before
// `entry.electron.ts` reaches its `setBackend(...)` line — asking for the
// backend here would throw before the window ever opens. `start()` fills it in
// from the host, falling back to the platform root if the host cannot say.
let homeDir = ''
/**
 * The docked file tree, one per workspace.
 *
 * Each workspace keeps its own tree so switching back finds the same folder
 * still open at the same expanded branches — a single shared tree that gets
 * re-pointed loses all of that on every switch. Trees are disposed with their
 * workspace, so the map only ever holds workspaces that exist.
 */
const dockedTrees = new Map<string, FilesPane>()

/**
 * The workspace root each docked tree was last pointed at, so a *changed* root
 * can be told apart from a tree the user has simply browsed away from.
 */
const appliedRoots = new Map<string, string>()

export async function start(): Promise<void> {
  await store.load()
  homeDir = (await backend().homeDir()) || fallbackCwd(backend().capabilities.platform)
  // Read once: the menus are built synchronously on right-click and cannot
  // await, and neither list changes while the app is running.
  await loadShells()

  terminals = new TerminalManager(document.getElementById('terminal-host')!)
  initInbox({
    jumpToPane: (workspaceId, paneId) => {
      actions.jumpToPane(workspaceId, paneId)
      closeInbox()
    },
  })

  terminals.setReaderHooks({
    openExternally: (target) => openInEditor(target),
  })

  terminals.setEditorHooks({
    openInEditor: (target) => openInEditor(target),
  })

  terminals.setSearchHooks({
    openHit: (target) => actions.openReader(target),
    openInEditor: (target) => openInEditor(target),
  })

  terminals.setPortsHooks({
    jumpToPane: (workspaceId, paneId) => actions.jumpToPane(workspaceId, paneId),
    // Typed, never submitted: ending a process is not a one-click action from a
    // list that refreshes under your cursor.
    suggest: (paneId, command) => void backend().pty.write(paneId, command),
  })

  terminals.setFilesHooks({
    openTerminalAt: (cwd) => {
      const tab = store.activeTab
      if (!tab) return
      if (store.splitPane(tab.id, 'column', 'terminal', cwd)) void remount()
    },
    sendToActiveTerminal: (text) => {
      const tab = store.activeTab
      const target = tab?.panes.find((p) => p.id === tab.activePaneId && isTerminalPane(p))
        ?? tab?.panes.find(isTerminalPane)
      if (target) void backend().pty.write(target.id, text)
    },
    onNavigate: (paneId, cwd) => {
      store.updatePaneMeta(paneId, { cwd })
      const workspace = store.workspaceOfPane(paneId)
      if (workspace) store.setTreeFolder(workspace.id, cwd)
    },
    onSelect: (paneId, path, isDir) => {
      const workspace = store.workspaceOfPane(paneId)
      if (workspace) store.setTreeSelection(workspace.id, path, isDir)
    },
    openReader: (path) => actions.openReader(path),
    openEditorTab: (path) => {
      const workspace = store.activeWorkspace
      if (workspace) actions.openEditor(workspace.id, path)
    },
    openInEditor: (path) => openInEditor(path),
  })

  terminals.setImagesHooks({
    // The gallery belongs to the workspace its own pane is in, not to whichever
    // workspace happens to be on screen — two workspaces can each hold one.
    treeFolder: () => store.treeFolder(store.activeWorkspace?.id ?? ''),
    treeSelection: () => store.treeSelection(store.activeWorkspace?.id ?? ''),
    openExternally: (path) => void backend().openInExplorer(path),
    // Always a file: this comes from the gallery's own right-click menu, and
    // everything in there is an image.
    revealInTree: (path) => {
      const workspace = store.activeWorkspace
      if (workspace) store.setTreeSelection(workspace.id, path, false)
    },
  })

  terminals.setPaneHooks({
    closePane: (paneId) => void actions.closePane(paneId),
    split: (direction) => actions.splitPane(direction),
    merge: (keepId) => {
      const tab = store.activeTab
      if (!tab) return
      terminals.closeMany(store.mergePanes(tab.id, keepId))
      void remount()
    },
    movePane: (tabId, sourceId, targetId, side) => {
      if (store.movePane(tabId, sourceId, targetId, side)) void remount()
    },
    dropTabIntoPane: (tabId, targetPaneId, side) => {
      if (store.dropTabIntoPane(tabId, targetPaneId, side)) void remount()
    },
    remount: () => void remount(),
  })

  initSidebar(actions)
  initTabstrip(actions)
  initNotificationPanel(actions)
  initThemeEditor(
    () => {
      applyTheme()
      void refreshSettings()
      render()
    },
    // Live preview: repaint only. Rebuilding the settings panel mid-drag would
    // destroy the slider or picker being dragged.
    () => applyTheme()
  )
  initSettingsPanel(() => {
    applyTheme()
    terminals.applySettings(store.settings)
    render()
  })

  // Before the first paint: every opacity decision depends on it.
  setRealTransparency(!backend().window.usesNativeOverlay)
  applyTheme()
  store.subscribe(render)
  render()

  initPalette(actions)
  initUsageMonitor()
  window.addEventListener('palette-closed', () => terminals.focusActive())

  wireContextMenuFallback()
  wireKeyboard()
  wireDockedTree()
  wireFindbar()
  wireStatusbar()
  wireWindowControls()
  wireAlerts()

  // First run, or a workspace whose tabs were all closed, should land on a
  // live shell rather than an empty pane.
  const active = store.activeWorkspace
  if (active && active.tabs.length === 0) store.addTab(active.id)

  await syncMountedTab()
  document.getElementById('status-runtime')!.textContent = backend().name
  startBranchPolling()

  // Deliberately not awaited: a slow or unreachable release feed must not hold
  // up a window the user is already looking at.
  void checkForUpdatesAtStartup()
}

/**
 * Swallows the right-click nobody else claimed.
 *
 * The UI is a web page in a webview, so anywhere without a menu of its own
 * falls through to the host's: WebView2 offers Back, Refresh, Save as, Print
 * and Inspect, which is a browser's menu appearing in the middle of a terminal.
 * Electron shows nothing there, so suppressing it also makes the three builds
 * agree.
 *
 * Bubble phase and no `stopPropagation`, so the panes, tabs, tree rows and
 * sidebar that *do* have menus still open theirs first. Text fields are the one
 * exception: their native menu is cut/copy/paste, which is worth having and is
 * not something we offer anywhere else.
 */
function wireContextMenuFallback(): void {
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('input, textarea, [contenteditable="true"]')) return
    e.preventDefault()
  })
}

function applyTheme(): void {
  const theme = activeTheme(store.settings)
  applyChrome(theme)
  terminals?.applySettings(store.settings)
  void backend().setTranslucent(isTranslucent(store.settings), theme.backdrop ?? 'none')
  // Native caption buttons sit outside the DOM and cannot inherit the variables
  // applyChrome just set, so the two colours Windows accepts are pushed across.
  backend().window.setOverlayColors(theme.chrome.bg, theme.chrome.textDim)
}

// ------------------------------------------------------------------- rendering

function render(): void {
  // Context menus are not inside anything that sets the workspace colour — the
  // root menu is a sibling of `#app` and its submenus are appended to
  // `document.body` — so it is handed over rather than inherited. Told, rather
  // than read from the store, so `contextMenu.ts` keeps importing nothing.
  setMenuAccent(store.activeWorkspace?.color ?? '')

  renderSidebar()
  renderTabstrip()
  renderNotifications()
  renderTitlebarContext()
  renderStatus()
  renderEmptyState()
  renderUsage()
  renderInbox()
  terminals?.applyAttention(store.attention)
  terminals?.applyPaneStatus()
  syncDockedTree()
  void syncMountedTab()
}

function renderTitlebarContext(): void {
  const workspace = store.activeWorkspace
  const tab = store.activeTab
  const el = document.getElementById('titlebar-context')!
  el.textContent = workspace ? (tab ? `${workspace.name} — ${tabLabel(tab)}` : workspace.name) : ''
  document.title = workspace ? `${workspace.name} — ia_workspaces` : 'ia_workspaces'
}

function renderStatus(): void {
  const pane = store.activePane
  const cwd = document.getElementById('status-cwd')!
  cwd.textContent = pane?.cwd ?? store.activeWorkspace?.cwd ?? ''
  cwd.title = cwd.textContent ? `${cwd.textContent}\nClick to open in Explorer` : ''

  const labels: Record<string, string> = {
    powershell: 'Windows PowerShell',
    pwsh: 'PowerShell 7',
    cmd: 'Command Prompt',
    wsl: 'WSL',
    custom: 'Custom shell',
  }
  document.getElementById('status-shell')!.textContent =
    labels[pane?.shell ?? store.settings.shell] ?? ''

  const tab = store.activeTab
  const panes = document.getElementById('status-panes')!
  panes.textContent = tab && tab.panes.length > 1 ? `${tab.panes.length} panes` : ''
}

function renderEmptyState(): void {
  const workspace = store.activeWorkspace
  const empty = !workspace || workspace.tabs.length === 0
  ;(document.getElementById('empty-state') as HTMLElement).hidden = !empty
}

/** Mounts the active tab's pane tree if it isn't already on screen. */
async function syncMountedTab(): Promise<void> {
  const workspace = store.activeWorkspace
  const tab = store.activeTab
  if (!workspace || !tab || mounting) return
  if (terminals.mountedTab === tab.id) {
    terminals.setActivePane(tab.activePaneId)
    return
  }
  mounting = true
  try {
    await terminals.showTab(workspace.id, tab)
    for (const pane of tab.panes) store.clearAttention(pane.id)
    updateBadge()
  } finally {
    mounting = false
  }
}


/**
 * Hands a file to the editor named in settings, or to Windows if none is.
 *
 * The editor is launched through a shell rather than a dedicated API because
 * there is no dedicated API — every runtime can open a path with its default
 * program, and none of them can run an arbitrary one. A pane is the honest
 * place for that: you see the command and you see it fail.
 */
function openInEditor(target: string): void {
  const editor = store.settings.externalEditor.trim()
  // No editor named: hand it to whatever Windows associates, which is a real
  // answer rather than a failure.
  if (!editor) {
    void backend().openInExplorer(target)
    return
  }
  void backend()
    .files.openWith(editor, target)
    .catch((err: unknown) =>
      showToast(
        'Could not open your editor',
        `${editor} — ${err instanceof Error ? err.message : String(err)}`,
        { kind: 'error' }
      )
    )
}

/**
 * Finds an already-open pane matching a predicate, so opening a panel twice
 * focuses the one you have instead of stacking copies.
 *
 * `workspaceId` narrows the search to one workspace, for the panels that are
 * per workspace — the changes and search panes answer questions about *this*
 * project, unlike the inbox and the process list which span the whole app.
 */
function findPane(
  match: (pane: PaneState) => boolean,
  workspaceId?: string
): { workspaceId: string; paneId: string } | null {
  const scope = workspaceId
    ? store.workspaces.filter((w) => w.id === workspaceId)
    : store.workspaces
  for (const workspace of scope) {
    for (const tab of workspace.tabs) {
      const pane = tab.panes.find(match)
      if (pane) return { workspaceId: workspace.id, paneId: pane.id }
    }
  }
  return null
}

function updateBadge(): void {
  const count = store.settings.notifications.flashTaskbar ? store.attention.size : 0
  void backend().setBadge(count)
}

// --------------------------------------------------------------------- actions

const actions: UiActions = {
  selectWorkspace(workspaceId) {
    store.setActiveWorkspace(workspaceId)
    const workspace = store.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    // Clicking a workspace should never land on an empty pane.
    if (!workspace.tabs.length) store.addTab(workspaceId)
    else if (!workspace.activeTabId) store.setActiveTab(workspaceId, workspace.tabs[0].id)
    void syncMountedTab()
  },

  addWorkspace(parentId) {
    // No folder prompt — a workspace is just a named group of terminals. It
    // starts in the folder set under Settings → Behaviour (your home folder if
    // that is blank); set a different one later from the right-click menu.
    const taken = new Set(store.workspaces.map((w) => w.name))
    let n = store.workspaces.length + 1
    while (taken.has(`Workspace ${n}`)) n++

    const workspace = store.addWorkspace(
      `Workspace ${n}`,
      store.settings.newWorkspaceDir.trim() || homeDir
    )
    if (parentId) store.setWorkspaceParent(workspace.id, parentId)
    store.addTab(workspace.id)
    void syncMountedTab()
    // Drop straight into rename so naming it is one action, not two.
    startRename(workspace.id)
  },

  /**
   * A worktree, and a workspace sitting in it.
   *
   * One gesture, because they are one intention: "give me somewhere to work on
   * this branch". The workspace is nested under the one it came from, so the
   * sidebar shows the relationship without needing a concept for it — and it is
   * an ordinary workspace in every other respect. Nothing about worktrees is
   * persisted; the folder simply *is* one, which `git worktree list` can always
   * be asked about later.
   */
  async newWorktree(workspaceId) {
    const workspace = store.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return

    const branch = await promptDialog({
      title: 'New worktree',
      body:
        'A branch, and a folder beside the repository to check it out into. ' +
        'An existing branch is checked out; a new name is created from where ' +
        'you are now.',
      placeholder: 'feature/thing',
      confirmLabel: 'Create',
    })
    if (!branch?.trim()) return

    const suggested = await backend().worktrees.suggest(workspace.cwd, branch.trim())
    if (!suggested) {
      showToast('Not a git repository', `${workspace.cwd} has no repository to branch from.`)
      return
    }

    const dir = await promptDialog({
      title: 'Where should it go?',
      body: 'A sibling of the repository, so nothing walks the same project twice.',
      initial: suggested,
      confirmLabel: 'Create worktree',
    })
    if (!dir?.trim()) return

    const res = await backend().worktrees.add(workspace.cwd, branch.trim(), dir.trim())
    if (!res.ok || !res.path) {
      // git's own message, which for this command is genuinely the best one
      // available — "already checked out at …" names the other worktree.
      showToast('Could not create the worktree', res.error ?? 'Unknown error')
      return
    }

    const created = store.addWorkspace(branch.trim(), res.path)
    store.setWorkspaceParent(created.id, workspaceId)
    store.addTab(created.id)
    void syncMountedTab()
    void refreshBranch(created.id, res.path)
    showToast(
      res.created ? `Branch ${branch.trim()} created` : `Checked out ${branch.trim()}`,
      res.path
    )
  },

  async changeWorkspaceFolder(workspaceId) {
    const workspace = store.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    const folder = await backend().pickFolder(workspace.cwd)
    if (!folder) return
    store.setWorkspaceCwd(workspaceId, folder)
    void refreshBranch(workspaceId, folder)
    showToast('Workspace folder changed', 'New terminals will start here.')
  },

  async removeWorkspace(workspaceId) {
    const workspace = store.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    const paneCount = workspace.tabs.reduce((n, t) => n + t.panes.length, 0)
    const ok = await confirmDialog({
      title: `Remove “${workspace.name}”?`,
      body: paneCount
        ? `This closes ${paneCount} terminal${paneCount === 1 ? '' : 's'}. The folder on disk is not touched.`
        : 'The folder on disk is not touched.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return

    // A workspace sitting in a worktree leaves one behind when it goes: the
    // checkout stays on disk and stays registered with the repository, which is
    // how `git worktree list` fills up with entries for folders nobody
    // remembers making. Asked rather than assumed — the branch may be the point
    // and the workspace merely how it was reached.
    const worktree = await backend().worktrees.at(workspace.cwd)
    if (worktree) {
      const alsoRemove = await confirmDialog({
        title: `Also remove the worktree?`,
        body:
          `${workspace.cwd} is a git worktree${worktree.branch ? ` on ${worktree.branch}` : ''}. ` +
          'Removing it deletes the folder and unregisters it; the branch itself stays. ' +
          'Keeping it leaves the folder exactly as it is.',
        confirmLabel: 'Remove the worktree too',
        danger: true,
      })
      if (alsoRemove) {
        const res = await backend().worktrees.remove(workspace.cwd, worktree.path, false)
        // Refused because the checkout is dirty. That refusal is the feature —
        // it is the only thing standing between "close a tab" and "lose an
        // afternoon" — so it is reported and the folder is left alone.
        if (!res.ok) showToast('Worktree kept', res.error ?? 'git would not remove it')
        else showToast('Worktree removed', worktree.path)
      }
    }

    disposeDockedTree(workspaceId)
    terminals.closeMany(store.removeWorkspace(workspaceId))
    void syncMountedTab()
  },

  selectTab(workspaceId, tabId) {
    store.setActiveTab(workspaceId, tabId)
    void syncMountedTab()
  },

  newTab(workspaceId, cwd) {
    store.addTab(workspaceId, cwd)
    void syncMountedTab()
  },

  newFileTab(workspaceId, cwd) {
    const workspace = store.workspaces.find((w) => w.id === workspaceId)
    store.addTab(workspaceId, cwd || store.activePane?.cwd || workspace?.cwd, 'files')
    void syncMountedTab()
  },

  saveWorkspace(workspaceId) {
    const workspace = store.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    void writeWorkspaceFile(
      store.exportWorkspace(workspaceId),
      `Save "${workspace.name}"`,
      fileNameFor(workspace.name)
    )
  },

  saveAllWorkspaces() {
    void writeWorkspaceFile(store.exportAll(), 'Save all workspaces', 'workspaces.iaws.json')
  },

  loadWorkspaces() {
    void readWorkspaceFile()
  },

  reopenPaneAs(paneId, shell, target) {
    const workspace = store.workspaceOfPane(paneId)
    if (!workspace) return
    // The store records the choice and moves the folder if the world changed;
    // the manager is what actually ends the shell and starts the new one.
    store.setPaneShell(paneId, shell, target)
    void terminals.restartPane(workspace.id, paneId)
  },

  async reopenPaneAsSshHost(paneId) {
    // Anything `ssh` would take on its own command line: an alias from the
    // config, a bare hostname, or `user@host`. Not validated here, because the
    // list of things ssh accepts is ssh's to know — a wrong one fails visibly
    // in the pane, which is where the error belongs.
    const host = await promptDialog({
      title: 'Open an SSH pane',
      body: 'Host to connect to — an alias from ~/.ssh/config, a hostname, or user@host.',
      placeholder: 'user@example.com',
    })
    if (!host) return
    this.reopenPaneAs(paneId, 'ssh', { sshHost: host })
  },

  openBrowser(workspaceId) {
    // Deliberately not deduplicated the way the ports and search panes are.
    // Those answer one question about the whole app, so a second one is a
    // duplicate; two browser panes on two different pages is the normal way to
    // use a browser.
    if (!backend().capabilities.browser) return
    store.addTab(workspaceId, undefined, 'browser')
    void syncMountedTab()
  },

  openPorts(workspaceId) {
    // One is enough — it lists every pane in the app, like the inbox.
    const existing = findPane((p) => p.kind === 'ports')
    if (existing) {
      actions.jumpToPane(existing.workspaceId, existing.paneId)
      return
    }
    store.addTab(workspaceId, undefined, 'ports')
    void syncMountedTab()
  },

  openSearch(workspaceId, cwd) {
    // A folder given explicitly opens a *new* pane rather than reusing one: the
    // caller is asking to search somewhere specific, and quietly jumping to a
    // pane pointed at the workspace instead would look like the request was
    // ignored.
    if (!cwd) {
      const existing = findPane((p) => p.kind === 'search', workspaceId)
      if (existing) {
        actions.jumpToPane(existing.workspaceId, existing.paneId)
        return
      }
    }
    store.addTab(workspaceId, cwd, 'search')
    void syncMountedTab()
  },

  openImages(workspaceId) {
    const existing = findPane((p) => p.kind === 'images', workspaceId)
    if (existing) {
      actions.jumpToPane(existing.workspaceId, existing.paneId)
      return
    }
    store.addTab(workspaceId, undefined, 'images')
    void syncMountedTab()
  },

  openDiff(workspaceId) {
    const existing = findPane((p) => p.kind === 'diff', workspaceId)
    if (existing) {
      actions.jumpToPane(existing.workspaceId, existing.paneId)
      return
    }
    store.addTab(workspaceId, undefined, 'diff')
    void syncMountedTab()
  },

  /**
   * Compares two files, asking for whichever it was not given.
   *
   * Unlike the other openers this never reuses an existing pane: "Changes" is
   * one question about one workspace, but a compare is about a specific pair,
   * and folding a second comparison into the first would throw away the one you
   * were looking at. Each pair gets its own tab.
   */
  openCompare(workspaceId, left, right) {
    // Empty is a working state: the pane shows two drop targets and waits.
    // Paths only arrive here when something already knows them, which is what a
    // future "Compare with…" on a file would pass — and, like the editor above,
    // they have to be on the pane before it is built to be of any use to it.
    store.addTabWith(
      workspaceId,
      'compare',
      left || right ? { compareLeft: left ?? '', compareRight: right ?? '' } : {}
    )
    void syncMountedTab()
  },

  openEditor(workspaceId, file) {
    // The same file twice is two views of one thing that can disagree about
    // what is in it, so an already-open file wins over a new tab. Two *empty*
    // editor tabs are fine — they are about to be different files.
    if (file) {
      const open = findPane((p) => p.kind === 'editor' && p.file === file, workspaceId)
      if (open) {
        actions.jumpToPane(open.workspaceId, open.paneId)
        return
      }
    }
    // The file is on the pane from birth. Set a line later it would be set into
    // an editor that had already been built and had already resolved its own
    // path.
    //
    // With no file, the empty string is recorded *explicitly*, and the
    // difference from leaving the field absent is the whole point: absent means
    // "a pane saved before this editor could open anything but the project
    // note", and still resolves to NOTES.md so those tabs come back as they
    // were. Empty means "new, untitled, nowhere to write until you say where".
    // A new tab landing on NOTES.md was this distinction not being drawn.
    store.addTabWith(workspaceId, 'editor', { file: file ?? '' })
    void syncMountedTab()
  },

  openReader(path) {
    const tab = store.activeTab
    if (!tab) return
    // Beside what you were looking at, not instead of it: you opened this from
    // a tree that is probably in the same tab, and replacing it would take away
    // the thing you were reading from.
    const pane = store.splitPane(tab.id, 'row', 'reader')
    if (!pane) return
    store.setPaneFile(pane.id, path)
    void remount()
  },

  openInbox() {
    toggleInbox()
  },

  async closeTab(workspaceId, tabId) {
    const tab = store.tab(tabId)
    if (!tab) return
    if (store.settings.confirmCloseRunning && (await terminals.tabIsBusy(tab))) {
      const ok = await confirmDialog({
        title: 'Close this terminal?',
        body: `“${tabLabel(tab)}” is still running a command. Closing ends it.`,
        confirmLabel: 'Close anyway',
        danger: true,
      })
      if (!ok) return
    }
    terminals.closeMany(store.removeTab(workspaceId, tabId))
    void syncMountedTab()
  },

  closeOtherTabs(workspaceId, keepId) {
    const workspace = store.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    for (const tab of [...workspace.tabs]) {
      if (tab.id === keepId) continue
      terminals.closeMany(store.removeTab(workspaceId, tab.id))
    }
    store.setActiveTab(workspaceId, keepId)
    void syncMountedTab()
  },

  splitPane(direction) {
    const tab = store.activeTab
    if (!tab) return
    if (!store.splitPane(tab.id, direction)) return
    // The layout changed, so the tab must be rebuilt rather than just refocused.
    void remount()
  },

  toggleFileTree() {
    store.setTree(!store.treeVisible)
  },

  splitWithFileTree() {
    const tab = store.activeTab
    const workspace = store.activeWorkspace
    if (!tab || !workspace) return

    const existing = store.filesPaneOf(tab)
    if (existing) {
      store.closePane(existing.id)
      terminals.close(existing.id)
      void remount()
      return
    }

    // Opens beside the active pane, rooted at whatever that pane is showing.
    const from = tab.panes.find((p) => p.id === tab.activePaneId)
    const pane = store.splitPane(tab.id, 'row', 'files', from?.cwd || workspace.cwd)
    if (pane) void remount()
  },

  async closePane(paneId) {
    if (store.settings.confirmCloseRunning && (await terminals.isBusy(paneId))) {
      const pane = store.pane(paneId)
      const ok = await confirmDialog({
        title: 'Close this pane?',
        body: `“${pane ? paneLabel(pane) : 'This pane'}” is still running a command. Closing ends it.`,
        confirmLabel: 'Close anyway',
        danger: true,
      })
      if (!ok) return
    }
    const { tabClosed } = store.closePane(paneId)
    terminals.close(paneId)
    if (!tabClosed) await remount()
    else void syncMountedTab()
  },

  openSettings() {
    void openSettings()
  },

  openInExplorer(target) {
    if (target) void backend().openInExplorer(target)
  },

  jumpToPane(workspaceId, paneId) {
    const tab = store.tabOfPane(paneId)
    store.setActiveWorkspace(workspaceId)
    if (tab) {
      store.setActiveTab(workspaceId, tab.id)
      store.setActivePane(tab.id, paneId)
    }
    store.clearAttention(paneId)
    store.markPaneNotificationsRead(paneId)
    void syncMountedTab()
  },
}

/** Forces the active tab to re-mount, e.g. after the pane tree changed. */
/**
 * A default file name from a workspace name.
 *
 * The name is the user's and can contain anything; this ends up as a path, so
 * everything Windows refuses in one is folded to a dash rather than trusted.
 */
function fileNameFor(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim()
  return `${safe || 'workspace'}.iaws.json`
}

/**
 * Asks where to put a workspace document, and writes it.
 *
 * Two dots in the extension, `.iaws.json`: it is JSON and every editor should
 * treat it as such, while still saying at a glance what kind of JSON it is.
 */
async function writeWorkspaceFile(
  doc: WorkspaceFile | null,
  title: string,
  defaultName: string
): Promise<void> {
  if (!doc) {
    showToast('Nothing to save', 'There are no workspaces open.')
    return
  }
  const path = await backend().pickSaveFile({ title, defaultName })
  if (!path) return

  try {
    await backend().files.writeText(path, JSON.stringify(doc, null, 2) + '\n')
    const count = doc.workspaces.length
    showToast(
      'Saved',
      `${count} workspace${count === 1 ? '' : 's'} written to ${path.split(/[\\/]/).pop()}`
    )
  } catch (err) {
    showToast('Could not save', err instanceof Error ? err.message : String(err))
  }
}

/** Asks for a workspace file and adds what it holds. */
async function readWorkspaceFile(): Promise<void> {
  const path = await backend().pickOpenFile({ title: 'Load workspaces' })
  if (!path) return

  let raw: unknown
  try {
    raw = JSON.parse(await backend().readText(path))
  } catch (err) {
    showToast('Could not read that file', err instanceof Error ? err.message : String(err))
    return
  }

  const result = store.importWorkspaceFile(raw)
  if ('error' in result) {
    showToast('Could not load that file', result.error)
    return
  }

  // Anything the file needed adjusting for is said out loud — a workspace that
  // quietly arrived under a different name is worse than being told.
  showToast(
    `Loaded ${result.added} workspace${result.added === 1 ? '' : 's'}`,
    result.notes.length ? result.notes.join(' ') : path.split(/[\\/]/).pop() || ''
  )
  void syncMountedTab()
}

async function remount(): Promise<void> {
  const workspace = store.activeWorkspace
  const tab = store.activeTab
  if (!workspace || !tab) return
  mounting = true
  try {
    await terminals.showTab(workspace.id, tab)
  } finally {
    mounting = false
  }
}

// ----------------------------------------------------------------- docked tree

function syncDockedTree(): void {
  const panel = document.getElementById('tree-panel') as HTMLElement
  const resizer = document.getElementById('tree-resizer') as HTMLElement
  const workspace = store.activeWorkspace
  const visible = store.treeVisible && Boolean(workspace)

  panel.hidden = !visible
  resizer.hidden = !visible
  panel.style.width = `${store.treeWidth}px`
  if (!visible || !workspace) return

  const workspaceId = workspace.id
  let tree = dockedTrees.get(workspaceId)

  if (!tree) {
    appliedRoots.set(workspaceId, workspace.cwd)
    tree = new FilesPane(`dock:${workspaceId}`, workspace.treeCwd || workspace.cwd, {
      // From a docked tree a new terminal belongs in its own tab, not squeezed
      // into whatever split happens to be open.
      openTerminalAt: (cwd) => actions.newTab(workspaceId, cwd),
      sendToActiveTerminal: (text) => {
        const tab = store.activeTab
        const target =
          tab?.panes.find((p) => p.id === tab.activePaneId && isTerminalPane(p)) ??
          tab?.panes.find(isTerminalPane)
        if (target) void backend().pty.write(target.id, text)
      },
      // Browsing is just browsing: the tree remembers where it is, and the
      // workspace root stays where it was put. Moving the root is a deliberate
      // act — "Change folder…" on the workspace — not a side effect of
      // double-clicking into a subfolder to read something.
      onNavigate: (_paneId, cwd) => {
        store.setTreeCwd(workspaceId, cwd)
        store.setTreeFolder(workspaceId, cwd)
      },
      onSelect: (_paneId, path, isDir) => store.setTreeSelection(workspaceId, path, isDir),
      // Renaming the folder the tree is standing in is a move, not a change of
      // root, so the workspace follows it rather than being left pointing at a
      // path that no longer exists.
      onRootRenamed: (from, to) => {
        const current = store.workspaces.find((w) => w.id === workspaceId)
        if (!current || current.cwd !== from) return
        appliedRoots.set(workspaceId, to)
        store.setWorkspaceCwd(workspaceId, to)
        void refreshBranch(workspaceId, to)
      },
      // A root that has just been deleted is not a root the workspace can keep:
      // every terminal opened from it would fail to start.
      onRootDeleted: (path, parent) => {
        const current = store.workspaces.find((w) => w.id === workspaceId)
        if (!current || !isAtOrInside(current.cwd, path)) return
        appliedRoots.set(workspaceId, parent)
        store.setWorkspaceCwd(workspaceId, parent)
        void refreshBranch(workspaceId, parent)
      },
      // The other way to move the root, for the folder already in front of you.
      // `appliedRoots` is deliberately left alone: the next render sees the
      // root has moved and walks the tree to it, exactly as "Change folder…"
      // does.
      setWorkspaceRoot: (folder) => {
        store.setWorkspaceCwd(workspaceId, folder)
        void refreshBranch(workspaceId, folder)
        showToast('Workspace folder changed', folder)
      },
      workspaceRoot: () => store.workspaces.find((w) => w.id === workspaceId)?.cwd ?? '',
      openReader: (path) => actions.openReader(path),
      openEditorTab: (path) => actions.openEditor(workspaceId, path),
      openInEditor: (path) => openInEditor(path),
    })
    // The docked tree is built here rather than by `ensureAux`, so it does not
    // get the zoom that every tab pane gets for free. Given one explicitly, or
    // it would be the single surface in the app where Ctrl+scroll did nothing.
    attachZoomWheel(tree.element, new DomZoom(tree.element))
    dockedTrees.set(workspaceId, tree)
  }

  // A moved root takes the tree back to it — "Change folder…", or switching the
  // workspace to WSL. Compared against the root we last applied rather than
  // against where the tree happens to be, so browsing away from the root is not
  // undone on the next render.
  if (appliedRoots.get(workspaceId) !== workspace.cwd) {
    appliedRoots.set(workspaceId, workspace.cwd)
    tree.navigate(workspace.cwd)
  }

  // Swap which tree is on screen; the others stay built, holding their state.
  if (panel.firstElementChild !== tree.element) panel.replaceChildren(tree.element)
}

/** True when `path` is `folder` itself or something beneath it. */
function isAtOrInside(path: string, folder: string): boolean {
  const at = path.toLowerCase().replace(/\\+$/, '')
  const of = folder.toLowerCase().replace(/\\+$/, '')
  return at === of || at.startsWith(`${of}\\`)
}

/** A workspace's tree goes when the workspace does. */
function disposeDockedTree(workspaceId: string): void {
  dockedTrees.get(workspaceId)?.dispose()
  dockedTrees.delete(workspaceId)
  appliedRoots.delete(workspaceId)
}

function wireDockedTree(): void {
  const panel = document.getElementById('tree-panel') as HTMLElement
  const resizer = document.getElementById('tree-resizer') as HTMLElement

  resizer.addEventListener('mousedown', (down) => {
    down.preventDefault()
    resizer.classList.add('dragging')
    const startX = down.clientX
    const startWidth = panel.offsetWidth

    const onMove = (move: MouseEvent) => {
      panel.style.width = `${Math.max(160, Math.min(560, startWidth + move.clientX - startX))}px`
    }
    const onUp = () => {
      resizer.classList.remove('dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      store.setTree(true, panel.offsetWidth)
      terminals.fitAll()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })
}

// ---------------------------------------------------------------------- alerts

function wireAlerts(): void {
  backend().on.alert(handleAlert)

  backend().on.paneStatus(({ paneId, activity, agent }) => {
    if (activity) store.setPaneActivity(paneId, activity)
    if (agent) store.setPaneAgent(paneId, agent)
  })

  // Explorer's "Open in ia_workspaces" on a folder. An existing workspace for
  // that folder is reused — opening the same project twice should not leave you
  // with two of it.
  backend().on.openFolder((folder) => {
    const existing = store.workspaces.find((w) => w.cwd.toLowerCase() === folder.toLowerCase())
    if (existing) {
      actions.selectWorkspace(existing.id)
      return
    }
    const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder
    const workspace = store.addWorkspace(name, folder)
    store.addTab(workspace.id)
    void syncMountedTab()
    void refreshBranch(workspace.id, folder)
  })

  backend().on.focusTerminal(({ workspaceId, paneId }) => {
    actions.jumpToPane(workspaceId, paneId)
  })

  backend().on.windowFocus((focused) => {
    if (!focused) return
    // Coming back to the window clears the pane you land on, matching the
    // "auto-dismiss what you're actually looking at" rule.
    const paneId = store.activeTab?.activePaneId
    if (paneId) {
      store.clearAttention(paneId)
      store.markPaneNotificationsRead(paneId)
    }
    updateBadge()
    terminals.focusActive()
  })
}

function handleAlert(alert: TerminalAlert): void {
  const n = store.settings.notifications
  if (!n.enabled) return

  const allowed: Record<TerminalAlert['trigger'], boolean> = {
    bell: n.onBell,
    'command-finished': n.onCommandFinished,
    idle: n.onIdle,
    exit: n.onExit,
    osc: true, // an explicit request from the program itself
    cli: true, // an explicit request from `iaw notify`
    // An agent that said it is waiting on a human. This is the one alert with
    // no self-resolving path, so it is not filterable.
    blocked: true,
  }
  if (!allowed[alert.trigger]) return

  // Don't interrupt for the pane you are already watching — except when an
  // agent is blocked, which stays until answered whether you are looking or not.
  if (n.onlyWhenUnattended && alert.trigger !== 'blocked' && store.isAttended(alert.paneId)) return

  const workspace = store.workspaces.find((w) => w.id === alert.workspaceId)
  const pane = store.pane(alert.paneId)
  const record: NotificationRecord = {
    ...alert,
    id: crypto.randomUUID(),
    at: Date.now(),
    read: false,
    where: [workspace?.name, pane ? paneLabel(pane) : null].filter(Boolean).join(' · '),
  }

  store.markAttention(alert.paneId)
  store.recordNotification(record)
  updateBadge()

  if (n.sound) playSound(n.soundName, n.volume)

  // A desktop toast for a window you're already looking at is just noise —
  // use the in-app toast when we have focus, the OS one when we don't.
  if (document.hasFocus()) {
    showToast(alert.title, alert.body, {
      kind:
        alert.trigger === 'bell' || alert.trigger === 'idle' || alert.trigger === 'blocked'
          ? 'warn'
          : 'info',
      onClick: () => actions.jumpToPane(alert.workspaceId, alert.paneId),
    })
  } else {
    void backend().notify({
      title: alert.title,
      body: alert.body,
      paneId: alert.paneId,
      workspaceId: alert.workspaceId,
    })
  }
}

// ------------------------------------------------------------------ git branch

/**
 * Branch is read from `.git/HEAD` rather than by spawning git, so polling all
 * workspaces every few seconds costs almost nothing.
 */
function startBranchPolling(): void {
  const tick = () => {
    if (!store.settings.showGitBranch) return
    for (const workspace of store.workspaces) void refreshBranch(workspace.id, workspace.cwd)
  }
  tick()
  window.setInterval(tick, 5000)
}

async function refreshBranch(workspaceId: string, cwd: string): Promise<void> {
  try {
    store.setWorkspaceBranch(workspaceId, await backend().gitBranch(cwd))
  } catch {
    /* not a repo, or the folder went away */
  }
}

// ---------------------------------------------------------------------- keyboard

function isTypingInField(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
    // xterm's hidden textarea is where terminal keystrokes land; it must not
    // count as "typing in a field" or none of our shortcuts would work.
    return !el.classList.contains('xterm-helper-textarea')
  }
  return false
}

function wireKeyboard(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      // The palette owns the keyboard while it is up. Its own handler covers
      // Escape, the arrows and Enter; everything else would otherwise act on
      // the app behind it — Ctrl+T opening a tab you cannot see, and so on.
      if (paletteIsOpen()) {
        if (e.key === 'Escape') {
          e.preventDefault()
          hidePalette()
          return
        }
        const ctrlP = isPrimary(e) && e.key.toLowerCase() === 'p'
        if (ctrlP) {
          e.preventDefault()
          hidePalette()
        }
        return
      }

      if (e.key === 'Escape') {
        hideContextMenu()
        if (!(document.getElementById('findbar') as HTMLElement).hidden) {
          closeFindbar()
          e.preventDefault()
          return
        }
        if (!(document.getElementById('inbox-panel') as HTMLElement).hidden) {
          closeInbox()
          e.preventDefault()
          return
        }
        if (isPanelOpen()) {
          closePanel()
          e.preventDefault()
          return
        }
        if (isSettingsOpen()) {
          closeSettings()
          e.preventDefault()
        }
        return
      }

      if (isTypingInField()) return

      const workspace = store.activeWorkspace
      const tab = store.activeTab
      // Every shortcut below is gated on this, so the platform's modifier is
      // chosen once: Command on a Mac, Control everywhere else.
      const ctrl = isPrimary(e) && !e.altKey
      const key = e.key.toLowerCase()

      // Splits
      if (ctrl && e.key === '\\') {
        e.preventDefault()
        actions.splitPane(e.shiftKey ? 'column' : 'row')
        return
      }
      // Alt+arrows move between panes — plus Command on a Mac, where bare
      // Option+arrow is the shell's word-jump and not ours to take.
      if (isNavigation(e) && tab && tab.panes.length > 1) {
        const map: Record<string, 'left' | 'right' | 'up' | 'down'> = {
          ArrowLeft: 'left',
          ArrowRight: 'right',
          ArrowUp: 'up',
          ArrowDown: 'down',
        }
        const direction = map[e.key]
        if (direction) {
          e.preventDefault()
          const next = terminals.paneInDirection(tab.activePaneId, direction)
          if (next) store.setActivePane(tab.id, next)
          return
        }
      }

      if (ctrl && e.shiftKey && key === 'n') {
        e.preventDefault()
        actions.addWorkspace()
        return
      }
      if (ctrl && !e.shiftKey && key === 't') {
        e.preventDefault()
        if (workspace) actions.newTab(workspace.id)
        return
      }
      if (ctrl && e.shiftKey && key === 'w') {
        e.preventDefault()
        if (tab) void actions.closePane(tab.activePaneId)
        return
      }
      if (ctrl && !e.shiftKey && key === 'w') {
        e.preventDefault()
        // With splits open, Ctrl+W closes the pane; otherwise the whole tab.
        if (tab && tab.panes.length > 1) void actions.closePane(tab.activePaneId)
        else if (workspace?.activeTabId) void actions.closeTab(workspace.id, workspace.activeTabId)
        return
      }
      if (ctrl && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault()
        cycleTab(e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1)
        return
      }
      if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const target = workspace?.tabs[Number(e.key) - 1]
        if (workspace && target) actions.selectTab(workspace.id, target.id)
        return
      }
      if (isNavigation(e) && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const target = store.workspaces[Number(e.key) - 1]
        if (target) actions.selectWorkspace(target.id)
        return
      }
      if (ctrl && !e.shiftKey && key === 'f') {
        e.preventDefault()
        openFindbar()
        return
      }
      if (ctrl && !e.shiftKey && key === 'k') {
        e.preventDefault()
        terminals.clearScrollback()
        return
      }
      // Ctrl+P — go anywhere, run anything. Ctrl+Shift+P too, for the muscle
      // memory that expects the "commands only" half of an editor's pair; there
      // is only one list here, so both open it.
      if (ctrl && key === 'p') {
        e.preventDefault()
        togglePalette()
        return
      }
      // Ctrl+Alt+H — everything you have typed before, in the same box. Alt
      // rather than Shift because Ctrl+Shift+H is find-and-replace in every
      // editor the rest of these shortcuts borrow from.
      if (ctrl && e.altKey && key === 'h') {
        e.preventDefault()
        void showHistory()
        return
      }
      // Ctrl+Alt+V — transcripts of panes you have closed. Picking one opens it
      // in the editor; the last entry searches the whole folder. Alt rather
      // than Shift because Ctrl+Shift+V is paste in every Linux terminal, and
      // claiming it would break the reflex of anyone who has one.
      if (ctrl && e.altKey && key === 'v') {
        e.preventDefault()
        void showVault()
        return
      }
      // Ctrl+Shift+E — file tree beside the current panes (editor convention).
      if (ctrl && e.shiftKey && key === 'e') {
        e.preventDefault()
        actions.toggleFileTree()
        return
      }
      // Ctrl+Shift+F — a whole tab that is a file tree.
      if (ctrl && e.shiftKey && key === 'f') {
        e.preventDefault()
        if (workspace) actions.newFileTab(workspace.id)
        return
      }
      // Ctrl+Shift+A — everything waiting on you, wherever it is.
      if (ctrl && e.shiftKey && key === 'a') {
        e.preventDefault()
        actions.openInbox('')
        return
      }
      // Ctrl+Shift+S — find a string under this workspace's folder.
      if (ctrl && e.shiftKey && key === 's') {
        e.preventDefault()
        if (workspace) actions.openSearch(workspace.id)
        return
      }
      // Ctrl+Shift+G — the images in whatever the file tree is showing. G for
      // gallery: Ctrl+Shift+I is the notification panel's neighbour and every
      // browser's devtools, and Ctrl+Shift+M is already taken.
      if (ctrl && e.shiftKey && key === 'g') {
        e.preventDefault()
        if (workspace) actions.openImages(workspace.id)
        return
      }
      // Ctrl+Shift+D — what has changed since the last commit.
      if (ctrl && e.shiftKey && key === 'd') {
        e.preventDefault()
        if (workspace) actions.openDiff(workspace.id)
        return
      }
      // Ctrl+Shift+B — a web page beside the terminal building it.
      if (ctrl && e.shiftKey && key === 'b') {
        e.preventDefault()
        if (workspace) actions.openBrowser(workspace.id)
        return
      }
      if (ctrl && !e.shiftKey && key === 'b') {
        e.preventDefault()
        toggleCollapsed()
        return
      }
      if (ctrl && !e.shiftKey && key === 'i') {
        e.preventDefault()
        togglePanel()
        return
      }
      if (ctrl && e.shiftKey && key === 'u') {
        e.preventDefault()
        if (!jumpToOldestUnread()) showToast('Nothing unread', '')
        return
      }
      if (ctrl && e.key === ',') {
        e.preventDefault()
        void openSettings()
        return
      }
      // Zoom goes to whatever pane is focused. A browser zooms its page, an
      // editor or a tree or a diff scales its layout, and a terminal — which
      // has no per-pane zoom on purpose, since one font size for every shell is
      // the point — falls through to the setting.
      if (ctrl && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        const zoom = terminals.activeZoom()
        if (zoom) zoom.step('in')
        else terminals.adjustFontSize(1)
        return
      }
      if (ctrl && e.key === '-') {
        e.preventDefault()
        const zoom = terminals.activeZoom()
        if (zoom) zoom.step('out')
        else terminals.adjustFontSize(-1)
        return
      }
      if (ctrl && e.key === '0') {
        e.preventDefault()
        const zoom = terminals.activeZoom()
        if (zoom) {
          zoom.reset()
          return
        }
        store.updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize })
        terminals.applySettings(store.settings)
        return
      }
      if (e.key === 'F2') {
        e.preventDefault()
        if (e.shiftKey) {
          if (workspace) startRename(workspace.id)
        } else if (tab && tab.panes.length > 1) {
          // With a split open, the pane is the thing you meant to rename.
          terminals.beginRenamePane(tab.activePaneId)
        } else if (tab) {
          startRenameTab(tab.id)
        }
      }
    },
    true // capture, so we win before xterm sees the key
  )
}

function cycleTab(direction: 1 | -1): void {
  const workspace = store.activeWorkspace
  if (!workspace || workspace.tabs.length < 2) return
  const current = workspace.tabs.findIndex((t) => t.id === workspace.activeTabId)
  const next = (current + direction + workspace.tabs.length) % workspace.tabs.length
  actions.selectTab(workspace.id, workspace.tabs[next].id)
}

// ----------------------------------------------------------------------- findbar

function openFindbar(): void {
  ;(document.getElementById('findbar') as HTMLElement).hidden = false
  const input = document.getElementById('find-input') as HTMLInputElement
  input.focus()
  input.select()
}

function closeFindbar(): void {
  ;(document.getElementById('findbar') as HTMLElement).hidden = true
  terminals.clearSearch()
  terminals.focusActive()
}

function wireFindbar(): void {
  const input = document.getElementById('find-input') as HTMLInputElement

  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      if (e.shiftKey) terminals.findPrevious(input.value)
      else terminals.findNext(input.value)
    } else if (e.key === 'Escape') {
      closeFindbar()
    }
  })
  input.addEventListener('input', () => {
    if (input.value) terminals.findNext(input.value)
    else terminals.clearSearch()
  })

  document.getElementById('find-next')!.addEventListener('click', () => terminals.findNext(input.value))
  document.getElementById('find-prev')!.addEventListener('click', () => terminals.findPrevious(input.value))
  document.getElementById('find-close')!.addEventListener('click', closeFindbar)
}

// --------------------------------------------------------------------- statusbar

function wireStatusbar(): void {
  document.getElementById('status-cwd')!.addEventListener('click', () => {
    const target = store.activePane?.cwd ?? store.activeWorkspace?.cwd
    if (target) void backend().openInExplorer(target)
  })
}

// ----------------------------------------------------------------- window chrome

function wireWindowControls(): void {
  const controls = document.getElementById('window-controls') as HTMLElement
  if (backend().window.usesNativeOverlay) {
    // The OS paints its buttons *over* the page rather than in it, so the bar
    // has to be told to stop short of them — see `.native-caption` in
    // styles.css. Without it the notification bell ends up underneath.
    document.documentElement.classList.add('native-caption')
    controls.hidden = true
    return
  }
  controls.hidden = false
  controls.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest('button')?.dataset.win
    if (action === 'minimize') backend().window.minimize()
    else if (action === 'maximize') backend().window.maximizeToggle()
    else if (action === 'close') backend().window.close()
  })
}
