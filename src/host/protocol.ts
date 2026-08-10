/**
 * The wire between the app and the session broker.
 *
 * Two things travel here and they have opposite shapes. Control is occasional,
 * structured and worth reading in a log — JSON. Terminal output is continuous,
 * binary in practice, and the single hottest path in the application — raw
 * bytes, framed, never encoded. Putting both through JSON would put a 33% base64
 * tax on every byte a shell prints, plus an escape pass; putting both through a
 * binary schema would make the control channel unreadable for the sake of
 * messages that arrive a few times a minute. So the frame carries a kind byte
 * and the two live side by side.
 *
 * The framing is length-prefixed rather than newline-delimited — the control
 * server upstream can use newlines because JSON escapes them, and terminal
 * output cannot, since a newline is the one byte it is guaranteed to contain.
 *
 * This module is pure: `Buffer` and nothing else. It is imported by the broker
 * (`src/host`) and by the client inside Electron's main process (`src/main`),
 * which are different processes, so it must not reach for either one's world.
 */

/** Bumped when a change would make an old client and a new broker disagree. */
export const PROTOCOL_VERSION = 1

/** A structured message. Payload is UTF-8 JSON. */
export const FRAME_JSON = 0
/** Live terminal bytes, in either direction. Payload is `[u16 idLen][id][data]`. */
export const FRAME_DATA = 1
/**
 * Replayed terminal bytes, same payload shape.
 *
 * A separate kind rather than a counted prefix on the live stream: the client
 * has to treat these differently — they are fed through a fresh OSC scanner to
 * recover a pane's title and directory, and they must not be mistaken for a
 * cold scrollback restore — and a self-describing frame beats asking the reader
 * to count bytes against a number it was told earlier.
 */
export const FRAME_BACKLOG = 2

/**
 * Largest payload we will assemble for one frame.
 *
 * Above the 2 MB a full ring replay can reach, and far below anything that
 * would let a confused or hostile peer make us allocate without bound. The
 * reader treats an overrun as fatal for the connection rather than skipping the
 * frame, because a length we do not believe means the stream is no longer
 * synchronised and every byte after it is a guess.
 */
export const MAX_FRAME = 8 * 1024 * 1024

const HEADER = 5 // u32 payload length + u8 kind

// ------------------------------------------------------------------ messages

/** Everything the app asks of the broker. `ref` correlates the reply. */
export type ClientMessage =
  /** First message on every connection; nothing else is served until it lands. */
  | { t: 'hello'; ref: number; token: string; protocol: number }
  /**
   * Start a shell.
   *
   * The command is already resolved. Choosing *what* to run means reading
   * settings, `resources/shells.json`, the WSL distribution list and the user's
   * SSH config — all of which belong to the app, and none of which should have
   * a second implementation in a process whose job is to hold file descriptors
   * open. The broker is handed an argv and an environment and runs them.
   */
  | {
      t: 'spawn'
      ref: number
      id: string
      file: string
      args: string[]
      cwd: string
      env: Record<string, string>
      cols: number
      rows: number
      /** Opaque to the broker; handed back on `list` and `attach`. */
      meta?: unknown
    }
  /** Subscribe to a session's output, and ask for what was missed. */
  | { t: 'attach'; ref: number; id: string; cursor?: number }
  /** Stop receiving output. The session keeps running. */
  | { t: 'detach'; ref: number; id: string }
  | { t: 'resize'; ref: number; id: string; cols: number; rows: number }
  /** End the shell for good. Unlike detaching, this is the user closing a pane. */
  | { t: 'kill'; ref: number; id: string }
  | { t: 'list'; ref: number }
  | { t: 'setMeta'; ref: number; id: string; meta: unknown }
  /**
   * Confirm an exit was delivered, so the broker can forget the session.
   *
   * Exits are held rather than fired and forgotten: the app may not be running
   * when a shell dies, and a pane that quietly vanished with no explanation is
   * the failure this whole design exists to avoid.
   */
  | { t: 'ackExit'; ref: number; id: string }
  /** Explicit teardown. Used by the tests; the app relies on the idle timer. */
  | { t: 'shutdown'; ref: number }

/** Everything the broker says back. */
export type HostMessage =
  | { t: 'hello'; ref: number; protocol: number; pid: number }
  | { t: 'ok'; ref: number; data?: unknown }
  | { t: 'error'; ref: number; message: string }
  /** Unsolicited: a shell ended. Held until the client acks it. */
  | { t: 'exit'; id: string; exitCode: number; signal?: number }

