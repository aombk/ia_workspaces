/**
 * One box for going somewhere and one box for doing something.
 *
 * Everything here already existed behind a shortcut or a right-click menu; the
 * palette is a way to reach it without knowing which. So it deliberately does
 * not own any behaviour — every entry calls the same action the menu calls, and
 * a feature that gains a menu item gains a palette entry by listing it here.
 *
 * Matching is subsequence, not substring: "nt" should find "new terminal", which
 * is how anyone actually types into one of these.
 */
import { store, tabLabel } from '../state'
import type { UiActions } from './actions'

interface Command {
  /** Grouping label shown on the right of the row. */
  kind: string
  label: string
  /** Extra text that should match but is drawn quieter. */
  detail?: string
  run(): void
}

let actions: UiActions
let commands: Command[] = []
let filtered: Command[] = []
let selected = 0

const root = () => document.getElementById('palette') as HTMLDivElement
const input = () => document.getElementById('palette-input') as HTMLInputElement
const list = () => document.getElementById('palette-list') as HTMLDivElement

export function initPalette(a: UiActions): void {
  actions = a

  input().addEventListener('input', () => {
    selected = 0
    refine()
  })

  input().addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      hidePalette()
      return
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
      e.preventDefault()
      move(1)
      return
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
      e.preventDefault()
      move(-1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const command = filtered[selected]
      if (!command) return
      // Hidden before running: an entry that opens a tab would otherwise leave
      // the palette sitting over the thing it just opened.
      hidePalette()
      command.run()
    }
  })

  // A click outside is a dismissal; a click on the box itself is not.
  root().addEventListener('mousedown', (e) => {
    if (e.target === root()) hidePalette()
  })
}

export function togglePalette(): void {
  if (root().hidden) showPalette()
  else hidePalette()
}

export function showPalette(): void {
  commands = collect()
  selected = 0
  root().hidden = false
  input().value = ''
  refine()
  input().focus()
}

export function hidePalette(): void {
  if (root().hidden) return
  root().hidden = true
  // Focus goes back to the terminal, or the next keystroke lands nowhere.
  window.dispatchEvent(new CustomEvent('palette-closed'))
}

export function paletteIsOpen(): boolean {
  return !root().hidden
}

/**
 * Everything reachable right now.
 *
 * Rebuilt on each open rather than kept in sync: it is a snapshot of state that
 * changes constantly, and building a few dozen rows costs nothing next to
 * getting it wrong.
 */
function collect(): Command[] {
  const out: Command[] = []
  const active = store.activeWorkspace

  for (const workspace of store.workspaces) {
    const parent = store.workspaces.find((w) => w.id === workspace.parentId)
    out.push({
      kind: 'Workspace',
      label: workspace.name,
      detail: [parent?.name, workspace.cwd].filter(Boolean).join(' · '),
      run: () => actions.selectWorkspace(workspace.id),
    })
  }

  for (const workspace of store.workspaces) {
    for (const tab of workspace.tabs) {
      out.push({
        kind: 'Tab',
        label: tabLabel(tab),
        detail: workspace.name,
        run: () => {
          actions.selectWorkspace(workspace.id)
          actions.selectTab(workspace.id, tab.id)
        },
      })
    }
  }

  if (active) {
    const id = active.id
    out.push(
      { kind: 'Action', label: 'New terminal', detail: 'Ctrl+T', run: () => actions.newTab(id) },
      {
        kind: 'Action',
        label: 'New file tree tab',
        detail: 'Ctrl+Shift+F',
        run: () => actions.newFileTab(id),
      },
      {
        kind: 'Action',
        label: 'Compare files…',
        detail: 'Diff any two files',
        run: () => void actions.openCompare(id),
      },
      {
        kind: 'Action',
        label: 'Waiting for you',
        detail: 'Ctrl+Shift+A',
        run: () => actions.openInbox(''),
      },
      {
        kind: 'Action',
        label: 'New workspace',
        detail: 'Ctrl+Shift+N',
        run: () => actions.addWorkspace(),
      },
      {
        kind: 'Action',
        label: store.treeVisible ? 'Hide docked tree' : 'Dock file tree',
        detail: 'Ctrl+Shift+E',
        run: () => actions.toggleFileTree(),
      },
      {
        kind: 'Action',
        label: 'Images',
        detail: 'Ctrl+Shift+G',
        run: () => actions.openImages(id),
      },
      {
        kind: 'Action',
        label: 'Save workspace to a file',
        detail: 'this workspace and anything nested under it',
        run: () => actions.saveWorkspace(id),
      },
      {
        kind: 'Action',
        label: 'Save all workspaces to a file',
        run: () => actions.saveAllWorkspaces(),
      },
      {
        kind: 'Action',
        label: 'Load workspaces from a file',
        detail: 'added beside what is already open',
        run: () => actions.loadWorkspaces(),
      },
      { kind: 'Action', label: 'Settings', detail: 'Ctrl+,', run: () => actions.openSettings() }
    )
  }

  return out
}

/**
 * Subsequence match, scored so tighter runs win.
 *
 * Returns null for no match. The score is the span the match covers — smaller
 * is better, so "build" beats "b…u…i…l…d" spread across a whole path.
 *
 * Exported for the test; nothing else should need it.
 */
export function score(haystack: string, needle: string): number | null {
  if (!needle) return 0
  const text = haystack.toLowerCase()
  let at = -1
  let first = -1
  for (const ch of needle.toLowerCase()) {
    at = text.indexOf(ch, at + 1)
    if (at === -1) return null
    if (first === -1) first = at
  }
  return at - first
}

function refine(): void {
  const query = input().value.trim()
  filtered = commands
    .map((command) => {
      const label = score(command.label, query)
      // A hit in the label beats a hit in the detail: "dev" should rank the
      // workspace called dev above every task that merely runs in it.
      const detail = label === null ? score(`${command.label} ${command.detail ?? ''}`, query) : null
      const value = label ?? (detail === null ? null : detail + 100)
      return value === null ? null : { command, value }
    })
    .filter((x): x is { command: Command; value: number } => x !== null)
    .sort((a, b) => a.value - b.value)
    .slice(0, 50)
    .map((x) => x.command)

  render()
}

function move(delta: number): void {
  if (!filtered.length) return
  selected = (selected + delta + filtered.length) % filtered.length
  render()
}

function render(): void {
  const el = list()
  el.replaceChildren()

  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'palette-empty'
    empty.textContent = 'Nothing matches.'
    el.appendChild(empty)
    return
  }

  filtered.forEach((command, index) => {
    const row = document.createElement('div')
    row.className = 'palette-row' + (index === selected ? ' selected' : '')
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(index === selected))

    const label = document.createElement('span')
    label.className = 'palette-label'
    label.textContent = command.label
    row.appendChild(label)

    if (command.detail) {
      const detail = document.createElement('span')
      detail.className = 'palette-detail'
      detail.textContent = command.detail
      row.appendChild(detail)
    }

    const kind = document.createElement('span')
    kind.className = 'palette-kind'
    kind.textContent = command.kind
    row.appendChild(kind)

    // mousedown, not click: the input loses focus on mousedown and a blur
    // handler would have closed the palette before click ever landed.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault()
      hidePalette()
      command.run()
    })
    row.addEventListener('mousemove', () => {
      if (selected === index) return
      selected = index
      render()
    })
    el.appendChild(row)
  })

  el.querySelector('.palette-row.selected')?.scrollIntoView({ block: 'nearest' })
}
