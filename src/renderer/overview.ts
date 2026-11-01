/**
 * Every workspace, every agent, at a glance — a window meant for a screen of
 * its own.
 *
 * The sidebar already says which workspace wants you and which is busy, but it
 * says it about the window it is in, a dot and a ring at a time, and it is on
 * the screen you are working on. This is the same information laid out for
 * reading from across the desk: each workspace with its tabs, each pane with
 * what its agent says it is doing, where on which screen it is, and what is
 * waiting for an answer — with the answer one click away.
 *
 * It is the same page as every other window, with the same store, reading the
 * same document and hearing the same statuses. It edits nothing: clicking
 * anything sends you to the window that holds it, and the only thing it sends
 * anywhere else is an answer to an agent that asked a question.
 */
import { backend } from '../backend'
import { paneLabel, store, tabLabel } from './state'
import type { NotificationRecord, PaneState, TerminalAlert, TerminalTabState, Workspace } from '../shared/types'
import { ownerOfTab } from '../shared/windowLayout'

let root: HTMLElement
let queued = false
/** Alerts heard since this window opened, newest first. */
const recent: NotificationRecord[] = []
const RECENT_MAX = 30
let busyOnly = false

export function startOverview(): void {
  document.documentElement.classList.add('overview-mode')
  document.title = 'Overview — ia_workspaces'
  const context = document.getElementById('titlebar-context')
  if (context) context.textContent = 'Overview'

  root = document.createElement('main')
  root.id = 'overview'
  root.className = 'overview'
  document.getElementById('app')!.appendChild(root)

  store.subscribe(queue)

  // What every window hears as it happens, and what this one missed before it
  // opened — the agents already working when the overview was asked for.
  backend().on.paneStatus(({ paneId, activity, agent, command }) => {
    if (activity) store.setPaneActivity(paneId, activity)
    if (agent) store.setPaneAgent(paneId, agent)
    if (command !== undefined) store.setPaneCommand(paneId, command)
  })
  void backend()
    .windows?.statuses()
    .then((all) => {
      for (const { paneId, activity, agent, command } of all) {
        if (activity) store.setPaneActivity(paneId, activity)
        if (agent) store.setPaneAgent(paneId, agent)
        if (command !== undefined) store.setPaneCommand(paneId, command)
      }
    })
  backend().on.alert((alert) => remember(alert))

  // Time-relative labels ("2 min ago") go stale without a change to redraw them.
  setInterval(queue, 30_000)
  render()
}

function remember(alert: TerminalAlert): void {
  const workspace = store.workspaces.find((w) => w.id === alert.workspaceId)
  const pane = store.pane(alert.paneId)
  recent.unshift({
    ...alert,
    id: crypto.randomUUID(),
    at: Date.now(),
    read: false,
    where: [workspace?.name, pane ? paneLabel(pane) : null].filter(Boolean).join(' · '),
  })
  recent.length = Math.min(recent.length, RECENT_MAX)
  queue()
}

function queue(): void {
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    render()
  })
  // A hidden window gets no frames, and an overview behind another window is
  // still worth keeping current for the moment it is looked at.
  setTimeout(() => {
    if (!queued) return
    queued = false
    render()
  }, 250)
}

// ------------------------------------------------------------------- reading

type PaneMood = 'blocked' | 'working' | 'failed' | 'command' | 'active' | 'idle'

/** The one word for what a pane is doing, most urgent first. */
function moodOf(pane: PaneState): PaneMood {
  const agent = store.paneAgent(pane.id)
  if (agent?.state === 'blocked') return 'blocked'
  if (agent?.state === 'working') return 'working'
  if (agent?.state === 'failed') return 'failed'
  if (store.paneCommandRunning(pane.id)) return 'command'
  if (store.paneActivity(pane.id) === 'active') return 'active'
  return 'idle'
}

const MOOD_RANK: Record<PaneMood, number> = { blocked: 5, failed: 4, working: 3, command: 2, active: 1, idle: 0 }

const MOOD_WORD: Record<PaneMood, string> = {
  blocked: 'waiting for you',
  working: 'working',
  failed: 'last turn failed',
  command: 'running a command',
  active: 'printing',
  idle: 'idle',
}

function loudest(panes: PaneState[]): PaneMood {
  return panes.reduce<PaneMood>((acc, p) => {
    const mood = moodOf(p)
    return MOOD_RANK[mood] > MOOD_RANK[acc] ? mood : acc
  }, 'idle')
}

function windowLabelOf(tab: TerminalTabState): string {
  const window = store.openWindows.find((w) => w.id === ownerOfTab(tab))
  return window ? store.windowName(window) : 'Main window'
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return `${h} h ago`
}

// ------------------------------------------------------------------- drawing

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Sends you to the window holding this, showing it. */
function goTo(tab: TerminalTabState, paneId?: string): void {
  void backend().windows?.focus(ownerOfTab(tab), paneId ? { paneId } : { tabId: tab.id })
}

