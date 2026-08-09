import { spawn, type IPty } from '@lydell/node-pty'
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
import type { AskResult } from './controlServer'
import { AGENT_SESSION_TTL_MS } from '../shared/types'
import { hasQuirk, pathListSeparator, platformKind } from '../shared/platform'
import type {
  AgentChoice,
  AgentSession,
  PaneAgentState,
  PaneStatus,
  PtyExit,
  PtyOutput,
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

/**
 * The line that re-enters a recorded conversation.
 *
 * `--resume <id>` and not `--continue`: continue means "the newest session in
 * this folder", which is the wrong answer the moment two panes are open on one
 * project. The id is checked against the shape Claude Code issues rather than
 * interpolated blind — it ends up on a command line, and this one is
 * reconstructed from a file on disk.
 */
function resumeCommand(session: AgentSession | undefined): string | null {
  if (!session || session.tool !== 'claude') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(session.id)) return null
  if (Date.now() - session.at > AGENT_SESSION_TTL_MS) return null
  return `claude --resume ${session.id}`
}

interface Session {
  id: string
  workspaceId: string
  pty: IPty
  scanner: OscScanner
  cwd: string
  title: string
  /** Last line submitted here, mirrored to the renderer so it is persisted. */
  lastCommand: string
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
}

export interface PtyManagerHooks {
  onData(payload: PtyOutput): void
  onExit(payload: PtyExit): void
  onMeta(payload: TerminalMeta): void
  onAlert(alert: TerminalAlert): void
  onStatus(status: PaneStatus): void
}

export interface PtyManagerDeps {
  /**
   * Where the `iaw` CLI should connect, injected into child shells. Read per
   * spawn rather than captured, because the control server can still be moving
   * from a named pipe to loopback TCP when the first pane starts.
   */
  notifyPipe: () => string
  /** Proof a caller is talking to us from inside one of our panes. */
  token: string
  /** Folder holding the `iaw.cmd` shim, prepended to each pane's PATH. */
  binDir: string | null
  scrollback: ScrollbackStore
  pidMap: PidMap
}

export class PtyManager {
  private readonly sessions = new Map<string, Session>()
  private readonly activity: ActivityMonitor
  readonly agents: AgentStateRegistry

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

  spawn(req: SpawnRequest): { ok: true } | { ok: false; error: string } {
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

    // Replay before the shell can print anything, so the restored screen is
    // always above this run's output rather than interleaved with it.
    this.replayScrollback(req.paneId, req.rows)

    // Stamped before the spawn rather than after it, so the value can only ever
    // be earlier than the OS's own creation time — never later, which would
    // make a legitimate process look like a recycled pid.
    const spawnedAt = Date.now()

    let pty: IPty
    try {
      pty = spawn(resolved.file, resolved.args, {
        name: 'xterm-256color',
        cols: Math.max(req.cols, 2),
        rows: Math.max(req.rows, 1),
        cwd,
        env: {
          ...(process.env as Record<string, string>),
          TERM_PROGRAM: 'ia_workspaces',
          // Claude Code and friends read this to decide colour depth.
          COLORTERM: 'truecolor',
          // Pane identity, so `iaw` run inside this shell — including from an
          // agent hook — lands on this exact pane.
          IAW_PANE_ID: req.paneId,
          IAW_WORKSPACE_ID: req.workspaceId,
          IAW_PIPE: this.deps.notifyPipe(),
          IAW_TOKEN: this.deps.token,
          // Makes `iaw` callable inside our panes without touching the
          // user's system PATH. The separator is a semicolon on Windows only,
          // because the colon was already spoken for by drive letters — get it
          // wrong and PATH becomes one entry that is every directory at once,
          // so nothing on it resolves.
          PATH: this.deps.binDir
            ? `${this.deps.binDir}${pathListSeparator(PLATFORM)}${process.env.PATH ?? ''}`
            : (process.env.PATH ?? ''),
          // Last, so a shell that needs its own environment to find our
          // integration gets it. Only zsh does; see `applyIntegration`.
          ...resolved.env,
        },
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const session: Session = {
      id: req.paneId,
      workspaceId: req.workspaceId,
      pty,
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
      // Only an agent pane gets a line back, and only the one we compose
      // ourselves. A plain shell reopens at an empty prompt.
      pendingCommand: resumeCommand(req.resumeSession),
      pendingCommandTimer: null,
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
        this.hooks.onMeta({ paneId: session.id, lastCommand: command })
      },
    })

    pty.onData((data) => {
      session.scanner.push(data)
      this.activity.feed(session.id, data.length)
      this.deps.scrollback.push(session.id, data)
      session.pending += data
      if (session.pending.length >= FLUSH_BYTES) this.flush(session)
      else if (!session.flushTimer) session.flushTimer = setTimeout(() => this.flush(session), FLUSH_MS)
    })

    pty.onExit(({ exitCode, signal }) => {
      // Typed as a number, but the code-less exit this guard exists for arrives
      // as null — that mismatch is the bug, so the runtime shape is what gets
      // inspected here.
      const code = exitCode as number | null | undefined
      const phantom = isPhantomExit(code, signal, session.pid, isPidAlive)

      session.exited = true

      // A killed shell still reports its exit, and by then the pane may already
      // be running a replacement — "Reopen as" kills and respawns under the same
      // pane id. Everything below is addressed by pane id, so letting a dead
      // session's exit through would announce the live one as exited, stop its
      // activity tracking and drop it from the map. Only the session the pane
      // currently holds gets to speak for it.
      if (this.sessions.get(session.id) !== session) {
        if (session.pendingCommandTimer) clearTimeout(session.pendingCommandTimer)
        if (session.flushTimer) clearTimeout(session.flushTimer)
        this.deps.pidMap.unregister(session.pid)
        if (phantom) void this.reapPhantomExit(session)
        return
      }

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
        // Reaping is asynchronous — it has to ask the OS who owns that pid
        // before it is allowed to kill anything — but the pane is finished with
        // either way, so nothing waits on it.
        void this.reapPhantomExit(session)
      } else if (this.getSettings().notifications.onExit) {
        this.fireAlert(session, 'exit', 'Shell exited', `${this.label(session)} exited with code ${code ?? -1}`)
      }
      this.sessions.delete(session.id)
    })

    this.sessions.set(req.paneId, session)
    this.activity.start(req.paneId)
    this.deps.scrollback.track(req.paneId)
    this.registerPid(session, pty)

    // cmd and WSL never emit a prompt marker, and PowerShell only does with
    // shell integration on. Without a deadline the resume would simply never
    // happen on those, so wait for the marker but do not depend on it.
    if (session.pendingCommand) {
      session.pendingCommandTimer = setTimeout(
        () => this.sendPendingCommand(session),
        RESUME_FALLBACK_MS
      )
    }
    return { ok: true }
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
    session.pendingCommand = null
    if (session.pendingCommandTimer) {
      clearTimeout(session.pendingCommandTimer)
      session.pendingCommandTimer = null
    }
    session.pty.write(command + '\r')
  }

