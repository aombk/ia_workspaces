import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { OscScanner } from './oscScanner'
import { resolveShell } from './shells'
import { ActivityMonitor } from './activityMonitor'
import { AgentStateRegistry, encodeKey, type AgentReport } from './agentState'
import { isPhantomExit, isPidAlive, reapPhantom } from './phantomExit'
import type { ScrollbackStore } from './scrollback'
import type { PidMap } from './pidMap'
import type { SessionVault } from './vault'
import { connectPtyHost, createLocalBackend, type PtyBackend, type PtyBackendHooks } from './ptyHost'
import { selectOrphans } from './orphans'
import { renderReplay } from './replayRender'
import { REPLAY_RESET, stripInteractive } from './replaySafe'
import type { AskResult } from './controlServer'
import { acceptSession, resumeCommand } from './agentSessions'
import { hasQuirk, platformKind, withBinDir } from '../shared/platform'
import type {
  AgentChoice,
  AgentSession,
  PaneAgentState,
  PaneStatus,
  PtyExit,
  PtyOutput,
  SessionHostInfo,
  Settings,
  SpawnRequest,
  TerminalAlert,
  TerminalMeta,
} from '../shared/types'

const PLATFORM = platformKind(process.platform)

/** Output is coalesced over this window before crossing the IPC boundary. */
const FLUSH_MS = 6
/** …unless a single pane buffers this much, then flush immediately. */
const FLUSH_BYTES = 128 * 1024
/** Bells fired closer together than this collapse into one notification. */
const ALERT_COOLDOWN_MS = 4000
/** How long to keep asking ConPTY for the shell's pid. See `registerPid`. */
const PID_RETRY_MS = [10, 40, 100, 250, 600, 1500]
/**
 * Most blank lines a replay will print to push itself into the scrollback.
 *
 * A ceiling rather than a number: the padding is one viewport tall, and a pane
 * that reports an absurd height must not be able to flood the buffer with it.
 */
const MAX_REPLAY_PADDING = 200
/** Longest wait for a prompt marker before resuming anyway. See `spawn`. */
const RESUME_FALLBACK_MS = 1500

interface Session {
  id: string
  workspaceId: string
  scanner: OscScanner
  cwd: string
  title: string
  /** Last line submitted here, mirrored to the renderer so it is persisted. */
  lastCommand: string
  /**
   * The agent conversation this pane is running, as far as we know.
   *
   * Mirrors what the renderer has been told, and is seeded with what it told
   * us at spawn, so `recordAgentSession` can tell a new conversation from the
   * one already recorded here without asking across the wire.
   */
  agentSession?: AgentSession
  /**
   * True between a command starting and the next 133;D marker. With shell
   * integration this comes from a real 133;C; without it we fall back to
   * watching for a submitted line, which is all cmd and WSL can offer.
   */
  running: boolean
  /** Whether this shell emits 133;C, so the fallback can stand down. */
  integrated: boolean
  commandStartedAt: number
  lastAlertAt: number
  pending: string
  flushTimer: NodeJS.Timeout | null
  exited: boolean
  /**
   * The shell's process id once ConPTY has resolved it — see `registerPid`.
   * Held here rather than read back off the pty so the pid map is always
   * unregistered with the same value it was registered with.
   */
  pid: number
  /**
   * When we handed this shell to ConPTY. Compared against the OS's own record
   * of when the process started before anything is killed on the strength of
   * its pid — see `phantomExit.ts`.
   */
  spawnedAt: number
  /** The executable we launched, for the same identity check. */
  shellImage: string
  /**
   * Command to type once the shell is ready, cleared as soon as it is sent.
   * Holds the agent-resume line on a restored pane; null on a fresh one.
   */
  pendingCommand: string | null
  pendingCommandTimer: NodeJS.Timeout | null
  /**
   * True only while replayed output is being pushed through the scanner.
   *
   * Everything the scanner reports during a replay is a fact about the past —
   * a bell that rang an hour ago, a command that finished before lunch — and
   * the alert pipeline must stay quiet for all of it. Raised and lowered around
   * one synchronous `push`, so it never spans a turn of the event loop.
   */
  replaying: boolean
}

export interface PtyManagerHooks {
  onData(payload: PtyOutput): void
  onExit(payload: PtyExit): void
  onMeta(payload: TerminalMeta): void
  onAlert(alert: TerminalAlert): void
  onStatus(status: PaneStatus): void
  /**
   * A command finished, with what it exited with and how long it took.
   *
   * Separate from `onAlert` because that one is deliberately picky — it fires
   * only for commands long enough to be worth interrupting somebody about — and
   * this has to see every one of them, including the instant failures, which
   * are exactly the ones worth remembering.
   */
  onOutcome(outcome: { paneId: string; exitCode: number; ms: number }): void
}

export interface PtyManagerDeps {
  /**
   * Where the `iaw` CLI should connect, injected into child shells. Read per
   * spawn rather than captured, because the control server can still be moving
   * from a named pipe to loopback TCP when the first pane starts.
   */
  notifyPipe: () => string
  /** Folder holding each pane's recallable commands, for the integration script. */
  historyDir: () => string
  /** Proof a caller is talking to us from inside one of our panes. */
  token: string
  /** Folder holding the `iaw.cmd` shim, prepended to each pane's PATH. */
  binDir: string | null
  scrollback: ScrollbackStore
  pidMap: PidMap
  /** Keeps a closed pane's transcript, which the scrollback buffer does not. */
  vault: SessionVault
  /** Re-executed as plain Node to start the broker. `process.execPath`. */
  execPath: string
  /** The broker's bundle, unpacked from the asar like the CLI's. */
  hostScript: string
}