function render(): void {
  if (!root) return
  const scrollTop = root.scrollTop
  const allPanes = store.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes))
  const count = (mood: PaneMood) => allPanes.filter((p) => moodOf(p) === mood).length

  const head = el('header', 'overview-head')
  const totals = el('div', 'overview-totals')
  const parts: Array<[PaneMood, number]> = [
    ['blocked', count('blocked')],
    ['working', count('working')],
    ['command', count('command')],
    ['failed', count('failed')],
  ]
  for (const [mood, n] of parts) {
    if (!n && mood !== 'working') continue
    const chip = el('span', `overview-total mood-${mood}`)
    chip.append(el('span', 'overview-mark'), el('span', '', `${n} ${MOOD_WORD[mood]}`))
    totals.appendChild(chip)
  }
  const filter = el('label', 'overview-filter')
  const box = el('input')
  box.type = 'checkbox'
  box.checked = busyOnly
  box.addEventListener('change', () => {
    busyOnly = box.checked
    render()
  })
  filter.append(box, el('span', '', 'Only busy'))
  head.append(totals, filter)

  const list = el('section', 'overview-list')
  for (const row of store.sidebarRows(true)) {
    const card = workspaceCard(row.workspace, row.depth)
    if (card) list.appendChild(card)
  }
  if (!list.children.length) {
    list.appendChild(el('p', 'overview-empty', busyOnly ? 'Nothing is busy.' : 'No workspaces.'))
  }

  const feed = el('section', 'overview-feed')
  if (recent.length) {
    feed.appendChild(el('h2', 'overview-feed-title', 'Since this window opened'))
    for (const record of recent) {
      const item = el('button', `overview-feed-item trigger-${record.trigger}`)
      item.append(
        el('span', 'overview-feed-when', ago(record.at)),
        el('span', 'overview-feed-what', record.title),
        el('span', 'overview-feed-where', record.where)
      )
      item.title = record.body
      item.addEventListener('click', () => {
        const tab = store.tabOfPane(record.paneId)
        if (tab) goTo(tab, record.paneId)
      })
      feed.appendChild(item)
    }
  }

  root.replaceChildren(head, list, feed)
  root.scrollTop = scrollTop
}

function workspaceCard(workspace: Workspace, depth: number): HTMLElement | null {
  const panes = workspace.tabs.flatMap((t) => t.panes)
  const mood = loudest(panes)
  if (busyOnly && (mood === 'idle' || mood === 'active')) return null

  const card = el('article', `overview-card mood-${mood}`)
  card.style.setProperty('--workspace-color', workspace.color)
  // Nested workspaces still read as nested inside a column, with a smaller step
  // than the sidebar's: a column is narrow, and the colour bar already groups.
  card.style.marginLeft = `${Math.min(depth, 3) * 10}px`

  const title = el('div', 'overview-card-head')
  title.append(el('span', 'overview-swatch'), el('span', 'overview-name', workspace.name))
  if (workspace.branch) title.appendChild(el('span', 'overview-branch', workspace.branch))
  const where = new Set(workspace.tabs.map(windowLabelOf))
  if (where.size) title.appendChild(el('span', 'overview-where', [...where].join(' · ')))
  title.addEventListener('click', () => {
    const first = workspace.tabs[0]
    if (first) void backend().windows?.focus(ownerOfTab(first), { workspaceId: workspace.id })
  })
  card.appendChild(title)

  for (const tab of workspace.tabs) {
    const tabMood = loudest(tab.panes)
    if (busyOnly && (tabMood === 'idle' || tabMood === 'active')) continue
    card.appendChild(tabRow(tab, workspace))
  }
  if (!workspace.tabs.length) card.appendChild(el('p', 'overview-none', 'No tabs open'))
  return card
}

function tabRow(tab: TerminalTabState, workspace: Workspace): HTMLElement {
  const row = el('div', 'overview-tab')
  const label = el('button', 'overview-tab-label')
  label.append(el('span', '', tabLabel(tab)))
  if (store.openWindows.length > 1) label.appendChild(el('span', 'overview-tab-window', windowLabelOf(tab)))
  label.addEventListener('click', () => goTo(tab))
  row.appendChild(label)

  for (const pane of tab.panes) row.appendChild(paneLine(pane, tab, workspace))
  return row
}

function paneLine(pane: PaneState, tab: TerminalTabState, _workspace: Workspace): HTMLElement {
  const mood = moodOf(pane)
  const agent = store.paneAgent(pane.id)
  const line = el('div', `overview-pane mood-${mood}`)

  const top = el('button', 'overview-pane-top')
  top.append(el('span', 'overview-mark'))
  if (tab.panes.length > 1 || pane.kind !== 'terminal') top.appendChild(el('span', 'overview-pane-name', paneLabel(pane)))
  top.appendChild(el('span', 'overview-pane-mood', MOOD_WORD[mood]))
  if (store.attention.has(pane.id)) top.appendChild(el('span', 'attention-dot'))
  const facts: string[] = []
  if (agent?.model) facts.push(agent.model)
  if (typeof agent?.contextPct === 'number') facts.push(`${Math.round(agent.contextPct)}% context`)
  if (agent?.tokens) facts.push(agent.tokens)
  if (facts.length) top.appendChild(el('span', 'overview-pane-facts', facts.join(' · ')))
  top.addEventListener('click', () => goTo(tab, pane.id))
  line.appendChild(top)

  if (typeof agent?.progress === 'number' && mood === 'working') {
    const bar = el('div', 'overview-progress')
    const fill = el('div', 'overview-progress-fill')
    fill.style.width = `${Math.max(0, Math.min(100, agent.progress))}%`
    bar.appendChild(fill)
    line.appendChild(bar)
  }

  // A question, and its answers, right here. The point of an overview is that
  // the agent waiting on you is not waiting on you finding its window.
  if (agent?.state === 'blocked') {
    if (agent.blockedReason) line.appendChild(el('div', 'overview-question', agent.blockedReason))
    if (agent.choices.length && !agent.answeredAt) {
      const choices = el('div', 'overview-choices')
      for (const choice of agent.choices) {
        const button = el('button', 'btn' + (choice.isDefault ? ' primary' : ''), choice.label)
        button.addEventListener('click', () => void backend().agent.answer(pane.id, choice.id))
        choices.appendChild(button)
      }
      line.appendChild(choices)
    } else if (agent.answeredAt) {
      line.appendChild(el('div', 'overview-answered', 'Answered — waiting for it to carry on'))
    }
  }
  return line
}
