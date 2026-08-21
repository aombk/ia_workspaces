/**
 * What every machine you work from is part-way through, in one list.
 *
 * The question this exists to answer is asked *before* you know which project
 * it is about — "did I leave something on the laptop?" — which is why it is a
 * tab of its own and not a third view inside the Git pane. A view in there
 * would make you pick the project first, and picking the project first is the
 * thing you are trying to avoid having to do.
 *
 * It reports and offers nothing. There is no button here that saves, sends,
 * brings in or carries anything between machines, and there is not going to be
 * one: the pane's whole job is to put you in a position to decide, in the git
 * pane, on the machine it affects. See `relay.ts` for why moving work is the
 * feature this deliberately is not.
 *
 * **Nothing here is in the present tense.** Every line is what some machine
 * could see when it last wrote, which may have been minutes ago through a sync
 * client or days ago before a lid closed. So every row carries how old it is,
 * and the word "has" never appears without one.
 */
import type { AuxPane } from './auxPane'
import { store } from './state'
import { latestRelay, live, othersFor, stale, watchRelay } from './ui/relayMonitor'
import type { RelayPresence } from '../shared/types'

/** Changed files listed under a machine before the rest become a count. */
const FILES_SHOWN = 6

/** Unsent save messages listed under a machine before the rest become a count. */
const SUBJECTS_SHOWN = 3