export class PtyManager {
  private readonly sessions = new Map<string, Session>()
  /**
   * Panes killed a moment ago, by pane id and when.
   *
   * A shell reports its exit after it has been asked to end, and a pane that is
   * being reopened as another shell has already spawned its replacement under
   * the same id by then. The broker we are talking to may be an older build
   * that still announces those, so the exit is matched against this and dropped
   * rather than pinned on the shell that is now running there.
   */
  private readonly killed = new Map<string, number>()
  /** How long after a kill an exit is still the killed shell's. */
  private static readonly KILL_ECHO_MS = 5_000
  /** Grace given to a slept shell's children before they count as orphans. */
  private static readonly SLEEP_REAP_AFTER_MS = 2_000
  private readonly activity: ActivityMonitor
  readonly agents: AgentStateRegistry
  private backend: PtyBackend | null = null
  private starting: Promise<PtyBackend> | null = null

  constructor(
    private readonly hooks: PtyManagerHooks,
    private getSettings: () => Settings,
    private readonly deps: PtyManagerDeps
  ) {
    this.activity = new ActivityMonitor(
      {
        onActive: (paneId) => this.hooks.onStatus({ paneId, activity: 'active' }),
        onIdle: (paneId) => this.handleWentQuiet(paneId),
      },
      () => this.getSettings().notifications.idleSeconds * 1000
    )
    this.agents = new AgentStateRegistry((agent) => this.handleAgentState(agent))
  }

  /**
   * Reaches the session broker, starting one if there is none.
   *
   * Lazy and memoised rather than done at construction, because it is async and
   * every caller below needs the same single answer. Nothing forces it early:
   * the first pane to spawn pays for it, and there is no window in which the
   * app is up but a terminal cannot be opened.
   */
  private host(): Promise<PtyBackend> {
    if (this.backend) return Promise.resolve(this.backend)
    if (this.starting) return this.starting

    // Read once, at the moment the first pane needs a shell, and not again.
    // Flipping this mid-run cannot move shells that are already running from
    // one owner to the other, so the setting says it takes effect on restart —
    // except at quit, where `release` honours the current value by ending the
    // sessions rather than leaving them behind.
    if (!this.getSettings().keepSessionsAlive) {
      this.backend = createLocalBackend(this.hostHooks())
      return Promise.resolve(this.backend)
    }

    this.starting = connectPtyHost({
      execPath: this.deps.execPath,
      hostScript: this.deps.hostScript,
      hooks: this.hostHooks(),
    }).then((backend) => {
      this.backend = backend
      return backend
    })
    return this.starting
  }

  private hostHooks(): PtyBackendHooks {
    return {
      onData: (id, data, backlog) => this.handleData(id, data, backlog),
      onExit: (id, exit) => this.handleExit(id, exit),
      onLost: () => this.handleHostLost(),
    }
  }

  /** Which kind of host is in use, for the UI to be honest about persistence. */
  get hostKind(): 'broker' | 'local' | 'connecting' {
    return this.backend?.kind ?? 'connecting'
  }

  /**
   * Every shell being held, and by what.
   *
   * Uses a no-launch probe when nothing has needed a shell yet, so opening the
   * processes pane on a window with no terminals still reports sessions left
   * over from a previous run — which is exactly the case worth being able to
   * see — without starting a broker to answer the question.
   */
  async hostSnapshot(): Promise<SessionHostInfo> {
    const host = this.backend ?? (await this.adoptExistingHost())
    if (!host) return { kind: this.backend?.kind ?? 'connecting', sessions: [] }
    const sessions = await host.list()
    return {
      kind: host.kind,
      sessions: sessions.map((s) => ({
        id: s.id,
        alive: s.alive,
        pid: s.pid,
        startedAt: s.startedAt,
        attached: s.attached,
      })),
    }
  }

  /**
   * Ends sessions no pane can ever reach again.
   *
   * The broker only forgets a session when the user closes its pane, when the
   * shell exits, or at a reboot — quitting the app deliberately does none of
   * those. So a pane that stops existing while the app is closed (a workspace
   * deleted, a different workspace file loaded, a pane removed by another
   * instance) leaves a shell running that nothing will ever display again. It
   * is invisible, it costs a shell's worth of memory, and — because idle-exit
   * requires *zero* sessions — a single one of them keeps the broker alive
   * indefinitely, and every other orphan with it. That is the one unbounded
   * case in the design, and this is what bounds it.
   *
   * `live` is every pane id in the workspace document, across all workspaces
   * rather than just the open one, because any of them may be shown again.
   *
   * Three conditions, and each rules out a different way of being wrong:
   *
   * - **not referenced** — nothing can ever draw it,
   * - **nobody attached** — no other instance of the app is using it right now,
   * - **older than the grace period** — a pane created seconds ago may not have
   *   reached `workspace.json` yet, and killing a shell the user just opened
   *   would be a far worse bug than the leak this fixes.
   */
  async reapOrphans(live: ReadonlySet<string>): Promise<number> {
    const host = this.backend ?? (await this.adoptExistingHost())
    if (!host) return 0

    const doomed = selectOrphans(await host.list(), live, Date.now())
    for (const session of doomed) host.kill(session.id)
    return doomed.length
  }

  /**
   * Connects only if a broker is already running.
   *
   * The sweep has to be able to run when this app has no panes of its own —
   * that is precisely the case where the orphans are — but it must not *start*
   * a broker to go looking, or every launch would spawn one to find nothing.
   * A connection made this way is a real one and is kept.
   */
  private async adoptExistingHost(): Promise<PtyBackend | null> {
    const backend = await connectPtyHost({
      execPath: this.deps.execPath,
      hostScript: this.deps.hostScript,
      noLaunch: true,
      hooks: this.hostHooks(),
    })
    // No broker running means no orphans to find. The local backend it fell
    // back to holds nothing, so dropping it costs nothing.
    if (backend.kind !== 'broker') return null
    this.backend = backend
    return backend
  }

