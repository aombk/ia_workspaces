/**
 * The broker's actual state: which shells exist, what they have printed, and
 * who is listening.
 *
 * Pure, and deliberately so — the pty is injected. Everything here can be
 * exercised with a fake shell in-process, which matters more than usual because
 * the failure mode this whole subsystem exists to prevent (a session lost) is
 * one you cannot reproduce by hand without closing the app.
 *
 * What is NOT here is as important as what is. No OSC scanning, no activity
 * detection, no agent state, no notifications, no settings. Those stay in the
 * app, where they already work and where the policy belongs. This process holds
 * file descriptors open and remembers bytes; if it grew opinions it would need
 * to be restarted to change them, which is the one thing it must never do.
 */
import { RingBuffer } from './ring'
import type { AttachResult, SessionSummary } from './protocol'

/** What the app asks us to run. Already resolved — see `ClientMessage.spawn`. */
export interface SpawnSpec {
  id: string
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  meta?: unknown
}

/** The slice of node-pty this depends on, so tests can supply their own. */
export interface PtyLike {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
}

export type Spawner = (spec: SpawnSpec) => PtyLike

interface Session {
  id: string
  pty: PtyLike | null
  ring: RingBuffer
  cols: number
  rows: number
  pid: number
  startedAt: number
  meta?: unknown
  /** Client ids currently receiving this session's output. */
  attached: Set<string>
  exit?: { exitCode: number; signal?: number }
  /**
   * Clients that have confirmed they saw the exit.
   *
   * An exit is not delivered once and forgotten. The app may be closed when a
   * shell dies — that is the normal case now, not an edge one — so the record
   * is held until somebody acknowledges it. Without this a pane would come back
   * looking alive, attached to nothing, waiting forever for output from a
   * process that ended last Tuesday.
   */
  acked: Set<string>
  /**
   * Killed on purpose, and already dropped from the table.
   *
   * The pty still reports its exit a moment later, and by then the same id may
   * belong to a brand-new session — reopening a pane as another shell kills and
   * respawns under the pane's own id. Announcing that exit would be reporting
   * the death of a shell nobody is watching, against a pane whose shell is
   * fine, so the late event is dropped instead.
   */
  discarded: boolean
}

export interface SessionHooks {
  /** Live bytes, addressed to whoever is attached. */
  onData(id: string, data: Buffer, clients: ReadonlySet<string>): void
  onExit(id: string, exit: { exitCode: number; signal?: number }): void
}

