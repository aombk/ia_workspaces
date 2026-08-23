/**
 * What you actually run in this project — derived, never configured.
 *
 * Every project has a handful of commands that are the whole of working on it:
 * the build, the test, the release, the one script with the argument nobody
 * remembers. They are normally written down in a README that goes stale, or in
 * nobody's head, and the honest version of them has been sitting in the command
 * history all along — with the part a README can never have, which is *whether
 * they worked*.
 *
 * So this configures nothing and asks for nothing. It reads what has been run
 * in this workspace's folder, ranks it, and says what happened. A project you
 * last touched a month ago answers "how do I build this" without you guessing.
 *
 * **Three groups, and the middle one is the point.** A command that has always
 * worked is reference. A command that is failing right now is the thing you
 * came here about. A command that *usually* works and sometimes does not is the
 * one worth knowing about before you run it — it is almost always the one with
 * an argument that has to be right.
 *
 * **Nothing here runs anything.** Picking a row puts it on the prompt, exactly
 * as the history box does, and for the same reason: what you last ran might be
 * a deploy, and putting it in front of the Enter key on somebody's behalf is
 * not a decision this app gets to make.
 */
import type { AuxPane } from './auxPane'
import { store } from './state'
import { backend } from '../backend'
import { allHistory, refreshPaneHistory, watchHistory } from './ui/paneHistory'
import type { HistoryEntry } from '../shared/types'

/** Rows per group before the rest become a count. */
const ROWS = 12

/**
 * Runs before a command is ranked on its failure rate rather than its count.
 *
 * One run that failed is not a flaky command, it is a command you got wrong
 * once — and a project's list would otherwise be led by every typo ever made
 * in it. Below this, a command sorts on how often it is run.
 */
const ENOUGH_RUNS = 3