/** What `attach` resolves to. */
export interface AttachResult {
  id: string
  /** False when the shell has already exited and only its output remains. */
  alive: boolean
  /** Total bytes this session has ever produced — pass back as `cursor`. */
  cursor: number
  /**
   * True when the ring had already discarded the bytes the client asked for, so
   * what it received starts later than it wanted. The pane is missing output;
   * saying so lets the UI be honest about it rather than presenting a gap as
   * continuity.
   */
  truncated: boolean
  exit?: { exitCode: number; signal?: number }
}

/** One row of `list`. */
export interface SessionSummary {
  id: string
  alive: boolean
  cursor: number
  cols: number
  rows: number
  pid: number
  startedAt: number
  attached: number
  meta?: unknown
  exit?: { exitCode: number; signal?: number }
}

// ------------------------------------------------------------------ encoding

export function encodeFrame(kind: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(HEADER + payload.length)
  frame.writeUInt32LE(payload.length, 0)
  frame.writeUInt8(kind, 4)
  payload.copy(frame, HEADER)
  return frame
}

export function encodeJson(message: ClientMessage | HostMessage): Buffer {
  return encodeFrame(FRAME_JSON, Buffer.from(JSON.stringify(message), 'utf8'))
}

/**
 * A terminal-bytes frame.
 *
 * The id is length-prefixed rather than delimited because a session id is
 * arbitrary text from a persisted document, and choosing a delimiter would mean
 * choosing a byte that may not appear in one.
 */
export function encodeData(kind: number, id: string, data: Buffer): Buffer {
  const idBytes = Buffer.from(id, 'utf8')
  if (idBytes.length > 0xffff) throw new Error('session id too long')
  const payload = Buffer.allocUnsafe(2 + idBytes.length + data.length)
  payload.writeUInt16LE(idBytes.length, 0)
  idBytes.copy(payload, 2)
  data.copy(payload, 2 + idBytes.length)
  return encodeFrame(kind, payload)
}

export function decodeData(payload: Buffer): { id: string; data: Buffer } | null {
  if (payload.length < 2) return null
  const idLen = payload.readUInt16LE(0)
  if (payload.length < 2 + idLen) return null
  return {
    id: payload.toString('utf8', 2, 2 + idLen),
    // A view, not a copy: this is the hot path, and every caller either writes
    // it straight out or copies it into a ring itself.
    data: payload.subarray(2 + idLen),
  }
}

export function decodeJson(payload: Buffer): ClientMessage | HostMessage | null {
  try {
    const parsed = JSON.parse(payload.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof (parsed as { t?: unknown }).t !== 'string') return null
    return parsed as ClientMessage | HostMessage
  } catch {
    return null
  }
}

// ------------------------------------------------------------------- reading

/**
 * Reassembles frames from a stream that knows nothing about them.
 *
 * A socket hands over whatever arrived: half a frame, six frames, a frame split
 * down the middle of its length field. This holds the remainder between chunks
 * and calls back once per complete frame.
 *
 * `onError` is terminal by contract. A length we cannot believe means the
 * stream is out of step, and there is no way to resynchronise a protocol with
 * no delimiter — the only honest response is to drop the connection.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)
  private failed = false

  constructor(
    private readonly onFrame: (kind: number, payload: Buffer) => void,
    private readonly onError: (message: string) => void
  ) {}

  push(chunk: Buffer): void {
    if (this.failed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    let offset = 0
    while (this.buffer.length - offset >= HEADER) {
      const length = this.buffer.readUInt32LE(offset)
      if (length > MAX_FRAME) {
        this.failed = true
        this.buffer = Buffer.alloc(0)
        this.onError(`frame of ${length} bytes exceeds the ${MAX_FRAME} limit`)
        return
      }
      if (this.buffer.length - offset < HEADER + length) break

      const kind = this.buffer.readUInt8(offset + 4)
      // Copied out before the callback: the payload outlives this iteration in
      // every consumer that rings or queues it, and the backing buffer here is
      // about to be sliced away.
      const payload = Buffer.from(this.buffer.subarray(offset + HEADER, offset + HEADER + length))
      offset += HEADER + length
      this.onFrame(kind, payload)
      if (this.failed) return
    }

    this.buffer = offset === 0 ? this.buffer : this.buffer.subarray(offset)
  }

  /** Bytes held waiting for the rest of their frame. For tests and diagnostics. */
  get pending(): number {
    return this.buffer.length
  }
}
