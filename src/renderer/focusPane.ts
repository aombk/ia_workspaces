/**
 * The project's own desk: where the time went, what is left to do, and breaks.
 *
 * One pane rather than three, because the ask was productivity tools for a
 * project *in one place* — and three tabs holding a number each is the thing
 * that makes people stop opening any of them. The three belong together in use
 * as well as on screen: you look at what is left, start a timer, and the time
 * lands against this project without anybody typing anything.
 *
 * Each part earns its place by needing nothing from you:
 *
 * - **Time** is observed. No start button to forget — see `timeLog.ts` for why
 *   that is the whole difference between this and every tracker people abandon.
 * - **To do** is the project's own `TODO.md`, whose name says what it holds.
 *   Markdown checkboxes, so the list versions in git with the code and is
 *   readable in anything.
 * - **Breaks** take themselves. There used to be a pomodoro here with a start
 *   button, and nobody pressed it; the movement breaks in `shared/moveBreaks.ts`
 *   notice that you have been sitting and come to you, and this only shows
 *   how today has gone.
 */
import type { AuxPane } from './auxPane'
import { Redraw } from './redraw'
import { store } from './state'
import { backend } from '../backend'
import { joinPath } from '../shared/platform'
import type { BreakRecord, BreakState } from '../shared/moveBreaks'
import {
  byDay,
  dayKey,
  durationMs,
  refreshTimeNow,
  timeSpans,
  watchTime,
} from './ui/timeMonitor'

/** Days of history in the little bar chart. Three weeks fits and reads. */
const DAYS = 21

/** A markdown task line: `- [ ] thing` or `* [x] thing`, at any indent. */
const TASK = /^(\s*)([-*])\s+\[( |x|X)\]\s+(.*)$/

interface Task {
  /** Line number in the file, which is how a click knows what to toggle. */
  line: number
  done: boolean
  text: string
}

