/**
 * Claude Code's usage limits, in the sidebar footer.
 *
 * Two numbers and two clocks: how much of the 5-hour session window is gone and
 * when it resets, and the same for the 7-day total. Both come from Anthropic's
 * own usage endpoint via the token Claude Code is already signed in with — none
 * of it is inferred from token counts on disk, because a monitor that guesses
 * is worse than no monitor.
 *
 * When the numbers are not available it says so rather than showing a zero. The
 * distinction matters most at 0%, which is exactly what "signed out" would look
 * like if it were faked.
 */
import { backend } from '../../backend'
import { store } from '../state'
import type { UsageReport } from '../../shared/types'

/**
 * How often to ask.
 *
 * A network round trip per pane repaint would be absurd, and the underlying
 * windows move on the scale of hours. Five minutes matches what the Rainmeter
 * skin settled on.
 */
const POLL_MS = 5 * 60 * 1000
/** A quick retry after a failure, so a laptop waking up recovers promptly. */
const RETRY_MS = 45 * 1000

let timer: ReturnType<typeof setTimeout> | null = null
let latest: UsageReport | null = null
/**
 * Whether the next read should ask the macOS keychain again.
 *
 * A dismissed keychain dialog is remembered in the main process so the
 * five-minute poll cannot raise another one every five minutes. Opening the
 * monitor panel is a deliberate act that means "show me this", so it is the
 * moment worth spending a second dialog on — and the only one, since it is
 * cleared as soon as it has been used.
 */
let retryKeychain = false

/**
 * The sidebar's own footer, not the status bar.
 *
 * Your Claude limits are not a property of the workspace you happen to be
 * looking at, so they sit with the app-wide controls rather than beside the
 * pane's shell and folder.
 */
const el = () => document.getElementById('sidebar-usage') as HTMLElement

export function initUsageMonitor(): void {
  void refresh()
  // The percentages only move when we ask, but the countdown moves on its own.
  // Repainting a minute at a time keeps it honest without another request.
  setInterval(() => renderUsage(), 60_000)
  // Coming back to the window is the moment you are most likely to look at it.
  window.addEventListener('focus', () => {
    if (latest?.status !== 'ok') void refresh()
  })
}

export function renderUsage(): void {
  const host = el()
  if (!store.settings.showUsageMonitor) {
    host.hidden = true
    return
  }
  host.hidden = false
  host.replaceChildren()

  if (!latest) {
    host.textContent = 'Claude usage …'
    host.className = 'sidebar-usage muted'
    return
  }

  if (latest.status !== 'ok') {
    host.className = 'sidebar-usage muted'
    host.textContent = EXPLANATION[latest.status]
    host.title = 'Claude Code usage could not be read'
    return
  }

  host.className = 'sidebar-usage'
  for (const bucket of latest.buckets) {
    const row = document.createElement('div')
    row.className = `usage-row usage-row--${severity(bucket.percent)}`
    row.title = `${bucket.label}: ${bucket.percent}% used${resetPhrase(bucket.resetsAt)}`

    const head = document.createElement('div')
    head.className = 'usage-row__head'

    const label = document.createElement('span')
    label.className = 'usage-row__label'
    label.textContent = SHORT[bucket.id] ?? bucket.id
    head.appendChild(label)

    const value = document.createElement('span')
    value.className = 'usage-row__value'
    value.textContent = `${bucket.percent}%`
    head.appendChild(value)
    row.appendChild(head)

    const track = document.createElement('span')
    track.className = 'usage-row__track'
    const fill = document.createElement('span')
    fill.className = 'usage-row__fill'
    fill.style.width = `${Math.min(100, Math.max(0, bucket.percent))}%`
    track.appendChild(fill)
    row.appendChild(track)

    // On its own line rather than in the tooltip. "29%" only answers half the
    // question — whether to start something long depends on how long you have,
    // and a number you have to hover to see is a number you do not read.
    const reset = document.createElement('span')
    reset.className = 'usage-row__reset'
    reset.textContent = resetLine(bucket.resetsAt)
    row.appendChild(reset)

    host.appendChild(row)
  }
}