export class RelayPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly body: HTMLDivElement
  private unwatch: (() => void) | null = null
  private disposed = false

  constructor(readonly paneId: string) {
    this.element = document.createElement('div')
    this.element.className = 'relay-pane'

    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent =
      'What each of your machines was part-way through, as each of them last reported it. ' +
      'Read from the folder your machines share — nothing here talks to them directly, and ' +
      'nothing here changes a repository on any of them.'
    this.element.appendChild(about)

    this.body = document.createElement('div')
    this.body.className = 'relay-body'
    this.element.appendChild(this.body)

    this.render()
    // Redrawn when a sweep lands rather than on a clock of its own. The one
    // exception would be the ageing timestamps, and a row that silently
    // recomputes "4 minutes ago" into "5 minutes ago" is not worth a timer.
    this.unwatch = watchRelay(() => this.render())
  }

  /** Cheap and idempotent: the store changing can rename a workspace. */
  sync(): void {
    this.render()
  }

  dispose(): void {
    this.disposed = true
    this.unwatch?.()
    this.unwatch = null
  }

  private render(): void {
    if (this.disposed) return
    const relay = latestRelay()
    this.body.replaceChildren()

    if (relay.problem === 'off') {
      this.body.appendChild(
        this.note(
          'Relay is off. It needs a folder your machines can all see — a synced drive or a network ' +
            'share — which is set in Settings, under “A folder your machines share”. The same folder ' +
            'is what pools token counts, so setting it once switches on both.'
        )
      )
      return
    }

    if (relay.problem === 'unreachable') {
      this.body.appendChild(
        this.note(
          'The shared folder cannot be reached right now — an unmounted drive, or a network that is ' +
            'down. Nothing has been lost: this machine will publish again when it comes back, and ' +
            'the other machines’ records are still in the folder.'
        )
      )
      return
    }

    const projects = this.projects()
    if (!projects.length) {
      this.body.appendChild(
        this.note(
          'Nothing has been written to the shared folder yet. This machine publishes within a minute ' +
            'of starting; the others will appear here once ia_workspaces has run on them too.'
        )
      )
      return
    }

    this.body.appendChild(this.headline(projects))
    for (const project of projects) this.body.appendChild(this.card(project))
  }

  /**
   * Every project any machine has reported, most in need of attention first.
   *
   * Deliberately not limited to the workspaces open here. A project you last
   * touched on the MacBook and have not opened on this machine for a week is
   * exactly the one you are most likely to have left something in, and a list
   * that could only show what is already in front of you would answer the
   * question for every case except the one that prompted it.
   */
  private projects(): Project[] {
    const relay = latestRelay()
    const mine = new Set(Object.values(relay.keys))

    const out: Project[] = []
    for (const [key, records] of Object.entries(relay.byProject)) {
      if (!records.length) continue
      const others = records.filter((record) => record.machine !== relay.machine)
      out.push({
        key,
        // The newest record names it. Two machines can disagree about what a
        // workspace is called, and the most recent one to say is the least
        // likely to be a name that was changed here months ago.
        name: records[0].name || 'this project',
        records,
        here: mine.has(key),
        loose: others.reduce((n, record) => n + record.unsent + record.changed.length, 0),
      })
    }

    return out.sort((a, b) => b.loose - a.loose || Number(b.here) - Number(a.here) || a.name.localeCompare(b.name))
  }

  /**
   * The one sentence somebody opened this pane to read.
   *
   * "Nothing" is a real and common answer and it is the whole point: the pane
   * has to be able to end the doubt, not merely describe it. Counting machines
   * rather than files, because "the laptop" is what you go and look at.
   */
  private headline(projects: Project[]): HTMLElement {
    const relay = latestRelay()
    const machines = new Map<string, RelayPresence>()
    for (const project of projects)
      for (const record of project.records) {
        if (record.machine === relay.machine) continue
        if (record.unsent + record.changed.length === 0) continue
        const seen = machines.get(record.machine)
        if (!seen || record.at > seen.at) machines.set(record.machine, record)
      }

    const card = document.createElement('div')
    card.className = 'relay-headline'

    if (!machines.size) {
      card.classList.add('relay-headline--calm')
      card.textContent =
        'No other machine reported anything unsaved or unsent. Every project below was last seen ' +
        'with its work committed and sent.'
      return card
    }

    const names = [...machines.values()].map((record) => record.label)
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    card.textContent =
      `${who} last reported work that had not been sent. ` +
      'What to do about it is below, and on that machine — nothing here can reach it.'
    return card
  }

  private card(project: Project): HTMLElement {
    const card = document.createElement('div')
    card.className = 'relay-card'

    const head = document.createElement('h3')
    head.textContent = project.name
    if (!project.here) {
      // Worth saying plainly. A project with no workspace on this machine is
      // the one whose state you have no other way of seeing.
      const tag = document.createElement('span')
      tag.className = 'relay-tag'
      tag.textContent = 'not open here'
      head.appendChild(tag)
    }
    card.appendChild(head)

    for (const record of project.records) card.appendChild(this.row(record))
    return card
  }

  private row(record: RelayPresence): HTMLElement {
    const relay = latestRelay()
    const mine = record.machine === relay.machine
    const row = document.createElement('div')
    row.className = 'relay-row'
    if (mine) row.classList.add('relay-row--mine')

    const head = document.createElement('div')
    head.className = 'relay-row__head'

    const name = document.createElement('span')
    name.className = 'relay-machine'
    name.textContent = record.label
    head.appendChild(name)

    if (mine) head.appendChild(this.faint('this machine'))
    else if (live(record)) head.appendChild(this.faint('in use'))

    // The timestamp is not optional and not a tooltip. It is the difference
    // between a fact and a guess, and it belongs where the fact is.
    head.appendChild(this.faint(stale(record.at)))
    row.appendChild(head)

    row.appendChild(this.state(record))

    if (record.unsentSubjects.length) {
      const shown = record.unsentSubjects.slice(0, SUBJECTS_SHOWN)
      const rest = record.unsent - shown.length
      row.appendChild(
        this.detail(
          `not sent: ${shown.map((subject) => `“${subject}”`).join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`
        )
      )
    }

    if (record.changed.length) {
      const shown = record.changed.slice(0, FILES_SHOWN)
      const rest = record.changed.length - shown.length
      row.appendChild(this.detail(`changed: ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`))
    }

    // Where it lives over there, which is rarely where it lives here — and is
    // what you need in order to go and find it.
    row.appendChild(this.detail(record.path, 'relay-path'));

    return row
  }

  /**
   * The state of one repository, as one sentence of plain English.
   *
   * The app's own words throughout — saves, sent, brought in — because a person
   * who reads "2 ahead, 1 behind, 3 unstaged" here and "2 saves not sent" in
   * the Git pane is being asked to learn the same fact twice.
   */
  private state(record: RelayPresence): HTMLElement {
    const parts: string[] = []
    if (record.detached) parts.push('not on a branch')
    else if (record.branch) parts.push(`on ${record.branch}`)

    if (record.inProgress) parts.push(`a ${record.inProgress} stopped part-way`)
    if (record.unsent) parts.push(`${count(record.unsent, 'save')} not sent`)
    // A branch with no upstream is not a branch with nothing outstanding. Every
    // save on it is on that machine alone, and git cannot count them because
    // there is nothing to count them against — so it is said rather than summed.
    else if (record.hasRemote && record.branch && !record.upstream)
      parts.push('never sent — every save on it is on that machine only')
    if (record.behind) parts.push(`${count(record.behind, 'save')} not brought in`)
    if (record.changed.length) parts.push(`${count(record.changed.length, 'file')} changed and not saved`)
    if (record.untracked) parts.push(`${count(record.untracked, 'new file')} git is not tracking`)
    if (!record.hasRemote) parts.push('no copy online')

    const line = document.createElement('div')
    line.className = 'relay-state'
    if (parts.length <= 1) {
      // Nothing outstanding. Said out loud rather than left as an empty row,
      // because "everything was saved and sent" is the answer people came for
      // and a blank space does not read as an answer.
      line.classList.add('relay-state--calm')
      line.textContent = parts.length ? `${parts[0]} — everything saved and sent` : 'everything saved and sent'
      return line
    }
    line.textContent = `${parts[0]} — ${parts.slice(1).join(', ')}`
    return line
  }

  private detail(text: string, extra?: string): HTMLElement {
    const el = document.createElement('div')
    el.className = extra ? `relay-detail ${extra}` : 'relay-detail'
    el.textContent = text
    return el
  }

  private faint(text: string): HTMLElement {
    const el = document.createElement('span')
    el.className = 'relay-faint'
    el.textContent = text
    return el
  }

  private note(text: string): HTMLElement {
    const el = document.createElement('p')
    el.className = 'relay-note'
    el.textContent = text
    return el
  }
}

