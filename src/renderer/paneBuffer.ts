/**
 * Holding a hidden pane's output until somebody looks at it.
 *
 * A pane that is not on screen used to cost exactly as much as one that is:
 * `hidden` stops the painting, and nothing stops the parsing. Measured in a
 * real Electron renderer against a real xterm, three hidden panes taking a
 * build's output between them spent 161 ms of the main thread — the same
 * thread the pane you *are* looking at needs — for output nobody could see.
 * Per megabyte that is roughly 86 ms, with no discount whatsoever for being
 * invisible.
 *
 * So the bytes wait here instead. Nothing observable is lost by not parsing
 * them: a pane's title, folder, activity state, alerts and scrollback are all
 * derived in the main process from the byte stream rather than read off the
 * screen, so every one of those stays live for a pane that is not rendering.
 * What is deferred is only the drawing of it.
 */

/** The mutable state a deferred pane carries. `Instance` satisfies this. */
export interface PendingBuffer {
  pending: string[]
  pendingBytes: number
  /** Set once the cap has forced the oldest output out. */
  pendingTruncated: boolean
}

/**
 * Most output a hidden pane will hold before it starts dropping the oldest.
 *
 * A cap is unavoidable — a hidden pane can print without limit, and a buffer
 * that cannot say no is a leak with a nice name. Two megabytes is the ceiling
 * the scrollback ring already uses, for the same reason: comfortably more than
 * a screenful of context, comfortably less than a problem.
 *
 * What overflow costs is the *middle* of the output. The tail is what a pane
 * shows on reveal and the head is what nobody scrolls back to first, so
 * dropping from the front keeps the part that is about to be read.
 */
export const PENDING_CAP = 2 * 1024 * 1024

export function bufferWhileHidden(buf: PendingBuffer, data: string, cap = PENDING_CAP): void {
  if (!data) return
  buf.pending.push(data)
  buf.pendingBytes += data.length
  // `length > 1` so the buffer never empties itself: a single chunk larger than
  // the whole cap is still the most recent thing the pane printed, and throwing
  // it away would leave a revealed pane blank rather than merely trimmed.
  while (buf.pendingBytes > cap && buf.pending.length > 1) {
    buf.pendingBytes -= buf.pending.shift()!.length
    buf.pendingTruncated = true
  }
}

/**
 * Takes everything held and resets the buffer.
 *
 * One string rather than the chunks, because xterm parses a single large write
 * appreciably faster than the same bytes in pieces, and there is no frame to
 * yield to that we are not about to redraw anyway.
 */
export function drainPending(buf: PendingBuffer): { text: string; truncated: boolean } {
  const text = buf.pending.join('')
  const truncated = buf.pendingTruncated
  buf.pending = []
  buf.pendingBytes = 0
  buf.pendingTruncated = false
  return { text, truncated }
}

/** Forgets what was held — for a pane whose shell is being replaced. */
export function clearPending(buf: PendingBuffer): void {
  buf.pending = []
  buf.pendingBytes = 0
  buf.pendingTruncated = false
}