  async spawn(req: SpawnRequest): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.sessions.has(req.paneId)) return { ok: true }

    const settings = this.getSettings()
    const resolved = resolveShell(req.shell, settings, {
      distro: req.wslDistro,
      host: req.sshHost,
      cwd: req.cwd,
    })

    // Where `ssh` itself runs is not where the pane ends up: the remote
    // directory travelled in the argv, and this machine has no folder by that
    // name. Home is somewhere that certainly exists and that the process never
    // looks at. Every other shell lands in the pane's own folder — and a folder
    // can be renamed or deleted between sessions, so a missing one falls back
    // rather than failing the spawn and losing the pane.
    const cwd = req.shell === 'ssh' ? os.homedir() : (usableDirectory(req.cwd) ?? os.homedir())

    // Stamped before the spawn rather than after it, so the value can only ever
    // be earlier than the OS's own creation time — never later, which would
    // make a legitimate process look like a recycled pid.
    const spawnedAt = Date.now()

    // Prepared here, before there is a shell, and that ordering is the whole
    // reason it is not done where it is used. Reconstructing a saved screen
    // takes milliseconds — measured at 12 for a full ring — and a shell that
    // printed its prompt during them would have it painted over by a restore
    // arriving late. Worse, `handleData` drops output for a pane that is not in
    // `sessions` yet, so those milliseconds are a window in which the prompt is
    // not merely reordered but lost. Nothing has been started yet here, so there
    // is no window.
    //
    // Read rather than consumed, because whether this is used at all is not
    // known until the spawn returns: a pane that reattached to a live session
    // gets its output from the broker and must leave the saved copy alone.
    const replay = await this.prepareReplay(req.paneId)

    const host = await this.host()
    const started = await host.spawn({
      id: req.paneId,
      file: resolved.file,
      args: resolved.args,
      cwd,
      cols: Math.max(req.cols, 2),
      rows: Math.max(req.rows, 1),
      // `withBinDir` wraps the whole block rather than setting a PATH inside
      // it, and that ordering is load-bearing: it is what guarantees the
      // child gets exactly one PATH however many of these spreads carry one.
      // Setting `PATH:` here alongside a spread of `process.env` is what used
      // to hand every pane two of them — see `withBinDir` for what that broke.
      env: withBinDir(
        {
          ...process.env,
          TERM_PROGRAM: 'ia_workspaces',
          // Claude Code and friends read this to decide colour depth.
          COLORTERM: 'truecolor',
          // Pane identity, so `iaw` run inside this shell — including from an
          // agent hook — lands on this exact pane.
          IAW_PANE_ID: req.paneId,
          IAW_WORKSPACE_ID: req.workspaceId,
          IAW_PIPE: this.deps.notifyPipe(),
          IAW_TOKEN: this.deps.token,
          // Where this pane's recallable commands are written. The integration
          // script binds the arrows and reads `$IAW_HISTORY_DIR/$IAW_PANE_ID.txt`.
          IAW_HISTORY_DIR: this.deps.historyDir(),
          // Last, so a shell that needs its own environment to find our
          // integration gets it. Only zsh does; see `applyIntegration`.
          ...resolved.env,
        },
        this.deps.binDir,
        PLATFORM
      ),
    })
    if (!started.ok) return { ok: false, error: started.error }

    // Two very different things can have just happened, and everything below
    // turns on which. A NEW shell wants the previous run's screen painted above
    // it, because there is nothing else there. A shell that was ALREADY RUNNING
    // — the app was restarted and the broker kept it — wants nothing of the
    // sort: its real output is about to be replayed from the broker's own ring,
    // and a stale copy from disk on top of that would be a second, older
    // rendering of the same pane.
    const reattached = started.existing
    // The pane's size is what makes the replay legible next time round; recorded
    // here as well as on every resize so a pane that is never resized still has
    // one. See `ScrollbackStore.setSize`.
    this.deps.scrollback.setSize(req.paneId, req.cols, req.rows)
    if (!reattached) this.emitReplay(req.paneId, replay, req.rows)

    const session: Session = {
      id: req.paneId,
      workspaceId: req.workspaceId,
      scanner: null as unknown as OscScanner,
      cwd,
      title: '',
      lastCommand: '',
      running: false,
      integrated: resolved.integrated,
      commandStartedAt: 0,
      lastAlertAt: 0,
      pending: '',
      flushTimer: null,
      exited: false,
      pid: 0,
      spawnedAt,
      shellImage: resolved.file,
      agentSession: req.resumeSession,
      // Only an agent pane gets a line back, and only the one we compose
      // ourselves. A plain shell reopens at an empty prompt.
      pendingCommand: resumeCommand(req.resumeSession, Date.now()),
      pendingCommandTimer: null,
      replaying: false,
    }

    session.scanner = new OscScanner({
      onBell: () => this.fireAlert(session, 'bell', 'Terminal needs attention', this.label(session)),
      onTitle: (title) => {
        const clean = title.trim()
        if (clean && clean !== session.title) {
          session.title = clean
          this.hooks.onMeta({ paneId: session.id, title: clean })
        }
      },
      onCwd: (cwd) => {
        if (cwd && cwd !== session.cwd) {
          session.cwd = cwd
          this.hooks.onMeta({ paneId: session.id, cwd })
        }
      },
      onNotify: (title, body) => this.fireAlert(session, 'osc', title, body),
      onPromptStart: () => {
        session.running = false
        // A prompt is the shell saying it is ready for input — the only honest
        // moment to type a resume line into it.
        this.sendPendingCommand(session)
      },
      onCommandStart: () => {
        session.integrated = true
        session.running = true
        session.commandStartedAt = Date.now()
      },
      onCommandEnd: (code) => this.handleCommandEnd(session, code),
      onCommandLine: (command) => {
        // Re-running the same line is the common case at a prompt; there is
        // nothing for the renderer to persist when nothing changed.
        if (command === session.lastCommand) return
        session.lastCommand = command
        // The folder travels with the line. Without it every entry recorded a
        // blank `cwd`, which is fine for a list you scroll and useless for
        // everything that asks "what do I run *here*" — the runbook filters on
        // it, and cross-machine sharing groups on it. The session has known the
        // folder all along; it simply was not on this message.
        this.hooks.onMeta({ paneId: session.id, lastCommand: command, cwd: session.cwd })
      },
    })

    this.sessions.set(req.paneId, session)
    this.activity.start(req.paneId)
    this.deps.scrollback.track(req.paneId)
    this.registerPid(session, started.pid)

    // Decided BEFORE attaching, because attaching is what starts the backlog
    // flowing and the backlog carries prompt markers.
    //
    // Whether a frame arrives before or after the attach continuation depends
    // on how the OS coalesces two writes, which varies by transport and payload
    // size — `tests/host.test.mjs` pins the current answer precisely because it
    // is not one to depend on. Settling this here puts the decision somewhere
    // no delivery timing can reach it.
    if (reattached) {
      // The resume line exists to put an agent back into a *fresh* shell. This
      // shell never stopped, and the agent is still sitting in it, so typing
      // `claude --resume` here would start a second conversation on top of the
      // one already running.
      session.pendingCommand = null
    } else if (session.pendingCommand) {
      // cmd and WSL never emit a prompt marker, and PowerShell only does with
      // shell integration on. Without a deadline the resume would simply never
      // happen on those, so wait for the marker but do not depend on it.
      session.pendingCommandTimer = setTimeout(
        () => this.sendPendingCommand(session),
        RESUME_FALLBACK_MS
      )
    }

    // Subscribing is what starts the output flowing, and for a shell that was
    // already running it is also what delivers everything printed while this
    // app was not here to see it — as backlog frames, through `handleData`.
    const attached = await host.attach(req.paneId)

    // It died while nobody was attached. The broker held the record precisely
    // so that this could still be reported rather than leaving a pane waiting
    // on a process that ended hours ago.
    if (attached && !attached.alive && attached.exit) {
      this.handleExit(req.paneId, attached.exit)
    }

    return { ok: true }
  }

  /**
   * Terminal bytes, live or replayed.
   *
   * The `backlog` distinction is not cosmetic. Replayed output is history: it
   * must reach the screen and the scanner — that is how a reattached pane gets
   * its title and directory back — but it must not be treated as *activity*, or
   * a pane that has sat quiet for an hour would flare into life the instant the
   * app reopened and then fire a "gone quiet" alert a few seconds later. Nor
   * may it raise alerts of its own: replaying an hour of output through the OSC
   * scanner would otherwise re-fire every bell and every command-finished
   * notification the pane ever produced.
   */
  private handleData(paneId: string, bytes: Buffer, backlog: boolean): void {
    const session = this.sessions.get(paneId)
    if (!session) return
    const data = bytes.toString('utf8')

    // Synchronous, because `scanner.push` is: the flag is only raised for the
    // duration of this one replayed chunk's worth of callbacks.
    session.replaying = backlog
    session.scanner.push(data)
    session.replaying = false

    if (!backlog) this.activity.feed(session.id, data.length)
    this.deps.scrollback.push(session.id, data)
    session.pending += data
    if (session.pending.length >= FLUSH_BYTES) this.flush(session)
    else if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flush(session), FLUSH_MS)
    }
  }

  private handleExit(paneId: string, exit: { exitCode: number; signal?: number }): void {
    const session = this.sessions.get(paneId)
    // The broker holds an exit until somebody acknowledges it, so this has to
    // happen even for a pane we no longer know about — otherwise the record
    // would outlive every client and keep the broker awake forever.
    void this.backend?.ackExit(paneId)

    // The shell we ended ourselves, saying so on its way out. Whatever holds
    // this pane id now is its replacement and is running fine.
    const killedAt = this.killed.get(paneId)
    if (killedAt !== undefined) {
      this.killed.delete(paneId)
      // Only an echo while whatever holds the id now is still running. A
      // replacement that really did die this fast — a bad ssh host — has to be
      // reported, and its pid is gone by the time we are asked.
      if (Date.now() - killedAt <= PtyManager.KILL_ECHO_MS && (!session || isPidAlive(session.pid)))
        return
    }

    if (!session) return

    const code = exit.exitCode
    const signal = exit.signal
    const phantom = isPhantomExit(code, signal, session.pid, isPidAlive)

    session.exited = true

    if (session.pendingCommandTimer) clearTimeout(session.pendingCommandTimer)
    session.pendingCommandTimer = null
    session.pendingCommand = null
    this.flush(session)
    this.activity.stop(session.id)
    this.deps.pidMap.unregister(session.pid)
    // The pane outlives its shell — keep the screen so a restart still has it.
    void this.deps.scrollback.flush(session.id)
    this.hooks.onExit({ paneId: session.id, exitCode: code ?? -1, signal })

    if (phantom) {
      // Reaping is asynchronous — it has to ask the OS who owns that pid before
      // it is allowed to kill anything — but the pane is finished with either
      // way, so nothing waits on it.
      void this.reapPhantomExit(session)
    } else if (this.getSettings().notifications.onExit) {
      this.fireAlert(
        session,
        'exit',
        'Shell exited',
        `${this.label(session)} exited with code ${code ?? -1}`
      )
    }
    this.sessions.delete(session.id)
  }

  /**
   * The broker died or the socket broke, with panes still open.
   *
   * Nothing is killed and nothing is announced as exited, because as far as we
   * know the shells are fine — it is our view of them that is gone. The panes
   * are marked so the next spawn reconnects rather than assuming it is already
   * attached.
   */
  private handleHostLost(): void {
    console.error('[pty] lost the session host; panes are detached until the next spawn')
    this.backend = null
    this.starting = null
  }

  /**
   * Types the pane's queued command, once.
   *
   * Deliberately written as if the user had typed it — the shell records it in
   * history and the line is visible in the pane, so a resume is something you
   * can see happened rather than a hidden side effect.
   *
   * Only ever the agent-resume line, which is a command we compose ourselves
   * and know the shape of. A pane's last *user* command is not replayed: it is
   * whatever they last ran, and a build, a push or a delete is not something to
   * put in front of the Enter key on their behalf.
   */
  private sendPendingCommand(session: Session): void {
    const command = session.pendingCommand
    if (!command || session.exited) return
    // A prompt marker inside replayed output is a fact about the past, exactly
    // like a replayed bell — it is not the shell saying it is ready for input
    // *now*. Acting on one types into a live agent on the strength of a prompt
    // it drew an hour ago. This is the same guard `fireAlert` carries, and it
    // should have been here from the start rather than only there.
    if (session.replaying) return
    session.pendingCommand = null
    if (session.pendingCommandTimer) {
      clearTimeout(session.pendingCommandTimer)
      session.pendingCommandTimer = null
    }
    this.backend?.write(session.id, command + '\r')
  }

  write(paneId: string, data: string): void {
    const s = this.sessions.get(paneId)
    if (!s || s.exited) return

    if (/[\r\n]/.test(data)) {
      // Proof a turn began even when the output that follows is too small for
      // the throughput detector to notice on its own.
      this.activity.beginTurn(paneId)
      // Whatever the pane was parked on, somebody is at it and has just given
      // it a line. See `submittedByHuman` for why Enter and not focus.
      this.agents.submittedByHuman(paneId)
      // Without shell integration this is the only command-start signal there
      // is. With it, 133;C is authoritative and this would also fire for every
      // Enter pressed inside a full-screen program.
      if (!s.integrated && !s.running) {
        s.running = true
        s.commandStartedAt = Date.now()
      }
    }
    this.backend?.write(paneId, data)
  }

  resize(paneId: string, cols: number, rows: number): void {
    const s = this.sessions.get(paneId)
    if (!s || s.exited) return
    const width = Math.max(cols, 2)
    const height = Math.max(rows, 1)
    this.backend?.resize(paneId, width, height)
    // The saved stream is painted against whatever the width is now, so the two
    // have to be recorded together or a restore reconstructs one against the
    // other. Cheap, and a no-op when the size has not actually changed.
    this.deps.scrollback.setSize(paneId, width, height)
  }

  /**
   * The user closed a pane.
   *
   * The one path that actually ends a shell. Everything else — quitting the
   * app, the window closing, the process being killed — now only detaches, so
   * this is the sole place work gets thrown away and it stays deliberate.
   */
  kill(paneId: string): void {
    const s = this.sessions.get(paneId)
    this.activity.stop(paneId)
    this.agents.release(paneId)
    // The last moment the transcript exists. `drop` below is right for the
    // *buffer* — it exists to restore a pane, and this pane is not coming back
    // — but the content is a different thing, and throwing it away was the one
    // place this app deliberately destroyed something the user might want.
    this.archive(paneId, s)
    // Closed by the user, so unlike an exit its screen is not coming back.
    this.deps.scrollback.drop(paneId)
    this.backend?.kill(paneId)
    const now = Date.now()
    for (const [id, at] of this.killed) {
      if (now - at > PtyManager.KILL_ECHO_MS) this.killed.delete(id)
    }
    this.killed.set(paneId, now)
    if (!s) return
    this.deps.pidMap.unregister(s.pid)
    if (s.flushTimer) clearTimeout(s.flushTimer)
    this.sessions.delete(paneId)
  }

  /**
   * The pane stays; its shell does not.
   *
   * Between `kill` and `release`: the shell is ended for real, but the pane is
   * not being closed and its shells are not being handed over to anybody, so
   * everything that makes the pane what it is survives — the saved screen, the
   * transcript, its place in the workspace. Only the processes go.
   *
   * What that gives back is the reason this exists. An idle agent pane is half
   * a gigabyte of `claude.exe` plus its MCP servers, and ConPTY does not
   * reliably take those children with it: killing the shell can leave the
   * expensive half of the tree running and orphaned, which would make the whole
   * feature a lie. So the tree is reaped afterwards, through the same identity
   * check the phantom-exit path uses — a pid is not an identity, and this must
   * never take out somebody else's work on the strength of a recycled number.
   */
  async sleep(paneId: string): Promise<void> {
    const s = this.sessions.get(paneId)
    if (!s) return
    this.activity.stop(paneId)
    this.agents.release(paneId)
    // Deliberately *not* `scrollback.drop`: the screen is the pane's, and the
    // pane is still here. Flushed instead, so a restart restores what it said.
    void this.deps.scrollback.flush(paneId)
    this.backend?.kill(paneId)
    // The pane writes its own line about going to sleep; an exit notice from
    // the shell we just ended would be the same news, worded as a failure.
    this.killed.set(paneId, Date.now())
    this.deps.pidMap.unregister(s.pid)
    if (s.flushTimer) clearTimeout(s.flushTimer)
    this.sessions.delete(paneId)
    await this.reapAfterSleep(s)
  }

  /**
   * Makes sure the shell's children went with it.
   *
   * A grace period first, because the ordinary case is that they did and the
   * cheapest correct thing is to look once, late, rather than race the shell's
   * own shutdown and reap a tree that was already leaving.
   */
  private async reapAfterSleep(session: Session): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, PtyManager.SLEEP_REAP_AFTER_MS))
    if (!isPidAlive(session.pid)) return
    const { identity, reaped } = await reapPhantom({
      pid: session.pid,
      spawnedAt: session.spawnedAt,
      shellImage: session.shellImage,
    })
    if (reaped) {
      console.warn(
        `[pty] ${session.id}: slept, and its tree outlived the shell` +
          ` (identity: ${identity}) — reaped pid ${session.pid} and its children`
      )
    } else if (identity === 'unconfirmed') {
      console.warn(
        `[pty] ${session.id}: slept, but pid ${session.pid} could not be confirmed as ours —` +
          ' left alone'
      )
    }
  }

  /**
   * The app is going away; the shells are not.
   *
   * This used to kill every pane, and the rename is the feature: quitting now
   * hangs up on the broker and leaves each session running, so reopening
   * reattaches to the same live shells rather than starting new ones over a
   * replayed screenshot. Where no broker could be reached the local backend
   * still ends them, because there is nothing there to keep them.
   */
  release(): void {
    // Turning the setting off mid-run cannot retroactively move running shells
    // out of the broker, but it can be honoured here: somebody who has just
    // said "do not keep my shells running" should not find them running. The
    // sessions this instance owns are ended; orphans from earlier runs are the
    // sweep's business.
    const keep = this.getSettings().keepSessionsAlive
    for (const id of [...this.sessions.keys()]) {
      const s = this.sessions.get(id)
      if (s?.flushTimer) clearTimeout(s.flushTimer)
      if (!keep) this.backend?.kill(id)
      this.activity.stop(id)
      this.sessions.delete(id)
    }
    this.backend?.release()
  }

  /** Pane id -> the shell's pid, for the process panel. Live sessions only. */
  panePids(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [paneId, session] of this.sessions) {
      if (!session.exited && session.pid > 0) out.set(paneId, session.pid)
    }
    return out
  }

  /** True while a foreground command is running — used to confirm pane close. */
  isBusy(paneId: string): boolean {
    return this.sessions.get(paneId)?.running ?? false
  }

  has(paneId: string): boolean {
    return this.sessions.has(paneId)
  }

  /** Raised by the CLI on behalf of a shell running in this pane. */
  /**
   * Records the agent conversation a pane is running, reported by the agent's
   * own hooks. Rides the meta channel the renderer already uses for cwd and
   * title, because it is the same kind of fact about the same pane.
   *
   * Not every id offered here is worth keeping. Claude Code issues one at
   * `SessionStart`, which is startup — before the conversation exists and
   * before anything is written to disk. Start Claude Code in a pane, say
   * nothing, quit the app: the id was recorded, the conversation never was,
   * and the pane came back typing `claude --resume <id>` at a conversation
   * Claude Code had never heard of. Worse, that empty session's id had
   * overwritten the id of the real one the pane had before it.
   *
   * So an id displaces a different, already-recorded one on one of two
   * grounds: its transcript is on disk, or it comes from the user submitting a
   * prompt to it, which is a conversation beginning in earnest. An id from a
   * session that has neither said anything nor written anything is not
   * evidence about which conversation this pane is having. A pane with nothing
   * recorded yet takes whatever it is given — there is nothing to lose, and
   * `resumeCommand` checks the transcript before typing anything anyway.
   */
  recordAgentSession(
    paneId: string,
    sessionId: string,
    transcriptPath?: string,
    hookEvent?: string
  ): boolean {
    const session = this.sessions.get(paneId)
    if (!session || session.exited) return false

    const record = acceptSession(
      session.agentSession,
      { id: sessionId, transcript: transcriptPath, hookEvent },
      Date.now()
    )
    // Nothing worth keeping. Still an accepted call: the caller is a hook, and
    // there is nothing here for it to report or retry.
    if (!record) return true

    session.agentSession = record
    this.hooks.onMeta({ paneId, agentSession: record })
    return true
  }

  notifyFromCli(paneId: string, title: string, body: string): boolean {
    const session = this.sessions.get(paneId)
    if (!session) return false
    this.fireAlert(session, 'cli', title, body)
    return true
  }

  /** A pane telling us what it is doing. */
  reportAgent(paneId: string, report: AgentReport): boolean {
    if (!this.sessions.has(paneId)) return false
    return this.agents.report(paneId, report)
  }

  /**
   * Puts a question in front of the human and holds the asker until it is
   * answered.
   *
   * This is the same question the blocked bar and the inbox already draw — it
   * arrives as ordinary declared state, so no UI knows or cares that this one
   * came with somebody waiting on the other end. What changes is where the
   * answer goes: back down the caller's own connection instead of into the
   * pane's keyboard.
   *
   * That is worth having because typing is the weak part of the existing relay.
   * It works everywhere, which is why it stays, but it means imitating a
   * keyboard against a menu we have to trust the agent to have described
   * correctly, in a pane that has to still be showing it. A hook that asks and
   * waits needs none of that to be true.
   */
  askAgent(opts: {
    paneId: string
    question: string
    choices: AgentChoice[]
    timeoutMs: number
    onAbort: (fn: () => void) => void
  }): Promise<{ ok: boolean; error?: string; result?: AskResult }> {
    const session = this.sessions.get(opts.paneId)
    if (!session || session.exited) {
      return Promise.resolve({ ok: false, error: 'unknown pane' })
    }

    return new Promise((resolve) => {
      const requestId = randomUUID()
      let settled = false

      const finish = (choice: AgentChoice) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          ok: true,
          result: {
            choice: choice.id,
            label: choice.label,
            // The registry settles an abandoned waiter with a blank choice, so
            // the caller can tell "the human picked this" from "nobody did".
            outcome: choice.id ? 'answered' : 'abandoned',
          },
        })
      }

      // A question nobody answers must not hold a pane blocked forever. The
      // deadline is the caller's, since it is the one that knows how long the
      // thing behind it will wait.
      const timer = setTimeout(() => {
        this.agents.abandonAsk(opts.paneId, requestId)
        finish({ id: '', label: '' })
      }, opts.timeoutMs)
      timer.unref?.()

      // The caller hung up — a hook killed at the keyboard, or an agent that
      // gave up. Nothing is going to read the answer, so stop showing the
      // question.
      opts.onAbort(() => {
        this.agents.abandonAsk(opts.paneId, requestId)
        finish({ id: '', label: '' })
      })

      const accepted = this.agents.ask(opts.paneId, opts.question, opts.choices, {
        requestId,
        settle: finish,
      })
      if (!accepted) {
        clearTimeout(timer)
        settled = true
        resolve({ ok: false, error: 'no answerable choices' })
      }
    })
  }

  /**
   * Relays a declared answer into a blocked pane.
   *
   * Two ways to deliver it, and the better one is tried first: a pane parked on
   * `iaw ask` has somebody holding a connection open for the answer, so it goes
   * straight back to them. Everything else gets the original treatment — the
   * bytes that pane itself published, typed into its terminal.
   *
   * Everything that makes the typed path safe lives in the registry: it refuses
   * unless the pane says it is blocked, and the bytes are the ones that pane
   * published. We never compose a payload of our own.
   */
  answerAgent(paneId: string, choiceId?: string): { ok: boolean; error?: string; label?: string } {
    const session = this.sessions.get(paneId)
    if (!session || session.exited) return { ok: false, error: 'unknown pane' }

    const delivered = this.agents.deliverAnswer(paneId, choiceId)
    if (delivered) return { ok: true, label: delivered.label }

    const resolved = this.agents.resolveAnswer(paneId, choiceId)
    if (!resolved) return { ok: false, error: 'pane is not waiting on a declared choice' }
    this.backend?.write(session.id, resolved.data)
    this.agents.markAnswered(paneId)
    return { ok: true, label: resolved.choice.label }
  }

  agentState(paneId?: string): PaneAgentState[] {
    return paneId ? [this.agents.snapshot(paneId)] : this.agents.all()
  }

  /**
   * Types text into a pane on behalf of a caller outside it.
   *
   * The trust boundary is the token, and it is worth being plain about what
   * that means: unlike `answer-agent`, which will only send bytes the pane's
   * own agent published and only while that agent says it is blocked, this
   * sends whatever it is given, whenever. Anything holding the token can drive
   * any shell in the app.
   *
   * That is the same bargain every comparable tool makes, and the token is only
   * ever handed out through a pane's own environment or the pid map, both of
   * which are already as private as the user's own processes. The alternative —
   * no way to drive a pane from a script — is what made the CLI useless for
   * anything but talking about itself.
   *
   * It goes through `write` rather than straight to the pty so a submitted line
   * still opens a turn for the activity detector, exactly as typing it would.
   */
  sendText(paneId: string, text: string): boolean {
    const session = this.sessions.get(paneId)
    if (!session || session.exited) return false
    this.write(paneId, text)
    return true
  }

  /**
   * The same, for a named key.
   *
   * The vocabulary is the closed list the declared-answer path already uses,
   * for the same reason it is closed there: this writes into a shell, so
   * "whatever string you like" is not an option. Modifiers are applied on top —
   * control characters for `--ctrl`, an escape prefix for `--alt`, which is how
   * a terminal has always encoded Meta.
   */
  sendKey(
    paneId: string,
    key: string,
    mods: { ctrl?: boolean; shift?: boolean; alt?: boolean }
  ): { ok: boolean; error?: string } {
    const session = this.sessions.get(paneId)
    if (!session || session.exited) return { ok: false, error: 'unknown pane' }
    const data = encodeKey(key, mods)
    if (data === null) return { ok: false, error: `unknown key: ${key}` }
    this.write(paneId, data)
    return { ok: true }
  }

  /** The tail of what a pane has printed, as text. */
  readScreen(paneId: string, lines: number): string | null {
    return this.deps.scrollback.peek(paneId, lines)
  }

  /**
   * A pane's PTY reported an exit its process did not agree with.
   *
   * The shell is still running with nothing pointing at it, so it is ours to
   * clean up — but only once we can show the pid still belongs to the process
   * we started, because on Windows a pid outlives its owner by very little and
   * killing a tree on a recycled number is unrecoverable. `reapPhantom` makes
   * that call; all this does is act on it and say what happened.
   */
  private async reapPhantomExit(session: Session): Promise<void> {
    const { identity, reaped } = await reapPhantom({
      pid: session.pid,
      spawnedAt: session.spawnedAt,
      shellImage: session.shellImage,
    })

    if (reaped) {
      console.warn(
        `[pty] ${session.id}: pty reported an exit while pid ${session.pid} was still running` +
          ` (identity: ${identity}) — reaped it and its children`
      )
    } else if (identity === 'unconfirmed') {
      console.warn(
        `[pty] ${session.id}: pty reported an exit while pid ${session.pid} was still running,` +
          ` but that pid no longer looks like the shell we started — left alone`
      )
    }

    // Worth interrupting for: something was still running with no pane left
    // pointing at it, which is exactly the state that used to go unnoticed.
    if (!this.getSettings().notifications.onExit) return
    this.fireAlert(
      session,
      'exit',
      reaped ? 'Shell was left running' : 'Shell exited',
      reaped
        ? `${this.label(session)} lost its console while still running — it and its children were stopped`
        : `${this.label(session)} lost its console`
    )
  }

  /**
   * Records the shell's process id once ConPTY has one.
   *
   * The pid reads 0 for a moment after spawn on Windows: ConPTY creates the
   * pseudoconsole first and attaches the shell to it asynchronously, so the id
   * does not exist yet when the call returns. Registering that 0 is what
   * silently left the map empty. A few short retries cover the gap without
   * making spawn wait on anything.
   *
   * The retry now asks the broker rather than re-reading a local handle — the
   * pty lives in another process, and `list` is the only view of it we have.
   */
  private registerPid(session: Session, pid: number, attempt = 0): void {
    if (session.exited) return
    if (pid > 0) {
      session.pid = pid
      this.deps.pidMap.register(pid, {
        paneId: session.id,
        workspaceId: session.workspaceId,
        pipe: this.deps.notifyPipe(),
        token: this.deps.token,
      })
      return
    }
    if (attempt >= PID_RETRY_MS.length) return
    setTimeout(() => {
      if (session.exited || !this.backend) return
      void this.backend.list().then((sessions) => {
        const found = sessions.find((s) => s.id === session.id)
        this.registerPid(session, found?.pid ?? 0, attempt + 1)
      })
    }, PID_RETRY_MS[attempt])
  }

  private label(s: Session): string {
    return s.title || s.cwd
  }

  /**
   * Files a closing pane's transcript in the vault.
   *
   * Reads the same ring `read-screen` does, so a pane whose shell exited a
   * while ago still archives what it printed — the buffer outlives the shell,
   * and only closing the pane discards it. Best effort throughout: nothing here
   * is worth failing a pane close over.
   */
  private archive(paneId: string, session: Session | undefined): void {
    try {
      const text = this.deps.scrollback.peek(paneId, 100_000)
      if (!text) return
      this.deps.vault.archive(text, {
        label: session ? this.label(session) : paneId,
        cwd: session?.cwd ?? '',
        workspace: session?.workspaceId ?? '',
      })
    } catch {
      /* a transcript we could not file is not a reason to keep the pane open */
    }
  }

  /**
   * Puts the pane's last screen back before its new shell starts.
   *
   * A leading reset because the ring may have been cut mid-sequence, and a
   * marker line so the restored text is not mistaken for this session's.
   *
   * On Windows it then prints one screenful of blank lines, which is what makes
   * any of this survive. ConPTY opens by painting its own empty buffer — the
   * first bytes out of a new pseudoconsole are `ESC[2J ESC[H` — and an erase of
   * the viewport takes those lines with it rather than scrolling them up, so the
   * restored screen appeared for an instant and was then wiped by the shell
   * starting. Pushing it above the top of the viewport first puts it in the
   * scrollback, where the erase cannot reach it: the pane opens on a clean
   * prompt, exactly as ConPTY believes it has, and the last session is one
   * scroll up. Nothing is padded on macOS or Linux, where no such repaint comes
   * and the restored screen stays where it is written.
   *
   * The bytes themselves are not handed over as they were saved, and that is the
   * fix for a bug that looked like two. They were written by a program that is
   * no longer there — a full-screen agent that turned mouse reporting on, asked
   * the terminal what it was, and painted in absolute coordinates for a pane of
   * a different width. Replayed verbatim into a pane now running a bare shell,
   * its mode sets took effect (every mouse movement arriving at the prompt as
   * `35;24;9M`), its queries were answered *into the pty* (`ESC[?1;2c` splitting
   * the restore's own `claude --resume …` into `zsh: command not found: 1`), and
   * its painting landed in the wrong columns. So the stream is reconstructed
   * into the screen it produced where that is possible, and filtered either way:
   * `renderReplay`, then `replaySafe`.
   *
   * Split in two around its one slow step. `prepareReplay` does the reading and
   * the reconstruction and is called before anything is spawned; `emitReplay` is
   * synchronous and writes what it produced. See `spawn` for why that ordering
   * is not a style preference.
   */
  private async prepareReplay(paneId: string): Promise<string | null> {
    const saved = this.deps.scrollback.read(paneId)
    if (!saved) return null

    // Null whenever the reconstruction could not be trusted — no saved size, a
    // serialiser that threw, a build without the packages. The filtered stream
    // is then used as it stands: it looks worse and is exactly as safe, which is
    // the right way round for a fallback.
    const rendered = await renderReplay(saved.data, saved.cols, saved.rows)
    return rendered ?? stripInteractive(saved.data)
  }

  private emitReplay(paneId: string, screen: string | null, rows: number): void {
    if (screen === null) return
    // Only now, because only now has the pane taken ownership of it. A spawn
    // that reattached instead never reaches here and leaves the file alone.
    this.deps.scrollback.consume(paneId)

    const padding = hasQuirk(PLATFORM, 'ptyClearsOnStart')
      ? '\r\n'.repeat(Math.min(Math.max(rows, 1), MAX_REPLAY_PADDING))
      : ''
    this.hooks.onData({
      paneId,
      data:
        `\x1b[0m${screen}${REPLAY_RESET}\r\n\x1b[38;5;244m── restored from last session ──\x1b[0m\r\n` +
        padding,
    })
  }

  private flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (!session.pending) return
    const data = session.pending
    session.pending = ''
    this.hooks.onData({ paneId: session.id, data })
  }

  private handleCommandEnd(session: Session, exitCode: number): void {
    const wasRunning = session.running
    const startedAt = session.commandStartedAt
    session.running = false

    // Recorded first and unconditionally. Everything below this is about
    // whether to *interrupt* somebody, which is a different question with a
    // different answer — and a command that failed in half a second is beneath
    // the notification threshold and is the most worth writing down.
    if (wasRunning && startedAt) {
      this.hooks.onOutcome({ paneId: session.id, exitCode, ms: Date.now() - startedAt })
    }

    const n = this.getSettings().notifications
    if (!n.onCommandFinished || !wasRunning || !startedAt) return

    const seconds = (Date.now() - startedAt) / 1000
    if (seconds < n.minCommandSeconds) return

    const ok = exitCode === 0
    this.fireAlert(
      session,
      'command-finished',
      ok ? 'Command finished' : `Command failed (exit ${exitCode})`,
      `${this.label(session)} · ${formatDuration(seconds)}`
    )
  }

  /**
   * A pane stopped producing output after a burst.
   *
   * This is the signal that works for agents, because it needs no cooperation
   * from the program in the pane. When the pane has *declared* that it is
   * blocked we stay quiet: that alert already fired, with a real reason
   * attached, and repeating it as "gone quiet" would be strictly worse.
   */
  private handleWentQuiet(paneId: string): void {
    this.hooks.onStatus({ paneId, activity: 'idle' })

    const session = this.sessions.get(paneId)
    if (!session || session.exited) return
    const n = this.getSettings().notifications
    if (!n.onIdle) return
    if (this.agents.snapshot(paneId).state === 'blocked') return

    this.fireAlert(session, 'idle', 'Waiting for input', `${this.label(session)} has gone quiet`)
  }

  /**
   * A pane changed its declared state. Becoming blocked is the one transition
   * worth interrupting someone for — it is the only state that cannot resolve
   * itself.
   */
  private handleAgentState(agent: PaneAgentState): void {
    this.hooks.onStatus({ paneId: agent.paneId, agent })

    if (agent.state !== 'blocked' || agent.answeredAt) return
    const session = this.sessions.get(agent.paneId)
    if (!session) return
    this.fireAlert(
      session,
      'blocked',
      'Agent needs you',
      agent.blockedReason || this.label(session)
    )
  }

  /**
   * Emits the alert to the renderer, which owns the policy decision about
   * whether it becomes a toast, a sound, or just a tab badge.
   */
  private fireAlert(session: Session, trigger: TerminalAlert['trigger'], title: string, body: string): void {
    // Everything the scanner reports during a replay already happened, often
    // long ago. Interrupting someone for a bell that rang before lunch — and
    // doing it for every one of them at once, the moment the app reopens — is
    // the failure mode this single guard exists to prevent.
    if (session.replaying) return
    const now = Date.now()
    if (now - session.lastAlertAt < ALERT_COOLDOWN_MS && trigger === 'bell') return
    session.lastAlertAt = now
    this.hooks.onAlert({
      paneId: session.id,
      workspaceId: session.workspaceId,
      trigger,
      title,
      body,
    })
  }
}

function usableDirectory(candidate: string): string | null {
  if (!candidate) return null
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : null
  } catch {
    return null
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
