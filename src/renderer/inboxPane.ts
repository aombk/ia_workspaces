/**
 * Every agent parked on a human, from every workspace, in one list.
 *
 * The blocked bar already puts an agent's question in front of you — but only
 * inside the pane asking it, which is the one place you have to have found
 * first. Six workspaces deep that is the whole problem: the tab is tinted, the
 * workspace is tinted, and you still have to go looking. This is the same
 * question and the same answer buttons, somewhere you can leave open.
 *
 * It draws from the declared agent state and nothing else. Unseen-activity is
 * not represented here on purpose: a bell means "something happened", and this
 * is a list of things that will not proceed until you act.
 */
import { backend } from '../backend'
import { store, paneLabel } from './state'
import type { AuxPane } from './auxPane'
import type { PaneAgentState } from '../shared/types'

export interface InboxPaneHooks {
  /** Bring the asking pane to the front, the way a notification does. */
  jumpToPane(workspaceId: string, paneId: string): void
}

/** One row's worth of resolved context, so render() does no lookups. */
interface Entry {
  agent: PaneAgentState
  workspaceId: string
  workspaceName: string
  workspaceColor: string
  where: string
}

export class InboxPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly list: HTMLDivElement
  private signature = ''
  private disposed = false

  constructor(
    readonly paneId: string,
    private readonly hooks: InboxPaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'inbox-pane'

    const head = document.createElement('div')
    head.className = 'inbox-head'
    const title = document.createElement('span')
    title.className = 'inbox-title'
    title.textContent = 'Waiting for you'
    head.appendChild(title)
    this.element.appendChild(head)

    // The list is empty most of the time, which is exactly when it most needs
    // to say what it would contain.
    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent =
      'Every Claude Code pane, in any workspace, that has stopped and is waiting on an answer from you. It stays listed until the agent says it is unblocked.'
    this.element.appendChild(about)

    this.list = document.createElement('div')
    this.list.className = 'inbox-list'
    this.element.appendChild(this.list)

    this.sync()
  }

  private entries(): Entry[] {
    const out: Entry[] = []
    for (const agent of store.blockedPanes()) {
      const workspace = store.workspaceOfPane(agent.paneId)
      const pane = store.pane(agent.paneId)
      // A blocked agent whose pane has since been closed has nothing to jump to
      // and no way to be answered. Drop it rather than draw a dead row.
      if (!workspace || !pane) continue
      out.push({
        agent,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceColor: workspace.color,
        where: paneLabel(pane),
      })
    }
    return out
  }

  /**
   * Redraws only when something in the list actually changed.
   *
   * `sync` runs on every app render — a keystroke's worth of throughput
   * anywhere repaints the status bar and would otherwise rebuild this list
   * under the user's cursor, losing the button they were about to press.
   */
  sync(): void {
    if (this.disposed) return
    const entries = this.entries()
    const signature = entries
      .map(
        (e) =>
          `${e.agent.paneId}|${e.agent.blockedReason ?? ''}|${e.agent.answeredAt ?? ''}|${e.where}|` +
          e.agent.choices.map((c) => c.id + c.label).join(',')
      )
      .join('\n')
    if (signature === this.signature) return
    this.signature = signature

    this.list.replaceChildren()
    if (!entries.length) {
      const empty = document.createElement('div')
      empty.className = 'inbox-empty'
      empty.textContent = 'Nothing is waiting on you right now.'
      this.list.appendChild(empty)
      return
    }
    for (const entry of entries) this.list.appendChild(this.row(entry))
  }

  private row(entry: Entry): HTMLElement {
    const row = document.createElement('div')
    row.className = 'inbox-row'
    row.style.setProperty('--workspace-color', entry.workspaceColor)

    const where = document.createElement('button')
    where.className = 'inbox-where'
    where.title = 'Go to this pane'
    const dot = document.createElement('span')
    dot.className = 'inbox-dot'
    where.appendChild(dot)
    const name = document.createElement('span')
    name.className = 'inbox-where__name'
    name.textContent = `${entry.workspaceName} · ${entry.where}`
    where.appendChild(name)
    where.addEventListener('click', () =>
      this.hooks.jumpToPane(entry.workspaceId, entry.agent.paneId)
    )
    row.appendChild(where)

    const reason = document.createElement('div')
    reason.className = 'inbox-reason'
    reason.textContent = entry.agent.blockedReason || 'Waiting for you'
    row.appendChild(reason)

    const actions = document.createElement('div')
    actions.className = 'inbox-actions'
    // Only the choices the agent declared. We are a relay, not an interpreter:
    // the agent said which answers it accepts and what each one sends, and
    // inventing a button here would mean guessing at somebody else's prompt.
    for (const choice of entry.agent.choices) {
      const button = document.createElement('button')
      button.className = 'inbox-choice' + (choice.isDefault ? ' default' : '')
      button.textContent = choice.label
      button.addEventListener('click', () => {
        void backend().agent.answer(entry.agent.paneId, choice.id)
      })
      actions.appendChild(button)
    }
    if (!entry.agent.choices.length) {
      const note = document.createElement('span')
      note.className = 'inbox-note'
      // Knowing *which* pane is stuck is most of the value even when the only
      // way to answer is to go and type into it.
      note.textContent = 'No preset answers — open the pane to reply'
      actions.appendChild(note)
    }
    if (entry.agent.answeredAt) {
      const sent = document.createElement('span')
      sent.className = 'inbox-sent'
      // The agent clears its own blocked state; until it does we only claim to
      // have delivered the answer, not that it worked.
      sent.textContent = 'answer sent'
      actions.appendChild(sent)
    }
    row.appendChild(actions)

    return row
  }

  dispose(): void {
    this.disposed = true
  }
}
