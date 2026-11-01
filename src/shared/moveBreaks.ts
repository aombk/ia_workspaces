/**
 * Getting up every so often, decided without anybody starting a timer.
 *
 * The pure half. Everything with judgement in it — when you count as sitting,
 * when a break is owed, what being away for a while means — is here as a plain
 * state machine over two inputs, the clock and how long the machine has had no
 * keyboard or mouse. `main/moveBreaks.ts` feeds it those and shows what it
 * decides, and has no judgement of its own. The split is the one `powerLock`
 * makes, for the same reason: the part that decides can be tested without an
 * app.
 *
 * ## Sitting is input, anywhere on the machine
 *
 * Not focus on this app's window. Someone reading a browser for twenty minutes
 * between two agent turns has been sitting for twenty minutes, and the point
 * is the chair, not the app. The idle time is the operating system's: the last
 * key or mouse movement in any program.
 *
 * ## Away counts as a break
 *
 * No input for as long as a break lasts means you were not sitting there, so
 * the count starts again — getting up for coffee is the thing this asks for,
 * and asking again ten minutes after it is how a reminder gets switched off.
 * For the same reason a break is only ever *raised* while you are at the
 * machine, and one already up resolves itself if you walk away from it.
 */

export type BreakPosture = 'standing' | 'seated'

/** How a break ended. `away` is walking off without answering it, which is a break too. */
export type BreakOutcome = 'done' | 'seated' | 'skipped' | 'away'

export interface BreakRecord {
  at: number
  outcome: BreakOutcome
  /** Minutes sat before it was raised. */
  satMin: number
}

export interface BreakSettings {
  enabled: boolean
  everyMin: number
  breakMin: number
  /** What you have to exercise with, by id. See `EQUIPMENT`. */
  equipment: string[]
  /** What to leave alone — a bad knee, a sore back. See `STRAINS`. */
  avoid: string[]
}

/** A break that is up on screen. */
export interface DueBreak {
  id: string
  raisedAt: number
  satMin: number
  /** Null while you are choosing; set once you have started one. */
  posture: BreakPosture | null
  /** When the countdown began — 0 until a posture is chosen. */
  startedAt: number
  /** The exercises for each choice, picked when the break was raised so every window shows the same. */
  standing: string[]
  seated: string[]
  /** Whether "not now" has been spent on this one. */
  snoozed: boolean
}

/** Everything a window needs to draw the break screen and the status chip. */
export interface BreakState {
  settings: BreakSettings
  /** When the current stretch of sitting began, or null when away or switched off. */
  sittingSince: number | null
  /** While snoozed, when it comes back. */
  snoozedUntil: number | null
  due: DueBreak | null
}

/** Input within this long counts as being at the machine right now. */
export const PRESENT_SEC = 60
/** How long "not now" puts a break off. Once per break. */
export const SNOOZE_MIN = 5

export const DEFAULT_BREAKS: BreakSettings = { enabled: true, everyMin: 25, breakMin: 5, equipment: [], avoid: [] }

/** Settings as stored, made safe: a hand-edited zero must not raise a break every tick. */
export function readBreakSettings(raw: {
  moveBreaks?: unknown
  moveEveryMin?: unknown
  moveBreakMin?: unknown
  moveEquipment?: unknown
  moveAvoid?: unknown
}): BreakSettings {
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
  return {
    enabled: raw.moveBreaks !== false,
    everyMin: num(raw.moveEveryMin, DEFAULT_BREAKS.everyMin, 5, 240),
    breakMin: num(raw.moveBreakMin, DEFAULT_BREAKS.breakMin, 1, 30),
    equipment: ids(raw.moveEquipment),
    avoid: ids(raw.moveAvoid),
  }
}

export class BreakClock {
  private sittingSince: number | null = null
  private snoozedUntil: number | null = null
  private snoozeSpent = false
  private due: DueBreak | null = null
  private settings: BreakSettings = DEFAULT_BREAKS

  constructor(
    private readonly pick: (posture: BreakPosture, count: number, settings: BreakSettings) => string[],
    private readonly newId: () => string = () => Math.random().toString(36).slice(2)
  ) {}

  state(): BreakState {
    return {
      settings: this.settings,
      sittingSince: this.sittingSince,
      snoozedUntil: this.snoozedUntil,
      due: this.due ? { ...this.due } : null,
    }
  }

  /**
   * One look at the world. Returns what happened, so the caller knows whether
   * to tell the windows and whether to make a noise.
   */
  tick(now: number, idleSec: number, settings: BreakSettings): { changed: boolean; raised: boolean; ended: BreakRecord | null } {
    const before = JSON.stringify(this.state())
    this.settings = settings
    let raised = false
    let ended: BreakRecord | null = null
    const awaySec = settings.breakMin * 60

    if (!settings.enabled) {
      this.sittingSince = null
      this.snoozedUntil = null
      this.snoozeSpent = false
      this.due = null
    } else if (this.due) {
      // Up on screen and you walked away from it: that was the break.
      if (idleSec >= awaySec) ended = this.finish(now, 'away')
    } else if (idleSec >= awaySec) {
      this.sittingSince = null
      this.snoozedUntil = null
      this.snoozeSpent = false
    } else {
      if (this.sittingSince === null) this.sittingSince = now - idleSec * 1000
      const snoozing = this.snoozedUntil !== null && now < this.snoozedUntil
      const owed = now - this.sittingSince >= settings.everyMin * 60_000
      if (!snoozing && (owed || this.snoozedUntil !== null) && idleSec < PRESENT_SEC) {
        this.raise(now)
        raised = true
      }
    }
    return { changed: JSON.stringify(this.state()) !== before, raised, ended }
  }

  /** A break now, because you asked for one. */
  raiseNow(now: number): void {
    if (!this.due) this.raise(now)
  }

  private raise(now: number): void {
    const count = Math.max(1, this.settings.breakMin)
    this.due = {
      id: this.newId(),
      raisedAt: now,
      satMin: this.sittingSince === null ? 0 : Math.round((now - this.sittingSince) / 60_000),
      posture: null,
      startedAt: 0,
      standing: this.pick('standing', count, this.settings),
      seated: this.pick('seated', count, this.settings),
      snoozed: this.snoozeSpent,
    }
    this.snoozedUntil = null
  }

  choose(now: number, posture: BreakPosture): boolean {
    if (!this.due) return false
    this.due = { ...this.due, posture, startedAt: now }
    return true
  }

  /** "Not now", once per break. */
  snooze(now: number): boolean {
    if (!this.due || this.due.snoozed) return false
    this.due = null
    this.snoozeSpent = true
    this.snoozedUntil = now + SNOOZE_MIN * 60_000
    return true
  }

  /**
   * Ends the break. A finished countdown is the only way to `done` or `seated`:
   * the screen does not offer it sooner, and this does not take it sooner
   * either.
   */
  finish(now: number, outcome: BreakOutcome): BreakRecord | null {
    const due = this.due
    if (!due) return null
    if ((outcome === 'done' || outcome === 'seated') && (!due.startedAt || now - due.startedAt < this.settings.breakMin * 60_000 - 1500)) {
      return null
    }
    this.due = null
    this.snoozeSpent = false
    this.snoozedUntil = null
    // Sitting starts again now, whatever happened: even a skipped break is a
    // decision, and asking again a minute later would just be nagging.
    this.sittingSince = now
    return { at: now, outcome, satMin: due.satMin }
  }

  /** The machine locked or went to sleep: nobody is sitting there. */
  away(): boolean {
    const was = this.sittingSince !== null
    this.sittingSince = null
    return was
  }
}