const SHORT: Record<string, string> = {
  fiveHour: '5 hour',
  sevenDay: '7 day',
  sevenDayOpus: 'opus',
}

const EXPLANATION: Record<string, string> = {
  'signed-out': 'Claude usage — not signed in',
  expired: 'Claude usage — sign-in expired',
  unmetered: 'Claude usage — not metered',
  error: 'Claude usage — unavailable',
  // The one that is not a failure. macOS keeps Claude Code's login in the
  // keychain, and the keychain asked whether we could read it and was told no.
  locked: 'Claude usage — keychain not allowed',
}

/** Colour bands. Only the top one is loud, or it stops meaning anything. */
function severity(percent: number): string {
  if (percent >= 90) return 'high'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/**
 * "resets in 2h 14m · 18:40", for the line under the bar.
 *
 * Both the countdown and the clock time, because they answer different
 * questions: how long you have left, and when to come back.
 */
function resetLine(resetsAt: string | null): string {
  if (!resetsAt) return 'not metered'
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return ''

  const ms = at.getTime() - Date.now()
  if (ms <= 0) return 'resets now'

  const clock = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay = at.toDateString() === new Date().toDateString()
  const when = sameDay
    ? clock
    : `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`
  return `resets in ${countdown(ms)} · ${when}`
}

/** "1d 4h", "2h 14m" or "9m" — the largest two units that still say something. */
function countdown(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

/**
 * "resets in 2h 14m (today 18:40)".
 *
 * Both forms, because the countdown answers "can I keep going" and the clock
 * time answers "when do I come back".
 */
function resetPhrase(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return ''

  const ms = at.getTime() - Date.now()
  if (ms <= 0) return ' — resets now'

  const sameDay = at.toDateString() === new Date().toDateString()
  const clock = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const when = sameDay
    ? `today ${clock}`
    : `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${clock}`
  return ` — resets in ${countdown(ms)} (${when})`
}

async function refresh(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null

  // Deliberately not gated on `showUsageMonitor`. That setting is about the
  // *sidebar footer*, and this used to skip the request whenever it was off —
  // which was right when the footer was the only thing drawing these numbers,
  // and became a bug the moment the monitor pane started drawing them too: the
  // pane's block sat on "Reading your usage limits…" for as long as the app ran,
  // because nothing was ever going to ask. One request every five minutes is
  // also the wrong thing to be economising on when a second consumer exists.
  if (!store.settings.showUsageMonitor && !store.monitorShows('claude')) {
    // Neither of the two places that draw this is showing it, so now there is
    // genuinely nothing to ask for.
    timer = setTimeout(() => void refresh(), POLL_MS)
    renderUsage()
    return
  }

  try {
    latest = await backend().claudeUsage(retryKeychain)
  } catch {
    latest = { status: 'error', buckets: [] }
  }
  retryKeychain = false
  renderUsage()
  timer = setTimeout(() => void refresh(), latest.status === 'ok' ? POLL_MS : RETRY_MS)
}

/**
 * Called when the setting is switched on, or the monitor panel is opened.
 *
 * `askKeychain` is what separates the two. Turning the sidebar row on should not
 * raise a macOS permission dialog out of nowhere; opening the panel that draws
 * these numbers, having previously dismissed one, is exactly when to offer it
 * again.
 */
export function refreshUsageNow(askKeychain = false): void {
  if (askKeychain && latest?.status === 'locked') retryKeychain = true
  void refresh()
}

/**
 * The last report, for anything that wants to draw it somewhere else.
 *
 * Read rather than subscribed to, because the two windows this describes move
 * on the scale of hours: whatever asks gets whatever the five-minute poll last
 * fetched, and a second consumer costs nothing and adds no request. Null before
 * the first answer, which is a different thing from a report saying zero.
 */
export function latestUsage(): UsageReport | null {
  return latest
}

/** How long until a window resets, in the same words the sidebar uses. */
export function usageResetLine(resetsAt: string | null): string {
  return resetLine(resetsAt)
}
