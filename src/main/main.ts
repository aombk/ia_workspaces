import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync as readBytesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import path from 'node:path'
import { listProcesses } from './processes'
import { forgetKeychainRefusal, readClaudeUsage } from './usage'
import { readTokenUsage } from './tokenUsage'
import { readTurnIndex } from './turns'
import { startFileDrag } from './fileDrag'
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
import {
  readDirectory,
  listByExtension,
  listImages,
  readText,
  fileStamp,
  readBytes,
  patchBytes,
  writeText,
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
import { AGENTS, agentById } from './agents'
import { isCliVerb, runCli } from './cli'
import { ScrollbackStore } from './scrollback'
import { EventLog, parseCategories } from './events'
import { CommandHistory } from './history'
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
import { DEFAULT_THEME_ID, findInterfaceTheme, type InterfaceTheme } from '../shared/themes'
import { OPENABLE_PANES } from '../shared/types'
import type {
  ClipboardImage,
  HistoryFilter,
  SpawnRequest,
  WeatherRequest,
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

  let win: BrowserWindow | null = null
  let store: Store
  let ptys: PtyManager
  let powerLock: PowerLock | undefined
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
  /** Set at window creation; see `wantsTransparentWindow`. */
  let transparentWindow = false
  /** Window transparency, parked — see `wantsTransparentWindow`. */
  const TRANSPARENCY_ENABLED: boolean = false
  /** A folder Explorer handed us at launch, held until the UI is ready for it. */
  let pendingFolder: string | null = directoryFromArgv(process.argv.slice(1))

  const send = (channel: string, payload: unknown): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  /**
   * Whether the window must be created genuinely transparent.
   *
   * `transparent` is a construction-time flag with no runtime setter, so the
   * decision has to be made from the persisted theme before the window exists.
   * The acrylic and mica backdrops do not need it — Windows composites those
   * behind an ordinary window — but "no blur" does: with no material and no
   * transparency there is simply nothing behind the page, and the window comes
   * up opaque. Switching between no-blur and a material therefore needs a
   * restart to take full effect.
   */
  function wantsTransparentWindow(): boolean {
    // Off while the feature is parked — see `TRANSPARENCY_ENABLED` in the
    // renderer's themes.ts, which is the other half of the same switch. A theme
    // still holding an old `opacity` must not build a transparent window the
    // page then paints solid: that is a window with an invisible frame and no
    // way back. Everything below is left ready for when it is picked up again.
    if (!TRANSPARENCY_ENABLED) return false

    const settings = (store.state as { settings?: Record<string, unknown> } | null)?.settings
    if (!settings) return false
    const themes = (settings.customThemes ?? []) as { id: string; opacity?: number; backdrop?: string }[]
    const theme = themes.find((t) => t.id === settings.themeId)
    // Every built-in theme is fully opaque, so an unmatched id means no.
    if (!theme) return false
    return (theme.opacity ?? 1) < 1 && (theme.backdrop ?? 'none') === 'none'
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

  function createWindow(): void {
    const persisted = (store.state ?? {}) as { window?: Record<string, number | boolean> }
    const bounds = persisted.window ?? {}
    transparentWindow = wantsTransparentWindow()

    win = new BrowserWindow({
      width: Number(bounds.width ?? 1360),
      height: Number(bounds.height ?? 860),
      x: bounds.x as number | undefined,
      y: bounds.y as number | undefined,
      minWidth: 720,
      minHeight: 480,
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
        sandbox: false,
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
      },
    })

    if (bounds.maximized) win.maximize()
    win.once('ready-to-show', () => {
      win?.show()
      if (pendingFolder) {
        send(IPC.onOpenFolder, pendingFolder)
        pendingFolder = null
      }
    })
    win.loadFile(path.join(__dirname, '../renderer/index.html'))

    win.on('focus', () => send(IPC.onWindowFocus, true))
    win.on('blur', () => send(IPC.onWindowFocus, false))

    const persistBounds = () => {
      if (!win || win.isDestroyed()) return
      const b = win.getNormalBounds()
      // `patch`, not a spread of `store.state`: that getter goes back to the
      // disk, and doing so in the middle of a read-modify-write is how a
      // workspace deleted a moment ago came back.
      store.patch({
        window: { width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() },
      })
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

    win.on('closed', () => {
      win = null

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
  }

  function registerIpc(): void {
    ipcMain.handle(IPC.loadState, () => store.state)
    ipcMain.handle(IPC.saveState, (_e, next: unknown) => store.save(next))

    ipcMain.handle(IPC.listShells, () => listShells(store.settings))
    ipcMain.handle(IPC.homeDir, () => app.getPath('home'))
    ipcMain.handle(IPC.appVersion, () => app.getVersion())
    ipcMain.handle(IPC.latestRelease, () => latestRelease())
    ipcMain.handle(IPC.gitBranch, (_e, cwd: string) => currentBranch(cwd))
    ipcMain.handle(IPC.readDir, (_e, dir: string, showHidden: boolean) =>
      readDirectory(dir, showHidden)
    )
    ipcMain.handle(
      IPC.listImages,
      (_e, dir: string, recursive: boolean, showHidden: boolean) =>
        listImages(dir, recursive, showHidden)
    )
    ipcMain.handle(IPC.listByExtension, (_e, dir: string, suffixes: string[]) =>
      listByExtension(dir, suffixes)
    )
    ipcMain.handle(IPC.readText, (_e, target: string) => readText(target))
    ipcMain.handle(IPC.fileStamp, (_e, target: string) => fileStamp(target))
    ipcMain.handle(IPC.readBytes, (_e, target: string) => readBytes(target))
    ipcMain.handle(IPC.patchBytes, (_e, target: string, offset: number, base64: string) =>
      patchBytes(target, offset, base64)
    )
    ipcMain.handle(IPC.writeText, (_e, target: string, content: string) =>
      writeText(target, content)
    )
    ipcMain.handle(IPC.gitDiff, (_e, cwd: string, target: string, untracked: boolean) =>
      gitDiff(cwd, target, untracked)
    )
    ipcMain.handle(IPC.compareFiles, (_e, left: string, right: string) =>
      compareFiles(left, right)
    )
    ipcMain.handle(IPC.search, (_e, cwd: string, query: string, caseSensitive: boolean) =>
      searchWorkspace(cwd, query, caseSensitive)
    )
    ipcMain.handle(IPC.processes, () => listProcesses(ptys.panePids()))
    ipcMain.handle(IPC.commandHistory, () => history.recent(300))
    ipcMain.handle(IPC.vaultList, () => vault.list())
    ipcMain.handle(IPC.vaultFolder, () => vault.folder)
    ipcMain.handle(IPC.sessionHost, () => ptys.hostSnapshot())
    // Every agent but Claude Code, which keeps its own handler above because it
    // also carries a bell setting and a prior-state record.
    ipcMain.handle(IPC.agentHooks, () => AGENTS.map((a) => readAgentHooks(a)))

    ipcMain.handle(IPC.worktreeList, (_e, cwd: string) => listWorktrees(cwd))
    ipcMain.handle(IPC.worktreeAt, (_e, cwd: string) => worktreeAt(cwd))
    ipcMain.handle(IPC.worktreeAdd, async (_e, cwd: string, branch: string, dir: string) => {
      // Every worktree command runs from the main checkout: `worktree add` from
      // inside another worktree works, but relative paths would then resolve
      // against the wrong root.
      const root = (await mainCheckoutRoot(cwd)) ?? cwd
      return addWorktree(root, { branch, dir })
    })
    ipcMain.handle(IPC.worktreeRemove, async (_e, cwd: string, dir: string, force: boolean) => {
      const root = (await mainCheckoutRoot(cwd)) ?? cwd
      return removeWorktree(root, dir, force)
    })
    ipcMain.handle(IPC.worktreeSuggest, async (_e, cwd: string, branch: string) => {
      const root = await mainCheckoutRoot(cwd)
      return root ? suggestWorktreeDir(root, branch) : null
    })
    // What git is doing, while it is doing it. Wired here rather than imported
    // by the module, because `git.ts` is also loaded by the CLI and by the
    // tests, where there is no window to send anything to.
    git.onGitProgress((p) => send(IPC.onGitProgress, p))

    // The git panes. Every one of these is a thin forward: the module owns the
    // decisions, including which of them are allowed to exist at all.
    ipcMain.handle(IPC.gitRepoStatus, (_e, cwd: string) => git.repoStatus(cwd))
    ipcMain.handle(IPC.gitHistory, (_e, cwd: string, limit?: number, filter?: HistoryFilter) =>
      git.history(cwd, limit, filter)
    )
    ipcMain.handle(IPC.gitBranches, (_e, cwd: string) => git.branches(cwd))
    ipcMain.handle(
      IPC.gitFileDiff,
      (_e, cwd: string, repoPath: string, opts: { picked?: boolean; untracked?: boolean }) =>
        git.fileDiff(cwd, repoPath, opts ?? {})
    )
    ipcMain.handle(IPC.gitPickedDiff, (_e, cwd: string) => git.pickedDiff(cwd))
    ipcMain.handle(IPC.gitCommitDiff, (_e, cwd: string, sha: string, repoPath?: string) =>
      git.commitDiff(cwd, sha, repoPath)
    )
    ipcMain.handle(IPC.gitCommitFiles, (_e, cwd: string, sha: string) => git.commitFiles(cwd, sha))
    ipcMain.handle(IPC.gitPick, (_e, cwd: string, paths: string[]) => git.pick(cwd, paths ?? []))
    ipcMain.handle(IPC.gitUnpick, (_e, cwd: string, paths: string[]) => git.unpick(cwd, paths ?? []))
    ipcMain.handle(IPC.gitSave, (_e, cwd: string, message: string) => git.save(cwd, message))
    ipcMain.handle(IPC.gitSend, (_e, cwd: string) => git.send(cwd))
    ipcMain.handle(IPC.gitPeek, (_e, cwd: string) => git.peek(cwd))
    ipcMain.handle(IPC.gitBringIn, (_e, cwd: string) => git.bringIn(cwd))
    ipcMain.handle(IPC.gitGoTo, (_e, cwd: string, branch: string) => git.goTo(cwd, branch))
    ipcMain.handle(IPC.gitStartBranch, (_e, cwd: string, name: string) => git.startBranch(cwd, name))
    ipcMain.handle(IPC.gitApplyLines, (_e, cwd: string, patch: string, direction: 'pick' | 'unpick') =>
      git.applyLines(cwd, patch, direction === 'unpick' ? 'unpick' : 'pick')
    )
    ipcMain.handle(IPC.gitUndoLastSave, (_e, cwd: string) => git.undoLastSave(cwd))
    ipcMain.handle(IPC.gitAmend, (_e, cwd: string, message: string) => git.amend(cwd, message ?? ''))
    ipcMain.handle(IPC.gitRevert, (_e, cwd: string, sha: string) => git.revertSave(cwd, sha))
    ipcMain.handle(IPC.gitTag, (_e, cwd: string, sha: string, name: string) => git.addTag(cwd, sha, name))
    ipcMain.handle(IPC.gitInit, (_e, cwd: string) => git.initRepo(cwd))
    ipcMain.handle(IPC.gitSetOrigin, (_e, cwd: string, url: string) => git.setOrigin(cwd, url))
    ipcMain.handle(IPC.gitHostTools, (_e, cwd: string) => git.hostTools(cwd))
    ipcMain.handle(
      IPC.gitCreateOnline,
      (_e, cwd: string, opts: { command: string; name: string; private: boolean; description?: string }) =>
        // The tool name is checked against the two this app knows rather than
        // passed through: everything else here forwards to git, and this one
        // forwards to an arbitrary program name from the renderer.
        opts && (opts.command === 'gh' || opts.command === 'glab')
          ? git.createOnline(cwd, opts)
          : Promise.resolve({ ok: false, error: 'unknown tool' })
    )
    ipcMain.handle(IPC.setAgentHooks, (_e, id: string, enabled: boolean) => {
      const spec = agentById(id)
      if (!spec) return { ok: false, error: `unknown agent: ${id}`, path: '' }
      return setAgentHooks(spec, enabled, cliShimPath(SHARED_DATA_DIR, 'electron'))
    })
    ipcMain.handle(IPC.wslDistros, () => listWslDistros())
    ipcMain.handle(IPC.wslRunning, () => listRunningWslDistros())
    ipcMain.handle(IPC.wslControl, (_e, action: WslAction, distro?: string) =>
      controlWsl(action, distro)
    )
    ipcMain.handle(IPC.sshHosts, () => listSshHosts())
    ipcMain.handle(IPC.claudeUsage, (_e, retry?: boolean) => {
      if (retry) forgetKeychainRefusal()
      return readClaudeUsage()
    })
    // The offsets it remembers live beside the workspace document, so a restart
    // reads only what has been appended rather than all of the transcripts again.
    ipcMain.handle(IPC.claudeTokens, () => readTokenUsage(SHARED_DATA_DIR))
    // The same transcripts, read for what was said. Its own offsets, beside the
    // token counter's, so neither can hold the other's scan up.
    ipcMain.handle(IPC.claudeTurns, () => readTurnIndex(SHARED_DATA_DIR))
    // Publishes this machine's per-project totals into the user's shared folder
    // and hands back every machine's. Off — and instant — while no folder is set.
    ipcMain.handle(IPC.shareTokens, (_e, dir: string, entries: PublishEntry[]) =>
      shareTokens(SHARED_DATA_DIR, dir, entries)
    )
    // The same folder, a different question: what every machine is part-way
    // through. Reads and writes descriptions only — see `relay.ts`.
    ipcMain.handle(IPC.relay, (_e, dir: string, entries: RelayEntry[]) =>
      publishRelay(SHARED_DATA_DIR, dir, entries, sharePassphrase(SHARED_DATA_DIR))
    )
    ipcMain.handle(IPC.startFileDrag, (event, paths: string[]) => startFileDrag(event.sender, paths))
    // What a pane's own Up arrow walks, for the shells that bind it themselves.
    // A file is the whole interface to them — see `paneHistoryFile.ts`.
    ipcMain.handle(IPC.writePaneHistory, (_e, paneId: string, commands: string[]) =>
      writePaneHistory(SHARED_DATA_DIR, paneId, commands)
    )
    // Set from the settings panel and never read back to it: a panel that can
    // show a passphrase is a panel that can leak one over somebody's shoulder.
    ipcMain.handle(IPC.setSharePassphrase, (_e, passphrase: string) =>
      setSharePassphrase(SHARED_DATA_DIR, passphrase)
    )
    ipcMain.handle(IPC.hasSharePassphrase, () => hasSharePassphrase(SHARED_DATA_DIR))
    // What is on screen, once every fifteen seconds. An empty cwd is "nothing
    // is being worked on", which is the same call rather than a second one — a
    // caller that must remember to say "stopped" forgets on the path nobody
    // tested. See `timeLog.ts`.
    ipcMain.handle(IPC.timeBeat, (_e, cwd: string, name: string) => timeLog.beat(cwd, name))
    ipcMain.handle(IPC.timeSpans, () => timeLog.all())
    ipcMain.handle(IPC.systemStats, (_e, opts?: { drives?: boolean }) => readSystemStats(opts))
    ipcMain.handle(IPC.weather, (_e, req: WeatherRequest) => readWeather(req))
    ipcMain.handle(IPC.crypto, (_e, req: { coins: string; currency: string }) => readCrypto(req))
    ipcMain.handle(IPC.gitStatus, (_e, cwd: string) => gitStatus(cwd))
    ipcMain.handle(IPC.isDirectory, (_e, dir: string) => isDirectory(dir))
    ipcMain.handle(IPC.createFile, (_e, parent: string, name: string) =>
      createFile(parent, name)
    )
    ipcMain.handle(IPC.openWith, (_e, program: string, target: string) =>
      openWith(program, target)
    )
    ipcMain.handle(IPC.createDirectory, (_e, parent: string, name: string) =>
      createDirectory(parent, name)
    )
    ipcMain.handle(IPC.renameEntry, (_e, target: string, name: string) =>
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
    ipcMain.handle(IPC.removeEntry, async (_e, target: string, permanent = false) => {
      if (permanent) return removeEntry(target)
      try {
        await shell.trashItem(target)
      } catch (err) {
        throw new Error(
          `could not move to the trash (${err instanceof Error ? err.message : String(err)}) — hold Shift while deleting to remove it permanently`
        )
      }
    })
    ipcMain.handle(IPC.copyEntry, (_e, source: string, destDir: string) =>
      copyEntry(source, destDir)
    )
    ipcMain.handle(IPC.moveEntry, (_e, source: string, destDir: string) =>
      moveEntry(source, destDir)
    )

    // Real transparency is decided when the window is built, so applying it at
    // all means starting again. Offered as a button rather than left as an
    // instruction: the setting is three clicks deep and the restart is not the
    // user's idea, it is ours.
    ipcMain.handle(IPC.relaunch, () => {
      app.relaunch()
      app.quit()
    })

    ipcMain.handle(IPC.setTranslucent, (_e, translucent: boolean, backdrop: string) => {
      if (!win || win.isDestroyed()) return
      // Windows composites one of a fixed set of backdrop materials behind the
      // window. There is no pixel radius to set — each material carries its own
      // blur. Electron exposes no lighter "blur", so that maps onto acrylic.
      //
      // A window created transparent already shows the desktop crisply; asking
      // for a material on top of that would put the blur back.
      const material =
        !translucent || transparentWindow || backdrop === 'none'
          ? 'none'
          : backdrop === 'mica'
            ? 'mica'
            : 'acrylic'
      try {
        // The window background must go fully transparent too, or an opaque
        // layer is painted over the backdrop and nothing shows through.
        win.setBackgroundColor(translucent ? '#00000000' : '#141414')
        win.setBackgroundMaterial(material)
      } catch {
        /* older Windows: stays opaque, which is a fine degradation */
      }
    })

    // Read once by the preload, before the renderer decides whether to draw its
    // own caption buttons.
    ipcMain.on(IPC.usesNativeOverlay, (event) => {
      event.returnValue = !transparentWindow
    })

    // Sent on every theme change: the overlay keeps whatever colours it was
    // built with until it is told otherwise, so without this the strip stays at
    // the startup theme's palette while the rest of the UI moves on.
    ipcMain.handle(IPC.setOverlayColors, (_e, color: string, symbolColor: string) => {
      if (!win || win.isDestroyed() || transparentWindow) return
      try {
        win.setTitleBarOverlay({ color, symbolColor, height: CAPTION_H })
      } catch {
        /* no overlay on this window: the page is drawing the buttons instead */
      }
    })

    ipcMain.handle(IPC.pickFolder, async (_e, defaultPath?: string) => {
      if (!win) return null
      const res = await dialog.showOpenDialog(win, {
        title: 'Choose a folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: defaultPath || app.getPath('home'),
      })
      return res.canceled ? null : res.filePaths[0]
    })

    ipcMain.handle(
      IPC.pickSaveFile,
      async (
        _e,
        opts: { title: string; defaultName: string; filters?: Electron.FileFilter[] }
      ) => {
        if (!win) return null
        const res = await dialog.showSaveDialog(win, {
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

    ipcMain.handle(
      IPC.pickOpenFile,
      async (_e, opts: { title: string; anyFile?: boolean; filters?: Electron.FileFilter[] }) => {
        if (!win) return null
        const res = await dialog.showOpenDialog(win, {
          title: opts.title,
          filters: opts.filters ?? (opts.anyFile ? ANY_FILTERS : WORKSPACE_FILTERS),
          properties: ['openFile'],
        })
        return res.canceled ? null : res.filePaths[0]
      }
    )

    ipcMain.handle(IPC.ptySpawn, (_e, req: SpawnRequest) => ptys.spawn(req))
    ipcMain.handle(IPC.ptyWrite, (_e, id: string, data: string) => ptys.write(id, data))
    ipcMain.handle(IPC.ptyResize, (_e, id: string, cols: number, rows: number) =>
      ptys.resize(id, cols, rows)
    )
    ipcMain.handle(IPC.ptyKill, (_e, id: string) => ptys.kill(id))
    ipcMain.handle(IPC.ptySleep, (_e, id: string) => ptys.sleep(id))
    ipcMain.handle(IPC.ptyIsBusy, (_e, id: string) => ptys.isBusy(id))

    ipcMain.handle(IPC.agentAnswer, (_e, paneId: string, choiceId?: string) =>
      ptys.answerAgent(paneId, choiceId)
    )
    ipcMain.handle(IPC.agentState, (_e, paneId?: string) => ptys.agentState(paneId))

    // The untitled buffers. `scratchBuffer.ts` validates the pane id and the
    // extension itself rather than trusting either — they arrive from a
    // renderer and are turned into a filename.
    ipcMain.handle(IPC.powerLock, () =>
      powerLock?.status() ?? { hold: false, reason: 'off', holding: [], supported: false }
    )

    ipcMain.handle(IPC.scratchRead, (_e, paneId: string, ext: string) =>
      readScratch(SHARED_DATA_DIR, paneId, ext)
    )
    ipcMain.handle(IPC.scratchWrite, (_e, paneId: string, ext: string, text: string) =>
      writeScratch(SHARED_DATA_DIR, paneId, ext, text)
    )
    ipcMain.handle(IPC.scratchDrop, (_e, paneId: string, ext: string) =>
      dropScratch(SHARED_DATA_DIR, paneId, ext)
    )

    // A screenshot on the clipboard becomes a file path typed into the pane,
    // which is what an agent can actually act on — the same gesture as dropping
    // an image into a chat, from any Windows capture tool.
    ipcMain.handle(IPC.clipboardImage, () => clipboardImage())

    // One image's bytes, so the image-notes editor can draw it onto a canvas it
    // is still allowed to export. See `Backend.readImageBytes` for why the
    // ordinary `iaw-media` route cannot be used for that one job.
    ipcMain.handle(IPC.readImageBytes, (_e, target: string) => {
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
    ipcMain.handle(IPC.saveNotedImage, (_e, from: string, bytes: Uint8Array) => {
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

    ipcMain.handle(IPC.pasteImage, () => {
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

    ipcMain.handle(IPC.getContextMenu, () => isContextMenuInstalled())
    ipcMain.handle(IPC.setContextMenu, (_e, enabled: boolean) =>
      setContextMenu(enabled, launchCommand(), `${process.execPath},0`)
    )

    ipcMain.handle(
      IPC.notify,
      (_e, opts: { title: string; body: string; paneId: string; workspaceId: string }) => {
        if (!Notification.isSupported()) return
        const notification = new Notification({
          title: opts.title,
          body: opts.body,
          silent: true, // the renderer plays our own chime
        })
        notification.on('click', () => {
          if (!win || win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          if (!win.isVisible()) win.show()
          win.focus()
          send(IPC.onFocusTerminal, { workspaceId: opts.workspaceId, paneId: opts.paneId })
        })
        notification.show()
      }
    )

    ipcMain.handle(IPC.setBadge, (_e, count: number) => {
      if (!win || win.isDestroyed()) return
      // Windows has no dock badge; flashing the taskbar is the closest signal.
      win.flashFrame(count > 0 && !win.isFocused())
    })

    ipcMain.handle(IPC.openExternal, (_e, url: string) => {
      if (/^https?:/.test(url)) shell.openExternal(url)
    })
    ipcMain.handle(IPC.openInExplorer, (_e, target: string) => shell.openPath(target))
    // Distinct from openInExplorer, which *runs* the file with whatever is
    // associated. This opens the folder around it with the item highlighted,
    // which is what "show me where this is" means.
    ipcMain.handle(IPC.revealItem, (_e, target: string) => shell.showItemInFolder(target))

    ipcMain.handle(IPC.readClaudeConfig, () => readClaudeSettings())
    ipcMain.handle(IPC.setClaudeIntegration, (_e, enabled: boolean) =>
      setClaudeIntegration(
        enabled,
        SHARED_DATA_DIR,
        cliShimPath(SHARED_DATA_DIR, 'electron')
      )
    )

    ipcMain.handle(IPC.windowMinimize, () => win?.minimize())
    ipcMain.handle(IPC.windowMaximizeToggle, () => {
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    })
    ipcMain.handle(IPC.windowClose, () => win?.close())
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
    store.watchExternal((state) => send(IPC.onExternalState, state))
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
          return { ok: true, data: buildTree(store.state, (id) => ptys.has(id)) }
        case 'list-panes': {
          const panes = flattenPanes(buildTree(store.state, (id) => ptys.has(id)))
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
          if (!win || win.isDestroyed()) return { ok: false, error: 'no window is open' }
          const kinds = Object.keys(OPENABLE_PANES)
          if (req.openPane && !kinds.includes(req.openPane)) {
            return { ok: false, error: `unknown pane kind — try one of: ${kinds.join(', ')}` }
          }
          send(IPC.onOpenView, {
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
    })

    ptys = new PtyManager(
      {
        onData: (p) => send(IPC.onPtyData, p),
        onExit: (p) => {
          send(IPC.onPtyExit, p)
          events.emit('pane', 'exit', {
            paneId: p.paneId,
            data: { exitCode: p.exitCode, signal: p.signal },
          })
        },
        onMeta: (p) => {
          send(IPC.onPtyMeta, p)
          // The shell integration already reports every submitted line so a
          // restored agent pane can be resumed; keeping more than the last one
          // is the whole of the history feature.
          if (p.lastCommand) history.add(p.lastCommand, p.cwd ?? '', p.paneId)
        },
        // What it exited with, stamped onto the entry `onMeta` just recorded.
        // This is the whole of what makes a command's past knowable: without it
        // the history is a list of things you typed, with no idea which worked.
        onOutcome: ({ paneId, exitCode, ms }) => history.finish(paneId, exitCode, ms),
        onAlert: (a) => {
          send(IPC.onAlert, a)
          events.emit('alert', a.trigger, {
            paneId: a.paneId,
            workspaceId: a.workspaceId,
            data: { title: a.title, body: a.body },
          })
        },
        onStatus: (s) => {
          send(IPC.onPaneStatus, s)
          // An agent starting or finishing is the event the wake lock exists
          // for, so it is answered here rather than left to the next poll. The
          // poll is the safety net for the case with no event at all — an agent
          // that dies without saying so — and this is the fast path for the
          // ordinary one. Cheap enough to call on every status: it filters a
          // short array and usually changes nothing.
          if (s.agent) powerLock?.evaluate()
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
        token: control.token,
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

    // Unawaited on purpose. Nothing in the app is waiting on a file that has
    // been sitting there for a month, and a slow disk should not hold up the
    // window.
    void sweepScratch(SHARED_DATA_DIR)

    registerIpc()
    createWindow()
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
        live = new Set(flattenPanes(buildTree(store.state, () => false)).map((p) => p.id))
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

  app.on('before-quit', () => {
    noteShutdown('before-quit')
    shutdown()
    hardExit('before-quit')
  })
}