export class SessionTable {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly spawner: Spawner,
    private readonly hooks: SessionHooks,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Starts a shell, or reports the one already running under this id.
   *
   * Re-spawning an id that exists is not an error and must not replace
   * anything: it is what an app that restarted and does not yet know what
   * survived will do for every pane it is restoring. Answering "already here"
   * is how a restored pane finds its own live shell.
   */
  create(
    spec: SpawnSpec
  ): { ok: true; existing: boolean; pid: number } | { ok: false; error: string } {
    const existing = this.sessions.get(spec.id)
    // The pid comes back on the existing path too: a restarting app needs it to
    // re-register the pid map, which is how `iaw` finds its pane when a process
    // has lost the environment.
    if (existing) return { ok: true, existing: true, pid: this.pidOf(existing) }

    let pty: PtyLike
    try {
      pty = this.spawner({
        ...spec,
        cols: Math.max(spec.cols, 2),
        rows: Math.max(spec.rows, 1),
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const session: Session = {
      id: spec.id,
      pty,
      ring: new RingBuffer(),
      cols: Math.max(spec.cols, 2),
      rows: Math.max(spec.rows, 1),
      pid: pty.pid,
      startedAt: this.now(),
      meta: spec.meta,
      attached: new Set(),
      acked: new Set(),
      discarded: false,
    }
    this.sessions.set(spec.id, session)

    pty.onData((chunk) => {
      const bytes = Buffer.from(chunk, 'utf8')
      // A killed shell can still print on its way out, and the id may already
      // belong to its replacement — those bytes would land in the wrong pane.
      if (session.discarded) return
      session.ring.write(bytes)
      // Emitted even with nobody attached — the ring is the point. A client
      // that connects in an hour gets this byte; the hooks simply have nobody
      // to hand it to right now.
      this.hooks.onData(session.id, bytes, session.attached)
    })

    pty.onExit((e) => {
      session.exit = { exitCode: e.exitCode, signal: e.signal }
      session.pty = null
      session.acked.clear()
      if (session.discarded) return
      this.hooks.onExit(session.id, session.exit)
    })

    return { ok: true, existing: false, pid: pty.pid }
  }

  /**
   * Subscribes a client and tells it what it missed.
   *
   * The reply carries the bytes rather than the caller fetching them
   * separately, because between the two calls the session would keep printing
   * and the seam would either drop output or repeat it.
   */
  attach(
    id: string,
    clientId: string,
    cursor?: number
  ): { result: AttachResult; backlog: Buffer } | null {
    const session = this.sessions.get(id)
    if (!session) return null
    session.attached.add(clientId)

    const slice = session.ring.readFrom(cursor ?? 0)
    return {
      result: {
        id,
        alive: session.pty !== null,
        cursor: slice.cursor,
        truncated: slice.truncated,
        exit: session.exit,
      },
      backlog: slice.data,
    }
  }

  detach(id: string, clientId: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    return session.attached.delete(clientId)
  }

  /** A client went away entirely — drop it from every session at once. */
  detachAll(clientId: string): void {
    for (const session of this.sessions.values()) session.attached.delete(clientId)
  }

  write(id: string, data: Buffer): boolean {
    const session = this.sessions.get(id)
    if (!session?.pty) return false
    session.pty.write(data.toString('utf8'))
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id)
    if (!session?.pty) return false
    session.cols = Math.max(cols, 2)
    session.rows = Math.max(rows, 1)
    try {
      session.pty.resize(session.cols, session.rows)
    } catch {
      // The shell can die between the client measuring and us resizing.
      return false
    }
    return true
  }

  /**
   * Ends a shell for good and forgets it.
   *
   * This is the user closing a pane, which is categorically different from the
   * app closing: detaching leaves the shell running, and only this throws the
   * work away. Nothing else in the broker destroys a session, which is the
   * property the whole design rests on.
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.discarded = true
    if (session.pty) {
      try {
        session.pty.kill()
      } catch {
        /* already gone */
      }
    }
    this.sessions.delete(id)
    return true
  }

  setMeta(id: string, meta: unknown): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.meta = meta
    return true
  }

  /**
   * A client confirms it has seen the exit.
   *
   * The session is only forgotten once no attached client still needs telling.
   * With two app instances open on one pane, the first to acknowledge must not
   * take the record away from the second.
   */
  ackExit(id: string, clientId: string): boolean {
    const session = this.sessions.get(id)
    if (!session || !session.exit) return false
    session.acked.add(clientId)
    const outstanding = [...session.attached].filter((c) => !session.acked.has(c))
    if (outstanding.length === 0) this.sessions.delete(id)
    return true
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      alive: s.pty !== null,
      cursor: s.ring.written,
      cols: s.cols,
      rows: s.rows,
      pid: this.pidOf(s),
      startedAt: s.startedAt,
      attached: s.attached.size,
      meta: s.meta,
      exit: s.exit,
    }))
  }

  /**
   * The shell's process id, resolved as late as necessary.
   *
   * ConPTY reports 0 for a short while after spawn: it creates the
   * pseudoconsole first and attaches the shell to it asynchronously, so there
   * is no id yet when `spawn` returns. Caching that 0 at creation — which is
   * what this used to do — meant `list` reported it forever, and the client's
   * retry had nothing better to read. Reading through to the pty and latching
   * the first real value fixes both, and costs nothing once it is known.
   *
   * Latched rather than always re-read so the id survives the session's death:
   * the phantom-exit check needs to know which pid to ask the OS about, and by
   * then the pty is gone.
   */
  private pidOf(session: Session): number {
    if (session.pid > 0) return session.pid
    const live = session.pty?.pid ?? 0
    if (live > 0) session.pid = live
    return session.pid
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  get count(): number {
    return this.sessions.size
  }

  /**
   * Whether there is anything left worth staying alive for.
   *
   * A dead session nobody has acknowledged still counts: its exit has not been
   * reported to anyone, and shutting down would lose the only record that the
   * shell ever ended.
   */
  get idle(): boolean {
    return this.sessions.size === 0
  }

  /** Last resort, on explicit shutdown only. */
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}
