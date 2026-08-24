import type { Backend } from './types'

/**
 * Tauri implementation of the same contract Electron answers.
 *
 * Everything goes through one command — `invoke('ipc', { channel, args })` —
 * because the renderer already addresses the host by channel name and a Rust
 * function per channel would be 108 pairs of names to keep in step. See
 * `src-tauri/src/ipc.rs`.
 *
 * **A channel the host has not ported yet rejects, naming itself.** That is the
 * point of doing it this way during a port: the app starts, the panes that work
 * work, and the one that does not says which channel it wanted instead of
 * failing at load with an undefined function.
 */
interface TauriGlobal {
  core: { invoke(command: string, args: Record<string, unknown>): Promise<unknown> }
  event: {
    listen(event: string, handler: (message: { payload: unknown }) => void): Promise<() => void>
  }
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal
  }
}

function tauri(): TauriGlobal {
  const api = window.__TAURI__
  if (!api) throw new Error('the Tauri bridge is not present — is this build running in Tauri?')
  return api
}

/** One call to the host. */
function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return tauri().core.invoke('ipc', { channel, args }) as Promise<T>
}

/**
 * Subscribes to one of the host's events.
 *
 * The Electron bridge hands back nothing, so neither does this: the renderer
 * subscribes once at startup and never unsubscribes. `listen` is asynchronous
 * and its unsubscriber is dropped on purpose rather than awaited into a
 * lifecycle nothing else has.
 */
function on<T>(event: string, handler: (payload: T) => void): () => void {
  // `listen` resolves to its own unsubscriber, and the renderer wants one
  // synchronously — so this returns a function that stops the listener whenever
  // the subscription finishes arriving. Unsubscribing before then is honoured.
  let stop: (() => void) | null = null
  let cancelled = false
  void tauri()
    .event.listen(event, (message) => handler(message.payload as T))
    .then((unlisten) => {
      if (cancelled) unlisten()
      else stop = unlisten
    })
  return () => {
    cancelled = true
    stop?.()
  }
}

/** Platform, from the user agent, since the host has not been asked yet. */
function platform(): 'windows' | 'macos' | 'linux' {
  const agent = navigator.userAgent
  if (/Windows/i.test(agent)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(agent)) return 'macos'
  return 'linux'
}

export function createTauriBackend(): Backend {
  const ported: Partial<Backend> = {
    name: 'tauri',
    // No `<webview>` here: a browser pane will have to be a child webview
    // window positioned over the layout, which is a different set of problems
    // from an element in the tree. Declared absent until it exists, and the
    // browser pane's own code already refuses to open where it is.
    capabilities: { browser: null, documents: false, platform: platform() },

    // No blocker on this host, and saying so is the honest answer rather than
    // reporting a lock nobody holds. `supported: false` is what the sidebar
    // renders as "not available here".
    powerLock: async () => ({ hold: false, reason: 'off' as const, holding: [], supported: false }),

    // No scratch store on this host yet. Answering rather than throwing is the
    // whole point of a total contract: an untitled pane here simply behaves the
    // way it did before there was one — nothing is kept, and nothing breaks.
    scratch: {
      read: async () => null,
      write: async () => {},
      drop: async () => {},
    },

    loadState: () => call('state:load'),
    saveState: (state) => call('state:save', state),
    onExternalStateChange: (cb) => on('state:external', cb),

    listShells: () => call('shell:list'),
    homeDir: () => call('app:homeDir'),
    appVersion: () => call('app:version'),

    readDir: (dir, showHidden) => call('files:readDir', dir, showHidden),
    readText: (target) => call('files:readText', target),
    fileStamp: (target) => call('files:stamp', target),
    isDirectory: (dir) => call('files:isDirectory', dir),

    // The rest of `files` is unported; the proxy answers those by name.
    files: { writeText: (target, content) => call('files:writeText', target, content) } as Backend['files'],

    pty: {
      spawn: (req) => call('pty:spawn', req),
      write: (paneId, data) => call('pty:write', paneId, data),
      resize: (paneId, cols, rows) => call('pty:resize', paneId, cols, rows),
      kill: (paneId) => call('pty:kill', paneId),
      sleep: (paneId) => call('pty:sleep', paneId),
      isBusy: (paneId) => call('pty:isBusy', paneId),
    },

    on: {
      ptyData: (cb) => on('pty:data', cb),
      ptyExit: (cb) => on('pty:exit', cb),
      ptyMeta: (cb) => on('pty:meta', cb),
      paneStatus: (cb) => on('pane:status', cb),
    } as Backend['on'],
  }

  return notYet(ported, '')
}

/**
 * Fills the gaps in a half-ported adapter with functions that say so.
 *
 * Without this the renderer meets `undefined is not a function` somewhere three
 * layers from the cause. With it, the pane that wanted `git:status` says
 * exactly that and everything else carries on — which is the difference between
 * a port you can use while it is unfinished and one you cannot start until it
 * is done.
 */
function notYet<T extends object>(partial: Partial<T>, path: string): T {
  return new Proxy(partial, {
    get(target, key: string) {
      const value = (target as Record<string, unknown>)[key]
      if (value !== undefined) return value
      const name = path ? `${path}.${key}` : key
      // A nested group — `files`, `git`, `pty` — rather than a call. Returning
      // another proxy keeps the message specific: `git.status`, not `git`.
      if (GROUPS.has(name)) return notYet({}, name)
      return () => Promise.reject(new Error(`not ported to the Tauri host yet: ${name}`))
    },
  }) as T
}

/** The `Backend` fields that hold other functions rather than being one. */
const GROUPS = new Set(['files', 'git', 'pty', 'on', 'agent', 'window', 'history', 'time'])
