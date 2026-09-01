/**
 * What you actually did today, assembled rather than remembered.
 *
 * The one genuinely useful thing in Sunsama and Akiflow is not the planning —
 * it is the review, and the review is the part people fake. At six o'clock
 * nobody can reconstruct the morning, so the answer gets rounded into
 * "worked on the thing", and a week later there is no record at all.
 *
 * Every fact here was already on this disk: which projects had the window, for
 * how long, what was run in them, what failed, and what got committed. Nothing
 * was typed into a form. That is the whole argument for it existing.
 *
 * Across projects and for one day, which is what makes it a pane
 * of its own rather than another card in `focusPane.ts` — that one answers
 * "how is this project going", and this one answers "where did today go".
 */
import type { AuxPane } from './auxPane'
import { backend } from '../backend'
import { allHistory, refreshPaneHistory, watchHistory } from './ui/paneHistory'
import { byDay, dayKey, durationMs, refreshTimeNow, timeSpans, watchTime } from './ui/timeMonitor'
import type { Commit, HistoryEntry } from '../shared/types'
import { inProject } from '../shared/runbook'
import { store } from './state'

/** Commits are fetched per project, so only for the ones you actually touched. */
const MAX_PROJECTS_FOR_COMMITS = 8

interface Line {
  cwd: string
  name: string
  ms: number
  commands: HistoryEntry[]
  commits: Commit[]
}