  write(paneId: string, data: string): void {
    const s = this.sessions.get(paneId)
    if (!s || s.exited) return

    if (/[\r\n]/.test(data)) {
      // Proof a turn began even when the output that follows is too small for
      // the throughput detector to notice on its own.
      this.activity.beginTurn(paneId)
      // Without shell integration this is the only command-start signal there
      // is. With it, 133;C is authoritative and this would also fire for every
      // Enter pressed inside a full-screen program.
      if (!s.integrated && !s.running) {
        s.running = true
        s.commandStartedAt = Date.now()
      }
    }
    s.pty.write(data)
  }

  resize(paneId: string, cols: number, rows: number): void {
    const s = this.sessions.get(paneId)
    if (!s || s.exited) return
    try {
      s.pty.resize(Math.max(cols, 2), Math.max(rows, 1))
    } catch {
      /* the pty can die between the renderer measuring and us resizing */
    }
  }

  kill(paneId: string): void {
    const s = this.sessions.get(paneId)
    this.activity.stop(paneId)
    this.agents.release(paneId)
    // Closed by the user, so unlike an exit its screen is not coming back.
    this.deps.scrollback.drop(paneId)
    if (!s) return
    this.deps.pidMap.unregister(s.pid)
    try {
      s.pty.kill()
    } catch {
      /* already gone */
    }
    if (s.flushTimer) clearTimeout(s.flushTimer)
    this.sessions.delete(paneId)
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      const s = this.sessions.get(id)
      if (s) {
        try {
          s.pty.kill()
        } catch {
          /* already gone */
        }
        if (s.flushTimer) clearTimeout(s.flushTimer)
      }
      this.activity.stop(id)
      this.sessions.delete(id)
    }
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
   * own SessionStart hook. Rides the meta channel the renderer already uses for
   * cwd and title, because it is the same kind of fact about the same pane.
   */
  recordAgentSession(paneId: string, sessionId: string): boolean {
    const session = this.sessions.get(paneId)
    if (!session || session.exited) return false
    this.hooks.onMeta({
      paneId,
      agentSession: { tool: 'claude', id: sessionId, at: Date.now() },
    })
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
    session.pty.write(resolved.data)
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
   * `pty.pid` reads 0 for a moment after spawn on Windows: ConPTY creates the
   * pseudoconsole first and attaches the shell to it asynchronously, so the id
   * does not exist yet when spawn returns. Registering that 0 is what silently
   * left the map empty. A few short retries cover the gap without making spawn
   * wait on anything.
   */
  private registerPid(session: Session, pty: IPty, attempt = 0): void {
    if (session.exited) return
    const pid = pty.pid
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
    setTimeout(() => this.registerPid(session, pty, attempt + 1), PID_RETRY_MS[attempt])
  }

  private label(s: Session): string {
    return s.title || s.cwd
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
   */
  private replayScrollback(paneId: string, rows: number): void {
    const restored = this.deps.scrollback.take(paneId)
    if (!restored) return
    const padding = hasQuirk(PLATFORM, 'ptyClearsOnStart')
      ? '\r\n'.repeat(Math.min(Math.max(rows, 1), MAX_REPLAY_PADDING))
      : ''
    this.hooks.onData({
      paneId,
      data:
        `\x1b[0m${restored}\x1b[0m\r\n\x1b[38;5;244m── restored from last session ──\x1b[0m\r\n` +
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
