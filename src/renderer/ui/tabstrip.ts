import { backend } from '../../backend'
import { shellFor, store, tabLabel } from '../state'
import { showContextMenu, type MenuEntry } from './contextMenu'
import { availableShells, shellLabel, sshHosts, sshMenuLabel, wslDistros } from '../shells'
import { EDITOR_MODES, EDITOR_MODE_LABELS, isTerminalPane } from '../../shared/types'
import { modeForFile } from '../../shared/editorModes'
import type { PaneState } from '../../shared/types'
import { attachInlineEditor } from './editing'
import { beginDrag, draggingPane, draggingTab, endDrag } from './dragState'
import { FILE_DRAG } from '../filesPane'
import type { UiActions } from './actions'

let actions: UiActions
let renaming: string | null = null

export function initTabstrip(a: UiActions): void {
  actions = a
  wireStripScrolling(document.getElementById('tabstrip')!)
}

/**
 * The wheel scrolls the strip sideways.
 *
 * The strip has always scrolled — `overflow-x: auto`, with the scrollbar hidden
 * because a bar under the tabs would eat into a row that is 32 pixels tall — and
 * that left keyboard tab-switching, which scrolls the active tab into view, as
 * the only way to reach a tab past the right edge. A wheel over a strip of tabs
 * is the obvious gesture and it did nothing.
 *
 * Attached once, here, rather than in `renderTabstrip`: that runs on every app
 * render and replaces the strip's children, so wiring it there would add a
 * listener per render for the life of the window.
 */
function wireStripScrolling(strip: HTMLElement): void {
  strip.addEventListener(
    'wheel',
    (e) => {
      // Ctrl+wheel is zoom, everywhere in the app.
      if (e.ctrlKey || e.metaKey) return
      if (strip.scrollWidth <= strip.clientWidth) return
      // Either axis moves the strip: a trackpad swipe already arrives as
      // `deltaX`, a mouse wheel and Shift+wheel as `deltaY`, and a strip that
      // only scrolls sideways has nothing else either could mean.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (!delta) return
      e.preventDefault()
      // `deltaMode` 1 is lines, which is what a mouse wheel reports on Windows.
      strip.scrollLeft += delta * (e.deltaMode === 1 ? 16 : 1)
    },
    { passive: false }
  )
}

export function startRenameTab(tabId: string): void {
  renaming = tabId
  renderTabstrip()
}