export class FocusPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly body: HTMLDivElement
  private unwatch: (() => void) | null = null
  private disposed = false
  private readonly redraw: Redraw

  /** The task file's lines, held so a toggle can rewrite exactly one of them. */
  private lines: string[] = []
  private tasks: Task[] = []
  private taskError = ''

  private breaks: BreakState | null = null
  private breaksToday: BreakRecord[] = []
  private unwatchBreaks: (() => void) | null = null

  constructor(
    readonly paneId: string,
    private readonly workspaceId: string
  ) {
    this.element = document.createElement('div')
    this.element.className = 'focus-pane'

    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent =
      'Time on this project, counted while its window is in front of you — nothing to start or ' +
      'stop. Tasks are the checkboxes in the project’s own TODO.md, so the list lives with the code.'
    this.element.appendChild(about)

    this.body = document.createElement('div')
    this.body.className = 'focus-body'
    this.element.appendChild(this.body)

    this.redraw = new Redraw(this.element)
    this.render()
    this.unwatch = watchTime(() => this.refresh())
    refreshTimeNow()
    void this.loadTasks()
    const breaks = backend().breaks
    if (breaks) {
      this.unwatchBreaks = breaks.onChange((state) => {
        this.breaks = state
        void this.loadBreaks()
      })
      void breaks.state().then((state) => {
        this.breaks = state
        void this.loadBreaks()
      })
    }
  }

  private async loadBreaks(): Promise<void> {
    this.breaksToday = (await backend().breaks?.today()) ?? []
    if (!this.disposed) this.refresh()
  }

  sync(): void {
    this.refresh()
  }

  /**
   * Everything the picture is drawn from. The clock's seconds are not in it:
   * they are written into the one element that shows them — see `onTick` —
   * rather than redrawing the card, and its buttons, every second.
   */
  private inputs(): readonly unknown[] {
    return [
      this.workspace()?.cwd,
      timeSpans(),
      this.tasks,
      this.taskError,
      this.breaks?.settings,
      this.breaks?.sittingSince,
      this.breaks?.snoozedUntil,
      this.breaksToday,
      dayKey(Date.now()),
    ]
  }

  /** Redraws for a change from outside, if it changed anything shown. */
  private refresh(): void {
    if (this.redraw.due(this.inputs())) this.render()
  }

  dispose(): void {
    this.disposed = true
    this.unwatch?.()
    this.unwatch = null
    this.unwatchBreaks?.()
    this.unwatchBreaks = null
  }

  private workspace() {
    return store.workspaces.find((w) => w.id === this.workspaceId) ?? null
  }

  private render(): void {
    if (this.disposed) return
    this.redraw.drew(this.inputs())
    const workspace = this.workspace()
    this.body.replaceChildren()

    if (!workspace) {
      this.body.appendChild(note('This workspace is gone.'))
      return
    }

    this.body.appendChild(this.timeCard(workspace.cwd))
    this.body.appendChild(this.tasksCard())
    this.body.appendChild(this.breaksCard())
  }

  // ------------------------------------------------------------------- time

  private timeCard(cwd: string): HTMLElement {
    const card = document.createElement('div')
    card.className = 'focus-card'
    card.appendChild(heading('time on this project'))

    const days = byDay(timeSpans(), cwd)
    const today = days.get(dayKey(Date.now())) ?? 0

    // The last seven days rather than a calendar week: "this week" on a Monday
    // morning is a number that says nothing.
    let week = 0
    let total = 0
    for (const [key, ms] of days) {
      total += ms
      if (withinDays(key, 7)) week += ms
    }

    const row = document.createElement('div')
    row.className = 'focus-figures'
    row.append(
      figure(durationMs(today), 'today'),
      figure(durationMs(week), 'last 7 days'),
      figure(durationMs(total), 'all time')
    )
    card.appendChild(row)

    if (!total) {
      card.appendChild(
        note(
          'Nothing recorded yet. Time is counted while this workspace is on screen and the window ' +
            'has focus, in stretches of half a minute or more.'
        )
      )
      return card
    }

    card.appendChild(this.chart(days))
    return card
  }

  /**
   * The last three weeks, as bars.
   *
   * Days with nothing keep their slot. A chart that skipped them would compress
   * a fortnight off into a gap you cannot see, and the gaps are half of what a
   * timesheet is for.
   */
  private chart(days: Map<string, number>): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'focus-chart'

    const bars: { key: string; ms: number }[] = []
    for (let back = DAYS - 1; back >= 0; back--) {
      const at = new Date()
      at.setHours(12, 0, 0, 0)
      at.setDate(at.getDate() - back)
      const key = dayKey(at.getTime())
      bars.push({ key, ms: days.get(key) ?? 0 })
    }

    const most = Math.max(...bars.map((b) => b.ms), 1)
    for (const bar of bars) {
      const cell = document.createElement('div')
      cell.className = 'focus-bar'
      // A minimum height so an hour and a minute are visibly different from
      // nothing at all, which is the comparison the chart is actually for.
      const height = bar.ms ? Math.max(6, Math.round((bar.ms / most) * 100)) : 0
      cell.style.setProperty('--h', `${height}%`)
      cell.title = `${bar.key} — ${bar.ms ? durationMs(bar.ms) : 'nothing'}`
      if (!bar.ms) cell.classList.add('empty')
      wrap.appendChild(cell)
    }
    return wrap
  }

  // ------------------------------------------------------------------ tasks

  private todoPath(): string {
    const workspace = this.workspace()
    if (!workspace) return ''
    return joinPath(backend().capabilities.platform, workspace.cwd, 'TODO.md')
  }

  private async loadTasks(): Promise<void> {
    const file = this.todoPath()
    if (!file) return
    try {
      const text = await backend().readText(file)
      this.lines = text.split('\n')
      this.taskError = ''
    } catch {
      // No TODO.md yet is the ordinary case for a project nobody has written
      // one for, and is not an error worth showing as one.
      this.lines = []
      this.taskError = ''
    }
    this.tasks = readTasks(this.lines)
    this.render()
  }

  private tasksCard(): HTMLElement {
    const card = document.createElement('div')
    card.className = 'focus-card'

    const open = this.tasks.filter((t) => !t.done)
    const done = this.tasks.filter((t) => t.done)
    card.appendChild(heading(`to do${this.tasks.length ? ` — ${open.length} left` : ''}`))

    if (this.taskError) {
      card.appendChild(note(this.taskError))
      return card
    }

    if (!this.tasks.length) {
      card.appendChild(
        note(
          'No checkboxes in this project’s TODO.md. Add a line like “- [ ] fix the parser” and it ' +
            'appears here — the list is a plain file beside the code, so it travels with the project.'
        )
      )
      return card
    }

    for (const task of [...open, ...done]) card.appendChild(this.taskRow(task))
    return card
  }

  private taskRow(task: Task): HTMLElement {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'focus-task' + (task.done ? ' done' : '')
    row.title = task.done ? 'Mark as not done' : 'Mark as done'

    const box = document.createElement('span')
    box.className = 'focus-check'
    box.textContent = task.done ? '☑' : '☐'
    row.appendChild(box)

    const text = document.createElement('span')
    text.className = 'focus-task__text'
    text.textContent = task.text
    row.appendChild(text)

    row.addEventListener('click', () => void this.toggle(task))
    return row
  }

  /**
   * Flips one checkbox, by rewriting one line.
   *
   * The whole file is written back, but only the one character that changed is
   * different — anything else in `TODO.md` is somebody's prose and must come
   * through untouched, including whatever they did with indentation.
   */
  private async toggle(task: Task): Promise<void> {
    const file = this.todoPath()
    if (!file) return
    const line = this.lines[task.line]
    const match = line?.match(TASK)
    if (!match) {
      // The file changed underneath us — edited in the editor pane, or by an
      // agent. Re-read rather than write over what is now somewhere else.
      await this.loadTasks()
      return
    }

    this.lines[task.line] = `${match[1]}${match[2]} [${task.done ? ' ' : 'x'}] ${match[4]}`
    this.tasks = readTasks(this.lines)
    this.render()

    try {
      await backend().files.writeText(file, this.lines.join('\n'))
    } catch {
      this.taskError = 'That could not be saved to TODO.md.'
      await this.loadTasks()
    }
  }

  // ----------------------------------------------------------------- breaks

  /**
   * Today's movement breaks, and when the next one is.
   *
   * Nothing to start: the break comes when you have been sitting long enough.
   * The one button is for taking it early.
   */
  private breaksCard(): HTMLElement {
    const card = document.createElement('div')
    card.className = 'focus-card'
    card.appendChild(heading('movement breaks'))

    const state = this.breaks
    if (!state) {
      card.appendChild(note('Breaks need the desktop app, which can tell whether you are at the machine.'))
      return card
    }
    if (!state.settings.enabled) {
      card.appendChild(note('Switched off in Settings → Movement breaks.'))
      return card
    }

    const count = (...outcomes: string[]) => this.breaksToday.filter((r) => outcomes.includes(r.outcome)).length
    const row = document.createElement('div')
    row.className = 'focus-figures'
    row.append(
      figure(String(count('done', 'away')), 'got up'),
      figure(String(count('seated')), 'seated'),
      figure(String(count('skipped')), 'skipped')
    )
    card.appendChild(row)

    const now = Date.now()
    let next = 'Away from the machine — the count starts when you are back.'
    if (state.snoozedUntil) next = `Put off; back in ${Math.max(1, Math.ceil((state.snoozedUntil - now) / 60_000))} min.`
    else if (state.sittingSince !== null) {
      const sat = Math.floor((now - state.sittingSince) / 60_000)
      const left = Math.max(0, Math.ceil((state.sittingSince + state.settings.everyMin * 60_000 - now) / 60_000))
      next = `Sitting for ${sat} min; the next break is in ${left} min.`
    }
    card.appendChild(note(next))

    const buttons = document.createElement('div')
    buttons.className = 'focus-buttons'
    buttons.appendChild(button('Take a break now', () => void backend().breaks?.now()))
    card.appendChild(buttons)

    card.appendChild(
      note(
        `Every ${state.settings.everyMin} minutes at the machine, ${state.settings.breakMin} minutes of moving. ` +
          'Walking away for that long counts as a break too.'
      )
    )
    return card
  }
}

/** Every checkbox line, with where it sits, so a toggle can rewrite just that one. */
function readTasks(lines: readonly string[]): Task[] {
  const out: Task[] = []
  lines.forEach((line, index) => {
    const match = line.match(TASK)
    if (!match) return
    out.push({ line: index, done: match[3].toLowerCase() === 'x', text: match[4].trim() })
  })
  return out
}

/** Whether a `2026-08-22` key is within the last `n` days, today included. */
function withinDays(key: string, n: number): boolean {
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - (n - 1))
  return key >= dayKey(cutoff.getTime())
}

function heading(text: string): HTMLElement {
  const el = document.createElement('h3')
  el.textContent = text
  return el
}

function figure(value: string, label: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'focus-figure'
  const big = document.createElement('div')
  big.className = 'focus-figure__value'
  big.textContent = value
  const small = document.createElement('div')
  small.className = 'focus-figure__label'
  small.textContent = label
  wrap.append(big, small)
  return wrap
}

function button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'btn'
  el.textContent = label
  el.disabled = disabled
  el.addEventListener('click', onClick)
  return el
}

function note(text: string): HTMLElement {
  const el = document.createElement('p')
  el.className = 'focus-note'
  el.textContent = text
  return el
}
