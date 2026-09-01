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
import { backend } from '../../backend'
import { store, tabLabel } from '../state'
import type { HistoryEntry, VaultEntry } from '../../shared/types'
import { showGlossary } from './gitWord'
import { commandsElsewhere } from './relayMonitor'
import { SCOPES, availableScopes, type HistoryScope } from './paneHistory'
import { byRunbookRank, commandFacts, inProject } from '../../shared/runbook'
import { filesTouched } from './turnMonitor'
import { typeIntoPane } from './paneInput'
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
const scopeBar = () => document.getElementById('palette-scope') as HTMLDivElement

/**
 * Which panes the history box is showing, remembered for the session.
 *
 * Sticky rather than reset on every open, because it is a habit and not a
 * per-search decision: somebody who works one pane at a time will want "this
 * pane" every time and should not have to say so every time. Not a setting —
 * it costs one keystroke to change and forgetting it at a restart is no loss.
 */
/**
 * What the history box is showing.
 *
 * Three of these are rings of history — the same three a pane's Up arrow walks
 * — and the fourth is a different question about the same commands: not "what
 * did I run, most recent first" but "what does this project actually run, worst
 * first". That used to be a tab of its own, which meant the answer to a
 * question about commands lived somewhere other than the box you open to look
 * for a command.
 *
 * Deliberately not part of `HistoryScope`. That type is saved on panes now and
 * decides what the Up arrow walks, and "runbook" is not a thing an arrow key
 * can step through.
 */
type HistoryView = HistoryScope | 'runbook'

/**
 * The views this box can actually show, narrowest first.
 *
 * "Everywhere" needs sharing switched on, and the runbook needs a project to be
 * about — a box opened from no pane has no folder, so there is nothing for it
 * to rank. Both are dropped from the cycle rather than offered and then found
 * to be empty.
 */
function availableViews(): readonly HistoryView[] {
  const views: HistoryView[] = [...availableScopes()]
  if (store.activePane) views.push('runbook')
  return views
}

/** The next view along, wrapping. What Tab does. */
function nextView(view: HistoryView): HistoryView {
  const views = availableViews()
  const at = views.indexOf(view)
  return views[(at + 1) % views.length]
}

/**
 * The ring the history box opens on.
 *
 * Starts from whatever a terminal would start on, so the box agrees with the
 * panes rather than having an opinion of its own. Changing it here is for this
 * search only — the corner control on a pane is where the lasting choice is
 * made, and a search box quietly rewriting a saved preference is not something
 * anybody asks for.
 */
let historyScope: HistoryView = 'machine'

/** The pane the history box was opened from, and will type into. */
let historyPane: { id: string } | null = null

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
    // Only the history box has two scopes, so Tab means nothing in the other
    // modes and is left alone there. Nothing else in the box takes focus, so
    // taking the key costs no navigation.
    if (e.key === 'Tab' && !scopeBar().hidden) {
      e.preventDefault()
      historyScope = nextView(historyScope)
      void showHistory()
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
  // The scope bar is the history box's, not the palette's. Left behind, it
  // would offer to narrow a list of actions by a pane, which means nothing.
  scopeBar().hidden = true
  commands = collect()
  selected = 0
  root().hidden = false
  input().value = ''
  input().placeholder = 'Go to, or do'
  refine()
  input().focus()
}

/**
 * The same box, filled with what you have typed before.
 *
 * A second mode rather than history mixed into the commands: five hundred shell
 * lines would drown the two dozen things the palette is actually for, and the
 * two are reached with different questions in mind. Everything else — the
 * subsequence matching, the keyboard handling, the styling — is shared, which
 * is why this is a mode and not a second widget.
 *
 * Picking one **types it without submitting**. That is the same rule the resume
 * feature follows and for the same reason: what you last ran might be a build,
 * a push or a delete, and putting it in front of the Enter key on somebody's
 * behalf is not a decision this app gets to make. The line lands on the prompt,
 * ready to edit or run.
 */