export function renderTabstrip(): void {
  const strip = document.getElementById('tabstrip')!
  const workspace = store.activeWorkspace
  strip.replaceChildren()
  if (!workspace) return

  strip.style.setProperty('--workspace-color', workspace.color)

  workspace.tabs.forEach((tab, index) => {
    const isActive = tab.id === workspace.activeTabId
    // Waiting on a human outranks unseen activity, and unlike it does not go
    // away when you look — only the agent saying it is unblocked clears this.
    const needsInput = store.tabNeedsInput(tab)
    const el = document.createElement('div')
    el.className = 'tab' + (isActive ? ' active' : '') + (needsInput ? ' needs-input' : '')
    el.dataset.tabId = tab.id
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(isActive))
    el.title = `${tabLabel(tab)}\n${tab.panes.map((p) => p.cwd).join('\n')}`
    el.draggable = renaming !== tab.id

    if (needsInput || store.tabHasAttention(tab)) {
      const dot = document.createElement('span')
      dot.className = needsInput ? 'attention-dot attention-dot--input' : 'attention-dot'
      dot.title = needsInput ? 'Waiting for your answer' : 'Needs attention'
      el.appendChild(dot)
    }

    if (renaming === tab.id) {
      const input = document.createElement('input')
      input.className = 'tab-title-input'
      input.value = tabLabel(tab)
      input.spellcheck = false
      el.appendChild(input)

      attachInlineEditor(input, {
        onCommit: (value) => {
          renaming = null
          store.renameTab(tab.id, value)
        },
        onCancel: () => {
          renaming = null
          renderTabstrip()
        },
      })
    } else {
      const title = document.createElement('span')
      title.className = 'tab-title'
      title.textContent = tabLabel(tab)
      el.appendChild(title)

      const close = document.createElement('button')
      close.className = 'tab-close'
      close.textContent = '✕'
      close.title = 'Close terminal (Ctrl+W)'
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        actions.closeTab(workspace.id, tab.id)
      })
      el.appendChild(close)
    }

    el.addEventListener('click', () => {
      if (renaming === tab.id) return
      actions.selectTab(workspace.id, tab.id)
    })
    el.addEventListener('dblclick', (e) => {
      e.preventDefault()
      startRenameTab(tab.id)
    })
    // Middle-click closes, matching every other tabbed app.
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        actions.closeTab(workspace.id, tab.id)
      }
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openTabMenu(e.clientX, e.clientY, workspace.id, tab.id)
    })

    wireDragAndDrop(el, index, workspace.id)
    strip.appendChild(el)
  })

  const add = document.createElement('button')
  add.className = 'new-tab'
  add.textContent = '+'
  add.title = 'New terminal (Ctrl+T) — right-click for more'
  add.addEventListener('click', () => actions.newTab(workspace.id))
  // Right-click offers the other tab kinds without adding a second button.
  add.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    openNewTabMenu(e.clientX, e.clientY, workspace.id)
  })
  strip.appendChild(add)

  // The empty strip area is the other obvious place to reach for "new tab".
  strip.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('.tab, .new-tab')) return
    e.preventDefault()
    openNewTabMenu(e.clientX, e.clientY, workspace.id)
  })

  // Dropping a pane on the empty run of strip past the last tab puts it at the
  // end. Aiming at a tab is the precise gesture; this is the forgiving one, and
  // without it a throw towards the strip lands on nothing.
  strip.addEventListener('dragover', (e) => {
    if ((e.target as HTMLElement).closest('.tab')) return
    const pane = draggingPane()
    if (!pane || (store.tab(pane.from)?.panes.length ?? 0) <= 1) return
    e.preventDefault()
    strip.classList.add('drop-end')
  })
  strip.addEventListener('dragleave', (e) => {
    if (!strip.contains(e.relatedTarget as Node)) strip.classList.remove('drop-end')
  })
  strip.addEventListener('drop', (e) => {
    strip.classList.remove('drop-end')
    if ((e.target as HTMLElement).closest('.tab')) return
    const pane = draggingPane()
    if (!pane) return
    e.preventDefault()
    endDrag()
    store.extractPaneToTab(pane.id)
  })

  strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function wireDragAndDrop(el: HTMLElement, index: number, workspaceId: string): void {
  el.addEventListener('dragstart', (e) => {
    const id = el.dataset.tabId
    if (!id) return
    beginDrag({ kind: 'tab', id, from: workspaceId })
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  })

  el.addEventListener('dragover', (e) => {
    // A file from the tree, dropped on an editor tab, opens there.
    if (e.dataTransfer?.types.includes(FILE_DRAG)) {
      if (!editorPaneOf(el.dataset.tabId)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      el.classList.add('drop-into')
      return
    }
    const tabDrag = draggingTab()
    // A pane dragged out of a split lands here as a tab of its own. Refused for
    // a pane that is already alone in its tab — that is this same tab, and the
    // gesture would rebuild it to no effect.
    const paneDrag = draggingPane()
    const liftable = paneDrag && (store.tab(paneDrag.from)?.panes.length ?? 0) > 1
    if (!liftable && (!tabDrag || tabDrag.id === el.dataset.tabId)) return
    e.preventDefault()
    const rect = el.getBoundingClientRect()
    const after = e.clientX > rect.left + rect.width / 2
    el.classList.toggle('drop-before', !after)
    el.classList.toggle('drop-after', after)
  })

  const clear = () => el.classList.remove('drop-before', 'drop-after', 'drop-into')
  el.addEventListener('dragleave', clear)
  el.addEventListener('dragend', () => {
    clear()
    endDrag()
  })

  el.addEventListener('drop', (e) => {
    e.preventDefault()
    clear()

    const file = e.dataTransfer?.getData(FILE_DRAG)
    if (file) {
      const pane = editorPaneOf(el.dataset.tabId)
      if (!pane) return
      endDrag()
      // Recorded first, so a tab that has never been mounted opens the right
      // file when it is; the event is for the pane that is already on screen.
      store.setPaneFile(pane.id, file)
      window.dispatchEvent(new CustomEvent('editor-open', { detail: { paneId: pane.id, file } }))
      actions.selectTab(workspaceId, el.dataset.tabId!)
      return
    }

    const rectOf = el.getBoundingClientRect()
    const dropAfter = e.clientX > rectOf.left + rectOf.width / 2

    const pane = draggingPane()
    if (pane) {
      endDrag()
      // No explicit remount: the lifted pane becomes the active tab, so the
      // ordinary mount path picks it up. The tab it left is offscreen and
      // rebuilds from its new layout the next time it is shown.
      store.extractPaneToTab(pane.id, index + (dropAfter ? 1 : 0))
      return
    }

    const dragged = draggingTab()
    endDrag()
    if (!dragged) return
    const workspace = store.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    const from = workspace.tabs.findIndex((t) => t.id === dragged.id)
    // A tab from another workspace lands here rather than reordering; the
    // sidebar handles the more common "drop onto the workspace itself".
    if (from === -1) {
      store.moveTabToWorkspace(dragged.id, workspaceId)
      return
    }
    const rect = el.getBoundingClientRect()
    const after = e.clientX > rect.left + rect.width / 2
    let to = index + (after ? 1 : 0)
    if (from < to) to -= 1
    store.moveTab(workspaceId, from, to)
  })
}

/**
 * Everything a workspace can open, for the `+` and the empty strip.
 *
 * Not repeated in a tab's own menu. "What can I open?" belongs to the button
 * that opens things; a tab's menu is about that tab, and duplicating the list
 * there only made it long enough to hide its own entries.
 *
 * No shells here. A terminal tab opens in whatever its workspace runs; picking
 * a different one is a thing you do to a tab that exists, further down.
 */
function newTabEntries(workspaceId: string): MenuEntry[] {
  return [
    { label: 'New terminal tab', shortcut: 'Ctrl+T', onClick: () => actions.newTab(workspaceId) },
    {
      label: 'New file tree tab',
      shortcut: 'Ctrl+Shift+F',
      onClick: () => actions.newFileTab(workspaceId),
    },
    {
      label: 'Editor',
      shortcut: 'Ctrl+Shift+O',
      onClick: () => actions.openEditor(workspaceId),
    },
    {
      label: 'Changes',
      shortcut: 'Ctrl+Shift+D',
      onClick: () => actions.openDiff(workspaceId),
    },
    {
      label: 'Compare files…',
      onClick: () => void actions.openCompare(workspaceId),
    },
    {
      label: 'Search',
      shortcut: 'Ctrl+Shift+S',
      onClick: () => actions.openSearch(workspaceId),
    },
    {
      label: 'Images',
      shortcut: 'Ctrl+Shift+G',
      onClick: () => actions.openImages(workspaceId),
    },
    {
      label: 'Running processes',
      onClick: () => actions.openPorts(workspaceId),
    },
    // Only where a host can actually show a web page. A menu entry that opens
    // an empty box is worse than no entry.
    ...(backend().capabilities.browser
      ? [
          {
            label: 'Browser',
            shortcut: 'Ctrl+Shift+B',
            onClick: () => actions.openBrowser(workspaceId),
          },
        ]
      : []),
  ]
}

/**
 * One "Reopen as" per shell this machine has, plus one per WSL distribution.
 *
 * Named for what it does. The shell a pane runs is fixed the moment the process
 * starts, so this ends it and starts another — the tick marks what is running
 * now, not a setting you are toggling. Only offered for a shell pane, and only
 * when there is more than one thing to offer.
 */
function reopenAsEntries(pane: PaneState | undefined, workspaceId: string): MenuEntry[] {
  if (!pane || !isTerminalPane(pane)) return []
  const shells = availableShells()
  const distros = wslDistros()
  const hosts = sshHosts()
  if (shells.length < 2) return []

  const current = shellFor(
    pane,
    store.workspaces.find((w) => w.id === workspaceId),
    store.settings
  )
  const entries: MenuEntry[] = ['separator']
  for (const profile of shells) {
    // WSL expands to its distributions when there are any, since "WSL" on its
    // own means whichever one happens to be default.
    if (profile.kind === 'wsl' && distros.length) {
      for (const distro of distros) {
        entries.push({
          label: `Reopen as ${shellLabel('wsl', { wslDistro: distro })}`,
          checked: current.shell === 'wsl' && current.wslDistro === distro,
          onClick: () => actions.reopenPaneAs(pane.id, 'wsl', { wslDistro: distro }),
        })
      }
      continue
    }

    // SSH likewise: "SSH" with no host is not something that can be opened, so
    // the entry is one per host rather than one for the shell. A machine with
    // no ~/.ssh/config gets no entries here and the "Other host…" prompt below
    // is the only way in.
    if (profile.kind === 'ssh') {
      for (const host of hosts) {
        entries.push({
          label: `Reopen as ${sshMenuLabel(host)}`,
          checked: current.shell === 'ssh' && current.sshHost === host.alias,
          onClick: () => actions.reopenPaneAs(pane.id, 'ssh', { sshHost: host.alias }),
        })
      }
      entries.push({
        label: hosts.length ? 'Reopen as SSH · other host…' : 'Reopen as SSH…',
        onClick: () => void actions.reopenPaneAsSshHost(pane.id),
      })
      continue
    }

    entries.push({
      label: `Reopen as ${profile.label}`,
      checked: current.shell === profile.kind,
      onClick: () => actions.reopenPaneAs(pane.id, profile.kind),
    })
  }
  return entries
}

/**
 * How an editor tab shows its file.
 *
 * On the tab rather than inside the pane: it is a property of the tab you are
 * looking at, the way "reopen as PowerShell" is, and putting it here keeps the
 * editor itself free of chrome that would only be in the way of the text.
 */
function editorModeEntries(pane: PaneState | undefined, notesFile?: string): MenuEntry[] {
  if (pane?.kind !== 'editor') return []
  // What the pane is *showing*, which is not the same as what it has been told
  // to show: a `.json` opened without a choice being made is in the JSON view
  // with `editorMode` still absent. Comparing against the stored value alone
  // left every mode unticked on those tabs — the menu said nothing about the
  // view you were looking at — and the fallback it compared against, `hybrid`,
  // had not been one of the modes for some time, so it could never tick either.
  //
  // The same rule the pane itself uses, down to the fallback: no file recorded
  // means the workspace's notes file, and no notes file means `NOTES.md`, which
  // `modeForFile('')` reads as markdown.
  const current = pane.editorMode ?? modeForFile(pane.file || notesFile || '')
  return [
    'separator',
    ...EDITOR_MODES.map((mode) => ({
      label: EDITOR_MODE_LABELS[mode],
      checked: current === mode,
      onClick: () => {
        store.setEditorMode(pane.id, mode)
        // The pane is mounted somewhere below and has no idea a menu was open.
        window.dispatchEvent(new CustomEvent('editor-mode', { detail: { paneId: pane.id, mode } }))
      },
    })),
  ]
}

/** The editor pane a tab is showing, if that is what it is showing. */
function editorPaneOf(tabId: string | undefined): PaneState | null {
  const tab = tabId ? store.tab(tabId) : null
  if (!tab) return null
  const active = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0]
  return active?.kind === 'editor' ? active : null
}