interface Project {
  key: string
  name: string
  records: RelayPresence[]
  /** True when a workspace on this machine points at this project. */
  here: boolean
  /** Unsent saves plus unsaved files across every *other* machine. The sort key. */
  loose: number
}

/** "1 save", "2 saves" — the plural nobody should have to think about. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * The one line the Git pane shows about the other machines.
 *
 * Lives here rather than in `git/` because it is Relay's sentence and Relay's
 * rules — past tense, timestamped, never a claim about right now. The Git pane
 * asks for it and places it; what it is allowed to say is decided in one file.
 *
 * Returns null when there is nothing worth a line, which is the ordinary case.
 * A band that is always there is a band that stops being read, and this one has
 * to work the day it says something.
 */
export function relayLineFor(cwd: string): string | null {
  const others = othersFor(cwd).filter((record) => record.unsent || record.changed.length)
  if (!others.length) return null

  const worst = others[0]
  const parts: string[] = []
  if (worst.unsent) parts.push(`${count(worst.unsent, 'save')} not sent`)
  if (worst.changed.length) parts.push(`${count(worst.changed.length, 'file')} changed and not saved`)
  if (!parts.length) return null

  const where = worst.branch ? ` on ${worst.branch}` : ''
  const rest = others.length > 1 ? `, and ${others.length - 1} other machine${others.length > 2 ? 's' : ''}` : ''
  return `${worst.label} had ${parts.join(' and ')}${where}, ${stale(worst.at)}${rest}.`
}

/**
 * The files another machine last reported having changed and not saved.
 *
 * What the editor's overlap warning is built on. Repository-relative paths, as
 * git says them, because that is the only spelling two machines agree on.
 */
export function changedElsewhere(cwd: string, repoPath: string): RelayPresence | null {
  for (const record of othersFor(cwd)) if (record.changed.includes(repoPath)) return record
  return null
}

/** Which workspace a folder belongs to, for anything holding only a path. */
export function workspaceCwdFor(root: string): string | null {
  return store.workspaces.find((workspace) => workspace.cwd === root)?.cwd ?? null
}