/**
 * Transcripts of panes that have been closed.
 *
 * A third mode, and the cheapest of the three: the entries are text files, so
 * picking one opens it in the editor pane — which already renders text and
 * already has find — rather than in anything written for this. Searching
 * *across* them is the search pane pointed at the folder, which the last entry
 * offers.
 */
export async function showVault(): Promise<void> {
  scopeBar().hidden = true
  let entries: VaultEntry[] = []
  let folder = ''
  try {
    ;[entries, folder] = await Promise.all([backend().vault.list(), backend().vault.folder()])
  } catch {
    entries = []
  }

  const workspace = store.activeWorkspace
  commands = entries.map((entry) => ({
    kind: 'Transcript',
    label: entry.label,
    detail: `${new Date(entry.at).toLocaleString()} · ${describeSize(entry.bytes)}`,
    run: () => {
      if (workspace) actions.openEditor(workspace.id, entry.path)
    },
  }))

  if (folder) {
    commands.push({
      kind: 'Transcript',
      label: 'Search every transcript…',
      detail: folder,
      run: () => {
        if (workspace) actions.openSearch(workspace.id, folder)
      },
    })
  }

  selected = 0
  root().hidden = false
  input().value = ''
  input().placeholder = entries.length
    ? 'Type to find a closed pane'
    : 'No transcripts yet — they are written when a pane is closed'
  refine()
  input().focus()
}

/**
 * The last segment of a path, on either platform's separator.
 *
 * `[\\/]`, not `[\/]`: the second is a class holding one escaped forward
 * slash, so a Windows path has nothing to split on and the whole path comes
 * back as the "file name".
 */
function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export async function showHistory(): Promise<void> {
  // Opens on the ring a terminal would, so the box and the panes agree — but
  // **only when it is opening**. A scope button and Tab both re-enter here to
  // redraw, so seeding on every pass overwrote the very choice that triggered
  // the redraw, and the switch did nothing at all. The box being hidden is what
  // "opening" means; every other path through here has it already up.
  if (root().hidden) historyScope = store.settings.historyScope
  let entries: HistoryEntry[] = []
  try {
    entries = await backend().commandHistory()
  } catch {
    entries = []
  }

  // Captured before the box opens: by the time a row is picked the palette has
  // taken focus, and "the pane you were in" is the only sensible target. It is
  // also what "this pane" means, for the same reason.
  historyPane = store.activePane
  if (!historyPane) historyScope = 'machine'
  // The sticky view can outlive the setting that made it possible: sharing
  // switched off between two openings leaves this on a slice with nothing in
  // it, and the runbook needs a project to be about.
  if (!availableViews().includes(historyScope)) historyScope = 'machine'

  // Every count, before anything is dropped, so each button says how much is
  // behind it. The useful question when a list looks short is "is that all of
  // them, or all of them *here*", and three numbers answer it without a click.
  const cwd = historyPane ? (store.workspaceOfPane(historyPane.id)?.cwd ?? '') : ''
  const counts: Record<HistoryView, number> = {
    terminal: historyPane ? entries.filter((e) => e.paneId === historyPane!.id).length : 0,
    machine: entries.length,
    everywhere: entries.length,
    runbook: entries.filter((e) => inProject(e, cwd)).length,
  }

  const elsewhere: HistoryEntry[] = []
  if (cwd) {
    const seen = new Set(entries.map((e) => e.command))
    for (const machine of commandsElsewhere(cwd)) {
      for (const command of machine.commands) {
        if (seen.has(command)) continue
        seen.add(command)
        elsewhere.push({ command, cwd, at: 0, elsewhere: machine.label })
      }
    }
  }
  counts.everywhere = entries.length + elsewhere.length

  // The runbook is the one view that reorders rather than filters by recency:
  // what this project runs, worst first. Everything else stays newest-first,
  // because that is what "history" means.
  const runbook = historyScope === 'runbook'
  if (runbook) {
    entries = entries.filter((entry) => inProject(entry, cwd)).sort(byRunbookRank)
  } else if (historyScope === 'terminal' && historyPane) {
    entries = entries.filter((entry) => entry.paneId === historyPane!.id)
  } else if (historyScope === 'everywhere') {
    // Appended rather than interleaved: another machine's commands carry no
    // timestamp this one can compare against its own clock, so sorting them
    // together would produce an order that is confidently wrong.
    entries = entries.concat(elsewhere)
  }

  const pane = historyPane
  commands = entries.map((entry) => ({
    kind: runbook ? 'Runbook' : (entry.elsewhere ?? 'History'),
    label: entry.command,
    // The runbook says how a command has been *going*; the history says where
    // and when it last ran. Same rows, different question.
    detail: runbook ? commandFacts(entry) : outcomeOf(entry),
    run: () => {
      void typeIntoPane(pane?.id, entry.command)
    },
  }))

  renderScope(counts)

  selected = 0
  root().hidden = false
  input().value = ''
  input().placeholder = commands.length
    ? 'Type to find a command — Enter puts it on the prompt'
    : historyScope === 'terminal'
      ? 'Nothing recorded in this terminal — Tab widens the search'
      : historyScope === 'runbook'
        ? 'Nothing has been run in this project yet'
        : 'Nothing recorded yet'
  refine()
  input().focus()
}

