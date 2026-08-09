import type { AgentChoice, AgentRunState, PaneAgentState } from '../shared/types'

/**
 * Agent state a pane *declares*, as opposed to state we infer.
 *
 * `activityMonitor.ts` can tell you a pane went quiet. It cannot tell you why,
 * and the difference matters more than anything else on screen: an agent that
 * finished and an agent stopped on a permission prompt both go silent, and
 * with six panes open the one that needs you looks exactly like the five that
 * don't.
 *
 * No amount of scraping fixes that reliably — it makes us depend on the exact
 * wording of somebody else's TUI, and when they change it the failure is
 * silent. So the agent says what it is doing, over `iaw report-agent`, and we
 * store it verbatim.
 *
 * Two facts produce three states:
 *   awaitingHuman   -> blocked
 *   runDepth > 0    -> working
 *   otherwise       -> idle
 * A pane that never reported is `unknown` and is simply absent here.
 *
 * runDepth is a refcount rather than a flag so a nested subagent finishing
 * cannot clear the outer run.
 */

/** Values older than this are dropped even if the reporter never says stop. */
const DEFAULT_METADATA_TTL_MS = 60_000

export interface AgentReport {
  /** Present when the agent parked on a human; empty string is a valid reason. */
  blocked?: string
  /** The human answered, or the agent gave up waiting. */
  unblocked?: boolean
  /** Answers this pane will accept while blocked. */
  choices?: AgentChoice[]
  runStart?: boolean
  runEnd?: boolean
  /** Absolute depth, for reporters that track it themselves. */
  runDepth?: number
  /**
   * Monotonic per-pane counter. Hook systems replay, and a replayed run-end
   * would decrement a refcount it never incremented.
   */
  seq?: number
  model?: string
  contextPct?: number
  tokens?: string
  /** Milliseconds the metadata stays valid. */
  ttl?: number
}

interface Record_ {
  paneId: string
  awaitingHuman: boolean
  runDepth: number
  blockedReason: string | null
  choices: AgentChoice[]
  answeredAt: number | null
  model?: string
  contextPct?: number
  tokens?: string
  metaExpiresAt?: number
  lastSeq: number
  updatedAt: number
  /** Set while a caller is parked on `iaw ask`. See {@link Waiter}. */
  waiter?: Waiter
}

/**
 * A caller sitting on an open connection, waiting to be told what the human
 * picked.
 *
 * This is the other half of the relay, and the better half where it applies.
 * Answering a blocked pane normally means typing the bytes the agent declared
 * into its terminal — which works for anything, but is still us imitating a
 * keyboard against somebody else's on-screen menu. When the question came in
 * through `iaw ask`, the asker is a process holding a socket open, so the
 * answer can go straight back to it: no keystrokes, no dependency on what the
 * pane happens to be drawing, and it works just as well when the pane is not
 * on screen or the agent has no menu at all.
 */
interface Waiter {
  /** Distinguishes this question from a later one on the same pane. */
  requestId: string
  /** Called once, with the id of the choice the human picked. */
  settle(choice: AgentChoice): void
}

export class AgentStateRegistry {
  private readonly records = new Map<string, Record_>()

  constructor(private readonly onChange: (state: PaneAgentState) => void) {}

  /**
   * Applies a report. Returns false when the report was rejected — a stale
   * `seq`, or a set of choices with nothing to send.
   */
  report(paneId: string, report: AgentReport): boolean {
    const rec = this.records.get(paneId) ?? blank(paneId)

    // Replayed hook events arrive out of order; only refcount changes are
    // order-sensitive, so that is all the sequence number guards.
    const touchesRefcount = report.runStart || report.runEnd || report.runDepth !== undefined
    if (report.seq !== undefined && touchesRefcount) {
      if (report.seq <= rec.lastSeq) return false
      rec.lastSeq = report.seq
    }

    if (report.blocked !== undefined) {
      const choices = sanitizeChoices(report.choices)
      if (report.choices?.length && !choices.length) return false
      rec.awaitingHuman = true
      rec.blockedReason = report.blocked || null
      rec.choices = choices
      rec.answeredAt = null
    }

    if (report.unblocked) {
      // An agent that declares itself unblocked has stopped waiting, so a
      // parked ask on the same pane is stale — settle it rather than leave its
      // caller holding a connection nothing will ever answer.
      rec.waiter?.settle({ id: '', label: '' })
      rec.waiter = undefined
      rec.awaitingHuman = false
      rec.blockedReason = null
      rec.choices = []
      rec.answeredAt = null
    }

    if (report.runDepth !== undefined) {
      rec.runDepth = Math.max(0, Math.floor(report.runDepth))
    } else {
      if (report.runStart) rec.runDepth += 1
      if (report.runEnd) rec.runDepth = Math.max(0, rec.runDepth - 1)
    }

    if (report.model !== undefined) rec.model = report.model
    if (report.contextPct !== undefined) rec.contextPct = clampPct(report.contextPct)
    if (report.tokens !== undefined) rec.tokens = report.tokens
    if (report.model !== undefined || report.contextPct !== undefined || report.tokens !== undefined) {
      rec.metaExpiresAt = Date.now() + (report.ttl && report.ttl > 0 ? report.ttl : DEFAULT_METADATA_TTL_MS)
    }

    rec.updatedAt = Date.now()
    this.records.set(paneId, rec)
    this.onChange(this.snapshot(paneId))
    return true
  }

