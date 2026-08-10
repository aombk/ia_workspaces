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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

interface Client {
  id: string
  socket: net.Socket
  reader: FrameReader
  authed: boolean
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
  onIdleExit?: () => void
  /** Ready to serve. The token file exists by the time this fires. */
  onListening?: () => void
  /**
   * Could not bind. `EADDRINUSE` is the ordinary case rather than a fault —
   * two app instances racing to start the broker, where the loser should exit
   * quietly and let the winner serve them both.
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
      server.close()
      opts.onIdleExit?.()
    }, opts.emptyExitMs ?? EMPTY_EXIT_MS)
    emptyTimer.unref?.()
  }

  const sessions = new SessionTable(opts.spawner, {
    onData: (id, data, attached) => {
      for (const clientId of attached) {
        const client = clients.get(clientId)
        if (client?.authed) write(client, encodeData(FRAME_DATA, id, data))
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
        server.close()
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
    const gone = () => {
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

  // A socket is a file and a crash leaves it behind; a pipe is a kernel object
  // and unlinking its "path" would be meaningless at best.
  if (!isPipeAddress(opts.address)) {
    mkdirSync(path.dirname(opts.address), { recursive: true })
    try {
      rmSync(opts.address, { force: true })
    } catch {
      /* listen will report anything that matters */
    }
  }

  // The token is written only once the address is ours.
  //
  // Ordering it the other way round would be tidier for clients — the file
  // would exist before anything could connect — but it would have the loser of
  // a startup race overwrite the winner's secret and lock every client out. So
  // binding comes first and clients retry the read, which is the cheaper of the
  // two problems by a wide margin. 0600 because a POSIX data directory is not
  // necessarily private; Windows ignores the mode and AppData already is.
  let ownsToken = false

  server.on('error', (err: NodeJS.ErrnoException) => {
    opts.onListenError?.(err)
  })

  server.listen(opts.address, () => {
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

  const idleTimer = setInterval(() => {
    if (!sessions.idle || clients.size > 0 || emptySince === 0) return
    if (Date.now() - emptySince < (opts.idleExitMs ?? IDLE_EXIT_MS)) return
    clearInterval(idleTimer)
    server.close()
    opts.onIdleExit?.()
  }, opts.idleCheckMs ?? IDLE_CHECK_MS)
  idleTimer.unref?.()

  return {
    address: opts.address,
    sessions,
    close: () => {
      clearInterval(idleTimer)
      if (emptyTimer) clearTimeout(emptyTimer)
      for (const c of clients.values()) c.socket.destroy()
      server.close()
      // Only the broker that wrote the token may remove it. A loser of the
      // startup race calls close() too, and deleting the winner's secret would
      // lock out every client of a broker that is working perfectly.
      if (!ownsToken) return
      try {
        rmSync(opts.tokenPath, { force: true })
      } catch {
        /* best effort */
      }
    },
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a ?? '', 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
