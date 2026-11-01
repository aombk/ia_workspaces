import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync as readBytesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import path from 'node:path'
import { listProcesses } from './processes'
import { ExternalApps, type AppSyncRequest } from './externalApps'
import { forgetKeychainRefusal, readClaudeUsage } from './usage'
import { readTokenUsage } from './tokenUsage'
import { readTurnIndex } from './turns'
import { prepareFileDrag, startFileDrag } from './fileDrag'
import { snapToTop } from './snapToTop'
import { readClipboardFiles, writeClipboardFiles } from './fileClipboard'
import { historyDir, writePaneHistory } from './paneHistoryFile'
import { dropScratch, readScratch, sweepScratch, writeScratch } from './scratchBuffer'
import { TimeLog, timeLogPath } from './timeLog'
import {
  hasSharePassphrase,
  setSharePassphrase,
  sharePassphrase,
} from './sharePassphrase'
import { publishRelay, type RelayEntry } from './relay'
import { shareTokens, type PublishEntry } from './tokenShare'
import { readSystemStats } from './systemStats'
import { readWeather } from './weather'
import { readCrypto } from './crypto'
import { randomUUID } from 'node:crypto'
import { latestRelease } from './updates'
import { PtyManager } from './ptyManager'
import { readSoftwareRendering, Store } from './store'
import {
  prepareIntegrationScript,
  listShells,
  listWslDistros,
  listRunningWslDistros,
  controlWsl,
  listSshHosts,
} from './shells'
import type { WslAction } from '../shared/wsl'
import { readClaudeSettings, setClaudeIntegration } from './claudeConfig'
import { currentBranch } from './gitBranch'
import * as git from './git'
import { registerImageScheme, serveImages } from './imageProtocol'
import { registerDocumentScheme, serveDocuments } from './docProtocol'
import { registerMediaScheme, serveMedia } from './mediaProtocol'
import { PowerLock } from './powerLock'
import { MoveBreaks } from './moveBreaks'
import { readBreakSettings } from '../shared/moveBreaks'
import {
  readDirectory,
  listByExtension,
  listImages,
  readText,
  fileStamp,
  readBytes,
  patchBytes,
  writeText,
  readJuceXml,
  writeJuceXml,
  gitDiff,
  compareFiles,
  searchWorkspace,
  gitStatus,
  isDirectory,
  createDirectory,
  createFile,
  openWith,
  renameEntry,
  removeEntry,
  copyEntry,
  moveEntry,
} from './files'
import {
  cliShimPath,
  startControlServer,
  writeCliShim,
  type ControlServer,
} from './controlServer'
import { buildTree, flattenPanes } from './controlSurface'
import { readAgentHooks, setAgentHooks } from './agentHooks'
import {
  addWorktree,
  listWorktrees,
  removeWorktree,
  mainCheckoutRoot,
  suggestWorktreeDir,
  worktreeAt,
} from './worktrees'
import * as space from './space'
import { AGENTS, agentById } from './agents'
import { isCliVerb, runCli } from './cli'
import { ScrollbackStore } from './scrollback'
import { EventLog, parseCategories } from './events'
import { CommandHistory } from './history'
import { primeToolPath } from './toolPath'
import { refreshPanePath } from './windowsPath'
import { guardBrowserPane } from './browserGuard'
import { MAIN_OWNED_FIELDS } from './rendererState'
import { StateHub } from './stateHub'
import { AppWindows } from './appWindows'
import {
  assignTabs,
  assignWorkspace,
  isLinked,
  keepOnlyWindows,
  MAIN_WINDOW,
  ownerOfTab,
  recordWindow,
  releaseWindow,
} from '../shared/windowLayout'
import { SessionVault } from './vault'
import { PidMap } from './pidMap'
import { directoryFromArgv, isContextMenuInstalled, setContextMenu } from './explorerMenu'
import { IPC } from '../shared/ipc'
import {
  dataDir as platformDataDir,
  isWindows,
  platformKind,
  MAC_TRAFFIC_LIGHTS,
} from '../shared/platform'
import {
  DEFAULT_THEME_ID,
  findInterfaceTheme,
  transparencyOf,
  type InterfaceTheme,
} from '../shared/themes'
import { OPENABLE_PANES } from '../shared/types'
import type {
  ClipboardImage,
  CrossPaneDecision,
  ExternalApp,
  HistoryFilter,
  SpawnRequest,
  OpenWindowRequest,
  StateRevision,
  WeatherRequest,
  WindowPlacement,
  WindowState,
  WindowTarget,
} from '../shared/types'

/** The title bar's height. Must match `--titlebar-h` in styles.css. */
const TITLEBAR_H = 36

/**
 * How tall to make the native caption strip.
 *
 * One pixel short of the bar, and that pixel is the point: `.titlebar` carries a
 * 1px bottom border, and an overlay the full height of the bar paints over it
 * wherever the buttons are. The separator then ran the width of the window and
 * stopped dead where the caption strip began, leaving the last stretch of the
 * bar with no line under it — which reads as a rendering fault rather than as a
 * design. Ending the overlay above the border lets the page draw it edge to
 * edge, underneath the buttons, the way it does everywhere else.
 *
 * `box-sizing: border-box` puts that border inside the declared 36px, so this
 * is exactly the bar's content height rather than an arbitrary pixel off.
 */
const CAPTION_H = TITLEBAR_H - 1

/** What the editor's Open offers: everything, with the text kinds gathered up. */
const ANY_FILTERS = [
  { name: 'All files', extensions: ['*'] },
  {
    name: 'Text and code',
    extensions: ['md', 'txt', 'json', 'csv', 'tsv', 'ts', 'tsx', 'js', 'rs', 'go', 'py', 'yml', 'yaml', 'toml', 'ini', 'xml', 'html', 'css', 'sh', 'ps1', 'sql'],
  },
]

/** One shared file type, so Save As and Open agree on what a workspace file is. */
const WORKSPACE_FILTERS = [
  { name: 'ia_workspaces workspace', extensions: ['iaws.json', 'json'] },
  { name: 'All files', extensions: ['*'] },
]

/**
 * Who Windows thinks raised a toast, and what the installer registers.
 *
 * Must match `build.appId` in `package.json`. It deliberately does not end in
 * `.app`, which is the bundle extension on macOS.
 */
const APP_ID = 'dev.iaworkspaces.terminal'

const PLATFORM = platformKind(process.platform)

/**
 * How long after launch the orphan sweep runs.
 *
 * Long enough for the renderer to have spawned every restored pane, so that a
 * session on its way back to a pane is never mistaken for one nothing wants.
 */
const ORPHAN_SWEEP_DELAY_MS = 20_000

/**
 * Where the workspace file lives.
 *
 * `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, and
 * `$XDG_CONFIG_HOME` on Linux — decided in `shared/platform.ts` so that
 * `cliEntry.ts` computes the identical path without importing Electron.
 */
const SHARED_DATA_DIR = platformDataDir(PLATFORM, process.env, os.homedir())

/**
 * Running under `tests/ui.e2e.mjs`.
 *
 * Two things change and nothing else: the window renders offscreen, and it is
 * never shown. The interface tests run on every build, and a build that threw
 * a window up over whatever you were doing — and took focus with it — would be
 * a build people learned to skip. Everything the tests exercise is the real
 * app; only where its pixels go is different.
 *
 * Isolation is the test's job, not this flag's: it launches the app with its
 * own home folder and profile, so it never sees your workspace, your shells or
 * your `~/.claude`.
 */
const UI_TEST = process.env.IAW_UI_TEST === '1'

/**
 * One executable serves as both the app and its CLI. `iaw notify …` must not
 * boot a window, so this runs before anything else touches Electron's app
 * lifecycle.
 */
const cliArgs = process.argv.slice(app.isPackaged ? 1 : 2)
if (isCliVerb(cliArgs[0])) {
  // A fallback for someone invoking the app binary directly. The `iaw` shim
  // does not come through here: it runs `cli/cli.js` with
  // ELECTRON_RUN_AS_NODE, because Chromium parses this process's command line
  // and treats a bare `scheme:rest` argument as a URL — so
  // `--blocked "permission: Bash(…)"` exits non-zero on this path even when the
  // call succeeded. See `writeCliShim`.
  runCli(cliArgs, SHARED_DATA_DIR).then((code) => process.exit(code))
} else {
  bootApp()
}

/** Files a clipboard file-URL is worth treating as a picture. */
const CLIPBOARD_IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i

/** The largest picture the image-notes editor will open. See `readImageBytes`. */
const MAX_MARKUP_BYTES = 64 * 1024 * 1024

/**
 * An image the clipboard *points at*, as opposed to pixels it carries.
 *
 * Copying a file in Finder puts a file URL on the pasteboard and the file's
 * display name beside it as plain text. That name is why pasting a screenshot
 * used to type `Screenshot 2026-08-25 at 9.20.21 PM` into a pane: whoever asked
 * the clipboard for text got an answer, and stopped looking.
 */
function clipboardImageFile(): string | null {
  for (const file of clipboardFiles()) {
    if (CLIPBOARD_IMAGE_EXT.test(file)) return file
  }
  return null
}

/**
 * Paths the clipboard is carrying, in whichever flavour this copy used.
 *
 * Two, because Finder does not consistently offer one: `public.file-url` is the
 * modern single-file flavour, and `NSFilenamesPboardType` is the older list one
 * that a multiple selection — and, depending on the macOS version, a single one
 * — arrives as instead. Reading only the first is why a copied screenshot fell
 * through to the bitmap branch and pasted the file's *icon*.
 */
function clipboardFiles(): string[] {
  const out: string[] = []

  try {
    const url = clipboard.read('public.file-url').trim()
    if (url) out.push(fileURLToPath(url))
  } catch {
    // Not a URL, or a flavour this platform does not have.
  }

  try {
    // A property list, whose paths are the only part worth having. Read as text
    // rather than parsed: an XML plist yields its strings to a match, and a
    // binary one yields nothing, which is the same answer as "no such flavour"
    // and is handled the same way.
    const plist = clipboard.read('NSFilenamesPboardType')
    for (const m of plist.matchAll(/<string>([^<]+)<\/string>/g)) {
      const file = m[1].trim()
      if (file && !out.includes(file)) out.push(file)
    }
  } catch {
    // Not present. The file-url above may still have answered.
  }

  try {
    // Windows. `FileNameW` is a single path in UTF-16, which is what Explorer
    // puts up for a copied file — the two flavours above are macOS UTIs and are
    // simply absent here, so without this a screenshot copied in Explorer was
    // not seen as an image at all.
    const wide = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0+$/, '').trim()
    if (wide && !out.includes(wide)) out.push(wide)
  } catch {
    // Not Windows, or nothing on that flavour.
  }

  return out
}

/**
 * What the clipboard is offering as a picture, and by which of the two routes.
 *
 * A copied *file* is judged by its name and answered with its path, never with
 * `readImage()`. Both macOS and Windows put the file's *icon* up as the picture
 * for a file copy, so reading the bitmap gets a grey PNG document however good
 * the screenshot was — which is the whole bug this exists to avoid, and it bit
 * twice: once here, and once in the agent that was handed the keystroke and
 * read the same icon for itself.
 *
 * `readImage()` is believed only when there is no file at all. That is the
 * screen-capture case, where the pixels are the only copy of the thing and
 * there is no path anybody could paste instead.
 */
/**
 * The time, as the part of a filename somebody has to recognise.
 *
 * Local, and readable, because this name is not an internal detail: it gets
 * typed into a pane for an agent to act on and appears in the user's own prompt.
 * `Date.now()` is unique and sorts correctly and is completely unreadable.
 *
 * Seconds, not milliseconds, because the thing it has to prevent is two pastes
 * landing on one name — the first path has already been typed into a pane, and
 * overwriting the file under it would hand the agent a different picture than
 * the one it was told about. Seconds make that essentially impossible by hand.
 */
