/**
 * What git is doing, on screen, while it is doing it.
 *
 * Every operation in this pane used to be a button that went dead and a toast
 * some seconds later. For picking a file that is exactly right — it is over
 * before a bar could draw. For a push of a large repository over a hotel
 * connection it is a minute of a window that looks broken, and the honest
 * questions at that point ("is it working? is it stuck? is it nearly done?")
 * had no answer anywhere in the app. Git knows all three; it was only ever
 * saying so to a terminal that was not there.
 *
 * Three states, and the middle one is the one that matters:
 *
 * - **hidden**, which is almost always,
 * - **working, with no number**, drawn as a stripe that moves — for the phases
 *   git cannot put a percentage on, and for the first moments of every
 *   operation before its first line of output arrives,
 * - **working, with a number**, drawn as a bar that fills.
 *
 * A bar that only appeared once a percentage was known would be absent for
 * precisely the pause people find alarming — the several seconds a push spends
 * opening a connection before it counts anything — so the stripe exists to fill
 * that gap and turns into a bar the moment there is a number.
 *
 * Nothing here is ever the only report of an outcome. The toast still says what
 * happened, in git's words and ours; this says what is happening, and then goes.
 */
import type { GitProgress } from '../../shared/types'

/** How long a finished bar stays on screen, so a fast operation still registers. */
const LINGER_MS = 600

export class GitProgressBar {
  readonly element: HTMLDivElement
  private readonly labelEl: HTMLDivElement
  private readonly countEl: HTMLDivElement
  private readonly trackEl: HTMLDivElement
  private readonly fillEl: HTMLDivElement

  private hideTimer: ReturnType<typeof setTimeout> | null = null
  /** What the caller called the operation, for the line before git says anything. */
  private opening = ''

  constructor() {
    this.element = document.createElement('div')
    this.element.className = 'git-progress'
    this.element.hidden = true
    // Announced politely: a bar that fires a screen-reader interruption on
    // every percentage would make the pane unusable with one on.
    this.element.setAttribute('role', 'status')
    this.element.setAttribute('aria-live', 'polite')

    const row = document.createElement('div')
    row.className = 'git-progress__row'

    this.labelEl = document.createElement('div')
    this.labelEl.className = 'git-progress__label'
    row.appendChild(this.labelEl)

    this.countEl = document.createElement('div')
    this.countEl.className = 'git-progress__count'
    row.appendChild(this.countEl)

    this.element.appendChild(row)

    this.trackEl = document.createElement('div')
    this.trackEl.className = 'git-progress__track'
    this.fillEl = document.createElement('div')
    this.fillEl.className = 'git-progress__fill'
    this.trackEl.appendChild(this.fillEl)
    this.element.appendChild(this.trackEl)
  }

  /**
   * An operation has started, before git has said anything about it.
   *
   * The label is the caller's, in the caller's words — "Sending your saves" —
   * because for the first second or two of a push there is nothing else to say,
   * and "working…" says less than nothing.
   */
  start(label: string): void {
    this.clearTimer()
    this.opening = label
    this.element.hidden = false
    this.labelEl.textContent = label
    this.countEl.textContent = ''
    this.indeterminate()
  }

  /** One line of what git said. */
  update(event: GitProgress): void {
    if (event.done) return
    this.clearTimer()
    this.element.hidden = false

    // A file name is the most concrete thing there is, so it wins the line
    // whenever there is one — "Picking src/main/git.ts" beats "Picking".
    this.labelEl.textContent = event.file ? `${event.plain} ${event.file}` : event.plain || this.opening

    if (typeof event.percent === 'number') {
      this.determinate(event.percent)
      this.countEl.textContent =
        event.total !== undefined ? `${event.percent}% · ${event.current}/${event.total}` : `${event.percent}%`
    } else {
      this.indeterminate()
      // A count with no total still moves, which is the entire question being
      // asked of it. Objects rather than files: it is git's own unit, and
      // calling them files would be wrong by a factor of anything.
      this.countEl.textContent = event.current !== undefined ? `${event.current}` : ''
    }
  }

  /**
   * The operation is over.
   *
   * Held for a moment first. An operation that finishes in 80ms would otherwise
   * flash a bar for one frame, which reads as a glitch rather than as a report
   * — and the whole reason this exists is to make the app look like it is doing
   * something rather than like it is broken.
   */
  finish(): void {
    this.clearTimer()
    if (this.element.hidden) return
    this.determinate(100)
    this.countEl.textContent = ''
    this.labelEl.textContent = 'Done'
    this.hideTimer = setTimeout(() => {
      this.element.hidden = true
      this.hideTimer = null
    }, LINGER_MS)
  }

  private determinate(percent: number): void {
    const clamped = Math.max(0, Math.min(100, percent))
    this.trackEl.classList.remove('waiting')
    this.fillEl.style.width = `${clamped}%`
    this.element.setAttribute('aria-valuenow', String(Math.round(clamped)))
  }

  private indeterminate(): void {
    this.trackEl.classList.add('waiting')
    this.fillEl.style.removeProperty('width')
    this.element.removeAttribute('aria-valuenow')
  }

  private clearTimer(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
  }

  dispose(): void {
    this.clearTimer()
  }
}