  /**
   * Parks a caller on a question: the pane goes blocked with these choices, and
   * the waiter is held until somebody answers.
   *
   * Returns false when the choices are unusable, which is the same bar
   * `report` applies — an unanswerable question would block the pane on a set
   * of buttons that cannot do anything.
   *
   * A second ask on the same pane replaces the first, and the one it displaces
   * is settled as abandoned rather than left hanging: its caller is owed an
   * answer either way, and an agent that asked twice has moved on from the
   * first question.
   */
  ask(paneId: string, question: string, choices: AgentChoice[], waiter: Waiter): boolean {
    const clean = sanitizeChoices(choices)
    if (!clean.length) return false

    const rec = this.records.get(paneId) ?? blank(paneId)
    const displaced = rec.waiter
    rec.awaitingHuman = true
    rec.blockedReason = question || null
    rec.choices = clean
    rec.answeredAt = null
    rec.waiter = waiter
    rec.updatedAt = Date.now()
    this.records.set(paneId, rec)
    displaced?.settle({ id: '', label: '' })
    this.onChange(this.snapshot(paneId))
    return true
  }

  /**
   * Hands the answer to a parked caller, if there is one.
   *
   * Returns the choice when it was delivered this way, so the caller knows not
   * to fall back to typing it into the terminal.
   *
   * Unlike the keystroke path this *does* clear the blocked flag. That rule
   * exists because we cannot see whether typed bytes actually picked anything —
   * a mis-declared key would leave a pane looking answered while its agent sat
   * there waiting, so the agent has to confirm. Here there is nothing to
   * confirm: the answer went back down the connection the asker is holding, and
   * we watched it happen.
   */
  deliverAnswer(paneId: string, choiceId?: string): AgentChoice | null {
    const rec = this.records.get(paneId)
    if (!rec?.waiter || !rec.awaitingHuman) return null

    const choice = choiceId
      ? rec.choices.find((c) => c.id === choiceId)
      : (rec.choices.find((c) => c.isDefault) ?? null)
    if (!choice) return null

    const waiter = rec.waiter
    rec.waiter = undefined
    rec.awaitingHuman = false
    rec.blockedReason = null
    rec.choices = []
    rec.answeredAt = Date.now()
    waiter.settle(choice)
    this.onChange(this.snapshot(paneId))
    return choice
  }

  /**
   * Drops a waiter that gave up — its caller went away, or it ran out of time.
   *
   * Keyed by request id so a timeout firing late cannot clear a *newer*
   * question that has since taken the pane's place.
   */
  abandonAsk(paneId: string, requestId: string): void {
    const rec = this.records.get(paneId)
    if (rec?.waiter?.requestId !== requestId) return
    const waiter = rec.waiter
    rec.waiter = undefined
    rec.awaitingHuman = false
    rec.blockedReason = null
    rec.choices = []
    rec.updatedAt = Date.now()
    // Settled, not merely dropped: the caller is owed an answer even when the
    // answer is "nobody picked one", and a waiter released without one would
    // sit on its connection until its own deadline ran out.
    waiter.settle({ id: '', label: '' })
    this.onChange(this.snapshot(paneId))
  }

  /**
   * The payload for a choice, or null when the pane isn't blocked or never
   * offered that choice.
   *
   * This is the guard on the only path that writes into somebody's shell from
   * outside it. We refuse unless the pane says it is blocked, and we only ever
   * send bytes the pane itself declared — we do not know how to answer a Claude
   * Code prompt or an OpenCode menu, and the moment we guess we own a
   * dependency on someone else's UI not changing.
   */
  resolveAnswer(paneId: string, choiceId?: string): { data: string; choice: AgentChoice } | null {
    const rec = this.records.get(paneId)
    if (!rec || !rec.awaitingHuman || !rec.choices.length) return null

    const choice = choiceId
      ? rec.choices.find((c) => c.id === choiceId)
      : (rec.choices.find((c) => c.isDefault) ?? null)
    if (!choice) return null

    const data = choice.text !== undefined ? choice.text : keyBytes(choice.key ?? '')
    if (data === null) return null
    return { data, choice }
  }

  /**
   * Records that an answer went in.
   *
   * Deliberately does *not* clear `blocked`. The agent confirms it is unblocked
   * with its own `--unblocked` report; if we cleared it here, one mis-declared
   * key would leave a stuck pane looking answered and it would never ask again.
   */
  markAnswered(paneId: string): void {
    const rec = this.records.get(paneId)
    if (!rec) return
    rec.answeredAt = Date.now()
    this.onChange(this.snapshot(paneId))
  }