/**
 * What happened last time, beside where it ran.
 *
 * The folder was the whole of this line before, and it is still the thing that
 * identifies a command — but "failed last time" is the fact that changes what
 * you do next, and it was being thrown away. An exit code nobody recorded reads
 * as nothing at all rather than as success: a pane with no shell integration
 * knows neither, and the two must not look the same.
 *
 * Deliberately not the number itself for the failures. "exit 1" is what git
 * said; "failed last time" is what it meant, and the number is on the screen
 * behind this box if anybody wants it.
 */
function outcomeOf(entry: HistoryEntry): string {
  const where = entry.cwd
  if (entry.lastCode === undefined) return where

  const runs = entry.runs ?? 1
  const fails = entry.fails ?? 0
  if (entry.lastCode !== 0) {
    const before = fails > 1 ? `, ${fails} of ${runs} runs` : ''
    return `failed last time (exit ${entry.lastCode})${before} · ${where}`
  }
  // A command that works now but has a history of not working is worth saying
  // so about — it is usually the one with an argument you keep getting wrong.
  if (fails > 0) return `worked last time, failed ${fails} of ${runs} · ${where}`
  return where
}

/**
 * The two scopes, both always drawn.
 *
 * The one that is not chosen is a place to go rather than something that has
 * disappeared, so it keeps its slot and its label — and "this pane" is greyed
 * rather than removed when there is no pane to mean, which says why it cannot
 * be picked instead of leaving somebody to wonder where it went.
 *
 * Counts on the labels, because the useful question when the list looks short
 * is "is that all of them, or all of them *here*", and the two numbers answer
 * it without a click.
 */
function renderScope(counts: Record<HistoryView, number>): void {
  const bar = scopeBar()
  bar.hidden = false
  bar.replaceChildren()

  for (const scope of [...SCOPES, 'runbook' as const]) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'palette-scope__btn' + (historyScope === scope ? ' on' : '')
    el.textContent = `${SCOPE_LABELS[scope]} (${counts[scope]})`
    // Greyed and struck through rather than removed, in both cases, which says
    // why a slice cannot be picked instead of leaving somebody to wonder where
    // it went: no pane to mean, or the machines are not sharing commands.
    const shared = scope === 'runbook' || availableScopes().includes(scope)
    el.disabled = ((scope === 'terminal' || scope === 'runbook') && !historyPane) || !shared
    if (!shared) {
      el.title = 'Switch on “Share the commands you run between machines” in Settings first.'
    } else if (el.disabled) {
      el.title = 'No terminal was focused when this opened.'
    } else if (scope === 'runbook') {
      el.title = 'What this project actually runs, worst first — failing commands before popular ones.'
    }
    el.addEventListener('click', () => {
      if (historyScope === scope) return
      historyScope = scope
      void showHistory()
    })
    bar.appendChild(el)
  }

  const hint = document.createElement('span')
  hint.className = 'palette-scope__hint'
  hint.textContent = 'Tab to switch'
  bar.appendChild(hint)
}

