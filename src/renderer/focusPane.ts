/**
 * The project's own desk: where the time went, what is left to do, and a timer.
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
 * - **To do** is the project's own `NOTES.md`, which already exists and which
 *   the editor pane already opens. Markdown checkboxes, so the list is the
 *   notes, versions in git with the code, and is readable in anything.
 * - **The timer** is a timer. It is here because it is the one part that has to
 *   be started deliberately, and because it belongs beside the thing it times.
 */
import type { AuxPane } from './auxPane'
import { store } from './state'
import { backend } from '../backend'
import { joinPath } from '../shared/platform'
import {
  byDay,
  dayKey,
  duration,
  refreshTimeNow,
  timeSpans,
  watchTime,
} from './ui/timeMonitor'

/** Days of history in the little bar chart. Three weeks fits and reads. */
const DAYS = 21

/** The two halves of a pomodoro, in minutes. The traditional pair. */
const WORK_MIN = 25
const BREAK_MIN = 5

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

  /** The notes file's lines, held so a toggle can rewrite exactly one of them. */
  private lines: string[] = []
  private tasks: Task[] = []
  private notesError = ''

  private endsAt = 0
  private onBreak = false
  private tick: ReturnType<typeof setInterval> | null = null

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
      'stop. Tasks are the checkboxes in the project’s own NOTES.md, so the list lives with the code.'
    this.element.appendChild(about)

    this.body = document.createElement('div')
    this.body.className = 'focus-body'
    this.element.appendChild(this.body)

    this.render()
    this.unwatch = watchTime(() => this.render())
    refreshTimeNow()
    void this.loadTasks()
  }

  sync(): void {
    this.render()
  }

  dispose(): void {
    this.disposed = true
    this.unwatch?.()
    this.unwatch = null
    if (this.tick) clearInterval(this.tick)
    this.tick = null
  }

  private workspace() {
    return store.workspaces.find((w) => w.id === this.workspaceId) ?? null
  }

  private render(): void {
    if (this.disposed) return
    const workspace = this.workspace()
    this.body.replaceChildren()

    if (!workspace) {
      this.body.appendChild(note('This workspace is gone.'))
      return
    }

    this.body.appendChild(this.timeCard(workspace.cwd))
    this.body.appendChild(this.tasksCard())
    this.body.appendChild(this.timerCard())
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
      figure(duration(today), 'today'),
      figure(duration(week), 'last 7 days'),
      figure(duration(total), 'all time')
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
      cell.title = `${bar.key} — ${bar.ms ? duration(bar.ms) : 'nothing'}`
      if (!bar.ms) cell.classList.add('empty')
      wrap.appendChild(cell)
    }
    return wrap
  }

  // ------------------------------------------------------------------ tasks

  private notesPath(): string {
    const workspace = this.workspace()
    if (!workspace) return ''
    return joinPath(backend().capabilities.platform, workspace.cwd, 'NOTES.md')
  }

  private async loadTasks(): Promise<void> {
    const file = this.notesPath()
    if (!file) return
    try {
      const text = await backend().readText(file)
      this.lines = text.split('\n')
      this.notesError = ''
    } catch {
      // No NOTES.md yet is the ordinary case for a project nobody has written
      // one for, and is not an error worth showing as one.
      this.lines = []
      this.notesError = ''
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

    if (this.notesError) {
      card.appendChild(note(this.notesError))
      return card
    }

    if (!this.tasks.length) {
      card.appendChild(
        note(
          'No checkboxes in this project’s NOTES.md. Add a line like “- [ ] fix the parser” and it ' +
            'appears here — the list is the notes file, so it travels with the project.'
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
   * different — anything else in `NOTES.md` is somebody's prose and must come
   * through untouched, including whatever they did with indentation.
   */
  private async toggle(task: Task): Promise<void> {
    const file = this.notesPath()
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
      this.notesError = 'That could not be saved to NOTES.md.'
      await this.loadTasks()
    }
  }

  // ------------------------------------------------------------------ timer

  private timerCard(): HTMLElement {
    const card = document.createElement('div')
    card.className = 'focus-card'
    card.appendChild(heading(this.onBreak ? 'break' : 'timer'))

    const left = this.endsAt ? Math.max(0, this.endsAt - Date.now()) : 0

    const clock = document.createElement('div')
    clock.className = 'focus-clock' + (this.endsAt ? ' running' : '')
    clock.textContent = this.endsAt ? clockText(left) : `${WORK_MIN}:00`
    card.appendChild(clock)

    const buttons = document.createElement('div')
    buttons.className = 'focus-buttons'

    // Both buttons are always here, one of them dead, so neither moves under
    // the cursor when the timer starts or stops.
    buttons.appendChild(
      button(this.endsAt ? 'Stop' : `Start ${WORK_MIN} minutes`, () => this.startStop())
    )
    buttons.appendChild(
      button('Take a break', () => this.start(BREAK_MIN, true), this.endsAt !== 0)
    )
    card.appendChild(buttons)

    card.appendChild(
      note(
        'A plain pomodoro. It does not need to be running for time to be counted — that happens ' +
          'anyway, above. This is for deciding to concentrate, which is a different thing.'
      )
    )
    return card
  }

  private startStop(): void {
    if (this.endsAt) {
      this.endsAt = 0
      this.onBreak = false
      if (this.tick) clearInterval(this.tick)
      this.tick = null
      this.render()
      return
    }
    this.start(WORK_MIN, false)
  }

  private start(minutes: number, isBreak: boolean): void {
    this.endsAt = Date.now() + minutes * 60_000
    this.onBreak = isBreak
    if (this.tick) clearInterval(this.tick)
    // Every second, because the number on screen is seconds. This is the only
    // clock in the app that has to be that fast, and it stops when it is done.
    this.tick = setInterval(() => this.onTick(), 1000)
    this.render()
  }

  private onTick(): void {
    if (this.disposed) return
    if (Date.now() < this.endsAt) {
      this.render()
      return
    }

    const wasBreak = this.onBreak
    this.endsAt = 0
    this.onBreak = false
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    this.render()

    const workspace = this.workspace()
    void backend()
      .notify({
        title: wasBreak ? 'Break over' : `${WORK_MIN} minutes done`,
        body: workspace ? workspace.name : '',
        paneId: this.paneId,
        workspaceId: this.workspaceId,
      })
      .catch(() => {
        // Notifications can be refused by the system. The pane already says it.
      })
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

function clockText(ms: number): string {
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
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
