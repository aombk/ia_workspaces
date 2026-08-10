import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { hasQuirk, platformKind } from '../shared/platform'
// One ring, two users: this store rings a pane so its last screen survives to
// disk, and the broker rings a session so a reconnecting client can be given
// what it missed. Re-exported because the tests and `main` have always taken
// `RingBuffer` from here.
import { RingBuffer } from '../host/ring'

export { RingBuffer } from '../host/ring'

const PLATFORM = platformKind(process.platform)

/**
 * Per-pane scrollback that survives a restart.
 *
 * A restored pane is a fresh shell — that doesn't change. What it can have back
 * is what was on screen before, which is the part you actually wanted: the
 * build output you were reading, the stack trace, the agent's last answer.
 *
 * Raw bytes are kept, escapes and all, because the point is to hand xterm the
 * exact stream it already rendered once. Anything that filters or re-encodes
 * would lose colour and cursor positioning.
 */

/** Written by the dump, and briefly present between the write and the rename. */
const TMP_SUFFIX = /\.tmp\.[0-9a-f]+$/

/**
 * Windows only: a virus scanner or a concurrent reader can hold a transient
 * handle on the destination, so the rename that makes a dump visible fails
 * EPERM/EACCES/EBUSY. The handle clears in tens of milliseconds. Without the
 * retry the pane stays dirty and re-dumps its whole ring on the next tick,
 * which is the expensive failure mode. POSIX rename never hits this.
 */
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRY_BACKOFF_MS = [20, 50, 100, 200]

/**
 * Dumps are serialised per destination file.
 *
 * Atomic rename buys integrity, not freshness: two dumps of the same pane can
 * be in flight (the periodic tick and an exit dump), and a retry-delayed older
 * one could otherwise land last and restore stale scrollback. Chaining on the
 * destination — the resource actually shared — makes the newest one win.
 */
const chains = new Map<string, Promise<void>>()

