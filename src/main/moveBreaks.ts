/**
 * Movement breaks, the Electron half.
 *
 * Owns the clock, the operating system's idle time and the record of breaks
 * taken. Everything that decides — when you count as sitting, when a break is
 * owed — is `BreakClock` in `shared/moveBreaks.ts`; this only feeds it and
 * passes on what it says. Main keeps it rather than a window so that every
 * window shows the same break, a break survives a window closing, and one
 * window's countdown cannot disagree with another's.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { powerMonitor } from 'electron'
import {
  BreakClock,
  type BreakOutcome,
  type BreakPosture,
  type BreakRecord,
  type BreakSettings,
  type BreakState,
} from '../shared/moveBreaks'
import { dealChoices, exercise, playedInRound } from '../shared/exercises'

/** How often the idle time is read. A break owed is raised within this of being owed. */
const TICK_MS = 10_000
/** Days of breaks kept in the log. The Focus pane shows today; a week is plenty to look back on. */
const KEEP_DAYS = 14

export class MoveBreaks {
  private readonly clock = new BreakClock((posture, settings) => this.deal(posture, settings), randomUUID)
  private timer: ReturnType<typeof setInterval> | null = null
  private records: BreakRecord[] = []
  private readonly file: string
  /**
   * What is still to come in this round of exercises, for each posture: every
   * exercise once, shuffled, before any repeats. Kept on disk so a restart does
   * not start a fresh round. See `dealChoices`.
   */
  private rounds: Record<BreakPosture, string[]> = { standing: [], seated: [] }
  private readonly roundFile: string

  constructor(
    dataDir: string,
    private readonly settings: () => BreakSettings,
    private readonly publish: (state: BreakState) => void,
    private readonly raised: () => void
  ) {
    this.file = path.join(dataDir, 'move-breaks.json')
    this.records = this.load()
    this.roundFile = path.join(dataDir, 'move-breaks-round.json')
    this.rounds = this.loadRounds()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    // Locking the machine or putting it to sleep is somebody leaving it.
    powerMonitor.on('lock-screen', this.onAway)
    powerMonitor.on('suspend', this.onAway)
    this.tick()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    powerMonitor.off('lock-screen', this.onAway)
    powerMonitor.off('suspend', this.onAway)
  }

  state(): BreakState {
    return this.clock.state()
  }

  /** Read again now — a setting changed, and waiting ten seconds to honour it would look broken. */
  tick(): void {
    const result = this.clock.tick(Date.now(), powerMonitor.getSystemIdleTime(), this.settings())
    if (result.ended) this.remember(result.ended)
    if (result.changed) this.publish(this.clock.state())
    if (result.raised) this.raised()
  }

  finish(outcome: BreakOutcome): boolean {
    const record = this.clock.finish(Date.now(), outcome)
    if (!record) return false
    this.remember(record)
    this.publish(this.clock.state())
    return true
  }

  lean(posture: BreakPosture): void {
    if (this.clock.lean(posture)) this.publish(this.clock.state())
  }

  another(): void {
    if (this.clock.another()) this.publish(this.clock.state())
  }

  snooze(): boolean {
    const ok = this.clock.snooze(Date.now())
    if (ok) this.publish(this.clock.state())
    return ok
  }

  now(): void {
    this.clock.raiseNow(Date.now())
    this.publish(this.clock.state())
  }

  /** You stopped: a break waiting for a pause comes up. */
  pause(): void {
    if (!this.clock.pause(Date.now())) return
    this.publish(this.clock.state())
    this.raised()
  }

  today(): BreakRecord[] {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return this.records.filter((r) => r.at >= start.getTime())
  }

  private readonly onAway = (): void => {
    if (this.clock.away()) this.publish(this.clock.state())
  }

  /** The exercises for a break about to come up, from what is left of the round. */
  private deal(posture: BreakPosture, settings: BreakSettings): string[] {
    const { choices, round } = dealChoices(
      posture,
      { equipment: settings.equipment, avoid: settings.avoid },
      this.rounds[posture],
      Math.random,
      this.records.at(-1)?.exercise
    )
    if (round.join() !== this.rounds[posture].join()) {
      this.rounds[posture] = round
      this.saveRounds()
    }
    return choices
  }

  private remember(record: BreakRecord): void {
    // The exercise it ended on is done for this round, whichever way it ended.
    const posture = record.exercise ? exercise(record.exercise)?.posture : undefined
    if (posture) {
      this.rounds[posture] = playedInRound(this.rounds[posture], record.exercise)
      this.saveRounds()
    }
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000
    this.records = [...this.records.filter((r) => r.at >= cutoff), record]
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records))
    } catch {
      // A log that cannot be written loses history, not the break.
    }
  }

  private saveRounds(): void {
    try {
      fs.writeFileSync(this.roundFile, JSON.stringify(this.rounds))
    } catch {
      // Lost, the round starts over: a repeat or two, nothing worse.
    }
  }

  private loadRounds(): Record<BreakPosture, string[]> {
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    try {
      const raw = JSON.parse(fs.readFileSync(this.roundFile, 'utf8')) as Record<string, unknown>
      return { standing: ids(raw?.standing), seated: ids(raw?.seated) }
    } catch {
      return { standing: [], seated: [] }
    }
  }

  private load(): BreakRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(raw)
        ? raw.filter((r): r is BreakRecord => Boolean(r) && typeof r.at === 'number' && typeof r.outcome === 'string')
        : []
    } catch {
      return []
    }
  }
}
