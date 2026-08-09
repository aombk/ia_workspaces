import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  watch,
  type FSWatcher,
} from 'node:fs'
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
export class Store {
  private readonly file: string
  private readonly dir: string
  private cache: unknown
  private writeTimer: NodeJS.Timeout | null = null
  private watcher: FSWatcher | null = null
  private watchDebounce: NodeJS.Timeout | null = null
  /** Set on every flush so we can ignore the watch event our own write causes. */
  private lastSelfWrite = 0

  constructor(userDataPath: string) {
    this.dir = userDataPath
    this.file = path.join(userDataPath, 'workspace.json')
    this.cache = this.read() ?? {}
  }

  get state(): unknown {
    // Re-read rather than trust the cache: the other app may have written since.
    const fresh = this.read()
    if (fresh !== null) this.cache = fresh
    return this.cache
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
    try {
      if (!existsSync(this.file)) return null
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // A corrupt file must never block startup — keep a copy and start clean.
      try {
        if (existsSync(this.file)) renameSync(this.file, this.file + '.corrupt')
      } catch {
        /* best effort */
      }
      return null
    }
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
      // Write-then-rename so a crash mid-write can't truncate the workspace.
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf8')
      this.lastSelfWrite = Date.now()
      renameSync(tmp, this.file)
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
