/**
 * The broker's transport: one socket, many clients, one session table.
 *
 * Everything interesting is in `sessions.ts`; this is the part that has to deal
 * with the outside world — framing, authentication, clients that vanish
 * mid-request, and knowing when there is nothing left to stay alive for.
 *
 * Multi-client from the start. Two copies of the app already share one
 * `workspace.json`, so two of them attached to one pane is a state that can
 * happen whether or not it was designed for, and single-client would have been
 * the wrong constraint to bake into the wire.
 */
import net from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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
  type ClientMessage,
  type HostMessage,
} from './protocol'
import { SessionTable, type Spawner } from './sessions'
import { isPipeAddress } from '../shared/platform'
import { ensurePrivateDir } from './paths'

/**
 * How long the broker lingers with nothing to hold.
 *
 * Not zero: an app restart takes seconds, and a broker that exited the instant
 * the last pane closed would be respawned constantly. Not forever either — a
 * process still running tomorrow with no sessions and no client is a leak, and
 * this one is deliberately hard to notice because staying alive is its job.
 */
const IDLE_EXIT_MS = 5 * 60 * 1000
const IDLE_CHECK_MS = 30 * 1000
/**
 * How long to wait after the last client leaves, when holding nothing.
 *
 * Short, because the executable this process is running from cannot be replaced
 * while it lives — so lingering is what makes "quit and install the update"
 * fail. Not zero, because a disconnect is not proof of disinterest: an app
 * restarting reconnects within a second, and `iaw host` connects merely to ask.
 */
const EMPTY_EXIT_MS = 3000
/**
 * How much unsent output a client may have queued before its shells are paused.
 *
 * Well above the socket's own high-water mark, because pausing a pty for every
 * 16 KB burst would put latency on ordinary output for no benefit; this is
 * about a client that has stopped keeping up, not one that is momentarily busy.
 */
const CLIENT_HIGH_WATER = 1024 * 1024
/**
 * How long a client may stay that far behind before it is taken to be hung.
 *
 * Pausing is right for a slow reader and wrong for a dead one: a wedged app
 * holding its socket open would otherwise freeze every shell attached to it
 * indefinitely. Dropping the connection detaches it like any other departure,
 * the shells resume into their rings, and a client that recovers reattaches
 * and is handed what it missed.
 */
const CLIENT_STALL_MS = 60 * 1000
/** How long to wait for an existing broker to answer before calling it alive. */
const PROBE_TIMEOUT_MS = 1000

interface Client {
  id: string
  socket: net.Socket
  reader: FrameReader
  authed: boolean
  /** Over the high-water mark and waiting for 'drain'; its shells are paused. */
  congested: boolean
  stallTimer: NodeJS.Timeout | null
}

export interface HostServer {
  address: string
  close(): void
  /** For tests: how many sessions are held right now. */
  readonly sessions: SessionTable
}

export interface HostServerOptions {
  address: string
  /** Where the token file is written, so clients can read it back. */
  tokenPath: string
  spawner: Spawner
  /** Overridable so tests do not wait five minutes. */
  idleExitMs?: number
  idleCheckMs?: number
  /** Overridable so tests are not shut down by their own disconnects. */
  emptyExitMs?: number
  /** Overridable so tests can congest a client without megabytes of output. */
  clientHighWater?: number
  clientStallMs?: number
  onIdleExit?: () => void
  /** Ready to serve. The token file exists by the time this fires. */
  onListening?: () => void
  /**
   * Could not bind. `EADDRINUSE` is the ordinary case rather than a fault —
   * two app instances racing to start the broker, where the loser should exit
   * quietly and let the winner serve them both. Also reported, with that code,
   * when a broker already answers at the address: see `probe`.
   */
  onListenError?: (err: NodeJS.ErrnoException) => void
}

