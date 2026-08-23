import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { readDurable, writeDurable } from './durableWrite'
import path from 'node:path'
import { DEFAULT_NOTIFICATIONS, DEFAULT_SETTINGS, type Settings } from '../shared/types'

/**
 * Shared workspace persistence.
 *
 * Deliberately stores the document as opaque JSON rather than a typed mirror.
 * The renderer owns the schema and normalises on load, and both the Electron
 * and any future build write the *same* file — round-tripping through a stale
 * typed struct here would silently drop fields the other build understands.
 * Only `settings` is read back typed, because the PTY layer acts on it.
 */
/**
 * One setting, read before the app is ready and before a `Store` can exist.
 *
 * Hardware acceleration can only be switched off in the moment between the
 * process starting and Electron becoming ready — earlier than anything else
 * here runs. So this reads the file directly rather than through the class
 * below, which is the sort of duplication worth having exactly once: the
 * alternative is a setting that cannot be honoured until the second launch
 * after you change it.
 *
 * Every failure answers false, which is hardware acceleration on. A machine
 * that cannot read its settings should get the fast path, not the fallback.
 */
export function readSoftwareRendering(userDataPath: string): boolean {
  try {
    const file = path.join(userDataPath, 'workspace.json')
    if (!existsSync(file)) return false
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      settings?: { useSoftwareRendering?: unknown }
    }
    return parsed?.settings?.useSoftwareRendering === true
  } catch {
    return false
  }
}

export class Store {
  private readonly file: string
  private readonly dir: string
  private cache: unknown
  private writeTimer: NodeJS.Timeout | null = null
  private watcher: FSWatcher | null = null
  private watchDebounce: NodeJS.Timeout | null = null
  /** Set on every flush so we can ignore the watch event our own write causes. */
  private lastSelfWrite = 0
  /** The exact text last written, so an unchanged document costs nothing. */
  private lastWritten: string | null = null

  constructor(userDataPath: string) {
    this.dir = userDataPath
    this.file = path.join(userDataPath, 'workspace.json')
    this.cache = this.read() ?? {}
  }

  get state(): unknown {
    // Re-read rather than trust the cache: another instance may have written
    // since. But *not* while this one has a write of its own waiting — then the
    // cache is newer than the disk, and adopting the disk would undo whatever
    // has not been flushed yet.
    //
    // That is not hypothetical. Deleting a workspace scheduled a save; any
    // window resize before it landed called this getter, adopted the older
    // document from the disk, and saved that instead. The workspace came back
    // on the next launch, having been deleted and then un-deleted by a resize.
    if (this.writeTimer) return this.cache

    const fresh = this.read()
    if (fresh !== null) this.cache = fresh
    return this.cache
  }

  /**
   * Changes some fields and leaves the rest alone.
   *
   * For the callers that want to record one thing — the window's bounds, say —
   * without caring about the rest of the document. They used to spread
   * `store.state` and save the result, which reads the disk in the middle of a
   * read-modify-write and is how a pending change gets lost.
   *
   * Merging into the cache is the whole point: the cache is what this process
   * believes, and a caller updating one field has no business adopting a
   * different version of every other field on the way past.
   */
  patch(fields: Record<string, unknown>): void {
    const base = (this.cache ?? {}) as Record<string, unknown>
    this.save({ ...base, ...fields })
  }

  /** Typed view of just the settings the main process acts on. */
  get settings(): Settings {
    const raw = (this.cache as { settings?: Partial<Settings> } | null)?.settings ?? {}
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      notifications: { ...DEFAULT_NOTIFICATIONS, ...(raw.notifications ?? {}) },
    }
  }

  private read(): unknown | null {
    // `readDurable` falls back to the copy of the previous version by itself —
    // a power cut leaves a file of the right length full of NUL bytes, which it
    // treats as damage rather than as an empty document. That distinction is
    // the difference between recovering from a crash and completing one.
    let recovered = false
    const parsed = readDurable<unknown>(
      this.file,
      (text) => JSON.parse(text) as unknown,
      () => {
        recovered = true
      }
    )
    if (parsed === null) return null
    if (!recovered) return parsed

    console.error('[store] workspace file was unreadable; recovered the previous version')
    try {
      // The unreadable one is kept rather than overwritten: it is the only
      // evidence of what went wrong, and it costs one file.
      if (existsSync(this.file)) renameSync(this.file, `${this.file}.corrupt`)
      // Put the good contents back now, so the next launch finds a good file
      // even if this session never saves — and so the recovery is a fact on the
      // disk rather than something true only in memory.
      writeFileSync(this.file, JSON.stringify(parsed, null, 2), 'utf8')
    } catch {
      /* the in-memory copy is still correct */
    }
    return parsed
  }

  /**
   * Debounced so the renderer can call save() freely (on every rename, tab
   * switch, resize) without hammering the disk.
   */
  save(next: unknown): void {
    this.cache = next
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => this.flush(), 400)
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })

      const text = JSON.stringify(this.cache, null, 2)
      // Nothing changed, so nothing is written. Fifty different things call
      // `save`, and plenty of them fire for changes this document does not hold
      // — a redraw, a status, a pane that reported the same folder again. Every
      // write skipped here is a write that cannot be interrupted by a crash,
      // which is the cheapest durability there is.
      if (text === this.lastWritten) return

      // Durable, with the version it replaces kept beside it. See
      // `durableWrite.ts` for why write-then-rename alone was not enough, and
      // for the incident that proved it.
      this.lastSelfWrite = Date.now()
      writeDurable(this.file, text, { backup: true })
      this.lastWritten = text
    } catch (err) {
      console.error('[store] failed to persist workspace', err)
    }
  }

  /**
   * Notifies when a *different* ia_workspaces instance rewrites the shared workspace
   * file, so two copies of the app stay in sync while both are open.
   * Our own writes are filtered out by timestamp.
   */
  watchExternal(cb: (state: unknown) => void): void {
    if (this.watcher) return
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      this.watcher = watch(this.dir, (_event, filename) => {
        if (filename !== 'workspace.json') return
        // The rename half of our own atomic write lands here too.
        if (Date.now() - this.lastSelfWrite < 1500) return
        if (this.watchDebounce) clearTimeout(this.watchDebounce)
        this.watchDebounce = setTimeout(() => {
          const fresh = this.read()
          if (fresh === null) return
          this.cache = fresh
          cb(fresh)
        }, 250)
      })
    } catch (err) {
      console.error('[store] could not watch workspace file', err)
    }
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
  }
}