export class RunbookPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly body: HTMLDivElement
  private unwatch: (() => void) | null = null
  private disposed = false

  constructor(
    readonly paneId: string,
    private readonly workspaceId: string
  ) {
    this.element = document.createElement('div')
    this.element.className = 'runbook-pane'

    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent =
      'The commands you actually run in this project, taken from what has been run here rather ' +
      'than from anything you had to write down. Picking one puts it on the prompt without running it.'
    this.element.appendChild(about)

    this.body = document.createElement('div')
    this.body.className = 'runbook-body'
    this.element.appendChild(this.body)

    this.render()
    this.unwatch = watchHistory(() => this.render())
    // Forced, because the cache is normally kept warm by typing in a terminal
    // and somebody opening this pane may not have typed in one for an hour.
    refreshPaneHistory(true)
  }

  /** Cheap and idempotent: the workspace's folder can change under this. */
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
    const workspace = store.workspaces.find((w) => w.id === this.workspaceId)
    this.body.replaceChildren()

    if (!workspace) {
      this.body.appendChild(this.note('This workspace is gone.'))
      return
    }

    const here = this.commandsHere(workspace.cwd)
    if (!here.length) {
      this.body.appendChild(
        this.note(
          `Nothing has been recorded in ${workspace.cwd} yet. Commands are noted as you run them, ` +
            'through the same shell integration that tracks the folder and the exit code — so a pane ' +
            'running a shell that has none contributes nothing here.'
        )
      )
      return
    }

    const broken = here.filter((e) => e.lastCode !== undefined && e.lastCode !== 0)
    const flaky = here.filter((e) => e.lastCode === 0 && (e.fails ?? 0) > 0)
    const solid = here.filter((e) => !broken.includes(e) && !flaky.includes(e))

    // Broken first: it is the only group anybody opens this pane in a hurry for.
    if (broken.length)
      this.body.appendChild(
        this.group(
          'failing now',
          'Ended in an error the last time it ran here.',
          broken,
          'runbook-card--bad'
        )
      )
    if (flaky.length)
      this.body.appendChild(
        this.group(
          'works, but not always',
          'Worked last time and has failed before — usually the one with an argument that has to be right.',
          flaky,
          'runbook-card--warn'
        )
      )
    if (solid.length)
      this.body.appendChild(
        this.group('what you run here', 'Most run first. None of these has failed.', solid, '')
      )
  }

  /**
   * Everything run in this workspace's folder, or below it.
   *
   * Below it as well, because a command run in `src/` is a command run in this
   * project — the folder a terminal happens to be sitting in is not a statement
   * about which project it belongs to.
   */
  private commandsHere(cwd: string): HistoryEntry[] {
    const root = norm(cwd)
    if (!root) return []
    return allHistory()
      .filter((entry) => {
        const at = norm(entry.cwd)
        return at === root || at.startsWith(`${root}/`)
      })
      .slice()
      .sort(rank)
  }

  private group(title: string, hint: string, entries: HistoryEntry[], extra: string): HTMLElement {
    const card = document.createElement('div')
    card.className = extra ? `runbook-card ${extra}` : 'runbook-card'

    const head = document.createElement('h3')
    head.textContent = title
    card.appendChild(head)

    const note = document.createElement('p')
    note.className = 'runbook-hint'
    note.textContent = hint
    card.appendChild(note)

    for (const entry of entries.slice(0, ROWS)) card.appendChild(this.row(entry))

    const rest = entries.length - ROWS
    if (rest > 0) {
      // Said out loud. A list that silently stops is a list you cannot trust the
      // top of either.
      const more = document.createElement('p')
      more.className = 'runbook-hint'
      more.textContent = `and ${rest} more — Ctrl+Alt+H searches all of them`
      card.appendChild(more)
    }
    return card
  }

  private row(entry: HistoryEntry): HTMLElement {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'runbook-row'
    row.title = 'Put this on the prompt. It is not run.'

    const command = document.createElement('span')
    command.className = 'runbook-command'
    command.textContent = entry.command
    row.appendChild(command)

    const facts = document.createElement('span')
    facts.className = 'runbook-facts'
    facts.textContent = factsOf(entry)
    row.appendChild(facts)

    row.addEventListener('click', () => {
      const target = store.activeTab?.activePaneId
      if (target) void backend().pty.write(target, entry.command)
    })
    return row
  }

  private note(text: string): HTMLElement {
    const el = document.createElement('p')
    el.className = 'runbook-note'
    el.textContent = text
    return el
  }
}

/**
 * Path comparison as the filesystem means it, not as JavaScript does.
 *
 * Windows writes separators both ways round and does not care about case, so
 * the same folder arrives spelled three ways across a week of use.
 */
function norm(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Most worth showing first.
 *
 * How often it is run, except where it has run enough times for its failure
 * rate to mean anything — a command that fails half the time is more worth
 * seeing than one run twice as often that always works. Recency breaks ties,
 * because two commands run the same number of times are told apart by which
 * one you were using this morning.
 */
function rank(a: HistoryEntry, b: HistoryEntry): number {
  const aRuns = a.runs ?? 1
  const bRuns = b.runs ?? 1
  if (aRuns >= ENOUGH_RUNS && bRuns >= ENOUGH_RUNS) {
    const aRate = (a.fails ?? 0) / aRuns
    const bRate = (b.fails ?? 0) / bRuns
    if (aRate !== bRate) return bRate - aRate
  }
  return bRuns - aRuns || b.at - a.at
}

/** The row's right-hand side: how much this command has been used, and how it went. */
function factsOf(entry: HistoryEntry): string {
  const runs = entry.runs ?? 1
  const fails = entry.fails ?? 0
  const parts = [runs === 1 ? 'once' : `${runs} times`]
  if (fails) parts.push(`${fails} failed`)
  if (entry.lastCode !== undefined && entry.lastCode !== 0) parts.push(`exit ${entry.lastCode}`)
  if (entry.lastMs !== undefined) parts.push(took(entry.lastMs))
  return parts.join(' · ')
}

/** A duration a person would say out loud. */
function took(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 90) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}
