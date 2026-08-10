import { backend } from '../../backend'
import { store, type SidebarRow } from '../state'
import { NESTING_GLYPHS, WORKSPACE_COLORS } from '../../shared/types'
import { showContextMenu } from './contextMenu'
import { promptDialog } from './confirm'
import { availableShells, shellLabel, sshHosts, sshMenuLabel } from '../shells'
import { attachInlineEditor } from './editing'
import { beginDrag, draggingTab, draggingWorkspace, endDrag } from './dragState'
import type { UiActions } from './actions'

let actions: UiActions
let renaming: string | null = null

export function initSidebar(a: UiActions): void {
  actions = a

  document.getElementById('add-workspace')!.addEventListener('click', () => actions.addWorkspace())
  document.getElementById('open-settings')!.addEventListener('click', () => actions.openSettings())
  document.getElementById('open-inbox')!.addEventListener('click', () => actions.openInbox(''))
  document.getElementById('collapse-sidebar')!.addEventListener('click', toggleCollapsed)

  // The empty space under the list is the obvious place to reach for "new
  // workspace", and without a menu of its own WebView2 offers the browser's —
  // Back, Refresh, Print — in the middle of a terminal app.
  document.getElementById('sidebar')!.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('.workspace, button, input')) return
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, [
      { label: 'New workspace…', shortcut: 'Ctrl+Shift+N', onClick: () => actions.addWorkspace() },
    ])
  })

  initResizer()
  applySidebarLayout()
}

export function toggleCollapsed(): void {
  store.setSidebar(store.state.sidebarWidth, !store.state.sidebarCollapsed)
  applySidebarLayout()
}

function applySidebarLayout(): void {
  const app = document.getElementById('app')!
  const sidebar = document.getElementById('sidebar') as HTMLElement
  app.classList.toggle('sidebar-collapsed', store.state.sidebarCollapsed)
  sidebar.style.width = `${store.state.sidebarWidth}px`
}