function stamp(): string {
  const t = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` +
    `-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`
  )
}

function clipboardImage(): ClipboardImage {
  const file = clipboardImageFile()
  if (file) return { file, pixels: false }
  return { file: null, pixels: !clipboard.readImage().isEmpty() }
}

function bootApp(): void {
  // Started now and never waited for: an app opened from the Dock inherits a
  // PATH with none of the places programs are installed, and working out the
  // real one takes a shell. Nothing needs the answer until a user opens a
  // panel, and everything that asks before then gets the inherited PATH, which
  // is what this app used everywhere until now. See `toolPath.ts`.
  void primeToolPath()
  // Same idea for terminals on Windows: Explorer can start us without the user
  // PATH, and the first pane should not be the one that finds out. See
  // `windowsPath.ts`.
  if (process.platform === 'win32') refreshPanePath()

  // Before anything creates a window: Electron refuses to register a scheme's
  // privileges once one exists, and the images pane cannot load a thing without
  // this. The handler itself is installed after `whenReady`.
  registerImageScheme()
  // The same, for the reader pane's PDFs. Two schemes rather than one because
  // an image and an embedded document are granted by different CSP directives —
  // see `shared/docs.ts`.
  registerDocumentScheme()
  // And sound and video through `media-src`, which is a third directive again.
  registerMediaScheme()

  // Windows shows toasts under this identity, and shows the *name of the Start
  // Menu shortcut* that carries it. Claiming it is only half the job — see
  // `ensureStartMenuShortcut` for the other half, and for why a dev run claims
  // a different one.
  app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`)

  // Before anything else Electron does, because this is the only moment it can
  // be said: hardware acceleration cannot be switched off once the app is
  // ready. Read straight from the settings file rather than through the store,
  // which does not exist yet.
  if (readSoftwareRendering(SHARED_DATA_DIR)) {
    app.disableHardwareAcceleration()
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.setPath('userData', SHARED_DATA_DIR)

  /**
   * The main window: the one the app has always had, and the one whose closing
   * quits. Kept under its old name because most of what refers to it means
   * exactly that window — the dock bounce, the second-instance focus, Explorer's
   * folder. Everything that means "whichever window" goes through `windows`.
   */
  let win: BrowserWindow | null = null
  const windows = new AppWindows()
  /** The document every window edits. Built once the store is. See `stateHub.ts`. */
  let hub: StateHub
  /** Which window drew each pane last — where its output goes. See `routePane`. */
  const paneOwner = new Map<string, string>()
  /**
   * Output held back from a pane while the screen it is being taken over with
   * is rebuilt, so nothing it prints in those milliseconds lands above it.
   */
  const holding = new Map<string, string[]>()
  /** Set once a quit has begun, so a window closing on the way out keeps its tabs. */
  let quitting = false
  /** Set while a quit waits for the renderer's last save. See `before-quit`. */
  let quitWhenFlushed: (() => void) | null = null
  let store: Store
  let ptys: PtyManager
  let powerLock: PowerLock | undefined
  let moveBreaks: MoveBreaks | undefined
  let scrollback: ScrollbackStore
  let pidMap: PidMap
  /**
   * What happened, for anything watching. Created before the control server so
   * a handler can close over it, and mirrored to disk once the data directory
   * is known.
   */
  const events = new EventLog()
  let history: CommandHistory
  let timeLog: TimeLog
  let vault: SessionVault
  let control: ControlServer | null = null
  /**
   * GUI programs the workspaces own — see `externalApps.ts`.
   *
   * Built here rather than lazily because `recover()` has to run before a
   * window exists: a previous run that died with windows hidden left them off
   * every screen and out of the taskbar, and putting them back is the first
   * thing this process owes anyone.
   */
  const externalApps = new ExternalApps({
    dataDir: SHARED_DATA_DIR,
    descendants: async (pid) => {
      const rows = await listProcesses(new Map([['app', pid]]))
      return rows.map((row) => row.pid)
    },
    // `tasklist` rather than the process walk above: this asks a different
    // question — every copy of one executable, wherever it was started from —
    // and answers in a fraction of the time a CIM query over every process
    // takes. The name is checked against a narrow pattern first, because it
    // reaches a command line and it came out of a saved document.
    pidsNamed: async (executable) => {
      if (!/^[\w.\- ]+$/.test(executable)) return []
      return new Promise((resolve) => {
        execFile(
          'tasklist.exe',
          ['/FI', `IMAGENAME eq ${executable}`, '/FO', 'CSV', '/NH'],
          { windowsHide: true },
          (error, stdout) => {
            if (error) return resolve([])
            const pids: number[] = []
            for (const line of stdout.split(/\r?\n/)) {
              const pid = Number(line.split('","')[1])
              if (Number.isFinite(pid) && pid > 0) pids.push(pid)
            }
            resolve(pids)
          }
        )
      })
    },
  })
  externalApps.recover()
  /** Set at window creation; see `wantsTransparentWindow`. */
  let transparentWindow = false
  /** A folder Explorer handed us at launch, held until the UI is ready for it. */
  let pendingFolder: string | null = directoryFromArgv(process.argv.slice(1))

  /** To the main window only. Most callers want `windows.broadcast` or `routePane`. */
  const send = (channel: string, payload: unknown): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  /**
   * The window a pane is drawn in.
   *
   * The window that last started or took it over, while that window is open;
   * otherwise the window its tab is filed under; otherwise the main one. The
   * first answer is the live one — it changes the moment a window mounts the
   * pane — and the second covers a pane nobody has mounted yet this run.
   */
  function windowOfPane(paneId: string): string {
    const drawn = paneOwner.get(paneId)
    if (drawn && windows.get(drawn)) return drawn
    const doc = hub?.doc as { workspaces?: Array<{ tabs?: Array<{ windowId?: string; panes?: Array<{ id: string }> }> }> }
    for (const workspace of doc?.workspaces ?? []) {
      for (const tab of workspace.tabs ?? []) {
        if (tab.panes?.some((p) => p.id === paneId)) {
          const owner = ownerOfTab(tab)
          return windows.get(owner) ? owner : MAIN_WINDOW
        }
      }
    }
    return MAIN_WINDOW
  }

  /** Terminal bytes and the like, to the one window drawing that pane. */
  function routePane(paneId: string, channel: string, payload: unknown): void {
    windows.sendTo(windowOfPane(paneId), channel, payload)
  }

  /**
   * A pane a window has just taken over, with its screen rebuilt.
   *
   * The pane's shell kept running while it changed windows, but its screen was
   * in the window it left. The ring is read synchronously, inside
   * `liveScreen`'s first step, at the same moment the pane's output starts
   * being held here — so what was printed is either in the rebuilt screen or in
   * what is held, never in both and never in neither.
   */
  async function takeOver(paneId: string): Promise<void> {
    holding.set(paneId, [])
    let screen: string | null = null
    try {
      screen = await ptys.liveScreen(paneId)
    } catch {
      // A screen that cannot be rebuilt is a blank pane that carries on — which
      // is what a moved pane used to be every time.
    }
    const held = holding.get(paneId) ?? []
    holding.delete(paneId)
    const data = (screen ?? '') + held.join('')
    if (data) routePane(paneId, IPC.onPtyData, { paneId, data })
  }

  /** Persists and sends a new revision of the document to every window. */
  function publish(next: StateRevision): void {
    store.save(next.doc)
    windows.broadcast(IPC.onState, next)
    closeEmptiedWindows(next.doc as Record<string, unknown>)
  }

  /** Windows other than the main one that have held at least one tab. */
  const hadTabs = new Set<string>()

  /**
   * Closes a window whose last tab has just been taken away — dragged to
   * another monitor, or into a pane somewhere else.
   *
   * An empty window left behind on a screen is clutter nobody asked for, and
   * it is what dragging the last thing out of a window means everywhere else.
   * Only once it has held something: a window just opened onto a workspace has
   * no tab for the moment between opening and starting its terminal, and must
   * not close in that moment.
   */
  function closeEmptiedWindows(doc: Record<string, unknown>): void {
    // Linked, a window is a monitor's share of whichever workspace is picked,
    // and a workspace with nothing on that monitor is not a reason to lose it.
    if (isLinked(doc)) return
    const counts = new Map<string, number>()
    for (const workspace of (doc.workspaces as Array<{ windowId?: string; tabs?: Array<{ windowId?: string }> }> | undefined) ?? []) {
      // A workspace listed there, even with no tab open, is something in it.
      const home = ownerOfTab(workspace)
      counts.set(home, (counts.get(home) ?? 0) + 1)
      for (const tab of workspace.tabs ?? []) {
        const owner = ownerOfTab(tab)
        counts.set(owner, (counts.get(owner) ?? 0) + 1)
      }
    }
    for (const entry of windows.all()) {
      if (entry.kind !== 'workspace') continue
      if (counts.get(entry.id)) hadTabs.add(entry.id)
      else if (hadTabs.has(entry.id) && !quitting) {
        hadTabs.delete(entry.id)
        entry.win.close()
      }
    }
  }

  /** Main's own edit of the document, sent to every window. */
  function editDoc(fn: (doc: Record<string, unknown>) => Record<string, unknown>): void {
    publish(hub.replace(fn(hub.doc)))
  }

  /** Tells every window which windows exist, after one opens, closes or takes focus. */
  function announceWindows(): void {
    windows.broadcast(IPC.onWindowsChanged, windows.info())
  }

  /**
   * Whether the window must be created genuinely transparent.
   *
   * `transparent` is a construction-time flag with no runtime setter, so the
   * decision has to be made from the persisted theme before the window exists.
   * Clear glass is the only translucent look this app offers, and it is the one
   * that cannot be arranged afterwards: with no compositor material and no
   * transparency there is simply nothing behind the page, and the window comes
   * up opaque. Switching it on or off therefore takes a restart, which the
   * theme editor offers at the moment the choice is made.
   */
  function wantsTransparentWindow(): boolean {
    const settings = (store.state as { settings?: Record<string, unknown> } | null)?.settings
    if (!settings) return false
    const themes = (settings.customThemes ?? []) as {
      id: string
      opacity?: number
      backdrop?: string
      transparency?: 'off' | 'terminal' | 'app'
    }[]
    const theme = themes.find((t) => t.id === settings.themeId)
    // Every built-in theme is fully opaque, so an unmatched id means no.
    if (!theme) return false
    // Scope first: a theme switched off keeps its opacity for when it is
    // switched back on, and that opacity may not build a clear window in the
    // meantime — that is the invisible frame with no way out of it.
    if (transparencyOf(theme) === 'off') return false
    return (theme.opacity ?? 1) < 1
  }

  /**
   * Whether the window's own corners should be square.
   *
   * The corners of the window are Windows 11's, not the page's: it rounds every
   * frameless window and no stylesheet can reach outside the frame to stop it.
   * `roundedCorners` is the one control, and like `transparent` it is read at
   * construction with no runtime setter — so choosing Square in the theme takes
   * effect on the next start, which the setting's own hint says.
   *
   * Only `square` squares the frame. `subtle` is about the widgets inside; a
   * 2px window corner is indistinguishable from a sharp one at the scale
   * Windows draws it, and asking for a restart to deliver nothing visible would
   * be a worse trade than leaving the frame alone.
   *
   * Windows only, and the `win32` check is the whole point of it. `roundedCorners`
   * is documented as being about corners, but on macOS turning it off also takes
   * the close/minimise/zoom buttons with it — the window comes up with no controls
   * at all, and the only way back is the keyboard or the Dock. Verified rather than
   * inferred: two windows identical but for this flag, and only the rounded one
   * had traffic lights. Square corners are a Windows 11 problem in the first
   * place — nothing on macOS rounds a frame the app did not ask to be rounded —
   * so there was never anything here for the Mac to gain in exchange.
   */
  function wantsSquareWindow(): boolean {
    if (process.platform !== 'win32') return false
    const settings = (store.state as { settings?: Record<string, unknown> } | null)?.settings
    if (!settings) return false
    const themes = (settings.customThemes ?? []) as { id: string; roundness?: string }[]
    const theme = themes.find((t) => t.id === settings.themeId)
    return theme?.roundness === 'square'
  }

  /**
   * The two colours Windows will accept for its caption buttons.
   *
   * The overlay is painted by the OS outside the DOM, so CSS cannot reach it and
   * these are the whole of the control we have. They mirror what the page paints
   * in the same row — `--bg` behind the title bar, `--text-dim` on the buttons
   * the Tauri build draws itself — so the strip reads as part of the bar rather
   * than as a rectangle sitting on it.
   *
   * Resolved here as well as on every theme change so the window comes up in the
   * right colours instead of flashing a default until the renderer reports in.
   */
  function captionColors(): { color: string; symbolColor: string } {
    const settings = (
      store.state as { settings?: { themeId?: string; customThemes?: InterfaceTheme[] } } | null
    )?.settings
    const theme = findInterfaceTheme(settings?.themeId ?? DEFAULT_THEME_ID, settings?.customThemes ?? [])
    return { color: theme.chrome.bg, symbolColor: theme.chrome.textDim }
  }

  /**
   * Who Windows thinks raised a toast.
   *
   * A dev run gets its *own* identity rather than none. With none, Windows has
   * nothing to attribute the notification to and falls back to the process —
   * so every toast from `npm start` said "Electron", with Electron's logo. And
   * it cannot share the packaged build's identity either: whichever shortcut
   * was written last would decide where a click from *either* build landed.
   * A separate id, with a name that says what it is, does neither.
   */
  function appId(): string {
    return app.isPackaged ? APP_ID : `${APP_ID}.dev`
  }

  function shortcutName(): string {
    return app.isPackaged ? app.getName() : `${app.getName()} (dev)`
  }

  /**
   * The app icon on disk.
   *
   * Packaged, it is copied in beside the asar (`build.extraResources`) rather
   * than into it: Electron reads this path with the OS's file APIs, which know
   * nothing about archives. Unpackaged, the repo's own copy is three levels up
   * from `out/electron/main`.
   */
  function iconPath(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'icon.ico')
      : path.join(__dirname, '..', '..', '..', 'src-tauri', 'icons', 'icon.ico')
  }

  /**
   * Gives Windows somewhere to send a toast click.
   *
   * A toast is not really raised by a process — it is raised by an *identity*,
   * and Windows only recognises an identity that has a Start Menu shortcut
   * carrying it. Without one, the toast still appears, and clicking it does
   * nothing at all: the shell has no idea what to hand the click to, so it
   * never reaches `notification.on('click')` and you never land on the pane
   * that was waiting for you. The installed build gets a shortcut from its
   * installer; the portable build, by design, gets nothing.
   *
   * So the app writes one itself. Three things about it are load-bearing, and
   * each of them was learned by getting it wrong:
   *
   * **The shortcut's name is the name on the toast.** Windows shows the
   * *shortcut* that carries the identity, so a stray `Electron.lnk` holding
   * this AUMID makes every notification — from either build — say "Electron".
   * `stripImposters` clears those out.
   *
   * **The icon has to be on the shortcut.** With none, Windows falls back to
   * the target executable's, which for a portable build is a copy in `%TEMP%`
   * that may not exist any more; that is the other half of the Electron logo
   * appearing on a toast. So the icon is written every time, not only when the
   * shortcut is created.
   *
   * **The target must outlive the run.** A portable build is launched from a
   * copy of itself unpacked into `%TEMP%`, and recording that path leaves a
   * shortcut pointing at nothing by tomorrow. `PORTABLE_EXECUTABLE_FILE` is the
   * exe that was actually double-clicked; failing that, anything under `%TEMP%`
   * is refused and an existing target kept instead.
   */
  function ensureStartMenuShortcut(): void {
    // A Start Menu is a Windows idea. macOS has /Applications and the app is
    // already there by virtue of being installed; Linux has .desktop files,
    // which the packaging formats write themselves.
    if (!isWindows(PLATFORM)) return
    const programs = path.join(app.getPath('appData'), 'Microsoft\\Windows\\Start Menu\\Programs')
    const link = path.join(programs, `${shortcutName()}.lnk`)

    // The installer writes a shortcut in its own group folder carrying this
    // same identity. Writing another at the root of the Start Menu would leave
    // two entries for one app — the app's, and the installer's — which is what
    // an upgrade would look like going wrong even though nothing had. So an
    // installed build stands down once it can see the installer's.
    if (installedShortcutExists(programs)) return

    let existing: Electron.ShortcutDetails | null = null
    try {
      existing = shell.readShortcutLink(link)
    } catch {
      // No shortcut yet, or one we cannot read. Either way, write a fresh one.
    }

    try {
      shell.writeShortcutLink(link, existing ? 'update' : 'create', {
        target: stableTarget(existing?.target),
        appUserModelId: appId(),
        icon: iconPath(),
        iconIndex: 0,
        description: 'Workspace-oriented terminal for Windows',
      })
      stripImposters(programs, link)
    } catch {
      // A Start Menu we are not allowed to write to costs toast clicks and
      // nothing else. Not worth interrupting a launch over.
    }
  }

  /**
   * Whether an installer has already put our identity in the Start Menu.
   *
   * Only true for an installed build: the portable one is a file somebody
   * downloaded, no installer ran, and writing its own shortcut is the only way
   * a toast click can reach it. `PORTABLE_EXECUTABLE_FILE` is set by the
   * portable wrapper and by nothing else, which is what tells the two apart.
   *
   * Looked for one level down as well as at the root, because the installer
   * files its shortcut under a publisher folder. Both Start Menus are checked:
   * an all-users install writes to the machine's, a per-user one to yours.
   */
  function installedShortcutExists(userPrograms: string): boolean {
    if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return false
    const common = process.env.ProgramData
      ? path.join(process.env.ProgramData, 'Microsoft\\Windows\\Start Menu\\Programs')
      : ''
    for (const root of [userPrograms, common].filter(Boolean)) {
      for (const dir of [root, ...subdirectories(root)]) {
        if (shortcutWithOurIdIn(dir)) return true
      }
    }
    return false
  }

  function subdirectories(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name))
    } catch {
      return []
    }
  }

  function shortcutWithOurIdIn(dir: string): boolean {
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.lnk'))
    } catch {
      return false
    }
    return names.some((name) => {
      try {
        return shell.readShortcutLink(path.join(dir, name)).appUserModelId === appId()
      } catch {
        return false
      }
    })
  }

  /**
   * Any *other* shortcut claiming this identity.
   *
   * Electron plants `Electron.lnk` when an unpackaged run raises a toast, and
   * it carries whatever AUMID was set at the time. It then outranks ours for
   * the rest of the machine's life — same identity, wrong name, no icon, and a
   * target in a `%TEMP%` folder that was deleted weeks ago.
   */
  function stripImposters(programs: string, keep: string): void {
    let names: string[] = []
    try {
      names = readdirSync(programs).filter((name) => name.toLowerCase().endsWith('.lnk'))
    } catch {
      return
    }
    for (const name of names) {
      const candidate = path.join(programs, name)
      if (candidate.toLowerCase() === keep.toLowerCase()) continue
      try {
        if (shell.readShortcutLink(candidate).appUserModelId !== appId()) continue
        rmSync(candidate)
      } catch {
        // Unreadable or undeletable: leave it be.
      }
    }
  }

  /** A path worth writing down: one that will still be there next week. */
  function stableTarget(existing: string | undefined): string {
    const portable = process.env.PORTABLE_EXECUTABLE_FILE
    if (portable) return portable
    const temp = (process.env.TEMP ?? process.env.TMP ?? '').toLowerCase()
    const running = process.execPath
    if (temp && running.toLowerCase().startsWith(temp)) return existing ?? running
    return existing ?? running
  }

  /** The main window, built from where it was left. */
  function createWindow(): void {
    const persisted = (hub.doc ?? {}) as { window?: Partial<WindowState> }
    transparentWindow = wantsTransparentWindow()
    win = buildWindow(MAIN_WINDOW, 'main', persisted.window ?? {})
  }

  /**
   * Builds one app window, of any kind.
   *
   * Every window is the same page with the same preload — a second window is a
   * second copy of the whole app pointed at the same document, which is why it
   * needed no second UI. The query string says which window it is, and the page
   * takes it from there. See `windowId` in the renderer's store.
   */
  function buildWindow(
    id: string,
    kind: 'main' | 'workspace' | 'overview',
    saved: Partial<WindowState>
  ): BrowserWindow {
    const bounds = kind === 'main' ? saved : visibleBounds(saved)
    const win = new BrowserWindow({
      width: Number(bounds.width ?? 1360),
      height: Number(bounds.height ?? 860),
      x: bounds.x as number | undefined,
      y: bounds.y as number | undefined,
      minWidth: kind === 'overview' ? 360 : 720,
      minHeight: kind === 'overview' ? 320 : 480,
      show: false,
      // Set for every build, not just the unpackaged one.
      //
      // A window with no icon of its own falls back to the .exe's, and ours is
      // only branded when electron-builder is allowed to edit the executable —
      // which it is not on a machine without Developer Mode (see README). That
      // left the packaged app wearing Electron's icon in the taskbar. The
      // window icon does not care how the exe was stamped, so it is the one
      // place the mark can be guaranteed.
      icon: iconPath(),
      transparent: transparentWindow,
      backgroundColor: transparentWindow ? '#00000000' : '#141414',
      roundedCorners: !wantsSquareWindow(),
      autoHideMenuBar: true,
      // Windows will not draw its caption buttons over a transparent window, so
      // the app falls back to the controls it already draws for Tauri
      // rather than leaving the window with no way to close it.
      //
      // `frame: false` is the part that makes transparency work at all. Electron
      // documents it plainly — "on Windows, does not work unless the window is
      // frameless" — and `titleBarStyle: 'hidden'` is not that: it hides the
      // caption and keeps the frame, and a framed window is composited opaque
      // however much alpha the page has. Setting `transparent` without it is
      // why the window washed out to grey instead of going clear, and why this
      // worked in the Tauri build and never here.
      //
      // Only on Windows. macOS composites a transparent window with
      // `titleBarStyle: 'hidden'` perfectly well, and going frameless there
      // would throw away the traffic lights for nothing.
      ...(transparentWindow && process.platform === 'win32'
        ? { frame: false }
        : { titleBarStyle: 'hidden' as const }),
      // Placed rather than left to the default, so the renderer knows exactly
      // how much of the bar's left end is spoken for — see `MAC_TRAFFIC_LIGHTS`.
      // The default sits them for a full-height title bar and leaves them
      // riding high in a 36px one.
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: MAC_TRAFFIC_LIGHTS.x, y: MAC_TRAFFIC_LIGHTS.y } }
        : {}),
      ...(transparentWindow
        ? {}
        : { titleBarOverlay: { ...captionColors(), height: CAPTION_H } }),
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed. The preload needs nothing a sandboxed one lacks — Electron's
        // bridge and IPC, `webUtils`, and `process.platform` — and its bundle
        // requires nothing but `electron`. Unsandboxed, a bug in this renderer
        // was a bug with the operating system's full reach; sandboxed, it has
        // to get past Chromium first, the same as a web page.
        sandbox: true,
        spellcheck: false,
        // What the browser pane is built on. `<webview>` rather than a
        // `WebContentsView` because it is an ordinary DOM element: it sits
        // inside the split layout, is clipped by it, hides with its tab and
        // stacks correctly under the settings panel — none of which a view
        // composited over the window does without being told, on every resize.
        //
        // The guest is not our renderer: it has its own process, no preload,
        // no node, and no access to anything on this side. See `browserPane.ts`.
        webviewTag: true,
        // Chromium's PDF viewer is a plugin document, and without this an
        // `<embed type="application/pdf">` renders as nothing at all. It is the
        // only plugin that exists in a modern engine — this does not reopen the
        // door to NPAPI, which has not existed for a decade.
        plugins: true,
        ...(UI_TEST ? { offscreen: true } : {}),
      },
    })

    // Without this, what shows through a clear window is a still image whenever
    // the window covers what is behind it — maximised, typically.
    //
    // Not ours to draw: the compositor shows the window behind live. That window
    // stops painting. Chromium-based apps — Chrome, Edge, VS Code, every
    // Electron app — skip rendering while another window fully covers them, and
    // the test they use for "covers" treats a DirectComposition window as solid
    // however much alpha it has. So the browser behind freezes on its last
    // frame, which is exactly what it looks like through the glass.
    //
    // What that test does honour is a layered window with an alpha below 255,
    // and `setOpacity` is Electron's way to make one. 254 of 255 is invisible
    // and enough. Measured, not inferred: a maximised clear window over an
    // animating one froze it without this and did not with it. Set before
    // `maximize`, so the very first occlusion check already sees it.
    if (transparentWindow && process.platform === 'win32') win.setOpacity(254 / 255)
    // The same window gets no Aero Snap from Windows. See `snapToTop`.
    if (transparentWindow && process.platform === 'win32') snapToTop(win)

    if (bounds.maximized) win.maximize()
    windows.add(id, kind, win)
    // Opened holding tabs — sent to it, or restored — so emptying it later
    // closes it. See `closeEmptiedWindows`.
    if (kind === 'workspace') closeEmptiedWindows(hub.doc)
    win.once('ready-to-show', () => {
      if (!UI_TEST) win.show()
      if (kind === 'main' && pendingFolder) {
        send(IPC.onOpenFolder, pendingFolder)
        pendingFolder = null
      }
    })
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { window: id, kind } })

    win.on('focus', () => {
      windows.sendTo(id, IPC.onWindowFocus, true)
      announceWindows()
    })
    win.on('blur', () => windows.sendTo(id, IPC.onWindowFocus, false))

    // Main's own field for the main window, as it always was; a record in the
    // window list for any other. Neither is a revision the windows are sent:
    // only main reads these, and a document broadcast on every drag of a window
    // edge is a lot of document for nobody.
    const persistBounds = () => {
      if (win.isDestroyed()) return
      const b = win.getNormalBounds()
      const state: WindowState = { width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() }
      if (kind === 'main') hub.patchMainOwned({ window: state })
      else hub.patchMainOwned({ windows: recordWindow(hub.doc, { id, kind, bounds: state }).windows })
      store.save(hub.doc)
    }
    win.on('resized', persistBounds)
    win.on('moved', persistBounds)
    win.on('maximize', persistBounds)
    win.on('unmaximize', persistBounds)

    // Never let the renderer navigate away or spawn popups.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    // What a page in the browser pane may ask for, and how a webview may be
    // attached at all. See `browserGuard.ts`.
    guardBrowserPane(win, path.join(__dirname, '../preload/webviewPreload.js'))

    // The main window is the app: closing it quits, with every other window,
    // through the same path as Cmd+Q so each of them gets to save first. Any
    // other window just goes, and hands its tabs back.
    win.on('close', (e) => {
      if (kind !== 'main' || quitting) return
      if (windows.all().length > 1) {
        e.preventDefault()
        app.quit()
      }
    })

    win.on('closed', () => {
      windows.remove(id)
      for (const [pane, owner] of paneOwner) if (owner === id) paneOwner.delete(pane)
      if (kind === 'main') {
        // The variable, not the parameter shadowing it: `win` out there is the
        // main window, and this is it going.
        clearMainWindow()
      } else if (!quitting) {
        editDoc((doc) => releaseWindow(doc, id))
        announceWindows()
      }

      // Quit from the window itself rather than waiting for `window-all-closed`.
      //
      // That is an app-level event, and the whole difficulty with this leak has
      // been that a surviving process tells you nothing about which step failed:
      // an event that never fired and a teardown that hung look identical from
      // Task Manager. Acting on the window's own `closed` removes one of the two
      // possibilities. `shutdown` is idempotent, so the app-level handlers
      // staying in place costs nothing and still covers a quit that arrives
      // without a window closing first — the Explorer verb, or a session ending.
      if (BrowserWindow.getAllWindows().length === 0) {
        noteShutdown('last window closed')
        shutdown()
        hardExit('last window closed')
      }
    })
    return win
  }

  /**
   * Bounds that put a window on a screen that is still there.
   *
   * A window remembered on a monitor that has since been unplugged would open
   * off every screen there is, and a window you cannot see is one you cannot
   * close. Kept where it was if any part of its title bar is on a display;
   * otherwise centred on the main one.
   */
  function visibleBounds(saved: Partial<WindowState>): Partial<WindowState> {
    const width = Number(saved.width) || 1100
    const height = Number(saved.height) || 760
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      const bar = { x: saved.x, y: saved.y, width, height: CAPTION_H }
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea
        return bar.x < a.x + a.width - 40 && bar.x + bar.width > a.x + 40 && bar.y >= a.y - 8 && bar.y < a.y + a.height - 20
      })
      if (onScreen) return { ...saved, width, height }
    }
    const area = screen.getPrimaryDisplay().workArea
    return {
      width: Math.min(width, area.width),
      height: Math.min(height, area.height),
      x: Math.round(area.x + (area.width - Math.min(width, area.width)) / 2),
      y: Math.round(area.y + (area.height - Math.min(height, area.height)) / 2),
      maximized: Boolean(saved.maximized),
    }
  }

  /** A new window id: short, and never one in use or remembered. */
  function newWindowId(): string {
    return `w${randomUUID().slice(0, 8)}`
  }

  /**
   * Opens a window, moving into it whatever the request names.
   *
   * There is only ever one overview: asking for a second shows the first.
   * A workspace window takes the tabs it was asked for, or a whole workspace's,
   * and with neither opens on a workspace with nothing in it yet — the page
   * starts a terminal there, the same as for any workspace with no tabs.
   */
  function openWindow(request: OpenWindowRequest): string | null {
    if (request.kind === 'overview') {
      const existing = windows.all().find((w) => w.kind === 'overview')
      if (existing) {
        windows.reveal(existing.id)
        return existing.id
      }
    }
    const id = newWindowId()
    const kind = request.kind === 'overview' ? 'overview' : 'workspace'
    const bounds = placeNewWindow(kind, request.at)

    // The document first, then the window: the page reads it as it loads and
    // should find its tabs already there rather than arrive empty and fill.
    editDoc((doc) => {
      let next = recordWindow(doc, { id, kind, bounds })
      if (kind === 'workspace') {
        if (request.workspaceId && request.wholeWorkspace && !request.tabIds?.length) {
          return assignWorkspace(next, request.workspaceId, id)
        }
        const tabIds = request.tabIds ?? []
        if (tabIds.length) next = assignTabs(next, tabIds, id)
        else if (request.workspaceId) {
          const views = { ...((next.views as Record<string, unknown>) ?? {}) }
          views[id] = { activeWorkspaceId: request.workspaceId, activeTabs: {} }
          next = { ...next, views }
        }
      }
      return next
    })
    buildWindow(id, kind, bounds)
    announceWindows()
    return id
  }

  /**
   * Where a new window goes: centred under the point a tab was dropped at, on
   * whichever display that is, or offset from the window you are in.
   */
  function placeNewWindow(kind: 'workspace' | 'overview', at?: WindowPlacement): WindowState {
    const from = windows.focusedForContent()?.win ?? win
    const size = from && !from.isDestroyed() ? from.getNormalBounds() : { x: 80, y: 80, width: 1200, height: 800 }
    const width = kind === 'overview' ? 460 : size.width
    const height = kind === 'overview' ? Math.max(560, Math.round(size.height * 0.9)) : size.height
    if (typeof at?.x === 'number' && typeof at?.y === 'number') {
      const area = screen.getDisplayNearestPoint({ x: Math.round(at.x), y: Math.round(at.y) }).workArea
      const w = Math.min(width, area.width)
      const h = Math.min(height, area.height)
      const x = Math.min(Math.max(Math.round(at.x - w / 2), area.x), area.x + area.width - w)
      const y = Math.min(Math.max(Math.round(at.y - CAPTION_H / 2), area.y), area.y + area.height - h)
      return { x, y, width: w, height: h, maximized: false }
    }
    return { x: size.x + 40, y: size.y + 40, width, height, maximized: false }
  }

  /** Sends tabs to another window and brings that window forward. */
  function moveTabs(tabIds: string[], to: string): boolean {
    if (!tabIds.length) return false
    const target = windows.get(to)
    if (!target || target.kind === 'overview') return false
    editDoc((doc) => assignTabs(doc, tabIds, to))
    windows.reveal(to)
    return true
  }

  /**
   * Tabs dropped on the desktop: one monitor, one window.
   *
   * Dropped on a monitor that already has one of the app's windows, they go
   * into it — which is how something dragged back to the main window's monitor
   * goes home. Dropped on a monitor with none, they become a new window there.
   * The window they came from does not count as being on its own monitor:
   * dragging a tab off a window onto the empty part of the same screen is
   * asking for a second window beside it.
   */
  function dropAt(tabIds: string[], at: WindowPlacement, from?: string, workspaceId?: string): string | null {
    if ((!tabIds.length && !workspaceId) || typeof at.x !== 'number' || typeof at.y !== 'number') return null
    const display = screen.getDisplayNearestPoint({ x: Math.round(at.x), y: Math.round(at.y) })
    const onThatMonitor = windows
      .all()
      .filter((w) => w.kind !== 'overview' && w.id !== from && !w.win.isMinimized())
      .find((w) => screen.getDisplayMatching(w.win.getBounds()).id === display.id)
    if (onThatMonitor) {
      if (workspaceId) moveWorkspace(workspaceId, onThatMonitor.id)
      else moveTabs(tabIds, onThatMonitor.id)
      return onThatMonitor.id
    }
    return workspaceId
      ? openWindow({ kind: 'workspace', workspaceId, wholeWorkspace: true, at })
      : openWindow({ kind: 'workspace', tabIds, at })
  }

  /** A whole workspace into another window — listed there, every tab with it. */
  function moveWorkspace(workspaceId: string, to: string): boolean {
    const target = windows.get(to)
    if (!target || target.kind === 'overview') return false
    editDoc((doc) => assignWorkspace(doc, workspaceId, to))
    windows.reveal(to)
    return true
  }

  /** Brings a window forward and has it show something. */
  function focusWindow(id: string, target?: WindowTarget): boolean {
    if (target?.quiet) {
      if (!windows.get(id)) return false
    } else if (!windows.reveal(id)) return false
    if (target) windows.sendTo(id, IPC.onWindowTarget, target)
    return true
  }

  /**
   * Opens every window that was open when the app last quit, where it was.
   *
   * Tabs filed under a window that is not coming back — its record lost, or
   * from a document older than windows — go to the main window first, so no
   * tab is left belonging to nobody.
   */
  function restoreWindows(): void {
    const records = ((hub.doc as { windows?: Array<{ id: string; kind: string; bounds: WindowState }> }).windows ?? [])
      .filter((r) => r && typeof r.id === 'string' && (r.kind === 'workspace' || r.kind === 'overview'))
    const live = new Set(records.map((r) => r.id))
    editDoc((doc) => ({ ...keepOnlyWindows(doc, live), windows: records }))
    for (const record of records) buildWindow(record.id, record.kind as 'workspace' | 'overview', record.bounds ?? {})
    if (records.length) announceWindows()
  }

  /** Forgets the main window once it has closed. */
  function clearMainWindow(): void {
    win = null
  }

  /**
   * Panes allowed to act on other panes without asking, until the app quits.
   *
   * Not saved: "always" is a decision about the program running in that pane
   * now, and a pane reopened tomorrow may be running something else.
   */
  const trustedPanes = new Set<string>()
  const approvals = new Map<string, (decision: CrossPaneDecision) => void>()

  /**
   * Asks you whether one pane may act on another. See `CROSS_PANE` in
   * `controlServer.ts` for which requests come here.
   *
   * The question goes to the window, where it names both panes the way the
   * sidebar does; the answer comes back over `IPC.controlApprovalAnswer`.
   * Unanswered for two minutes reads as no — the request is a program waiting
   * on a person, and a person who did not answer did not agree.
   */
  function approveCrossPane(from: string, to: string, method: string): Promise<boolean> {
    if (trustedPanes.has(from)) return Promise.resolve(true)
    if (!win || win.isDestroyed()) return Promise.resolve(false)

    const panes = flattenPanes(buildTree(hub.doc, (id) => ptys.has(id)))
    const describe = (id: string) => {
      const pane = panes.find((p) => p.id === id)
      return pane ? pane.title || pane.cwd || 'an unnamed pane' : 'a pane that no longer exists'
    }
    const id = randomUUID()
    send(IPC.onControlApproval, { id, from: describe(from), to: describe(to), method })
    // The prompt is in the window, which may be behind something else. A
    // program is waiting on you; say so where you will see it.
    if (process.platform === 'darwin' && !win.isFocused()) app.dock?.bounce('informational')

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle('deny'), 120_000)
      const settle = (decision: CrossPaneDecision) => {
        clearTimeout(timer)
        approvals.delete(id)
        if (decision === 'always') trustedPanes.add(from)
        resolve(decision !== 'deny')
      }
      approvals.set(id, settle)
    })
  }

  /**
   * A window's save, merged into the document every window shares.
   *
   * `baseRev` is the revision the window built it on; without one — the
   * original single-window call — what it sent is taken whole, as it always
   * was. See `stateHub.ts`.
   */
  function adoptWindowSave(sender: Electron.WebContents, next: unknown, baseRev?: number): void {
    const from = windows.ofSender(sender)
    // The overview edits nothing. A save from it is a bug, and a bug that
    // could rewrite every workspace is not one to let through.
    if (!from || from.kind === 'overview') return
    const result = hub.save(next, baseRev, from.kind === 'main')
    if (!result) return
    publish({ ...result, from: from.id })
  }

  function registerIpc(): void {
    /**
     * Whether a message came from our own window's own page.
     *
     * Every handler below acts with the main process's full reach — spawning
     * shells, writing and deleting files, opening programs — and none of them
     * used to ask who was calling. The window is not the only web content this
     * app hosts: each browser pane is a guest showing whatever site it was
     * pointed at. A guest has no route to these today, but "no route today" is
     * a property of everything else staying right, and this makes it a rule:
     * the caller must be this window's top frame, and nothing else.
     */
    const trusted = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => {
      const from = windows.ofSender(e.sender)
      return !!from && e.senderFrame === from.win.webContents.mainFrame
    }

    function handle<A extends unknown[]>(
      channel: string,
      fn: (e: IpcMainInvokeEvent, ...args: A) => unknown
    ): void {
      ipcMain.handle(channel, (e, ...args) => {
        if (!trusted(e)) throw new Error(`refused ${channel}: not from the app window`)
        return fn(e, ...(args as A))
      })
    }

    function listen<A extends unknown[]>(channel: string, fn: (e: IpcMainEvent, ...args: A) => void): void {
      ipcMain.on(channel, (e, ...args) => {
        if (!trusted(e)) {
          e.returnValue = undefined
          return
        }
        fn(e, ...(args as A))
      })
    }

    handle(IPC.loadState, () => hub.doc)
    handle(IPC.saveState, (e, next: unknown) => {
      adoptWindowSave(e.sender, next)
      // The keep-awake setting arrives in here with everything else, and
      // turning it off is a request about *now* — the poll used to be what
      // eventually noticed, which meant a setting that took effect somewhere
      // in the next half-minute and, with the poll no longer always running,
      // one that might not take effect at all.
      powerLock?.evaluate()
    })
    // The same document, on the way out. `sendSync` holds the closing window
    // until this returns, which is the point: it is the one save that cannot
    // be overtaken by the process ending.
    listen(IPC.saveStateSync, (e, next: unknown) => {
      adoptWindowSave(e.sender, next)
      // Written now, not on the store's own debounce: this save is only ever
      // made on the way out, and "main has it in memory" is one more step
      // that has to go right before it is safe.
      store.flush()
      e.returnValue = true
    })

    // The same three, with revisions, for windows that keep up with each other.
    handle(IPC.stateLoad, () => hub.snapshot())
    handle(IPC.stateSave, (e, next: unknown, baseRev: number) => {
      adoptWindowSave(e.sender, next, baseRev)
      powerLock?.evaluate()
      // The break settings live in the document; a change applies now.
      moveBreaks?.tick()
    })
    listen(IPC.stateSaveSync, (e, next: unknown, baseRev: number) => {
      adoptWindowSave(e.sender, next, baseRev)
      store.flush()
      e.returnValue = true
    })

    handle(IPC.windowsList, () => windows.info())
    handle(IPC.windowsOpen, (_e, request: OpenWindowRequest) => openWindow(request))
    handle(IPC.windowsMoveTabs, (_e, tabIds: string[], to: string) => moveTabs(tabIds, to))
    handle(IPC.windowsDropAt, (e, tabIds: string[], at: WindowPlacement, workspaceId?: string) =>
      dropAt(tabIds, at, windows.ofSender(e.sender)?.id, workspaceId)
    )
    handle(IPC.windowsMoveWorkspace, (_e, workspaceId: string, to: string) => moveWorkspace(workspaceId, to))
    handle(IPC.windowsFocus, (_e, id: string, target?: WindowTarget) => focusWindow(id, target))
    handle(IPC.windowsSeen, (e, seen: { panes: string[]; workspaces: string[] }) => {
      windows.broadcast(IPC.onWindowsSeen, seen, windows.ofSender(e.sender)?.id)
    })
    handle(IPC.paneStatuses, () => ptys.statuses())

    handle(IPC.breaksState, () => moveBreaks?.state())
    handle(IPC.breaksChoose, (_e, posture: 'standing' | 'seated') => {
      if (posture === 'standing' || posture === 'seated') moveBreaks?.choose(posture)
    })
    handle(IPC.breaksFinish, (_e, outcome: string) =>
      outcome === 'done' || outcome === 'seated' || outcome === 'skipped' ? (moveBreaks?.finish(outcome) ?? false) : false
    )
    handle(IPC.breaksSnooze, () => moveBreaks?.snooze() ?? false)
    handle(IPC.breaksNow, () => moveBreaks?.now())
    handle(IPC.breaksToday, () => moveBreaks?.today() ?? [])

    // Your answer to "may this pane act on that one". Ignored for an id that is
    // not waiting — a stale or forged answer has nothing to settle.
    handle(IPC.controlApprovalAnswer, (_e, id: string, decision: CrossPaneDecision) => {
      if (decision !== 'once' && decision !== 'always' && decision !== 'deny') return
      approvals.get(id)?.(decision)
    })

    handle(IPC.listShells, () => listShells(store.settings))
    handle(IPC.homeDir, () => app.getPath('home'))
    handle(IPC.appVersion, () => app.getVersion())
    handle(IPC.latestRelease, () => latestRelease())
    handle(IPC.gitBranch, (_e, cwd: string) => currentBranch(cwd))
    handle(IPC.readDir, (_e, dir: string, showHidden: boolean) =>
      readDirectory(dir, showHidden)
    )
    handle(
      IPC.listImages,
      (_e, dir: string, recursive: boolean, showHidden: boolean) =>
        listImages(dir, recursive, showHidden)
    )
    handle(IPC.listByExtension, (_e, dir: string, suffixes: string[]) =>
      listByExtension(dir, suffixes)
    )
    handle(IPC.readText, (_e, target: string) => readText(target))
    handle(IPC.fileStamp, (_e, target: string) => fileStamp(target))
    handle(IPC.readBytes, (_e, target: string) => readBytes(target))
    handle(IPC.patchBytes, (_e, target: string, offset: number, base64: string) =>
      patchBytes(target, offset, base64)
    )
    handle(IPC.writeText, (_e, target: string, content: string) =>
      writeText(target, content)
    )
    handle(IPC.readJuceXml, (_e, target: string) => readJuceXml(target))
    handle(IPC.writeJuceXml, (_e, target: string, xml: string) => writeJuceXml(target, xml))
    handle(IPC.gitDiff, (_e, cwd: string, target: string, untracked: boolean) =>
      gitDiff(cwd, target, untracked)
    )
    handle(IPC.compareFiles, (_e, left: string, right: string) =>
      compareFiles(left, right)
    )
    handle(IPC.search, (_e, cwd: string, query: string, caseSensitive: boolean) =>
      searchWorkspace(cwd, query, caseSensitive)
    )
    handle(IPC.processes, () => listProcesses(ptys.panePids()))
    handle(IPC.commandHistory, () => history.recent(300))
    handle(IPC.forgetCommand, (_e, command: string, cwd?: string) =>
      history.remove(command, cwd)
    )
    handle(IPC.vaultList, () => vault.list())
    handle(IPC.vaultFolder, () => vault.folder)
    handle(IPC.sessionHost, () => ptys.hostSnapshot())
    // Every agent but Claude Code, which keeps its own handler above because it
    // also carries a bell setting and a prior-state record.
    handle(IPC.agentHooks, () => AGENTS.map((a) => readAgentHooks(a)))

    handle(IPC.worktreeList, (_e, cwd: string) => listWorktrees(cwd))
    handle(IPC.worktreeAt, (_e, cwd: string) => worktreeAt(cwd))
    handle(IPC.worktreeAdd, async (_e, cwd: string, branch: string, dir: string) => {
      // Every worktree command runs from the main checkout: `worktree add` from
      // inside another worktree works, but relative paths would then resolve
      // against the wrong root.
      const root = (await mainCheckoutRoot(cwd)) ?? cwd
      return addWorktree(root, { branch, dir })
    })
    handle(IPC.worktreeRemove, async (_e, cwd: string, dir: string, force: boolean) => {
      const root = (await mainCheckoutRoot(cwd)) ?? cwd
      return removeWorktree(root, dir, force)
    })
    handle(IPC.worktreeSuggest, async (_e, cwd: string, branch: string) => {
      const root = await mainCheckoutRoot(cwd)
      return root ? suggestWorktreeDir(root, branch) : null
    })
    // What git is doing, while it is doing it. Wired here rather than imported
    // by the module, because `git.ts` is also loaded by the CLI and by the
    // tests, where there is no window to send anything to.
    git.onGitProgress((p) => windows.broadcast(IPC.onGitProgress, p))

    // The git panes. Every one of these is a thin forward: the module owns the
    // decisions, including which of them are allowed to exist at all.
    handle(IPC.gitRepoStatus, (_e, cwd: string) => git.repoStatus(cwd))
    handle(IPC.gitHistory, (_e, cwd: string, limit?: number, filter?: HistoryFilter) =>
      git.history(cwd, limit, filter)
    )
    handle(IPC.gitBranches, (_e, cwd: string) => git.branches(cwd))
    handle(
      IPC.gitFileDiff,
      (_e, cwd: string, repoPath: string, opts: { picked?: boolean; untracked?: boolean }) =>
        git.fileDiff(cwd, repoPath, opts ?? {})
    )
    handle(IPC.gitPickedDiff, (_e, cwd: string) => git.pickedDiff(cwd))
    handle(IPC.gitCommitDiff, (_e, cwd: string, sha: string, repoPath?: string) =>
      git.commitDiff(cwd, sha, repoPath)
    )
    handle(IPC.gitCommitFiles, (_e, cwd: string, sha: string) => git.commitFiles(cwd, sha))
    handle(IPC.gitPick, (_e, cwd: string, paths: string[]) => git.pick(cwd, paths ?? []))
    handle(IPC.gitUnpick, (_e, cwd: string, paths: string[]) => git.unpick(cwd, paths ?? []))
    handle(IPC.gitSave, (_e, cwd: string, message: string) => git.save(cwd, message))
    handle(IPC.gitSend, (_e, cwd: string) => git.send(cwd))
    handle(IPC.gitSendSize, (_e, cwd: string) => git.sendSize(cwd))
    handle(IPC.gitStop, (_e, cwd: string) => git.stopOperation(cwd))
    handle(IPC.gitPeek, (_e, cwd: string) => git.peek(cwd))
    handle(IPC.gitBringIn, (_e, cwd: string) => git.bringIn(cwd))
    handle(IPC.gitGoTo, (_e, cwd: string, branch: string) => git.goTo(cwd, branch))
    handle(IPC.gitStartBranch, (_e, cwd: string, name: string) => git.startBranch(cwd, name))
    handle(IPC.gitApplyLines, (_e, cwd: string, patch: string, direction: 'pick' | 'unpick') =>
      git.applyLines(cwd, patch, direction === 'unpick' ? 'unpick' : 'pick')
    )
    handle(IPC.gitUndoLastSave, (_e, cwd: string) => git.undoLastSave(cwd))
    handle(IPC.gitAmend, (_e, cwd: string, message: string) => git.amend(cwd, message ?? ''))
    handle(IPC.gitRevert, (_e, cwd: string, sha: string) => git.revertSave(cwd, sha))
    handle(IPC.gitTag, (_e, cwd: string, sha: string, name: string) => git.addTag(cwd, sha, name))
    handle(IPC.gitInit, (_e, cwd: string) => git.initRepo(cwd))
    handle(IPC.gitSetOrigin, (_e, cwd: string, url: string) => git.setOrigin(cwd, url))
    handle(IPC.gitReconnect, (_e, cwd: string, url: string) => git.reconnect(cwd, url))
    handle(IPC.gitGuessOrigin, (_e, cwd: string) => git.guessOrigin(cwd))
    handle(IPC.gitHostTools, (_e, cwd: string) => git.hostTools(cwd))
    handle(IPC.gitBackgroundFetch, (_e, cwd: string, minAgeMs: number) =>
      git.backgroundFetch(cwd, Math.max(30_000, Number(minAgeMs) || 0))
    )
    handle(
      IPC.gitCreateOnline,
      (_e, cwd: string, opts: { command: string; name: string; private: boolean; description?: string }) =>
        // The tool name is checked against the two this app knows rather than
        // passed through: everything else here forwards to git, and this one
        // forwards to an arbitrary program name from the renderer.
        opts && (opts.command === 'gh' || opts.command === 'glab')
          ? git.createOnline(cwd, opts)
          : Promise.resolve({ ok: false, error: 'unknown tool' })
    )
    // Project sizes and getting room back. Every path is re-checked in
    // `space.ts`; nothing here takes the renderer's word that a folder is safe
    // to delete.
    const spaceSizes = space.spaceCache(path.join(SHARED_DATA_DIR, 'space-cache.json'))
    handle(IPC.spaceMeasure, (_e, dir: string) => spaceSizes.measure(dir))
    handle(IPC.spaceCached, () => spaceSizes.all())
    handle(IPC.spaceCompressor, () => space.compressor())
    handle(IPC.spaceCompress, (_e, dir: string) => space.compress(dir))
    handle(IPC.spaceClean, (_e, dir: string, paths: string[]) => space.clean(dir, Array.isArray(paths) ? paths : []))
    handle(IPC.spacePark, (_e, dir: string, paths: string[]) => space.park(dir, Array.isArray(paths) ? paths : []))
    handle(IPC.spaceGitInfo, (_e, dir: string) => space.gitInfo(dir))
    handle(IPC.spaceGitCompact, (_e, dir: string) => space.gitCompact(dir))
    handle(IPC.spaceGitTrim, (_e, dir: string, keep: number, backupFile: string) =>
      space.gitTrim(dir, Number(keep), String(backupFile ?? ''))
    )
    handle(IPC.spaceDirSize, (_e, dir: string) => space.dirSize(dir))
    handle(IPC.spaceGitRemove, (_e, dir: string, backupFile: string) => space.gitRemove(dir, String(backupFile ?? '')))
    handle(IPC.setAgentHooks, (_e, id: string, enabled: boolean) => {
      const spec = agentById(id)
      if (!spec) return { ok: false, error: `unknown agent: ${id}`, path: '' }
      return setAgentHooks(spec, enabled, cliShimPath(SHARED_DATA_DIR, 'electron'))
    })
    handle(IPC.wslDistros, () => listWslDistros())
    handle(IPC.wslRunning, () => listRunningWslDistros())
    handle(IPC.wslControl, (_e, action: WslAction, distro?: string) =>
      controlWsl(action, distro)
    )
    handle(IPC.sshHosts, () => listSshHosts())
    handle(IPC.claudeUsage, (_e, retry?: boolean) => {
      if (retry) forgetKeychainRefusal()
      return readClaudeUsage()
    })
    // The offsets it remembers live beside the workspace document, so a restart
    // reads only what has been appended rather than all of the transcripts again.
    handle(IPC.claudeTokens, () => readTokenUsage(SHARED_DATA_DIR))
    // The same transcripts, read for what was said. Its own offsets, beside the
    // token counter's, so neither can hold the other's scan up.
    handle(IPC.claudeTurns, () => readTurnIndex(SHARED_DATA_DIR))
    // Publishes this machine's per-project totals into the user's shared folder
    // and hands back every machine's. Off — and instant — while no folder is set.
    handle(IPC.shareTokens, (_e, dir: string, entries: PublishEntry[]) =>
      shareTokens(SHARED_DATA_DIR, dir, entries)
    )
    // The same folder, a different question: what every machine is part-way
    // through. Reads and writes descriptions only — see `relay.ts`.
    handle(IPC.relay, (_e, dir: string, entries: RelayEntry[]) =>
      publishRelay(SHARED_DATA_DIR, dir, entries, sharePassphrase(SHARED_DATA_DIR))
    )
    handle(IPC.startFileDrag, (event, paths: string[]) => startFileDrag(event.sender, paths))
    handle(IPC.prepareFileDrag, (_e, file: string) => prepareFileDrag(file))
    handle(IPC.writeClipboardFiles, (_e, paths: string[], mode: 'copy' | 'cut', text: string) =>
      writeClipboardFiles(paths, mode === 'cut' ? 'cut' : 'copy', String(text ?? ''))
    )
    handle(IPC.readClipboardFiles, () => readClipboardFiles())
    // What a pane's own Up arrow walks, for the shells that bind it themselves.
    // A file is the whole interface to them — see `paneHistoryFile.ts`.
    handle(IPC.writePaneHistory, (_e, paneId: string, commands: string[]) =>
      writePaneHistory(SHARED_DATA_DIR, paneId, commands)
    )
    // Set from the settings panel and never read back to it: a panel that can
    // show a passphrase is a panel that can leak one over somebody's shoulder.
    handle(IPC.setSharePassphrase, (_e, passphrase: string) =>
      setSharePassphrase(SHARED_DATA_DIR, passphrase)
    )
    handle(IPC.hasSharePassphrase, () => hasSharePassphrase(SHARED_DATA_DIR))
    // What is on screen, once every fifteen seconds. An empty cwd is "nothing
    // is being worked on", which is the same call rather than a second one — a
    // caller that must remember to say "stopped" forgets on the path nobody
    // tested. See `timeLog.ts`.
    handle(IPC.timeBeat, (_e, cwd: string, name: string) => timeLog.beat(cwd, name))
    handle(IPC.timeSpans, () => timeLog.all())
    handle(IPC.systemStats, (_e, opts?: { drives?: boolean }) => readSystemStats(opts))
    handle(IPC.weather, (_e, req: WeatherRequest) => readWeather(req))
    handle(IPC.crypto, (_e, req: { coins: string; currency: string }) => readCrypto(req))
    handle(IPC.gitStatus, (_e, cwd: string) => gitStatus(cwd))
    handle(IPC.isDirectory, (_e, dir: string) => isDirectory(dir))
    handle(IPC.createFile, (_e, parent: string, name: string) =>
      createFile(parent, name)
    )
    handle(IPC.openWith, (_e, program: string, target: string) =>
      openWith(program, target)
    )
    handle(IPC.createDirectory, (_e, parent: string, name: string) =>
      createDirectory(parent, name)
    )
    handle(IPC.renameEntry, (_e, target: string, name: string) =>
      renameEntry(target, name)
    )
    /**
     * Delete goes through the platform's own trash, and only bypasses it when
     * asked to in so many words.
     *
     * `shell.trashItem` is the Recycle Bin on Windows, the Trash on macOS and
     * the freedesktop trash on Linux, which means the file is recoverable by
     * the file manager the user already knows rather than by anything we would
     * have to build and they would have to find.
     *
     * A failure here is reported, never quietly downgraded to `rm`. It fails on
     * exactly the paths where a silent permanent delete would be worst — a
     * network share, `\\wsl.localhost`, a Linux session with no trash directory
     * on that mount — and "it did not go where I could get it back from" is
     * something the user has to be told, not something to paper over.
     */
    handle(IPC.removeEntry, async (_e, target: string, permanent = false) => {
      if (permanent) return removeEntry(target)
      try {
        await shell.trashItem(target)
      } catch (err) {
        throw new Error(
          `could not move to the trash (${err instanceof Error ? err.message : String(err)}) — hold Shift while deleting to remove it permanently`
        )
      }
    })
    handle(IPC.copyEntry, (_e, source: string, destDir: string) =>
      copyEntry(source, destDir)
    )
    handle(IPC.moveEntry, (_e, source: string, destDir: string) =>
      moveEntry(source, destDir)
    )

    // Real transparency is decided when the window is built, so applying it at
    // all means starting again. Offered as a button rather than left as an
    // instruction: the setting is three clicks deep and the restart is not the
    // user's idea, it is ours.
    handle(IPC.appsSupported, () => externalApps.supported)
    handle(IPC.appsRunning, () => externalApps.list())
    handle(IPC.appsReason, () => externalApps.reason)
    handle(IPC.appsAttachable, () => externalApps.attachable())
    handle(
      IPC.appsAttach,
      (_e, app_: ExternalApp, workspaceId: string, hwnd: string, pid: number) =>
        externalApps.attach(app_.id, workspaceId, app_, hwnd, pid)
    )
    handle(IPC.appsShowAll, () => externalApps.showAll())
    handle(IPC.appsRelease, (_e, appId: string) => externalApps.release(appId))
    handle(IPC.appsLaunch, (_e, app_: ExternalApp, workspaceId: string, cwd: string) =>
      externalApps.launch(app_, workspaceId, cwd)
    )

    /**
     * Where the snapping panes are, converted from the renderer's coordinates
     * to the screen's.
     *
     * The renderer measures in CSS pixels inside the content area, which is the
     * only thing it can see. Two steps get from there to what `SetWindowPos`
     * wants: add the content area's own position on the desktop, then multiply
     * by the display's scale, because the helper is DPI-aware and therefore
     * talks in real pixels. Approximate across monitors of *different* scales —
     * the window is placed by the scale of the display our window is mostly on,
     * which is the display the pane is on in every case but a half-dragged one.
     */
    handle(IPC.appsSync, (_e, request: AppSyncRequest) => {
      if (!win || win.isDestroyed()) return externalApps.sync({ ...request, rects: {} })
      const content = win.getContentBounds()
      // One driver works in points rather than pixels — macOS applies the
      // display's backing scale itself, and multiplying here as well would put
      // a window at twice the offset on a Retina screen.
      const scale = externalApps.logicalPixels
        ? 1
        : screen.getDisplayMatching(content).scaleFactor || 1
      const rects: AppSyncRequest['rects'] = {}
      for (const [id, rect] of Object.entries(request.rects ?? {})) {
        rects[id] = {
          x: Math.round((content.x + rect.x) * scale),
          y: Math.round((content.y + rect.y) * scale),
          width: Math.round(rect.width * scale),
          height: Math.round(rect.height * scale),
        }
      }
      return externalApps.sync({ ...request, rects })
    })

    handle(IPC.relaunch, () => {
      app.relaunch()
      app.quit()
    })

    /**
     * The window's own background colour, for when the page stops painting one.
     *
     * That is the whole of it, and the emptiness is the point. This handler used
     * to also set a Windows backdrop material, and `setBackgroundMaterial` —
     * called with `'none'`, on a window that asked for no material at all — turns
     * a window built transparent permanently opaque, compositing the page over
     * white. A page at 50% then reads as flat grey, which is exactly the
     * washed-out window this feature was parked for.
     *
     * Measured rather than reasoned: two identical transparent frameless
     * windows, one `setBackgroundMaterial('none')` between them, and only the one
     * that made the call came up solid. `setBackgroundColor('#00000000')` on its
     * own was tested the same way and is harmless.
     *
     * There is nothing to put back. Acrylic, mica and vibrancy are all *frosted*
     * looks and this app does not offer one — see `glassGroup` in themeEditor.ts.
     * If that ever changes, a material has to go on a window that is not
     * transparent, decided at construction, and never on this one.
     */
    handle(IPC.setTranslucent, (e, translucent: boolean) => {
      const target = windows.ofSender(e.sender)?.win
      if (!target || target.isDestroyed()) return
      try {
        target.setBackgroundColor(translucent ? '#00000000' : '#141414')
      } catch {
        /* the window can go between the guard above and here */
      }
    })

    // Read once by the preload, before the renderer decides whether to draw its
    // own caption buttons.
    listen(IPC.usesNativeOverlay, (event) => {
      event.returnValue = !transparentWindow
    })

    // Sent on every theme change: the overlay keeps whatever colours it was
    // built with until it is told otherwise, so without this the strip stays at
    // the startup theme's palette while the rest of the UI moves on.
    handle(IPC.setOverlayColors, (e, color: string, symbolColor: string) => {
      const target = windows.ofSender(e.sender)?.win
      if (!target || target.isDestroyed() || transparentWindow) return
      try {
        target.setTitleBarOverlay({ color, symbolColor, height: CAPTION_H })
      } catch {
        /* no overlay on this window: the page is drawing the buttons instead */
      }
    })

    handle(IPC.pickFolder, async (e, defaultPath?: string) => {
      const parent = windows.ofSender(e.sender)?.win
      if (!parent) return null
      const res = await dialog.showOpenDialog(parent, {
        title: 'Choose a folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: defaultPath || app.getPath('home'),
      })
      return res.canceled ? null : res.filePaths[0]
    })

    handle(
      IPC.pickSaveFile,
      async (
        e,
        opts: { title: string; defaultName: string; filters?: Electron.FileFilter[] }
      ) => {
        const parent = windows.ofSender(e.sender)?.win
        if (!parent) return null
        const res = await dialog.showSaveDialog(parent, {
          title: opts.title,
          defaultPath: opts.defaultName,
          // The caller's own type where it named one. Workspace files are only
          // the default because this dialog started life saving those.
          filters: opts.filters ?? WORKSPACE_FILTERS,
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        })
        return res.canceled || !res.filePath ? null : res.filePath
      }
    )

    handle(
      IPC.pickOpenFile,
      async (e, opts: { title: string; anyFile?: boolean; filters?: Electron.FileFilter[] }) => {
        const parent = windows.ofSender(e.sender)?.win
        if (!parent) return null
        const res = await dialog.showOpenDialog(parent, {
          title: opts.title,
          filters: opts.filters ?? (opts.anyFile ? ANY_FILTERS : WORKSPACE_FILTERS),
          properties: ['openFile'],
        })
        return res.canceled ? null : res.filePaths[0]
      }
    )

    // The window asking is the window drawing the pane from now on — which is
    // how a pane moved to another window starts receiving its output there. A
    // pane whose shell is already running here is being taken over rather than
    // started: its screen is rebuilt and sent, and it is sized to its new home.
    handle(IPC.ptySpawn, (e, req: SpawnRequest) => {
      const from = windows.ofSender(e.sender)
      if (from) paneOwner.set(req.paneId, from.id)
      if (!ptys.has(req.paneId)) return ptys.spawn(req)
      void takeOver(req.paneId)
      ptys.resize(req.paneId, req.cols, req.rows)
      return { ok: true }
    })
    handle(IPC.ptyWrite, (_e, id: string, data: string) => ptys.write(id, data))
    handle(IPC.ptyResize, (_e, id: string, cols: number, rows: number) =>
      ptys.resize(id, cols, rows)
    )
    handle(IPC.ptyKill, (_e, id: string) => ptys.kill(id))
    handle(IPC.ptySleep, (_e, id: string) => ptys.sleep(id))
    handle(IPC.ptyIsBusy, (_e, id: string) => ptys.isBusy(id))

    handle(IPC.agentAnswer, (_e, paneId: string, choiceId?: string) =>
      ptys.answerAgent(paneId, choiceId)
    )
    handle(IPC.agentDismiss, (_e, paneId: string) => ptys.dismissAgent(paneId))
    handle(IPC.agentState, (_e, paneId?: string) => ptys.agentState(paneId))

    // The untitled buffers. `scratchBuffer.ts` validates the pane id and the
    // extension itself rather than trusting either — they arrive from a
    // renderer and are turned into a filename.
    handle(IPC.powerLock, () =>
      powerLock?.status() ?? { hold: false, reason: 'off', holding: [], supported: false }
    )

    handle(IPC.scratchRead, (_e, paneId: string, ext: string) =>
      readScratch(SHARED_DATA_DIR, paneId, ext)
    )
    handle(IPC.scratchWrite, (_e, paneId: string, ext: string, text: string) =>
      writeScratch(SHARED_DATA_DIR, paneId, ext, text)
    )
    handle(IPC.scratchDrop, (_e, paneId: string, ext: string) =>
      dropScratch(SHARED_DATA_DIR, paneId, ext)
    )

    // A screenshot on the clipboard becomes a file path typed into the pane,
    // which is what an agent can actually act on — the same gesture as dropping
    // an image into a chat, from any Windows capture tool.
    handle(IPC.clipboardImage, () => clipboardImage())

    // One image's bytes, so the image-notes editor can draw it onto a canvas it
    // is still allowed to export. See `Backend.readImageBytes` for why the
    // ordinary `iaw-media` route cannot be used for that one job.
    handle(IPC.readImageBytes, (_e, target: string) => {
      // The same guard the media protocol uses, and here for the same reason:
      // this is not what makes it safe — the renderer is ours — but a bug on
      // our side should surface as a picture that will not open rather than as
      // a handler that reads whatever it is pointed at.
      if (!CLIPBOARD_IMAGE_EXT.test(target)) return null
      try {
        // A cap, because this one *does* land in the renderer's heap — well
        // above any screenshot, and well below the size at which a mistake
        // becomes a problem. A picture past it simply cannot be marked up.
        if (statSync(target).size > MAX_MARKUP_BYTES) return null
        return readBytesSync(target)
      } catch {
        return null
      }
    })

    // A copy of a picture with numbered markers drawn into it, from the
    // image-notes editor. The renderer hands over bytes and the name of the file
    // they came from; where it lands is decided here, so the call cannot be
    // used to write anywhere else.
    handle(IPC.saveNotedImage, (_e, from: string, bytes: Uint8Array) => {
      const dir = path.join(os.tmpdir(), 'ia_workspaces')
      mkdirSync(dir, { recursive: true })
      // Named after the picture it marks, so the two sit together in a folder
      // listing and the agent is handed a name that says what it is. The
      // original's own name is used only for its stem — a path from the
      // renderer decides nothing about where this goes.
      const stem = path.basename(from).replace(/\.[^.]*$/, '').slice(0, 80) || 'image'
      const file = path.join(dir, `${stem}-notes-${stamp()}.png`)
      writeFileSync(file, Buffer.from(bytes))
      return file
    })

    handle(IPC.pasteImage, () => {
      // A file the clipboard points at is used where it lies. Copying it into
      // temp would hand the pane a second name for a picture that already has
      // one the user recognises, and leave a duplicate behind.
      const existing = clipboardImageFile()
      if (existing) return existing

      const image = clipboard.readImage()
      if (image.isEmpty()) return null
      try {
        const dir = path.join(os.tmpdir(), 'ia_workspaces')
        mkdirSync(dir, { recursive: true })
        // Named for when it was taken, in the local time the user reads off
        // their own clock — see `stamp` for why that matters and why seconds
        // are the right resolution.
        const file = path.join(dir, `screenshot-${stamp()}.png`)
        writeFileSync(file, image.toPNG())
        return file
      } catch {
        return null
      }
    })

    handle(IPC.getContextMenu, () => isContextMenuInstalled())
    handle(IPC.setContextMenu, (_e, enabled: boolean) =>
      setContextMenu(enabled, launchCommand(), `${process.execPath},0`)
    )

    handle(
      IPC.notify,
      (_e, opts: { title: string; body: string; paneId: string; workspaceId: string }) => {
        if (!Notification.isSupported()) return
        const notification = new Notification({
          title: opts.title,
          body: opts.body,
          silent: true, // the renderer plays our own chime
        })
        // To the window the pane is in, which is not necessarily the one
        // that raised the notification.
        notification.on('click', () => {
          const owner = windowOfPane(opts.paneId)
          if (!windows.reveal(owner)) return
          windows.sendTo(owner, IPC.onFocusTerminal, { workspaceId: opts.workspaceId, paneId: opts.paneId })
        })
        notification.show()
      }
    )

    handle(IPC.setBadge, (e, count: number) => {
      const target = windows.ofSender(e.sender)?.win
      if (!target || target.isDestroyed()) return
      // Windows has no dock badge; flashing the taskbar is the closest signal.
      target.flashFrame(count > 0 && !target.isFocused())
    })

    handle(IPC.openExternal, (_e, url: string) => {
      if (/^https?:/.test(url)) shell.openExternal(url)
    })
    handle(IPC.openInExplorer, (_e, target: string) => shell.openPath(target))
    // Distinct from openInExplorer, which *runs* the file with whatever is
    // associated. This opens the folder around it with the item highlighted,
    // which is what "show me where this is" means.
    handle(IPC.revealItem, (_e, target: string) => shell.showItemInFolder(target))

    handle(IPC.readClaudeConfig, () => readClaudeSettings())
    handle(IPC.setClaudeIntegration, (_e, enabled: boolean) =>
      setClaudeIntegration(
        enabled,
        SHARED_DATA_DIR,
        cliShimPath(SHARED_DATA_DIR, 'electron')
      )
    )

    // Each window's own caption buttons act on that window.
    const senderWindow = (e: IpcMainInvokeEvent) => windows.ofSender(e.sender)?.win
    handle(IPC.windowMinimize, (e) => senderWindow(e)?.minimize())
    handle(IPC.windowMaximizeToggle, (e) => {
      const target = senderWindow(e)
      if (!target) return
      if (target.isMaximized()) target.unmaximize()
      else target.maximize()
    })
    handle(IPC.windowClose, (e) => senderWindow(e)?.close())
  }

  /**
   * How Explorer should launch the app. In development the executable is
   * Electron itself, so the app directory has to travel with it.
   */
  function launchCommand(): string {
    return app.isPackaged
      ? `"${process.execPath}"`
      : `"${process.execPath}" "${app.getAppPath()}"`
  }

  // Explorer's "Open in ia_workspaces" on an already-running app arrives here
  // rather than as a fresh process.
  app.on('second-instance', (_event, argv) => {
    const folder = directoryFromArgv(argv.slice(1))
    if (!win) {
      pendingFolder = folder
      return
    }
    if (win.isMinimized()) win.restore()
    win.focus()
    if (folder) send(IPC.onOpenFolder, folder)
  })

  app.whenReady().then(() => {
    serveImages()
    serveDocuments()
    serveMedia()
    ensureStartMenuShortcut()
    const userData = SHARED_DATA_DIR
    store = new Store(userData)
    hub = new StateHub(store.state, MAIN_OWNED_FIELDS)
    // Another copy of the app rewrote the file. Its document is a revision
    // like any other: every window takes it, merging whatever it had not yet
    // saved on top.
    store.watchExternal((state) => windows.broadcast(IPC.onState, hub.replace(state)))
    prepareIntegrationScript(userData)

    // Kept separate from the Tauri shim so the two can't overwrite each
    // other's forwarding target in the shared data folder.
    // The CLI runs as plain Node out of its own bundle, not through the app
    // entry point — see writeCliShim. It has to be the *unpacked* copy: the
    // second process runs with ELECTRON_RUN_AS_NODE, where asar support is not
    // guaranteed, so a path inside app.asar may simply not resolve.
    const cliScript = path
      .join(__dirname, '../cli/cli.js')
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    const binDir = writeCliShim(userData, 'electron', process.execPath, cliScript)

    history = new CommandHistory(path.join(userData, 'command-history.json'))
    timeLog = new TimeLog(timeLogPath(userData))
    vault = new SessionVault(path.join(userData, 'vault'))
    events.mirrorTo(path.join(userData, 'events.jsonl'))
    events.emit('host', 'started', { data: { pid: process.pid, version: app.getVersion() } })

    scrollback = new ScrollbackStore(
      path.join(userData, 'scrollback-electron'),
      () => store.settings.restoreScrollback
    )
    pidMap = new PidMap(path.join(userData, 'pid-map'))
    // Entries from a previous run name processes that are gone; a recycled pid
    // would otherwise resolve a CLI call onto the wrong pane.
    pidMap.clear()

    control = startControlServer('electron', (req, ctx) => {
      switch (req.method) {
        case 'ping':
          return { ok: true }
        case 'notify':
          return ptys.notifyFromCli(req.paneId!, req.title ?? 'Terminal', req.body ?? '')
            ? { ok: true }
            : { ok: false, error: 'unknown pane' }
        case 'session':
          return ptys.recordAgentSession(
            req.paneId!,
            req.sessionId ?? '',
            req.transcriptPath,
            req.hookEvent
          )
            ? { ok: true }
            : { ok: false, error: 'unknown pane' }
        case 'report-agent':
          return ptys.reportAgent(req.paneId!, req)
            ? { ok: true }
            : { ok: false, error: 'unknown pane, stale seq, or unanswerable choices' }
        case 'ask':
          return ptys
            .askAgent({
              paneId: req.paneId!,
              question: req.question ?? '',
              choices: req.choices ?? [],
              timeoutMs: req.timeout ?? 120_000,
              onAbort: ctx.onAbort,
            })
            .then((res) =>
              res.ok ? { ok: true, data: res.result } : { ok: false, error: res.error }
            )
        case 'answer-agent': {
          const res = ptys.answerAgent(req.paneId!, req.choice)
          return res.ok ? { ok: true, data: { label: res.label } } : { ok: false, error: res.error }
        }
        case 'agent-state':
          return { ok: true, data: ptys.agentState(req.paneId) }

        case 'tree':
          return { ok: true, data: buildTree(hub.doc, (id) => ptys.has(id)) }
        case 'list-panes': {
          const panes = flattenPanes(buildTree(hub.doc, (id) => ptys.has(id)))
          // With a pane named, this answers "tell me about that one" — which is
          // how a script inside a pane finds out where it is.
          return {
            ok: true,
            data: req.paneId ? panes.filter((p) => p.id === req.paneId) : panes,
          }
        }
        // Opening something is the renderer's job — it owns the tabs, the
        // panes and the layout. So this is a push rather than a call: the
        // window is told what to show, and the answer is whether there was a
        // window to tell. Whether the file turns out to be readable is the
        // pane's business to report, in the pane, the way it does for a file
        // opened any other way.
        case 'open': {
          // The window the asking pane is in — `iaw open` from a terminal in a
          // second window opens beside that terminal — or the one in front.
          const target = req.paneId ? windows.get(windowOfPane(req.paneId)) : windows.focusedForContent()
          if (!target) return { ok: false, error: 'no window is open' }
          const kinds = Object.keys(OPENABLE_PANES)
          if (req.openPane && !kinds.includes(req.openPane)) {
            return { ok: false, error: `unknown pane kind — try one of: ${kinds.join(', ')}` }
          }
          windows.sendTo(target.id, IPC.onOpenView, {
            paneId: req.paneId ?? '',
            target: req.target ?? '',
            openPane: req.openPane ?? '',
            edit: Boolean(req.edit),
            url: Boolean(req.url),
          })
          return { ok: true }
        }
        case 'send':
          return ptys.sendText(req.paneId!, req.text ?? '')
            ? { ok: true }
            : { ok: false, error: 'unknown pane' }
        case 'send-key':
          return ptys.sendKey(req.paneId!, req.key ?? '', {
            ctrl: req.ctrl,
            shift: req.shift,
            alt: req.alt,
          })
        case 'events': {
          const categories = parseCategories(req.categories)
          const cursor = typeof req.after === 'number' ? req.after : undefined
          // Follow is a long poll rather than a stream: this protocol is one
          // request and one reply, and `ask` already established that a handler
          // may answer later. A follower simply asks again with the cursor it
          // was handed, which also makes "three events arrived at once" behave
          // exactly like "one did".
          if (req.follow && cursor !== undefined) {
            return events
              .wait(cursor, Math.min(req.follow, 120_000), ctx.onAbort)
              .then(() => ({
                ok: true,
                data: events.since(cursor, { boot: req.boot, categories, limit: req.lines }),
              }))
          }
          return {
            ok: true,
            data: events.since(cursor, { boot: req.boot, categories, limit: req.lines }),
          }
        }

        case 'read-screen': {
          const text = ptys.readScreen(req.paneId!, req.lines ?? 100)
          return text === null
            ? { ok: false, error: 'unknown pane' }
            : { ok: true, data: { text } }
        }
      }
    }, approveCrossPane)

    ptys = new PtyManager(
      {
        onData: (p) => {
          const held = holding.get(p.paneId)
          if (held) held.push(p.data)
          else routePane(p.paneId, IPC.onPtyData, p)
        },
        onExit: (p) => {
          routePane(p.paneId, IPC.onPtyExit, p)
          events.emit('pane', 'exit', {
            paneId: p.paneId,
            data: { exitCode: p.exitCode, signal: p.signal },
          })
        },
        onMeta: (p) => {
          routePane(p.paneId, IPC.onPtyMeta, p)
          // The shell integration already reports every submitted line so a
          // restored agent pane can be resumed; keeping more than the last one
          // is the whole of the history feature.
          // `record` keeps the line unless it is the resume line this app typed
          // (`synthetic` on `TerminalMeta`) — and either way notes that the pane
          // started something, so that command's exit code lands on it and not
          // on whatever ran before. See `history.ts`.
          if (p.lastCommand) history.record(p)
        },
        // What it exited with, stamped onto the entry `onMeta` just recorded.
        // This is the whole of what makes a command's past knowable: without it
        // the history is a list of things you typed, with no idea which worked.
        onOutcome: ({ paneId, exitCode, ms }) => history.finish(paneId, exitCode, ms),
        onAlert: (a) => {
          windows.broadcast(IPC.onAlert, a)
          events.emit('alert', a.trigger, {
            paneId: a.paneId,
            workspaceId: a.workspaceId,
            data: { title: a.title, body: a.body },
          })
        },
        onStatus: (s) => {
          windows.broadcast(IPC.onPaneStatus, s)
          // An agent starting or finishing is the event the wake lock exists
          // for, so it is answered here rather than left to the next poll. The
          // poll is the safety net for the case with no event at all — an agent
          // that dies without saying so — and this is the fast path for the
          // ordinary one. Cheap enough to call on every status: it filters a
          // short array and usually changes nothing.
          if (s.agent) powerLock?.evaluate()
          // Output is the wake lock's other clock — a turn can go twenty
          // minutes between hooks and still be visibly alive — so a pane
          // finding its voice again is the event that can end a release. The
          // poll would notice too, half a minute later, which is half a minute
          // of a machine that might have gone down in the meantime.
          if (s.activity === 'active') powerLock?.evaluate()
          // Two different facts arrive on one channel. Split them, because a
          // reader watching for "an agent needs me" should not have to wade
          // through a throughput detector's opinion of every pane.
          if (s.activity) {
            events.emit('activity', s.activity, { paneId: s.paneId })
          }
          if (s.agent) {
            events.emit('agent', s.agent.state, {
              paneId: s.paneId,
              data: {
                blockedReason: s.agent.blockedReason,
                choices: s.agent.choices?.map((c) => ({ id: c.id, label: c.label })),
                answeredAt: s.agent.answeredAt,
              },
            })
          }
        },
      },
      () => store.settings,
      {
        notifyPipe: () => control!.address,
        historyDir: () => historyDir(SHARED_DATA_DIR),
        tokenFor: (paneId) => control!.tokenFor(paneId),
        binDir,
        scrollback,
        pidMap,
        vault,
        execPath: process.execPath,
        // Same unpacking dance as the CLI above, and for the same reason: the
        // broker runs with ELECTRON_RUN_AS_NODE, where asar support is not
        // guaranteed, so a path inside app.asar may simply not resolve.
        hostScript: path
          .join(__dirname, '../host/host.js')
          .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
      }
    )

    // After `ptys`, because it reads that registry, and before the window,
    // because a workspace restored with an agent already running should be
    // holding the machine up from the first evaluation rather than from the
    // first report after it.
    //
    // Both settings are read through getters rather than captured, so changing
    // the mode takes effect on the next evaluation — at most `POLL_MS` away,
    // and immediately if anything else prompts one. A setting about sleep that
    // needed a restart to apply would be a poor joke.
    powerLock = new PowerLock(
      () => ptys.agentState(),
      () => store.settings.keepAwake
    )

    // Every window covers itself when a break is up; the notification is for
    // when none of them is in front of you, which is most of the time.
    moveBreaks = new MoveBreaks(
      SHARED_DATA_DIR,
      () => readBreakSettings(store.settings),
      (state) => windows.broadcast(IPC.onBreaks, state),
      () => {
        if (Notification.isSupported()) {
          new Notification({ title: 'Time to get up', body: 'A few minutes of moving — ia_workspaces has an exercise for you.' }).show()
        }
        for (const entry of windows.all()) if (!entry.win.isDestroyed() && !entry.win.isFocused()) entry.win.flashFrame(true)
      }
    )
    moveBreaks.start()

    // Unawaited on purpose. Nothing in the app is waiting on a file that has
    // been sitting there for a month, and a slow disk should not hold up the
    // window.
    void sweepScratch(SHARED_DATA_DIR)

    registerIpc()
    createWindow()
    restoreWindows()
    scheduleOrphanSweep()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  /**
   * Clears out what nothing can reach any more: broker sessions and the
   * scrollback files behind panes the workspace document no longer mentions.
   *
   * Delayed rather than immediate, because "no pane references this" is only
   * true once the restored panes have actually been restored — the renderer
   * spawns them as it loads, and sweeping first would look at a broker full of
   * sessions whose panes are still on their way. The delay is belt to the
   * grace period's braces: `reapOrphans` also refuses to touch anything with a
   * client attached or anything younger than a few minutes.
   *
   * Both halves take the same set. `prune` has existed since scrollback did and
   * had no caller, so its files have been accumulating on every install.
   */
  function scheduleOrphanSweep(): void {
    setTimeout(() => {
      let live: Set<string>
      try {
        live = new Set(flattenPanes(buildTree(hub.doc, () => false)).map((p) => p.id))
      } catch {
        // A document we cannot read is not evidence that anything is an orphan.
        // Sweeping on a guess would kill live shells.
        return
      }
      // An empty document is the one shape that cannot be trusted here: a store
      // that failed to load looks identical to a fresh install, and acting on it
      // would reap every session the user has.
      if (live.size === 0) return

      scrollback.prune(live)
      void ptys
        .reapOrphans(live)
        .then((n) => {
          if (n > 0) console.log(`[pty] ended ${n} session(s) no pane refers to any more`)
        })
        .catch((err) => console.error('[pty] orphan sweep failed', err))
    }, ORPHAN_SWEEP_DELAY_MS)
  }

  /**
   * A line in `shutdown.log`, next to the workspace file.
   *
   * The leak is intermittent and leaves nothing behind to look at — by the time
   * you notice the processes in Task Manager, whatever happened is long past.
   * This is the record: which quit path fired, whether the cleanup finished, and
   * whether we ever reached the last line. If the tree is still there afterwards
   * the log says how far it got, which is the one thing guessing cannot supply.
   */
  function noteShutdown(line: string): void {
    try {
      appendFileSync(
        path.join(SHARED_DATA_DIR, 'shutdown.log'),
        `${new Date().toISOString()} pid=${process.pid} ${line}\n`
      )
    } catch {
      // Diagnostics must never be the reason a quit fails.
    }
  }

  /**
   * Everything that has to reach disk before the process goes away.
   *
   * Idempotent, because both quit paths call it and either may get there first.
   * Order matters: the panes' screens are dumped while their buffers still
   * exist, and `release` drops them.
   *
   * `release` rather than the kill this used to be. The shells outlive us now —
   * hanging up on the broker is the whole of the work, and the scrollback dump
   * above stops being the only thing that survives and becomes a fallback for
   * the one case that still ends them: a machine restart.
   */
  let shutdownRan = false
  function shutdown(): void {
    if (shutdownRan) return
    shutdownRan = true
    try {
      // First, and deliberately so. Everything below it can throw, and the one
      // piece of state that must not survive this process is a power blocker:
      // it outlives nothing else we hold, but while it is registered the
      // machine will not sleep, and there is no longer an app to release it.
      powerLock?.dispose()
      moveBreaks?.dispose()
      scrollback?.shutdownSync()
      scrollback?.dispose()
      ptys?.release()
      // The entries name this app's control pipe, which is about to stop
      // answering. A surviving session re-registers when a pane reattaches.
      pidMap?.clear()
      control?.close()
      history?.dispose()
      // The session that is ending is the one most worth recording, and the
      // process is about to be killed outright — nothing runs after this.
      timeLog?.close()
      timeLog?.flush()
      store?.dispose()
      store?.flush()
      noteShutdown('cleanup ok')
    } catch (err) {
      noteShutdown(`cleanup threw: ${String(err)}`)
    }
  }

  /**
   * Ends the process, and does not negotiate about it.
   *
   * `app.quit()` was not enough: the packaged build kept its whole tree alive
   * after the last window closed, and so was `app.exit(0)` — a run with that in
   * place was still found holding main, the GPU and the network service with no
   * window. Both of those ask Chromium to unwind, and something in the packaged
   * app intermittently refuses to. A timer-based fallback cannot help either,
   * since a process wedged inside its own exit path never runs another tick.
   *
   * `SIGKILL` to self maps to TerminateProcess on Windows, which no stuck
   * native thread can block, and Chromium's job object takes the child
   * processes down with it. `shutdown()` has already flushed both stores
   * synchronously by this point, so there is nothing left to lose by not
   * unwinding politely.
   */
  function hardExit(reason: string): void {
    noteShutdown(`terminating after ${reason}`)
    try {
      process.kill(process.pid, 'SIGKILL')
    } catch {
      // Not fatal on some platform: fall back to asking nicely.
    }
    app.exit(0)
  }

  app.on('window-all-closed', () => {
    noteShutdown('window-all-closed')
    shutdown()
    hardExit('window-all-closed')
  })

  app.on('before-quit', (e) => {
    noteShutdown('before-quit')
    // A quit reaches here before any window has closed, so a change still
    // sitting in the renderer's save debounce has not been sent — and
    // `hardExit` leaves no later moment to send it. Ask for it, and go the
    // moment it arrives. Bounded, because a renderer that is hung or gone must
    // not be able to stop the app quitting: past the deadline it quits with
    // whatever main already has, which is how every quit used to behave.
    quitting = true
    const open = windows.all()
    if (open.length && !quitWhenFlushed) {
      e.preventDefault()
      let done = false
      quitWhenFlushed = () => {
        if (done) return
        done = true
        clearTimeout(deadline)
        shutdown()
        hardExit('before-quit')
      }
      const deadline = setTimeout(() => quitWhenFlushed?.(), 600)
      // Called by name rather than signalled: `executeJavaScript` settles only
      // after the call has run, and the save inside it is synchronous, so by
      // the time this resolves the document is either here or there was
      // nothing pending. See `flushNow` in the renderer's store.
      //
      // Every window, and only once all of them have answered: each holds its
      // own unsent edits, and quitting on the first answer would drop the rest.
      void Promise.allSettled(
        open.map((entry) => entry.win.webContents.executeJavaScript('window.__iawFlushState?.()'))
      ).then(() => quitWhenFlushed?.())
      return
    }
    shutdown()
    hardExit('before-quit')
  })
}
