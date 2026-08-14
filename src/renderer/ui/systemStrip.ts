/**
 * The machine, in four lines, under the Claude usage rows.
 *
 * Same footer and the same shape as the usage rows deliberately: a label, a
 * number, a bar. They are answering the neighbouring halves of one question —
 * how much of your Claude limit is left, and how much of your machine — and
 * making them look like two different kinds of readout would hide that.
 *
 * Four lines and no more. The strip is for the glance that tells you whether to
 * look; the pane (`MonitorPane`) is for the looking, and there is a link to it
 * at the bottom of this. Anything that cannot be said in a label and a number
 * belongs there, which is why the graphs, the per-core cells and the interface
 * list are all over there and none of them are here.
 *
 * Off by default, unlike the usage rows. Those ride along on a network call the
 * app makes anyway; this one starts a small process every few seconds, and that
 * is not a thing to switch on for somebody without being asked.
 */
import { store } from '../state'
import type { SystemStats } from '../../shared/types'
import { band, bytes, percent, rate, watchSystem } from './systemMonitor'

/**
 * Slower than the pane's two seconds.
 *
 * Nothing in four lines is being watched frame by frame, and this runs whenever
 * the app is open rather than whenever a pane is. When the pane *is* open its
 * faster clock wins for both — see `watchSystem`.
 */
const POLL_MS = 5000

const el = () => document.getElementById('sidebar-system') as HTMLElement

let unwatch: (() => void) | null = null
let latest: SystemStats | null = null
let openMonitor: (() => void) | null = null

/** `onOpen` is what the "open the monitor" link does; the sidebar owns that. */
export function initSystemStrip(onOpen: () => void): void {
  openMonitor = onOpen
  syncSystemStrip()
}

/**
 * Starts or stops the watch to match the setting.
 *
 * Called on every settings change as well as at startup, because the whole
 * point of the switch is that turning it off stops the polling rather than
 * merely hiding what the polling produced.
 */
export function syncSystemStrip(): void {
  const wanted = store.settings.showSystemMonitor
  if (wanted && !unwatch) {
    unwatch = watchSystem((stats) => {
      latest = stats
      render()
    }, POLL_MS)
  } else if (!wanted && unwatch) {
    unwatch()
    unwatch = null
    latest = null
  }
  render()
}

function render(): void {
  const host = el()
  if (!host) return

  if (!store.settings.showSystemMonitor) {
    host.hidden = true
    host.replaceChildren()
    return
  }
  host.hidden = false
  host.replaceChildren()

  if (!latest) {
    host.className = 'sidebar-system muted'
    host.textContent = 'Machine …'
    return
  }

  host.className = 'sidebar-system'

  const memory = percent(latest.memory.used, latest.memory.total)
  row(host, 'cpu', latest.cpu.load, latest.cpu.load === null ? '—' : `${latest.cpu.load.toFixed(0)}%`)
  row(host, 'ram', memory, `${memory.toFixed(0)}%`, `${bytes(latest.memory.used)} of ${bytes(latest.memory.total)}`)

  // The fullest disk rather than all of them, because the one that matters is
  // the one about to run out and the others are the pane's business.
  const fullest = [...latest.disks].sort(
    (a, b) => percent(b.total - b.free, b.total) - percent(a.total - a.free, a.total)
  )[0]
  if (fullest) {
    const used = percent(fullest.total - fullest.free, fullest.total)
    row(host, fullest.mount.toLowerCase(), used, `${used.toFixed(0)}%`, `${bytes(fullest.free)} free on ${fullest.mount}`)
  }

  // Traffic has no ceiling to draw a bar against, so it is the one line that is
  // text only — inventing a "maximum" for a network interface would put a
  // meaningless bar beside three meaningful ones.
  const down = sum(latest.networks.map((n) => n.rxPerSec))
  const up = sum(latest.networks.map((n) => n.txPerSec))
  const net = document.createElement('div')
  net.className = 'system-row system-row--text'
  const label = document.createElement('span')
  label.className = 'system-row__label'
  label.textContent = 'net'
  net.appendChild(label)
  const value = document.createElement('span')
  value.className = 'system-row__value'
  value.textContent = `↓${rate(down)}  ↑${rate(up)}`
  net.appendChild(value)
  host.appendChild(net)

  const more = document.createElement('button')
  more.className = 'system-more'
  more.textContent = 'Open the monitor'
  more.title = 'Graphs, per-core load, every disk and every interface.'
  more.addEventListener('click', () => openMonitor?.())
  host.appendChild(more)
}

function row(host: HTMLElement, label: string, value: number | null, text: string, title?: string): void {
  const el = document.createElement('div')
  el.className = `system-row system-row--${band(value)}`
  if (title) el.title = title

  const head = document.createElement('div')
  head.className = 'system-row__head'
  const name = document.createElement('span')
  name.className = 'system-row__label'
  name.textContent = label
  head.appendChild(name)
  const out = document.createElement('span')
  out.className = 'system-row__value'
  out.textContent = text
  head.appendChild(out)
  el.appendChild(head)

  const track = document.createElement('span')
  track.className = 'system-row__track'
  const fill = document.createElement('span')
  fill.className = 'system-row__fill'
  fill.style.width = `${Math.min(100, Math.max(0, value ?? 0))}%`
  track.appendChild(fill)
  el.appendChild(track)

  host.appendChild(el)
}

function sum(values: Array<number | null>): number | null {
  let total = 0
  let any = false
  for (const value of values) {
    if (value === null) continue
    total += value
    any = true
  }
  return any ? total : null
}