  /** The agent is done with this pane; back to `unknown`. */
  release(paneId: string): void {
    // The pane is going away, so anything parked on it is never going to be
    // answered. Settling it as abandoned unblocks the caller — which for a
    // hook means the agent it is holding up — rather than leaving it to time
    // out on a pane that no longer exists.
    this.records.get(paneId)?.waiter?.settle({ id: '', label: '' })
    if (!this.records.delete(paneId)) return
    this.onChange({
      paneId,
      state: 'unknown',
      awaitingHuman: false,
      runDepth: 0,
      blockedReason: null,
      choices: [],
      answeredAt: null,
    })
  }

  snapshot(paneId: string): PaneAgentState {
    const rec = this.records.get(paneId)
    if (!rec) {
      return {
        paneId,
        state: 'unknown',
        awaitingHuman: false,
        runDepth: 0,
        blockedReason: null,
        choices: [],
        answeredAt: null,
      }
    }
    const fresh = !rec.metaExpiresAt || rec.metaExpiresAt > Date.now()
    return {
      paneId,
      state: stateOf(rec),
      awaitingHuman: rec.awaitingHuman,
      runDepth: rec.runDepth,
      blockedReason: rec.blockedReason,
      choices: rec.choices,
      answeredAt: rec.answeredAt,
      model: fresh ? rec.model : undefined,
      contextPct: fresh ? rec.contextPct : undefined,
      tokens: fresh ? rec.tokens : undefined,
    }
  }

  all(): PaneAgentState[] {
    return [...this.records.keys()].map((id) => this.snapshot(id))
  }

  blocked(): PaneAgentState[] {
    return this.all().filter((r) => r.state === 'blocked')
  }
}

function blank(paneId: string): Record_ {
  return {
    paneId,
    awaitingHuman: false,
    runDepth: 0,
    blockedReason: null,
    choices: [],
    answeredAt: null,
    lastSeq: 0,
    updatedAt: Date.now(),
  }
}

function stateOf(rec: Record_): AgentRunState {
  if (rec.awaitingHuman) return 'blocked'
  return rec.runDepth > 0 ? 'working' : 'idle'
}

function clampPct(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, value))
}

/**
 * Drops choices that cannot be sent. A button that does nothing when clicked is
 * worse than no button, so an unanswerable choice is rejected at report time
 * rather than failing at the click.
 */
function sanitizeChoices(choices: AgentChoice[] | undefined): AgentChoice[] {
  if (!Array.isArray(choices)) return []
  const out: AgentChoice[] = []
  for (const raw of choices.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue
    const id = String(raw.id ?? '').trim()
    const label = String(raw.label ?? '').trim()
    if (!id || !label) continue
    const text = typeof raw.text === 'string' ? raw.text : undefined
    const key = typeof raw.key === 'string' ? raw.key.trim() : undefined
    if (text === undefined && (!key || keyBytes(key) === null)) continue
    out.push({ id, label, key, text, isDefault: Boolean(raw.isDefault) })
  }
  return out
}

/**
 * Key names an agent may name in a choice, mapped to what we type into the PTY.
 *
 * Deliberately a closed list. It is the vocabulary for writing into a shell
 * from outside, so "whatever string you like" is not an option — a single
 * printable character is allowed because menus are usually numbered.
 */
const KEYS: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  esc: '\x1b',
  escape: '\x1b',
  space: ' ',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  y: 'y',
  n: 'n',
}

export function keyBytes(name: string): string | null {
  const key = name.toLowerCase()
  if (key in KEYS) return KEYS[key]
  // Menu selections are overwhelmingly "press 2".
  if (/^[0-9a-z]$/.test(key)) return key
  return null
}

/**
 * `keyBytes` with modifiers applied — what `iaw send-key --ctrl c` sends.
 *
 * Control is the classic subtraction: a terminal has encoded Ctrl+letter as the
 * letter's position in the alphabet since teletypes, which is why Ctrl+C is 3
 * and Ctrl+D is 4. Alt is an escape prefix, which is how Meta has always been
 * carried over a byte stream. Shift is left alone deliberately: for a letter it
 * means the capital, which the caller can simply send, and for anything else
 * its encoding depends on the terminal's mode — guessing would produce bytes
 * that mean something different in each pane.
 */
export function encodeKey(
  name: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean }
): string | null {
  const base = keyBytes(name)
  if (base === null) return null

  let out = base
  if (mods.ctrl && /^[a-z]$/.test(base)) {
    out = String.fromCharCode(base.charCodeAt(0) - 96)
  } else if (mods.ctrl && base.length === 1) {
    // Ctrl on a key with no control code of its own — a digit, say. Sending the
    // key unmodified is closer to the request than sending nothing.
    out = base
  }
  if (mods.shift && /^[a-z]$/.test(out)) out = out.toUpperCase()
  if (mods.alt) out = '\x1b' + out
  return out
}
