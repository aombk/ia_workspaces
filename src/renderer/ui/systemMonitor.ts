/**
 * One poll of the machine, shared by everything that draws it.
 *
 * A singleton rather than a timer per view, and that is a correctness matter
 * rather than tidiness. Half the readings are *rates* — CPU busy-ness, bytes
 * per second — and a rate is a difference between two samples divided by the
 * time between them. The main process keeps the previous sample, so if the pane
 * and the sidebar strip each polled on their own clock, every call would
 * measure its delta against whichever view happened to ask last. Both would
 * show numbers that were individually plausible and jointly nonsense, worst
 * exactly when something is busy and the two views disagree about how much.
 *
 * So: one clock, one sample, many subscribers. Each subscriber says how often
 * it would like to hear, and the poll runs at the shortest of those — the pane
 * asking for two seconds speeds the strip up while it is open, and closing it
 * drops the whole thing back to the strip's slower rate. With nobody watching,
 * nothing runs at all: this spawns a process per sample, and a monitor that
 * keeps doing that behind a pane you closed is a monitor that shows up in
 * somebody else's monitor.
 */
import { backend } from '../../backend'
import { store } from '../state'
import type { SystemStats } from '../../shared/types'
import { cpuTemperature } from '../../shared/sensors'

/**
 * How many samples the graphs keep.
 *
 * At the pane's 2s poll this is ten minutes of history, which is the span that
 * answers "was that spike me?" — long enough to still hold the thing you turned
 * to look at, short enough that the line has visible shape rather than being a
 * decade of grey fuzz.
 */
export const HISTORY = 300

export interface SystemHistory {
  /** Percent busy, all cores. */
  cpu: Array<number | null>
  /** Percent of RAM in use. */
  memory: Array<number | null>
  /** Bytes per second, summed over every interface. */
  rx: Array<number | null>
  tx: Array<number | null>
  /**
   * The warmest processor sensor, when the machine will give one.
   *
   * Kept beside the load so the two can be drawn over each other: load says
   * what is being asked of the chip and temperature says what that is costing,
   * and the interesting shape is the lag between them — which only reads as a
   * lag if they share an axis.
   */
  cpuTemp: Array<number | null>
  /** The first GPU's load and temperature, when there is a source for them. */
  gpuLoad: Array<number | null>
  gpuTemp: Array<number | null>
  /** Percent of the GPU's own memory in use. */
  gpuMemory: Array<number | null>
  /** This app's own CPU, so "the machine is busy" can be told from "we are". */
  appCpu: Array<number | null>
  /**
   * Per drive, keyed by the counter's own name — how hard it is working and how
   * hot it is.
   *
   * Keyed rather than an array because drives come and go: an external disk
   * unplugged mid-session must not shift every other drive's history by one
   * position, which is exactly what an index would do.
   */
  driveBusy: Record<string, Array<number | null>>
  driveTemp: Record<string, Array<number | null>>
}

const history: SystemHistory = {
  cpu: [],
  memory: [],
  cpuTemp: [],
  gpuMemory: [],
  rx: [],
  tx: [],
  gpuLoad: [],
  gpuTemp: [],
  appCpu: [],
  driveBusy: {},
  driveTemp: {},
}

type Listener = (stats: SystemStats | null, history: SystemHistory) => void

const subscribers = new Map<Listener, number>()
let latest: SystemStats | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let interval = 0
let polling = false

/**
 * Watch the machine, at most this often.
 *
 * Returns the unsubscribe, which every caller must actually call — see the note
 * at the top about what a monitor left running looks like.
 */
// Coming back to the window is when somebody starts reading again, so the
// skipped sample is taken then rather than up to an interval later.
window.addEventListener('focus', () => {
  if (subscribers.size) void poll()
})

export function watchSystem(listener: Listener, everyMs: number): () => void {
  subscribers.set(listener, everyMs)
  retime()
  // Whatever the last sample was, immediately — a pane that opens to an empty
  // frame and fills in two seconds later reads as broken for those two seconds.
  listener(latest, history)
  if (!latest) void poll()
  return () => {
    subscribers.delete(listener)
    retime()
  }
}

export function latestSystem(): SystemStats | null {
  return latest
}

export function systemHistory(): SystemHistory {
  return history
}

/** Restarts the clock at the shortest interval anybody asked for, or stops it. */
function retime(): void {
  const wanted = subscribers.size ? Math.min(...subscribers.values()) : 0
  if (wanted === interval) return
  interval = wanted
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (interval > 0) schedule()
}

function schedule(): void {
  if (timer || interval <= 0) return
  timer = setTimeout(() => {
    timer = null
    void poll()
  }, interval)
}