export function startHostServer(opts: HostServerOptions): HostServer {
  const token = randomBytes(24).toString('hex')
  const clients = new Map<string, Client>()
  let nextClientId = 1
  /** When the last client disconnected, or 0 while one is connected. */
  let emptySince = Date.now()
  /** Pending short exit, cancelled the moment anyone connects. */
  let emptyTimer: NodeJS.Timeout | null = null

  function scheduleEmptyExit(): void {
    if (emptyTimer || !sessions.idle) return
    emptyTimer = setTimeout(() => {
      emptyTimer = null
      // Re-checked rather than trusted: a client may have connected and a
      // session may have been created while this was pending.
      if (clients.size > 0 || !sessions.idle) return
      stopListening()
      opts.onIdleExit?.()
    }, opts.emptyExitMs ?? EMPTY_EXIT_MS)
    emptyTimer.unref?.()
  }

  const sessions = new SessionTable(opts.spawner, {
    onData: (id, data, attached) => {
      for (const clientId of attached) {
        const client = clients.get(clientId)
        if (!client?.authed) continue
        write(client, encodeData(FRAME_DATA, id, data))
        // Backpressure. A shell that prints faster than its client reads used
        // to queue without limit in this process — the one process whose
        // death takes every shell with it. Paused instead, until the client
        // drains. Only a shell with a client attached can be paused at all,
        // so one nobody is watching keeps printing into its ring as before.
        if (client.congested) sessions.block(id, client.id)
      }
    },
    onExit: (id, exit) => {
      // Broadcast to everyone: an exit is held until acknowledged, and a client
      // that is not attached still wants to know a pane it is showing has died.
      for (const client of clients.values()) {
        if (client.authed) write(client, encodeJson({ t: 'exit', id, ...exit } as HostMessage))
      }
    },
  })

  function write(client: Client, frame: Buffer): void {
    if (client.socket.destroyed) return
    client.socket.write(frame)
    if (client.congested) return
    if (client.socket.writableLength <= (opts.clientHighWater ?? CLIENT_HIGH_WATER)) return
    // Past the socket's own high-water mark, so this write returned false and
    // a 'drain' is owed — that is what lifts the pause.
    client.congested = true
    client.stallTimer = setTimeout(() => client.socket.destroy(), opts.clientStallMs ?? CLIENT_STALL_MS)
    client.stallTimer.unref?.()
  }

  function uncongest(client: Client): void {
    if (client.stallTimer) clearTimeout(client.stallTimer)
    client.stallTimer = null
    if (!client.congested) return
    client.congested = false
    sessions.unblockClient(client.id)
  }

  function reply(client: Client, message: HostMessage): void {
    write(client, encodeJson(message))
  }

  function handleJson(client: Client, message: ClientMessage): void {
    // Nothing but `hello` is served before authentication, and a wrong token is
    // fatal to the connection rather than merely refused: there is no
    // legitimate caller that gets this wrong twice.
    if (!client.authed) {
      if (message.t !== 'hello') {
        reply(client, { t: 'error', ref: (message as { ref?: number }).ref ?? 0, message: 'expected hello' })
        client.socket.destroy()
        return
      }
      if (!constantTimeEqual(message.token, token)) {
        reply(client, { t: 'error', ref: message.ref, message: 'unauthorized' })
        client.socket.destroy()
        return
      }
      if (message.protocol !== PROTOCOL_VERSION) {
        // A mismatch is the app and the broker having been built at different
        // times — an upgrade with panes still open. Say so plainly; the client
        // responds by asking the old broker to stand down.
        reply(client, {
          t: 'error',
          ref: message.ref,
          message: `protocol ${message.protocol} unsupported, this broker speaks ${PROTOCOL_VERSION}`,
        })
        client.socket.destroy()
        return
      }
      client.authed = true
      reply(client, { t: 'hello', ref: message.ref, protocol: PROTOCOL_VERSION, pid: process.pid })
      return
    }

    switch (message.t) {
      case 'hello':
        reply(client, { t: 'error', ref: message.ref, message: 'already greeted' })
        return

      case 'spawn': {
        const res = sessions.create(message)
        if (!res.ok) reply(client, { t: 'error', ref: message.ref, message: res.error })
        else reply(client, { t: 'ok', ref: message.ref, data: { existing: res.existing, pid: res.pid } })
        return
      }

      case 'attach': {
        const attached = sessions.attach(message.id, client.id, message.cursor)
        if (!attached) {
          reply(client, { t: 'error', ref: message.ref, message: 'unknown session' })
          return
        }
        // The reply first, then the backlog: the client has to know how to read
        // what follows before it arrives, and a backlog frame is distinguished
        // by kind rather than by position so the order is a courtesy, not a
        // contract.
        reply(client, { t: 'ok', ref: message.ref, data: attached.result })
        if (attached.backlog.length) {
          write(client, encodeData(FRAME_BACKLOG, message.id, attached.backlog))
        }
        return
      }

      case 'detach':
        reply(client, { t: 'ok', ref: message.ref, data: sessions.detach(message.id, client.id) })
        return

      case 'resize':
        reply(client, {
          t: 'ok',
          ref: message.ref,
          data: sessions.resize(message.id, message.cols, message.rows),
        })
        return

      case 'kill':
        reply(client, { t: 'ok', ref: message.ref, data: sessions.kill(message.id) })
        return

      case 'list':
        reply(client, { t: 'ok', ref: message.ref, data: sessions.list() })
        return

      case 'setMeta':
        reply(client, { t: 'ok', ref: message.ref, data: sessions.setMeta(message.id, message.meta) })
        return

      case 'ackExit':
        reply(client, { t: 'ok', ref: message.ref, data: sessions.ackExit(message.id, client.id) })
        return

      case 'shutdown':
        reply(client, { t: 'ok', ref: message.ref })
        sessions.killAll()
        stopListening()
        for (const c of clients.values()) c.socket.destroy()
        opts.onIdleExit?.()
        return
    }
  }

  const server = net.createServer((socket) => {
    const id = `c${nextClientId++}`
    // Terminal output is bursty and large; Nagle would add latency to every
    // keystroke echo for the sake of coalescing we already do upstream.
    socket.setNoDelay(true)

    const client: Client = {
      id,
      socket,
      authed: false,
      congested: false,
      stallTimer: null,
      reader: new FrameReader(
        (kind, payload) => {
          if (kind === FRAME_JSON) {
            const message = decodeJson(payload) as ClientMessage | null
            if (!message) {
              socket.destroy()
              return
            }
            handleJson(client, message)
            return
          }
          if (kind === FRAME_DATA) {
            if (!client.authed) {
              socket.destroy()
              return
            }
            const framed = decodeData(payload)
            if (framed) sessions.write(framed.id, framed.data)
            return
          }
          // A kind we do not know is a peer we cannot follow.
          socket.destroy()
        },
        () => socket.destroy()
      ),
    }

    clients.set(id, client)
    emptySince = 0
    if (emptyTimer) {
      clearTimeout(emptyTimer)
      emptyTimer = null
    }

    socket.on('data', (chunk) => client.reader.push(chunk))
    socket.on('drain', () => uncongest(client))
    const gone = () => {
      // Unblocked before it is detached: a client that left owes no 'drain',
      // and its shells must not stay paused on its account.
      uncongest(client)
      clients.delete(id)
      // Detaching is all that happens: the sessions keep running, which is the
      // entire point of this process existing.
      sessions.detachAll(id)
      if (clients.size !== 0) return
      emptySince = Date.now()

      // Nothing to hold and nobody watching: go soon rather than in five
      // minutes. The long grace exists so an app restart does not pay to
      // respawn us, and with zero sessions a restart has nothing to come back
      // to — so it buys nothing and costs something real. This process is the
      // app's own executable re-run as Node, so while it lives the file is held
      // open and an installer cannot replace it, which is exactly the moment
      // there are no sessions left to protect.
      //
      // A few seconds rather than at once, and cancellable, because a client
      // disconnecting is not proof nobody wants us: `iaw host` connects only to
      // ask a question, and shutting down because somebody looked would be a
      // fine way to make the status command a lie.
      scheduleEmptyExit()
    }
    socket.on('close', gone)
    socket.on('error', () => {
      gone()
      socket.destroy()
    })
  })

  // A socket is a file and a crash leaves it behind, so a stale one has to be
  // removed before anything can bind there. The trap is removing one that is
  // *not* stale: a second broker that unlinked a live broker's socket would
  // bind in its place, strand the first (alive, holding shells, unreachable),
  // and later have its own socket and token deleted when the first one exited.
  // So the address is asked first, and only a socket nobody answers on is
  // removed. A pipe is a kernel object and has nothing to remove.
  //
  // The token is written only once the address is ours. Ordering it the other
  // way round would be tidier for clients — the file would exist before
  // anything could connect — but it would have the loser of a startup race
  // overwrite the winner's secret and lock every client out. So binding comes
  // first and clients retry the read, which is the cheaper of the two problems
  // by a wide margin. 0600 because a POSIX data directory is not necessarily
  // private; Windows ignores the mode and AppData already is.
  let ownsToken = false
  let closed = false
  /** The socket file we bound, to tell it apart from one that replaced it. */
  let bound: { dev: number; ino: number } | null = null
  const isSocketFile = !isPipeAddress(opts.address)

  server.on('error', (err: NodeJS.ErrnoException) => {
    opts.onListenError?.(err)
  })

  function listen(): void {
    if (closed) return
    server.listen(opts.address, () => {
      if (isSocketFile) {
        try {
          const st = statSync(opts.address)
          bound = { dev: st.dev, ino: st.ino }
        } catch {
          /* checked again whenever it matters */
        }
      }
      try {
        mkdirSync(path.dirname(opts.tokenPath), { recursive: true })
        writeFileSync(opts.tokenPath, token, { encoding: 'utf8', mode: 0o600 })
        ownsToken = true
      } catch (err) {
        opts.onListenError?.(err as NodeJS.ErrnoException)
        return
      }
      opts.onListening?.()
    })
  }

  if (!isSocketFile) {
    listen()
  } else {
    void (async () => {
      try {
        ensurePrivateDir(path.dirname(opts.address))
      } catch (err) {
        opts.onListenError?.(err as NodeJS.ErrnoException)
        return
      }
      const state = await probe(opts.address)
      if (closed) return
      if (state === 'live') {
        const err = new Error(`a session host is already listening on ${opts.address}`) as NodeJS.ErrnoException
        err.code = 'EADDRINUSE'
        opts.onListenError?.(err)
        return
      }
      if (state === 'stale') {
        try {
          rmSync(opts.address, { force: true })
        } catch {
          /* listen will report anything that matters */
        }
      }
      // Two brokers that both found it stale can still both get here; the
      // second `listen` then fails EADDRINUSE and that one exits. The window
      // that remains — one unlinking just after the other bound — is narrow,
      // and `close` below is what keeps it from also costing the winner its
      // socket and token.
      listen()
    })()
  }

  /**
   * Whether the socket at the address is still the one this process bound.
   *
   * Closing a listening unix socket unlinks its path — libuv does it, not us —
   * so a broker whose address has since been taken over must not close it the
   * ordinary way, or it deletes the socket of the broker that replaced it.
   */
  function stillOurs(): boolean {
    if (!isSocketFile) return true
    if (!bound) return false
    try {
      const st = statSync(opts.address)
      return st.dev === bound.dev && st.ino === bound.ino
    } catch {
      return false
    }
  }

  function stopListening(): void {
    if (!server.listening) {
      server.close()
      return
    }
    if (stillOurs()) {
      server.close()
      return
    }
    // Displaced. The listening handle is left to die with the process rather
    // than closed, because closing it would unlink a path that is no longer
    // ours; unref'd so it does not keep the process alive on its own.
    server.unref()
  }

  const idleTimer = setInterval(() => {
    if (!sessions.idle || clients.size > 0 || emptySince === 0) return
    if (Date.now() - emptySince < (opts.idleExitMs ?? IDLE_EXIT_MS)) return
    clearInterval(idleTimer)
    stopListening()
    opts.onIdleExit?.()
  }, opts.idleCheckMs ?? IDLE_CHECK_MS)
  idleTimer.unref?.()

  return {
    address: opts.address,
    sessions,
    close: () => {
      if (closed) return
      closed = true
      clearInterval(idleTimer)
      if (emptyTimer) clearTimeout(emptyTimer)
      for (const c of clients.values()) c.socket.destroy()
      stopListening()
      // Only the broker that wrote the token may remove it, and only while it
      // is still the token on disk. A loser of the startup race calls close()
      // too, and so does a broker that was displaced after binding — and
      // deleting the current broker's secret would lock out every client of a
      // broker that is working perfectly.
      if (!ownsToken) return
      try {
        if (readFileSync(opts.tokenPath, 'utf8') === token) rmSync(opts.tokenPath, { force: true })
      } catch {
        /* best effort */
      }
    },
  }
}

/**
 * Asks whether anything is listening at a socket path.
 *
 * `stale` is a socket file nobody answers on (or nothing at all), which is safe
 * to remove. Anything that connects is `live`, as is anything that takes too
 * long to say: a broker too busy to accept for a second is still a broker, and
 * the cost of guessing wrong is stranding it. Any other failure — the path is
 * not ours to read, say — is `unknown`: nothing is removed, and `listen` then
 * reports whatever is really wrong.
 */
function probe(address: string): Promise<'live' | 'stale' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = net.connect(address)
    const done = (state: 'live' | 'stale' | 'unknown') => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.on('error', () => undefined)
      socket.destroy()
      resolve(state)
    }
    const timer = setTimeout(() => done('live'), PROBE_TIMEOUT_MS)
    socket.once('connect', () => done('live'))
    socket.once('error', (err: NodeJS.ErrnoException) =>
      done(err.code === 'ECONNREFUSED' || err.code === 'ENOENT' ? 'stale' : 'unknown')
    )
  })
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a ?? '', 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