function initResizer(): void {
  const resizer = document.getElementById('sidebar-resizer')!
  const sidebar = document.getElementById('sidebar') as HTMLElement

  resizer.addEventListener('mousedown', (down) => {
    if (store.state.sidebarCollapsed) return
    down.preventDefault()
    resizer.classList.add('dragging')
    const startX = down.clientX
    const startWidth = sidebar.offsetWidth

    const onMove = (move: MouseEvent) => {
      const next = Math.max(160, Math.min(420, startWidth + move.clientX - startX))
      sidebar.style.width = `${next}px`
    }
    const onUp = () => {
      resizer.classList.remove('dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      store.setSidebar(sidebar.offsetWidth, false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })
}

export function renderSidebar(): void {
  const list = document.getElementById('workspace-list')!
  const active = store.state.activeWorkspaceId
  list.replaceChildren()

  for (const row of store.sidebarRows(store.state.sidebarCollapsed)) {
    list.appendChild(workspaceRow(row, active))
  }
}

/** How far one level of nesting indents, in pixels. */
const INDENT = 12

function workspaceRow(row: SidebarRow, active: string | null): HTMLElement {
  const { workspace, depth, hasChildren } = row

  // A shut parent is the one place a waiting agent could hide, so what is
  // nested under it counts towards what the row reports.
  const needsInput =
    store.workspaceNeedsInput(workspace.id) ||
    (workspace.collapsed && store.subtreeNeedsInput(workspace.id))
  const hasAttention =
    !needsInput &&
    (store.workspaceHasAttention(workspace.id) ||
      (workspace.collapsed && store.subtreeHasAttention(workspace.id)))

  const marker = depth > 0 ? (NESTING_GLYPHS[store.settings.nestingMarker] ?? '') : ''

  const el = document.createElement('div')
  el.className =
    'workspace' +
    (workspace.id === active ? ' active' : '') +
    (needsInput ? ' needs-input' : '') +
    (hasAttention ? ' has-attention' : '')
  el.style.setProperty('--workspace-color', workspace.color)
  // The elbow, when there is one, is what fills this row's own level of indent
  // — so that level is spent on the glyph instead of on empty space.
  el.style.paddingLeft = `${8 + (depth - (marker ? 1 : 0)) * INDENT}px`
  el.dataset.workspaceId = workspace.id
  el.setAttribute('role', 'tab')
  el.setAttribute('aria-selected', String(workspace.id === active))
  el.title = `${workspace.name}
${workspace.cwd}`
  el.draggable = renaming !== workspace.id

  // The twisty only exists when there is something to fold. Its slot is kept
  // either way, so names stay aligned down a level.
  const twisty = document.createElement('span')
  twisty.className = 'workspace-twisty'
  if (hasChildren) {
    twisty.textContent = workspace.collapsed ? '›' : '⌄'
    twisty.title = workspace.collapsed ? 'Expand' : 'Collapse'
    twisty.addEventListener('click', (e) => {
      // Folding is not selecting — without this the click falls through to the
      // row and switches workspace as a side effect of tidying the sidebar.
      e.stopPropagation()
      store.toggleCollapsed(workspace.id)
    })
  }
  el.appendChild(twisty)

  // An elbow marking the row as somebody's child. Indentation alone says the
  // same thing, but only by comparison with the row above — and the row above
  // is often scrolled away, or is itself a child. A glyph says it outright.
  //
  // Between the twisty and the dot, which puts it in the column the parent's
  // colour dot occupies and hard against this row's own dot: it reads as a line
  // drawn from the parent down to this workspace, rather than as a third mark
  // floating on its own.
  //
  // One per row rather than one per level: it marks "this is nested", and a
  // ladder of them at depth 3 reads as a drawing rather than a label. Decorative
  // to a screen reader, which gets the structure from the list itself.
  if (marker) {
    const elbow = document.createElement('span')
    elbow.className = 'workspace-elbow'
    elbow.textContent = marker
    elbow.setAttribute('aria-hidden', 'true')
    el.appendChild(elbow)
  }

  const dot = document.createElement('span')
  dot.className = 'workspace-dot'
  dot.title = needsInput
    ? 'A terminal in here is waiting for your answer'
    : hasAttention
      ? 'A terminal in here needs attention'
      : ''
  el.appendChild(dot)

  if (renaming === workspace.id) {
    const input = document.createElement('input')
    input.className = 'workspace-name-input'
    input.value = workspace.name
    input.spellcheck = false
    el.appendChild(input)
    attachInlineEditor(input, {
      onCommit: (value) => {
        renaming = null
        store.renameWorkspace(workspace.id, value)
      },
      onCancel: () => {
        renaming = null
        renderSidebar()
      },
    })
  } else {
    const label = document.createElement('span')
    label.className = 'workspace-label'

    const name = document.createElement('span')
    name.className = 'workspace-name'
    name.textContent = workspace.name
    label.appendChild(name)

    if (store.settings.showGitBranch && workspace.branch) {
      const branch = document.createElement('span')
      branch.className = 'workspace-branch'
      branch.textContent = workspace.branch
      branch.title = `On branch ${workspace.branch}`
      label.appendChild(branch)
    }
    el.appendChild(label)

    const count = workspace.tabs.length
    if (count && store.settings.showTabCount) {
      const badge = document.createElement('span')
      badge.className = 'workspace-count'
      badge.textContent = String(count)
      el.appendChild(badge)
    }
  }

  el.addEventListener('click', () => {
    if (renaming === workspace.id) return
    actions.selectWorkspace(workspace.id)
  })
  el.addEventListener('dblclick', () => startRename(workspace.id))
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    openWorkspaceMenu(e.clientX, e.clientY, workspace.id)
  })

  wireDragAndDrop(el)
  return el
}

export function startRename(workspaceId: string): void {
  renaming = workspaceId
  renderSidebar()
}

function wireDragAndDrop(row: HTMLElement): void {
  row.addEventListener('dragstart', (e) => {
    const id = row.dataset.workspaceId
    if (!id) return
    beginDrag({ kind: 'workspace', id })
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  })

  row.addEventListener('dragover', (e) => {
    // A tab dropped anywhere on the row moves into that workspace — there is no
    // "before" or "after" for a tab in a list it is not in yet.
    const tab = draggingTab()
    if (tab && tab.from !== row.dataset.workspaceId) {
      e.preventDefault()
      row.classList.add('drop-into')
      return
    }

    const moved = draggingWorkspace()
    if (!moved || moved === row.dataset.workspaceId) return
    e.preventDefault()
    const rect = row.getBoundingClientRect()
    const offset = (e.clientY - rect.top) / rect.height
    const into = offset > 0.25 && offset < 0.75
    row.classList.toggle('drop-into', into)
    row.classList.toggle('drop-before', !into && offset <= 0.25)
    row.classList.toggle('drop-after', !into && offset >= 0.75)
  })

  const clear = () => row.classList.remove('drop-before', 'drop-after', 'drop-into')
  row.addEventListener('dragleave', clear)
  row.addEventListener('dragend', () => {
    clear()
    endDrag()
  })

  row.addEventListener('drop', (e) => {
    e.preventDefault()
    clear()
    const ontoId = row.dataset.workspaceId

    // A tab from the strip: file it under this workspace and go there.
    const tab = draggingTab()
    if (tab) {
      endDrag()
      if (ontoId) store.moveTabToWorkspace(tab.id, ontoId)
      return
    }

    const moved = draggingWorkspace()
    endDrag()
    if (!moved) return
    if (!ontoId || moved === ontoId) return
    const onto = store.workspaces.find((w) => w.id === ontoId)
    if (!onto) return

    // Three bands. The middle half of a row nests the dropped workspace inside
    // it; the top and bottom quarters reorder as a sibling, which is how the
    // list worked before nesting existed and still needs to.
    const rect = row.getBoundingClientRect()
    const offset = (e.clientY - rect.top) / rect.height
    if (offset > 0.25 && offset < 0.75) {
      store.setWorkspaceParent(moved, ontoId)
      return
    }

    // Reordering as a sibling means adopting the target's parent, then moving.
    store.setWorkspaceParent(moved, onto.parentId ?? null)
    const from = store.workspaces.findIndex((w) => w.id === moved)
    const at = store.workspaces.findIndex((w) => w.id === ontoId)
    if (from === -1 || at === -1) return
    let to = at + (offset >= 0.75 ? 1 : 0)
    if (from < to) to -= 1
    store.moveWorkspace(from, to)
  })
}

/**
 * Which shell this workspace's new panes start with.
 *
 * The distributions are listed individually rather than behind a "WSL" entry
 * plus a second picker: on a machine with one distro that is one click, and on
 * a machine with three the names are what you are choosing between anyway.
 */
async function openShellMenu(x: number, y: number, workspaceId: string): Promise<void> {
  const workspace = store.workspaces.find((w) => w.id === workspaceId)
  if (!workspace) return
  const distros = await backend().wslDistros()
  const hosts = sshHosts()

  // Whatever this machine actually has, rather than a written-down list. This
  // used to name PowerShell, pwsh and cmd outright, which was correct while the
  // app was Windows-only and became three entries a Mac cannot run the moment
  // it was not. WSL and SSH are handled below, because neither is one entry.
  const plain = availableShells().filter(
    (p) => p.kind !== 'wsl' && p.kind !== 'ssh' && p.kind !== 'custom'
  )

  showContextMenu(x, y, [
    {
      label: `Default (${store.settings.shell})`,
      checked: !workspace.shell,
      onClick: () => store.setWorkspaceShell(workspaceId, undefined),
    },
    ...plain.map((profile) => ({
      label: profile.label,
      checked: workspace.shell === profile.kind,
      onClick: () => store.setWorkspaceShell(workspaceId, profile.kind),
    })),
    ...(distros.length ? ['separator' as const] : []),
    ...distros.map((distro) => ({
      label: `WSL · ${distro}`,
      checked: workspace.shell === 'wsl' && workspace.wslDistro === distro,
      onClick: () => store.setWorkspaceShell(workspaceId, 'wsl', { wslDistro: distro }),
    })),
    'separator' as const,
    ...hosts.map((host) => ({
      label: sshMenuLabel(host),
      checked: workspace.shell === 'ssh' && workspace.sshHost === host.alias,
      onClick: () => store.setWorkspaceShell(workspaceId, 'ssh', { sshHost: host.alias }),
    })),
    {
      label: hosts.length ? 'SSH · other host…' : 'SSH…',
      onClick: () => void chooseSshHost(workspaceId),
    },
  ])
}

/** Asks for a host not in `~/.ssh/config`, then points the workspace at it. */
async function chooseSshHost(workspaceId: string): Promise<void> {
  const host = await promptDialog({
    title: 'Point this workspace at an SSH host',
    body: 'Host to connect to — an alias from ~/.ssh/config, a hostname, or user@host. New panes here will open on it.',
    placeholder: 'user@example.com',
  })
  if (host) store.setWorkspaceShell(workspaceId, 'ssh', { sshHost: host })
}

function openWorkspaceMenu(x: number, y: number, workspaceId: string): void {
  const workspace = store.workspaces.find((w) => w.id === workspaceId)
  if (!workspace) return

  showContextMenu(x, y, [
    { label: 'New terminal', shortcut: 'Ctrl+T', onClick: () => actions.newTab(workspaceId) },
    {
      label: 'New file tree tab',
      shortcut: 'Ctrl+Shift+F',
      onClick: () => actions.newFileTab(workspaceId, workspace.cwd),
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
      label: 'History',
      shortcut: 'Ctrl+Shift+H',
      onClick: () => actions.openHistory(workspaceId),
    },
    {
      label: 'Compare files…',
      shortcut: 'Ctrl+Alt+D',
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
      shortcut: 'Ctrl+Shift+R',
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
    {
      label: store.treeVisible ? 'Hide docked tree' : 'Dock file tree',
      shortcut: 'Ctrl+Shift+E',
      onClick: () => actions.toggleFileTree(),
    },
    'separator',
    {
      label: 'Save workspace…',
      onClick: () => actions.saveWorkspace(workspaceId),
    },
    {
      label: 'Save all workspaces…',
      onClick: () => actions.saveAllWorkspaces(),
    },
    {
      label: 'Load workspaces…',
      onClick: () => actions.loadWorkspaces(),
    },
    'separator',
    // Nesting is mostly done by dragging; this is the keyboard-reachable way
    // to the same thing, and the only way to un-nest without a drag.
    ...(workspace.parentId
      ? [
          {
            label: 'Move to top level',
            onClick: () => store.setWorkspaceParent(workspaceId, null),
          },
        ]
      : []),
    ...(store.childrenOf(workspaceId).length
      ? [
          {
            label: workspace.collapsed ? 'Expand' : 'Collapse',
            onClick: () => store.toggleCollapsed(workspaceId),
          },
        ]
      : []),
    'separator',
    {
      label: workspace.shell
        ? `Shell: ${shellLabel(workspace.shell, workspace)}`
        : 'Shell…',
      onClick: () => void openShellMenu(x, y, workspaceId),
    },
    'separator',
    { label: 'Rename…', shortcut: 'F2', onClick: () => startRename(workspaceId) },
    { label: 'Change folder…', onClick: () => actions.changeWorkspaceFolder(workspaceId) },
    { label: 'New worktree…', onClick: () => actions.newWorktree(workspaceId) },
    { label: 'Reveal in Explorer', onClick: () => actions.openInExplorer(workspace.cwd) },
    {
      kind: 'swatches',
      colors: WORKSPACE_COLORS,
      selected: workspace.color,
      onPick: (color) => store.setWorkspaceColor(workspaceId, color),
    },
    'separator',
    { label: 'Remove workspace', danger: true, onClick: () => actions.removeWorkspace(workspaceId) },
  ])
}