async function poll(): Promise<void> {
  // A probe that takes longer than the interval must not be asked again on top
  // of itself; the next tick is scheduled when this one lands, not before.
  if (polling) return

  // Nobody is reading a reading nobody can see. On Windows the slow half of a
  // sample costs a `powershell.exe`, and a dock left open behind another window
  // was spawning one every few seconds all day — which is a real amount of heat
  // for a graph nobody was looking at. The clock keeps running so the pane
  // fills the moment it comes back; the sample is what is skipped.
  if (document.hidden || !document.hasFocus()) {
    schedule()
    return
  }

  polling = true
  try {
    // The drives block is the only reading here that costs a process, so it is
    // not collected when nothing is showing it. See `readSystemStats`.
    latest = await backend().systemStats({ drives: store.monitorShows('drives') })
    record(latest)
  } catch {
    // A failed sample is a gap in the graph, not a zero in it, and not a reason
    // to stop watching — a machine under enough load to time out a probe is
    // precisely the machine somebody is watching this for.
    latest = null
    record(null)
  } finally {
    polling = false
    for (const listener of subscribers.keys()) listener(latest, history)
    schedule()
  }
}

function record(stats: SystemStats | null): void {
  push(history.cpu, stats?.cpu.load ?? null)
  push(history.memory, stats ? percent(stats.memory.used, stats.memory.total) : null)
  push(history.rx, sum(stats?.networks.map((n) => n.rxPerSec)))
  push(history.tx, sum(stats?.networks.map((n) => n.txPerSec)))
  push(history.cpuTemp, cpuTemperature(stats?.temperatures ?? [])?.celsius ?? null)
  push(history.gpuLoad, stats?.gpus[0]?.load ?? null)
  push(history.gpuTemp, stats?.gpus[0]?.temperature ?? null)
  push(
    history.gpuMemory,
    stats?.gpus[0]?.memoryUsed != null && stats.gpus[0].memoryTotal
      ? percent(stats.gpus[0].memoryUsed, stats.gpus[0].memoryTotal)
      : null
  )
  push(history.appCpu, stats?.app.cpu ?? null)

  // One series per drive, and every known drive gets a sample every time —
  // including the ones that reported nothing this round, so a gap in one
  // drive's line stays lined up with the others rather than sliding left.
  const io = stats?.diskIo ?? []
  const health = stats?.health ?? []
  for (const drive of io) {
    const key = drive.label ?? drive.name
    push((history.driveBusy[key] ??= []), drive.busyPercent)
    const match = health.find((h) => h.name === key)
    push((history.driveTemp[key] ??= []), match?.temperature ?? null)
  }
  const seen = new Set(io.map((d) => d.label ?? d.name))
  for (const key of Object.keys(history.driveBusy)) {
    if (seen.has(key)) continue
    push(history.driveBusy[key], null)
    push(history.driveTemp[key], null)
  }
}

/**
 * The warmest processor sensor, or null where there is none.
 *
 * The warmest rather than an average: a package running at 90 while seven
 * cores idle is the machine throttling, and a mean would hide it. Null on any
 * machine with no readable sensor, which is most of Windows — see `SystemStats`.
 */
function push(series: Array<number | null>, value: number | null): void {
  series.push(value)
  if (series.length > HISTORY) series.shift()
}

/** Null when nothing reported, rather than a zero that means "no interfaces". */
function sum(values: Array<number | null> | undefined): number | null {
  if (!values?.length) return null
  let total = 0
  let any = false
  for (const value of values) {
    if (value === null) continue
    total += value
    any = true
  }
  return any ? total : null
}

export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((1000 * part) / whole) / 10 : 0
}

// ------------------------------------------------------------------ writing

/**
 * Bytes, in the unit a person would have said.
 *
 * Binary units throughout — 1024, not 1000 — because that is what every OS
 * reports free space in, and a monitor that disagrees with Explorer about the
 * size of the same disk is a monitor nobody trusts about anything else.
 */
export function bytes(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let size = Math.abs(value)
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  // No decimal on bytes, and none once the number is big enough to be its own
  // answer: "512 GB" and "512.0 GB" say the same thing and one is quieter.
  const places = unit === 0 ? 0 : size >= 100 ? 0 : decimals
  return `${size.toFixed(places)} ${units[unit]}`
}

export function rate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${bytes(value, value >= 1024 * 1024 ? 1 : 0)}/s`
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/**
 * Which of the three bands a percentage falls in.
 *
 * Only the top one is loud, the same rule the usage rows follow: a monitor
 * where several things are always amber is a monitor whose colours mean
 * nothing on the day one of them turns red.
 */
export function band(value: number | null): 'idle' | 'warn' | 'high' {
  if (value === null) return 'idle'
  if (value >= 90) return 'high'
  if (value >= 70) return 'warn'
  return 'idle'
}
