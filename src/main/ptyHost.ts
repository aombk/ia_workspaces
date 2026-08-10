/**
 * The app's side of the session broker.
 *
 * Two implementations of one interface, and the second is not a nicety. If the
 * broker cannot be reached — a policy that forbids the pipe namespace, a
 * sandbox, an antivirus that eats the detached child — the honest fallback is
 * the behaviour this app had before it existed: shells that run in-process and
 * die with the window. That is a real degradation and it is reported as one,
 * but it is enormously better than an app that cannot open a terminal.
 *
 * Both run the same `SessionTable`, so there is one implementation of what a
 * session *is*; the difference is only whether it lives on the other side of a
 * socket.
 */
import net from 'node:net'
import { spawn as spawnProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { spawn as spawnPty } from '@lydell/node-pty'
import {
  FRAME_BACKLOG,
  FRAME_DATA,
  FRAME_JSON,
  FrameReader,
  decodeData,
  decodeJson,
  encodeData,
  encodeJson,
  PROTOCOL_VERSION,
  type AttachResult,
  type ClientMessage,
  type HostMessage,
  type SessionSummary,
} from '../host/protocol'
import { hostPaths } from '../host/paths'
import { SessionTable, type PtyLike, type SpawnSpec } from '../host/sessions'

export type { SpawnSpec } from '../host/sessions'

/** How long to keep trying to reach a broker we have just launched. */
const CONNECT_TIMEOUT_MS = 8000
const CONNECT_BACKOFF_MS = [0, 50, 100, 200, 350, 500, 750, 1000, 1000, 1500, 1500, 2000]

export interface PtyBackendHooks {
  /**
   * Terminal bytes. `backlog` marks output the session produced while this app
   * was not listening — it is replayed to rebuild a pane, and callers must not
   * treat it as activity or the pane would look busy the moment it reappeared.
   */
  onData(id: string, data: Buffer, backlog: boolean): void
  onExit(id: string, exit: { exitCode: number; signal?: number }): void
  /** The broker went away mid-session. Panes are live but unreachable. */
  onLost?(): void
}

export interface PtyBackend {
  readonly kind: 'broker' | 'local'
  spawn(
    spec: SpawnSpec
  ): Promise<{ ok: true; existing: boolean; pid: number } | { ok: false; error: string }>
  attach(id: string, cursor?: number): Promise<AttachResult | null>
  detach(id: string): void
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  list(): Promise<SessionSummary[]>
  ackExit(id: string): void
  setMeta(id: string, meta: unknown): void
  /** Quitting: stop listening, leave everything running. */
  release(): void
}

// ------------------------------------------------------------------- broker

class BrokerBackend implements PtyBackend {
  readonly kind = 'broker'
  private ref = 0
  private readonly waiting = new Map<number, (m: HostMessage) => void>()
  private closed = false

  constructor(
    private readonly socket: net.Socket,
    private readonly hooks: PtyBackendHooks
  ) {
    const reader = new FrameReader(
      (kind, payload) => {
        if (kind === FRAME_JSON) {
          const message = decodeJson(payload) as HostMessage | null
          if (!message) return
          if (message.t === 'exit') {
            this.hooks.onExit(message.id, { exitCode: message.exitCode, signal: message.signal })
            return
          }
          const settle = this.waiting.get((message as { ref: number }).ref)
          if (settle) {
            this.waiting.delete((message as { ref: number }).ref)
            settle(message)
          }
          return
        }
        const framed = decodeData(payload)
        if (framed) this.hooks.onData(framed.id, framed.data, kind === FRAME_BACKLOG)
      },
      () => this.fail()
    )
    socket.on('data', (chunk) => reader.push(chunk))
    socket.on('close', () => this.fail())
    socket.on('error', () => this.fail())
  }

  private fail(): void {
    if (this.closed) return
    this.closed = true
    // Every caller still waiting gets an answer rather than a hung promise: a
    // pane that cannot be told its spawn failed is a pane that never draws.
    for (const [ref, settle] of this.waiting) {
      settle({ t: 'error', ref, message: 'the session host went away' })
    }
    this.waiting.clear()
    this.socket.destroy()
    this.hooks.onLost?.()
  }

  private send(message: Omit<ClientMessage, 'ref'>): Promise<HostMessage> {
    if (this.closed) {
      return Promise.resolve({ t: 'error', ref: 0, message: 'the session host went away' })
    }
    const ref = ++this.ref
    return new Promise((resolve) => {
      this.waiting.set(ref, resolve)
      this.socket.write(encodeJson({ ...message, ref } as ClientMessage))
    })
  }

  static async greet(socket: net.Socket, token: string, hooks: PtyBackendHooks): Promise<BrokerBackend> {
    const backend = new BrokerBackend(socket, hooks)
    const res = await backend.send({ t: 'hello', token, protocol: PROTOCOL_VERSION } as ClientMessage)
    if (res.t !== 'hello') throw new Error(res.t === 'error' ? res.message : 'unexpected greeting')
    return backend
  }

  async spawn(spec: SpawnSpec) {
    const res = await this.send({ t: 'spawn', ...spec } as ClientMessage)
    if (res.t !== 'ok') {
      return { ok: false as const, error: res.t === 'error' ? res.message : 'unexpected reply' }
    }
    const data = res.data as { existing?: boolean; pid?: number } | undefined
    return { ok: true as const, existing: !!data?.existing, pid: data?.pid ?? 0 }
  }

  async attach(id: string, cursor?: number): Promise<AttachResult | null> {
    const res = await this.send({ t: 'attach', id, cursor } as ClientMessage)
    if (res.t !== 'ok') return null
    return (res.data as AttachResult | undefined) ?? null
  }

  detach(id: string): void {
    void this.send({ t: 'detach', id } as ClientMessage)
  }

  write(id: string, data: string): void {
    if (this.closed) return
    this.socket.write(encodeData(FRAME_DATA, id, Buffer.from(data, 'utf8')))
  }

  resize(id: string, cols: number, rows: number): void {
    void this.send({ t: 'resize', id, cols, rows } as ClientMessage)
  }

  kill(id: string): void {
    void this.send({ t: 'kill', id } as ClientMessage)
  }

  async list(): Promise<SessionSummary[]> {
    const res = await this.send({ t: 'list' } as ClientMessage)
    return res.t === 'ok' ? ((res.data as SessionSummary[]) ?? []) : []
  }

  ackExit(id: string): void {
    void this.send({ t: 'ackExit', id } as ClientMessage)
  }

  setMeta(id: string, meta: unknown): void {
    void this.send({ t: 'setMeta', id, meta } as ClientMessage)
  }

  release(): void {
    // Just hang up. The broker detaches us and keeps every shell running —
    // which is the entire reason this class exists.
    this.closed = true
    this.socket.destroy()
  }
}

// -------------------------------------------------------------------- local

/**
 * The fallback: the same session table, in this process.
 *
 * Sessions die with the app, exactly as they did before the broker. Kept
 * deliberately identical in shape so nothing upstream has to know which one it
 * is talking to.
 */
class LocalBackend implements PtyBackend {
  readonly kind = 'local'
  private readonly table: SessionTable
  private static readonly CLIENT = 'in-process'

  constructor(private readonly hooks: PtyBackendHooks) {
    this.table = new SessionTable(localSpawner, {
      onData: (id, data) => hooks.onData(id, data, false),
      onExit: (id, exit) => hooks.onExit(id, exit),
    })
  }

  spawn(spec: SpawnSpec) {
    return Promise.resolve(this.table.create(spec))
  }

  attach(id: string, cursor?: number): Promise<AttachResult | null> {
    const attached = this.table.attach(id, LocalBackend.CLIENT, cursor)
    if (!attached) return Promise.resolve(null)
    // No socket to carry it, so the backlog goes over the same hook the broker
    // path uses. Deferred a tick so it lands *after* the caller has seen the
    // attach result, matching the ordering a socket imposes for free.
    if (attached.backlog.length) {
      queueMicrotask(() => this.hooks.onData(id, attached.backlog, true))
    }
    return Promise.resolve(attached.result)
  }

  detach(id: string): void {
    this.table.detach(id, LocalBackend.CLIENT)
  }
  write(id: string, data: string): void {
    this.table.write(id, Buffer.from(data, 'utf8'))
  }
  resize(id: string, cols: number, rows: number): void {
    this.table.resize(id, cols, rows)
  }
  kill(id: string): void {
    this.table.kill(id)
  }
  list(): Promise<SessionSummary[]> {
    return Promise.resolve(this.table.list())
  }
  ackExit(id: string): void {
    this.table.ackExit(id, LocalBackend.CLIENT)
  }
  setMeta(id: string, meta: unknown): void {
    this.table.setMeta(id, meta)
  }
  release(): void {
    // Nothing here outlives us, so letting go means ending them — the same
    // thing `killAll` always did.
    this.table.killAll()
  }
}

function localSpawner(spec: SpawnSpec): PtyLike {
  const pty = spawnPty(spec.file, spec.args, {
    name: 'xterm-256color',
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: spec.env,
  })
  return {
    get pid() {
      return pty.pid
    },
    write: (d) => pty.write(d),
    resize: (c, r) => pty.resize(c, r),
    kill: () => pty.kill(),
    onData: (cb) => pty.onData(cb),
    onExit: (cb) =>
      pty.onExit(({ exitCode, signal }) =>
        cb({ exitCode: (exitCode as number | null) ?? -1, signal })
      ),
  }
}

// ----------------------------------------------------------------- launching

export interface HostLaunchOptions {
  /** The binary to re-execute as plain Node — `process.execPath`. */
  execPath: string
  /** The broker's bundle, unpacked from the asar like the CLI's. */
  hostScript: string
  hooks: PtyBackendHooks
  /** Set by tests, and by the orphan sweep, to skip launching anything. */
  noLaunch?: boolean
}

/**
 * Shells that run here and end with the window.
 *
 * What the user asked for when they turned "keep shells running" off, and what
 * the app falls back to when no broker can be reached. Exported so the caller
 * can choose it outright rather than having to fail its way into it.
 */
export function createLocalBackend(hooks: PtyBackendHooks): PtyBackend {
  return new LocalBackend(hooks)
}

/**
 * Reaches the broker, starting one if necessary, and falls back in-process.
 *
 * The connect-then-launch-then-retry shape matters: two app instances starting
 * together must not each end up with their own broker, and the way to avoid
 * that is to let both try to launch and let the loser's process exit on
 * EADDRINUSE while both connect to the winner.
 */
export async function connectPtyHost(opts: HostLaunchOptions): Promise<PtyBackend> {
  const { address, tokenPath } = hostPaths()

  let attempted = false
  const deadline = Date.now() + CONNECT_TIMEOUT_MS

  for (let i = 0; ; i++) {
    const wait = CONNECT_BACKOFF_MS[Math.min(i, CONNECT_BACKOFF_MS.length - 1)]
    if (wait) await delay(wait)

    const socket = await tryConnect(address)
    if (socket) {
      try {
        const token = readFileSync(tokenPath, 'utf8').trim()
        return await BrokerBackend.greet(socket, token, opts.hooks)
      } catch (err) {
        socket.destroy()
        // A broker that is up but unreadable is worse than none: it holds the
        // address, so retrying forever would never succeed. One launch attempt
        // has already been made by now; fall through to the local backend.
        if (Date.now() >= deadline) {
          console.error('[ptyhost] could not greet the session host', err)
          break
        }
        continue
      }
    }

    // `noLaunch` asks whether a broker is *already* there — the orphan sweep
    // must not start one just to discover there was nothing to sweep. One
    // failed connect is the whole answer, so it returns immediately rather
    // than spending the retry budget waiting for a process nobody will start.
    if (opts.noLaunch) break
    if (!attempted) {
      attempted = true
      launch(opts.execPath, opts.hostScript)
      continue
    }
    if (Date.now() >= deadline) break
  }

  console.warn(
    '[ptyhost] no session host — shells will run in-process and will not survive a restart'
  )
  return new LocalBackend(opts.hooks)
}

function tryConnect(address: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(address)
    socket.setNoDelay(true)
    const done = (value: net.Socket | null) => {
      socket.removeAllListeners('connect')
      socket.removeAllListeners('error')
      resolve(value)
    }
    socket.once('connect', () => done(socket))
    socket.once('error', () => {
      socket.destroy()
      done(null)
    })
  })
}

/**
 * Starts the broker so that it outlives us.
 *
 * `detached` plus `unref` is the whole trick, and it was verified rather than
 * assumed: on Windows it survives the `SIGKILL` this app sends itself on the
 * way out (Chromium's job object binds its own helper processes, not arbitrary
 * children of main), and on POSIX `detached` means `setsid`, so the broker
 * leaves our process group and no signal aimed at us can reach it.
 *
 * `stdio: 'ignore'` is not tidiness — an inherited pipe nobody drains fills,
 * and the broker would block forever on its first `console.log`.
 */
function launch(execPath: string, hostScript: string): void {
  try {
    const child = spawnProcess(execPath, [hostScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.unref()
  } catch (err) {
    console.error('[ptyhost] could not launch the session host', err)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