/** The three rings, in the words the search box has room for. */
const SCOPE_LABELS: Record<HistoryView, string> = {
  terminal: 'this terminal',
  machine: 'this machine',
  everywhere: 'everywhere',
  runbook: 'runbook',
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

  // The two other modes of this very box. Listed because a chord is not
  // discoverable and, on some keyboard layouts, Ctrl+Alt is AltGr and produces
  // a character instead.
  out.push({
    kind: 'Find',
    label: 'Command history',
    detail: 'Everything you have typed, and this project’s runbook — Ctrl+Alt+H',
    run: () => void showHistory(),
  })
  out.push({
    kind: 'Action',
    label: 'Clipboard image notes editor\u2026',
    detail: 'Number places on a screenshot and say what you mean by each',
    run: () => actions.addImageNotes(),
  })
  out.push({
    kind: 'Find',
    label: 'Every prompt you have sent',
    detail: 'Search your own agent history, across every project',
    run: () => {
      const active = store.activeWorkspace
      if (active) actions.openPrompts(active.id)
    },
  })
  out.push({
    kind: 'Find',
    label: 'Transcripts of closed panes',
    detail: 'What a pane printed before you closed it — Ctrl+Alt+V',
    run: () => void showVault(),
  })

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

  // Files the agent in the pane you came from has opened.
  //
  // The list nobody can reconstruct by hand: an agent working for ten minutes
  // has read thirty files across four folders, and the one you now want to look
  // at yourself is somewhere in a scrollback you would have to search. It is
  // already written down — every read and every write is in the conversation's
  // own transcript — so this is a lookup rather than a feature.
  //
  // Only the focused pane's agent, and deliberately: two panes' worth of files
  // interleaved is a list where the folder tells you nothing about which agent
  // touched it, and "the one I was just watching" is what anybody means.
  const watching = store.activePane
  const transcript = watching ? store.pane(watching.id)?.agentSession?.transcript : undefined
  for (const file of filesTouched(transcript)) {
    out.push({
      kind: file.wrote ? 'Agent wrote' : 'Agent read',
      label: fileName(file.path),
      detail: file.path,
      run: () => actions.openReader(file.path),
    })
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
        detail: 'Diff any two files — Ctrl+Alt+D',
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
        label: 'git — history',
        detail: 'every save in this project, and the lines they sit on — Ctrl+Shift+H',
        run: () => actions.openHistory(id),
      },
      {
        kind: 'Action',
        label: 'running processes',
        detail: 'what each pane is running, and what is holding a port — Ctrl+Shift+R',
        run: () => actions.openPorts(id),
      },
      {
        kind: 'Action',
        label: 'token stats',
        detail: 'what Claude Code has spent in this project, and what it would have cost',
        run: () => actions.openTokens(id),
      },
      {
        kind: 'Action',
        label: 'canvas',
        detail: 'connected notes for this project, in Obsidian’s .canvas format',
        run: () => actions.openCanvas(id),
      },
      {
        kind: 'Action',
        label: 'today',
        detail: 'where the day went — time, commands and saves, across every project',
        run: () => actions.openDay(id),
      },
      {
        kind: 'Action',
        label: 'focus',
        detail: 'time on this project, what is left to do, and a timer',
        run: () => actions.openFocus(id),
      },
      {
        kind: 'Action',
        label: 'command history',
        detail:
          'everything you have typed at a prompt, plus the runbook — what this project ' +
          'actually runs, worst first. Ctrl+Alt+H',
        run: () => void showHistory(),
      },
      {
        kind: 'Action',
        label: 'system',
        detail: 'load, memory, disks, network and graphics — how this computer is coping',
        run: () => actions.openMonitor(id),
      },
      {
        kind: 'Action',
        label: 'Git words, in plain words',
        detail: 'what staged, commit, origin, HEAD and the rest actually mean',
        run: () => showGlossary(),
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