export class DayPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly body: HTMLDivElement
  private readonly stops: (() => void)[] = []
  private disposed = false

  /** Which day is being shown. Zero is today, one is yesterday. */
  private back = 0
  /** Commits by project folder, for the day on screen. Cleared when the day changes. */
  private commits = new Map<string, Commit[]>()
  /**
   * Whether to show only the project you are standing in.
   *
   * On by default, and that is a change of emphasis worth naming: this pane was
   * built to answer "where did the day go" across every project, and opening it
   * unscoped answers a question you mostly have at the end of a week rather than
   * in the middle of an afternoon. The wider view is one click away and keeps
   * its own paragraph below; what moved is which of the two you get first.
   */
  private here = true

  constructor(readonly paneId: string) {
    this.element = document.createElement('div')
    this.element.className = 'day-pane'

    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent =
      'Where the day went, put together from what already happened — time with each project in ' +
      'front of you, the commands you ran there, and what you committed. Nothing to fill in.'
    this.element.appendChild(about)

    this.body = document.createElement('div')
    this.body.className = 'day-body'
    this.element.appendChild(this.body)

    this.render()
    this.stops.push(watchTime(() => this.render()))
    this.stops.push(watchHistory(() => this.render()))
    refreshTimeNow()
    refreshPaneHistory(true)
    void this.loadCommits()
  }

  sync(): void {
    this.render()
  }

  dispose(): void {
    this.disposed = true
    for (const stop of this.stops) stop()
  }

  /** The midnight-to-midnight window being shown. */
  private window(): { from: number; to: number; key: string } {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - this.back)
    const from = start.getTime()
    const end = new Date(from)
    end.setDate(end.getDate() + 1)
    return { from, to: end.getTime(), key: dayKey(from) }
  }

  /**
   * Everything that happened in the window, by project, most time first.
   *
   * Time decides the order rather than commits or commands, because time is
   * the thing the day was actually made of — an afternoon of reading leaves no
   * commits and was still the afternoon.
   */
  private lines(): Line[] {
    const { from, to, key } = this.window()
    const out = new Map<string, Line>()

    // Applied at the end rather than while collecting: the folders are gathered
    // from three sources that name them slightly differently, and filtering
    // each one separately is three chances to disagree about what "this
    // project" includes.
    const root = this.here ? (store.workspaceOfPane(this.paneId)?.cwd ?? '') : ''

    for (const span of timeSpans()) {
      if (span.end <= from || span.start >= to) continue
      const id = norm(span.cwd)
      const line = out.get(id) ?? { cwd: span.cwd, name: span.name, ms: 0, commands: [], commits: [] }
      // Through `byDay` so a session across midnight is split at it rather than
      // counted whole against whichever day it began in.
      line.name = span.name || line.name
      out.set(id, line)
    }

    // The per-day totals, which already handle the midnight split properly.
    for (const [id, line] of out) {
      line.ms = byDay(timeSpans(), line.cwd).get(key) ?? 0
      if (!line.ms) out.delete(id)
      else if (root && !inProject({ cwd: line.cwd }, root)) out.delete(id)
    }

    for (const entry of allHistory()) {
      if (entry.at < from || entry.at >= to || !entry.cwd) continue
      const id = ownerOf(entry.cwd, [...out.values()])
      if (!id) continue
      out.get(norm(id))?.commands.push(entry)
    }

    for (const line of out.values()) line.commits = this.commits.get(norm(line.cwd)) ?? []

    return [...out.values()].sort((a, b) => b.ms - a.ms)
  }

  /**
   * Commits made in the window, asked of git once per project that had time.
   *
   * Only those projects, and only a few of them: this is the one thing here
   * that costs a process, and a day is spent in a handful of places. Everything
   * else on this screen was already in memory.
   */
  private async loadCommits(): Promise<void> {
    const { from, to } = this.window()
    const projects = this.lines().slice(0, MAX_PROJECTS_FOR_COMMITS)

    for (const line of projects) {
      try {
        const history = await backend().git.history(line.cwd, 80)
        if (this.disposed) return
        this.commits.set(
          norm(line.cwd),
          history.filter((c) => c.at >= from && c.at < to)
        )
      } catch {
        // Not a repository, or git is not there. No commits to show, which is
        // also the answer for a project that simply had none.
      }
    }
    this.render()
  }

  private render(): void {
    if (this.disposed) return
    this.body.replaceChildren()

    this.body.appendChild(this.header())

    const lines = this.lines()
    if (!lines.length) {
      this.body.appendChild(
        note(
          this.back === 0
            ? 'Nothing recorded today yet. Time is counted while a workspace is on screen and this ' +
                'window has focus, in stretches of half a minute or more.'
            : 'Nothing was recorded on this day.'
        )
      )
      return
    }

    const total = lines.reduce((sum, line) => sum + line.ms, 0)
    const commands = lines.reduce((sum, line) => sum + line.commands.length, 0)
    const failed = lines.reduce(
      (sum, line) => sum + line.commands.filter((c) => c.lastCode !== undefined && c.lastCode !== 0).length,
      0
    )
    const commits = lines.reduce((sum, line) => sum + line.commits.length, 0)

    const figures = document.createElement('div')
    figures.className = 'day-figures'
    figures.append(
      figure(durationMs(total), 'at the keyboard'),
      figure(String(lines.length), lines.length === 1 ? 'project' : 'projects'),
      figure(String(commands), commands === 1 ? 'command' : 'commands'),
      figure(String(commits), commits === 1 ? 'save' : 'saves')
    )
    if (failed) figures.appendChild(figure(String(failed), failed === 1 ? 'failed' : 'failed'))
    this.body.appendChild(figures)

    for (const line of lines) this.body.appendChild(this.card(line))
  }

  private header(): HTMLElement {
    const head = document.createElement('div')
    head.className = 'day-head'

    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'btn'
    back.textContent = '‹'
    back.title = 'The day before'
    back.addEventListener('click', () => this.go(1))

    const label = document.createElement('span')
    label.className = 'day-label'
    label.textContent = this.back === 0 ? 'today' : this.back === 1 ? 'yesterday' : this.window().key

    const forward = document.createElement('button')
    forward.type = 'button'
    forward.className = 'btn'
    forward.textContent = '›'
    forward.title = 'The day after'
    // Kept rather than removed at today, so the pair does not move under the
    // cursor on the day you are most likely to be clicking them.
    forward.disabled = this.back === 0
    forward.addEventListener('click', () => this.go(-1))

    // Same control and the same words as the prompt explorer's, because it is
    // the same question about a different list. Two pieces of chrome meaning
    // one thing should not be two different shapes.
    const scope = document.createElement('label')
    scope.className = 'day-scope'
    scope.title = 'Only the project this workspace is in, or below it.'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.here
    box.addEventListener('change', () => {
      this.here = box.checked
      this.render()
    })
    scope.appendChild(box)
    scope.appendChild(document.createTextNode('this project'))

    head.append(back, label, forward, scope)
    return head
  }

  private go(by: number): void {
    this.back = Math.max(0, this.back + by)
    this.commits.clear()
    this.render()
    void this.loadCommits()
  }

  private card(line: Line): HTMLElement {
    const card = document.createElement('div')
    card.className = 'day-card'

    const head = document.createElement('h3')
    head.textContent = line.name || line.cwd
    const time = document.createElement('span')
    time.className = 'day-card__time'
    time.textContent = durationMs(line.ms)
    head.appendChild(time)
    card.appendChild(head)

    for (const commit of line.commits) {
      const row = document.createElement('div')
      row.className = 'day-item day-item--commit'
      row.textContent = `saved “${commit.subject}”`
      card.appendChild(row)
    }

    // The commands are the texture of the day and there can be a lot of them,
    // so the failures come first: they are what you would want reminding of.
    const commands = line.commands.slice().sort((a, b) => rankFail(b) - rankFail(a) || b.at - a.at)
    for (const entry of commands.slice(0, 8)) {
      const row = document.createElement('div')
      const bad = entry.lastCode !== undefined && entry.lastCode !== 0
      row.className = 'day-item' + (bad ? ' day-item--bad' : '')
      row.textContent = bad ? `${entry.command} — failed (exit ${entry.lastCode})` : entry.command
      card.appendChild(row)
    }
    if (commands.length > 8) {
      const rest = document.createElement('div')
      rest.className = 'day-item day-item--more'
      rest.textContent = `and ${commands.length - 8} more commands`
      card.appendChild(rest)
    }

    if (!line.commits.length && !commands.length) {
      card.appendChild(note('Time here, but nothing run and nothing saved — reading, or thinking.'))
    }
    return card
  }
}

function rankFail(entry: HistoryEntry): number {
  return entry.lastCode !== undefined && entry.lastCode !== 0 ? 1 : 0
}

/** Which of the day's projects a command's folder belongs to, if any. */
function ownerOf(cwd: string, lines: Line[]): string | null {
  const at = norm(cwd)
  let best: string | null = null
  for (const line of lines) {
    const root = norm(line.cwd)
    // The longest match wins, so a command in a nested project is filed under
    // the nested one rather than under its parent.
    if ((at === root || at.startsWith(`${root}/`)) && (!best || root.length > norm(best).length)) {
      best = line.cwd
    }
  }
  return best
}

function norm(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function figure(value: string, label: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'day-figure'
  const big = document.createElement('div')
  big.className = 'day-figure__value'
  big.textContent = value
  const small = document.createElement('div')
  small.className = 'day-figure__label'
  small.textContent = label
  wrap.append(big, small)
  return wrap
}

function note(text: string): HTMLElement {
  const el = document.createElement('p')
  el.className = 'day-note'
  el.textContent = text
  return el
}