function openNewTabMenu(x: number, y: number, workspaceId: string): void {
  showContextMenu(x, y, newTabEntries(workspaceId))
}

function openTabMenu(x: number, y: number, workspaceId: string, tabId: string): void {
  const tab = store.tab(tabId)
  if (!tab) return
  const workspace = store.workspaces.find((w) => w.id === workspaceId)
  const onlyTab = (workspace?.tabs.length ?? 0) <= 1
  const activePane = tab.panes.find((p) => p.id === tab.activePaneId)

  showContextMenu(x, y, [
    { label: 'Rename…', shortcut: 'F2', onClick: () => startRenameTab(tabId) },
    { label: 'Duplicate', onClick: () => actions.newTab(workspaceId, activePane?.cwd) },
    // Everything else a workspace can open lives on the `+`, not here.
    ...reopenAsEntries(activePane, workspaceId),
    ...editorModeEntries(activePane, workspace?.notesFile),
    'separator',
    { label: 'Split right', shortcut: 'Ctrl+\\', onClick: () => actions.splitPane('row') },
    { label: 'Split down', shortcut: 'Ctrl+Shift+\\', onClick: () => actions.splitPane('column') },
    {
      label: store.filesPaneOf(tab) ? 'Remove file tree pane' : 'Split with file tree',
      onClick: () => actions.splitWithFileTree(),
    },
    {
      label: store.treeVisible ? 'Hide docked tree' : 'Dock file tree',
      shortcut: 'Ctrl+Shift+E',
      onClick: () => actions.toggleFileTree(),
    },
    'separator',
    { label: 'Reveal in Explorer', onClick: () => actions.openInExplorer(activePane?.cwd ?? '') },
    {
      label: 'Close others',
      disabled: onlyTab,
      onClick: () => actions.closeOtherTabs(workspaceId, tabId),
    },
    { label: 'Close', shortcut: 'Ctrl+W', danger: true, onClick: () => actions.closeTab(workspaceId, tabId) },
  ])
}