export class ScrollbackStore {
  private readonly rings = new Map<string, RingBuffer>()
  /** Panes written to since their last dump. */
  private readonly dirty = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly dir: string,
    private readonly enabled: () => boolean
  ) {
    try {
      mkdirSync(dir, { recursive: true })
      // A dump interrupted by a power cut leaves its tmp behind; readers skip
      // them, but nothing else would ever remove them.
      for (const name of readdirSync(dir)) {
        if (TMP_SUFFIX.test(name)) {
          try {
            unlinkSync(path.join(dir, name))
          } catch {
            /* raced with another instance; fine */
          }
        }
      }
    } catch {
      /* a read-only data dir just means no persistence */
    }
  }

  /** Starts the rolling dump. Idempotent. */
  begin(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.dumpDirty(), 30_000)
    this.timer.unref?.()
  }

  /**
   * Starts buffering a pane.
   *
   * The in-memory ring is kept whatever the setting says, because two features
   * read it and only one of them is about persistence: turning off "restore
   * what a pane was showing" is a statement about writing to disk, not a
   * request to stop being able to answer `iaw read-screen`. An idle pane's ring
   * is 64 KB, so keeping it costs little. Everything that touches the disk —
   * the rolling dump, the exit flush, the restore — still checks the setting.
   */
  track(paneId: string): void {
    if (!this.rings.has(paneId)) this.rings.set(paneId, new RingBuffer())
    this.begin()
  }

  /**
   * The tail of what a pane has printed, as readable text.
   *
   * Non-destructive, unlike `take`: this answers a question about a pane that
   * is still running, and asking twice must not empty it.
   *
   * Escapes are stripped rather than preserved — the opposite of what the
   * restore path wants. A restore is handing xterm back a stream it already
   * rendered, so it has to be byte-exact; this is for something reading the
   * screen as text, where cursor moves and colour codes are noise. What comes
   * out is approximate for a full-screen program: a TUI paints by moving the
   * cursor around, so replaying its output as lines gives you every frame it
   * ever drew rather than the one on screen.
   */
  peek(paneId: string, lines: number): string | null {
    const ring = this.rings.get(paneId)
    if (!ring) return null
    const data = ring.readAll()
    if (!data.length) return ''

    // The ring wraps at a byte boundary, so the oldest bytes can be the tail of
    // a multi-byte character; dropping them beats a replacement character.
    let start = 0
    while (start < data.length && (data[start] & 0xc0) === 0x80) start++

    const text = stripEscapes(data.subarray(start).toString('utf8'))
    const rows = text.split('\n')
    // A trailing newline leaves an empty last row that is not a line of output.
    if (rows.length && rows[rows.length - 1] === '') rows.pop()
    const wanted = Math.max(1, Math.min(lines, 10_000))
    return rows.slice(-wanted).join('\n')
  }

  push(paneId: string, data: string): void {
    const ring = this.rings.get(paneId)
    if (!ring) return
    ring.write(Buffer.from(data, 'utf8'))
    this.dirty.add(paneId)
  }

  /**
   * What this pane had on screen last run, or null.
   *
   * Consumed once: a pane that has been restored owns its stream from then on,
   * and a second read would duplicate the buffer if the pane were re-spawned.
   */
  take(paneId: string): string | null {
    if (!this.enabled()) return null
    const file = this.fileFor(paneId)
    try {
      const data = readFileSync(file)
      unlinkSync(file)
      if (!data.length) return null
      // The ring wraps at a byte boundary, so the oldest bytes can be the tail
      // of a multi-byte character. Decoding those produces a replacement
      // character at the very top of the restored screen; dropping them is a
      // cheaper fix than tracking character boundaries in the ring.
      let start = 0
      while (start < data.length && (data[start] & 0xc0) === 0x80) start++
      return data.subarray(start).toString('utf8')
    } catch {
      return null
    }
  }

  /** Pane closed by the user: its scrollback is not coming back. */
  drop(paneId: string): void {
    this.rings.delete(paneId)
    this.dirty.delete(paneId)
    try {
      unlinkSync(this.fileFor(paneId))
    } catch {
      /* never dumped */
    }
  }

  /** Pane's shell exited but the pane lives on — keep what it printed. */
  async flush(paneId: string): Promise<void> {
    const ring = this.rings.get(paneId)
    if (!ring || !this.enabled()) return
    this.dirty.delete(paneId)
    await this.dump(paneId, ring)
  }

  private async dumpDirty(): Promise<void> {
    if (!this.enabled()) return
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const id of ids) {
      const ring = this.rings.get(id)
      if (ring) await this.dump(id, ring)
    }
  }

  /**
   * Last-word save on the way out. Synchronous because the event loop is about
   * to stop and an awaited dump would simply not happen.
   */
  shutdownSync(): void {
    if (!this.enabled()) return
    for (const [id, ring] of this.rings) {
      const data = ring.readAll()
      if (!data.length) continue
      const target = this.fileFor(id)
      const tmp = `${target}.tmp.${randomBytes(6).toString('hex')}`
      try {
        writeFileSync(tmp, data)
        renameSync(tmp, target)
      } catch {
        try {
          unlinkSync(tmp)
        } catch {
          /* already gone */
        }
      }
    }
  }

  /** Forgets panes the workspace file no longer mentions. */
  prune(livePaneIds: ReadonlySet<string>): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (TMP_SUFFIX.test(name) || !name.endsWith('.buf')) continue
      if (livePaneIds.has(name.slice(0, -4))) continue
      try {
        unlinkSync(path.join(this.dir, name))
      } catch {
        /* best effort */
      }
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Drops every buffer on disk — used when the setting is turned off.
   *
   * The live rings stay: they are also what `read-screen` reads, and the
   * setting being turned off means "stop writing this to disk", not "stop
   * knowing what my panes have printed".
   */
  clearAll(): void {
    this.dirty.clear()
    try {
      rmSync(this.dir, { recursive: true, force: true })
      mkdirSync(this.dir, { recursive: true })
    } catch {
      /* best effort */
    }
  }

  private fileFor(paneId: string): string {
    // Pane ids are UUIDs we generate, but a hostile workspace.json could carry
    // anything, and this value becomes a path.
    return path.join(this.dir, `${paneId.replace(/[^A-Za-z0-9._-]/g, '_')}.buf`)
  }

  private dump(paneId: string, ring: RingBuffer): Promise<void> {
    const target = this.fileFor(paneId)
    const prev = chains.get(target) ?? Promise.resolve()
    const run = prev
      .catch(() => {
        /* an earlier failure must not skip this dump */
      })
      .then(() => writeAtomic(target, ring.readAll()))
    chains.set(target, run)
    return run
      .catch(() => {
        // Leave it dirty so the next tick tries again.
        this.dirty.add(paneId)
      })
      .finally(() => {
        // Only if nothing newer took ownership of the chain.
        if (chains.get(target) === run) chains.delete(target)
      })
  }
}

async function writeAtomic(target: string, data: Buffer): Promise<void> {
  // Same directory as the destination: a cross-filesystem rename fails EXDEV.
  const tmp = `${target}.tmp.${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmp, data)
    await renameWithRetry(tmp, target)
  } catch (err) {
    try {
      await unlink(tmp)
    } catch {
      /* may already be gone */
    }
    throw err
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      // Windows only: a rename can lose to an indexer or a virus scanner
      // holding the destination open for a few milliseconds. POSIX rename is
      // atomic and does not fail that way, so retrying there would only be
      // hiding a real error behind a delay.
      if (hasQuirk(PLATFORM, 'scrollbackRetries') && RETRY_CODES.has(code) && attempt < RETRY_BACKOFF_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]))
        continue
      }
      throw err
    }
  }
}

/**
 * Removes the escape sequences from a captured stream, leaving the text.
 *
 * Four families, because that is what a Windows terminal stream actually
 * contains: CSI (`ESC [ … final`) for colour and cursor movement, OSC
 * (`ESC ] … BEL` or `ESC \`) for titles, cwd reports and our own shell
 * integration markers, the two-character escapes, and the bare control
 * characters that survive both. Carriage returns are dropped rather than kept,
 * since a CRLF stream would otherwise come out with a stray CR on every line.
 */
export function stripEscapes(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '')
    // Backspace-overstrike is how a shell redraws a line being edited; the
    // character it was meant to erase is already in the stream, so leaving the
    // control byte in would just make the text unreadable.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}
