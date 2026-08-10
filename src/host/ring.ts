/**
 * The byte ring behind both a live session and a pane's saved screen.
 *
 * It lived in `src/main/scrollback.ts` and moved here when the broker needed
 * the same structure for a different reason. The two uses are worth telling
 * apart: `ScrollbackStore` rings a pane so its last screen can be written to
 * disk and replayed into a *fresh* shell, while the broker rings a session so a
 * reconnecting client can be handed the output it missed from a shell that
 * never stopped running. Same data structure, and no reason to have two.
 *
 * Raw bytes, escapes and all — the point is to hand xterm back the exact stream
 * it already rendered once, and anything that filtered or re-encoded would lose
 * colour and cursor positioning.
 *
 * Pure but for `Buffer`, so it stays out of `src/shared`, which the renderer
 * imports and where no Node global exists.
 */

/** Ceiling per session. Reached only by sessions that actually print this much. */
export const CAPACITY_BYTES = 2 * 1024 * 1024
/**
 * Buffers start here and double toward the ceiling, so twenty idle sessions
 * cost about a megabyte between them rather than forty.
 */
export const INITIAL_BYTES = 64 * 1024

/** What a client gets back when it asks for everything since a cursor. */
export interface RingSlice {
  data: Buffer
  /**
   * True when the requested cursor had already been overwritten, so the data
   * starts later than the caller asked for. Output is genuinely missing; a
   * caller that presents the result as continuous is lying to someone.
   */
  truncated: boolean
  /** Where the caller now is — pass back next time. */
  cursor: number
}

export class RingBuffer {
  private buffer: Buffer
  private physical: number
  private writePos = 0
  private length = 0
  private total = 0

  constructor(private readonly capacity = CAPACITY_BYTES) {
    this.physical = Math.min(INITIAL_BYTES, capacity)
    this.buffer = Buffer.alloc(this.physical)
  }

  get size(): number {
    return this.length
  }

  /**
   * Every byte ever written, which is the cursor clients hold.
   *
   * Monotonic and never reset, so it stays a stable coordinate even as the ring
   * discards the bytes behind it. It is a byte count rather than a sequence
   * number precisely so that "how far behind am I" is answerable by subtraction.
   */
  get written(): number {
    return this.total
  }

  /** The oldest byte still held, as a cursor. Below this, history is gone. */
  get oldest(): number {
    return this.total - this.length
  }

  write(data: Buffer): void {
    if (data.length === 0) return
    this.total += data.length
    this.grow(this.length + data.length)

    // A single write larger than the whole ring: keep only its tail.
    if (data.length >= this.physical) {
      data.copy(this.buffer, 0, data.length - this.physical, data.length)
      this.writePos = 0
      this.length = this.physical
      return
    }

    const toEnd = this.physical - this.writePos
    if (data.length <= toEnd) {
      data.copy(this.buffer, this.writePos)
    } else {
      data.copy(this.buffer, this.writePos, 0, toEnd)
      data.copy(this.buffer, 0, toEnd, data.length)
    }
    this.writePos = (this.writePos + data.length) % this.physical
    this.length = Math.min(this.length + data.length, this.physical)
  }

  /** Oldest byte first. A copy — the ring itself is never handed out. */
  readAll(): Buffer {
    if (this.length === 0) return Buffer.alloc(0)
    if (this.length < this.physical) return Buffer.from(this.buffer.subarray(0, this.length))
    // Full and wrapped: writePos is the oldest byte.
    return Buffer.concat([
      this.buffer.subarray(this.writePos, this.physical),
      this.buffer.subarray(0, this.writePos),
    ])
  }

  /**
   * Everything written since `cursor`.
   *
   * Three cases, and the middle one is the reason this exists. A client that is
   * up to date gets nothing. A client that has fallen behind but is still
   * inside the ring gets exactly what it missed, which is what makes
   * reattaching to a live session seamless rather than a screenful of
   * duplicates. A client whose cursor has been overwritten — or one that has
   * never seen this session, which is the same question with `cursor` at zero —
   * gets the whole ring and is told the history is incomplete.
   */
  readFrom(cursor: number): RingSlice {
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0
    if (cursor >= this.total) {
      return { data: Buffer.alloc(0), truncated: false, cursor: this.total }
    }
    if (cursor < this.oldest) {
      return { data: this.readAll(), truncated: cursor > 0, cursor: this.total }
    }
    const wanted = this.total - cursor
    const all = this.readAll()
    return { data: all.subarray(all.length - wanted), truncated: false, cursor: this.total }
  }

  /**
   * Grows the allocation toward the ceiling by doubling. Copying in logical
   * order also un-wraps the ring, which is safe because after a grow the stored
   * length is strictly below the new size.
   */
  private grow(needed: number): void {
    if (this.physical >= this.capacity || needed <= this.physical) return
    let next = this.physical
    while (next < needed && next < this.capacity) next *= 2
    next = Math.min(next, this.capacity)
    if (next === this.physical) return

    const existing = this.readAll()
    const grown = Buffer.alloc(next)
    existing.copy(grown, 0)
    this.buffer = grown
    this.physical = next
    this.writePos = existing.length
    this.length = existing.length
  }
}
