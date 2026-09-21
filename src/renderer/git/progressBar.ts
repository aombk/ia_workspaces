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
import { formatSize } from '../../shared/gitSize'
import type { GitProgress, SendSize } from '../../shared/types'

/**
 * What a push is carrying, beside the phase: "Uploading 12 files in 3 saves".
 *
 * Said in files because that is the unit a person thinks in — and only here,
 * as the total, never as a running count. Git's progress counts objects, and
 * one file can be several of them across several saves, so a "6 of 12 files"
 * derived from it would be a number that looks measured and is not.
 */
function sendingWhat(size: SendSize): string {
  const files = `${size.files} file${size.files === 1 ? '' : 's'}`
  const saves = `${size.saves} save${size.saves === 1 ? '' : 's'}`
  return `${files} in ${saves}`
}

/**
 * The right-hand figures: how far, how much, how fast.
 *
 *   46% · 6 of 13 objects · 1.2 MB of ~2.1 MB · 1.1 MB/s
 *
 * Each part only when git said it. The "of" total is the estimate worked out
 * before the push began, and only on the upload phase — it is the size of what
 * is being written, and next to "Counting" it would be a total of something
 * else. Marked "~" because git compresses again on the way out, so the upload
 * usually finishes under it.
 */
function countLine(event: GitProgress): string {
  const parts = [`${event.percent}%`]
  if (event.total !== undefined) parts.push(`${event.current} of ${event.total} objects`)
  if (event.bytes !== undefined) {
    const uploading = event.sending && event.phase.startsWith('Writing objects')
    parts.push(uploading ? `${formatSize(event.bytes)} of ~${formatSize(event.sending!.upload)}` : formatSize(event.bytes))
  }
  if (event.rate !== undefined) parts.push(`${formatSize(event.rate)}/s`)
  return parts.join(' · ')
}

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
    this.labelEl.textContent = event.file
      ? `${event.plain} ${event.file}`
      : (event.plain || this.opening) + (event.sending ? ` ${sendingWhat(event.sending)}` : '')

    if (typeof event.percent === 'number') {
      this.determinate(event.percent)
      this.countEl.textContent = countLine(event)
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
