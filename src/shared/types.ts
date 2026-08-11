/**
 * Types shared between the main process, preload bridge and renderer.
 *
 * Nothing in this file may import Electron or Node APIs — the renderer bundles
 * it too, and keeping it runtime-free is what lets the UI layer stay portable
 * to a different shell later without touching the components.
 */

import type { InterfaceTheme, TerminalTheme } from './themes'
import type { ImageFilter, ImageLayout, ImageSort, TreeSort } from './images'

/**
 * Every shell kind on every platform, in one union.
 *
 * Not split per platform, because a workspace file is portable — saved on
 * Windows, opened on a Mac — and a value the reader cannot even name is one it
 * would have to discard. `resolveShell` walks its fallback chain instead, so a
 * `powershell` pane opened on macOS becomes a zsh pane rather than a dead tab.
 */
export type ShellKind =
  | 'powershell'
  | 'pwsh'
  | 'cmd'
  | 'wsl'
  | 'ssh'
  | 'zsh'
  | 'bash'
  | 'fish'
  | 'sh'
  | 'custom'

export interface ShellProfile {
  kind: ShellKind
  /** Human label for the settings dropdown and tab tooltips. */
  label: string
  /** Absolute path to the executable, resolved at startup. */
  path: string
  args: string[]
  /** Whether this profile supports our OSC-based shell integration injection. */
  supportsIntegration: boolean
  available: boolean
}

export interface Workspace {
  id: string
  name: string
  /**
   * The workspace this one sits inside, or absent for a top-level one.
   *
   * A workspace contains workspaces — there is no separate "group" entity. A
   * folder you nest others under is still a workspace: it has its own cwd, its
   * own tabs and its own terminals, and nesting is just where it sits in the
   * list. One concept instead of two, and nothing to convert when a workspace
   * turns out to be the natural home for a couple of others.
   */
  parentId?: string | null
  /** Folded shut. Children keep running; the sidebar stops listing them. */
  collapsed?: boolean
  /**
   * The workspace's folder: where new terminals start, what the changes and
   * search panes look at, which branch is shown, and where `NOTES.md` lives.
   *
   * Only "Change folder…" on the workspace moves it. Browsing the docked tree
   * does not — wandering into a subfolder to read one file is not a statement
   * about which project the workspace *is*, and having it silently re-root
   * everything else was the surprise.
   */
  cwd: string
  /**
   * Where the docked tree is currently browsing, when that is not the root.
   *
   * Kept so switching workspaces and restarting come back to the folder you
   * left open. Absent means "at the root", which is also what a tree gets when
   * the root moves under it.
   */
  treeCwd?: string
  /** Accent colour token, used for the sidebar dot and active tab bar. */
  color: string
  tabs: TerminalTabState[]
  activeTabId: string | null
  /** Git branch, refreshed in the background. Not user-editable. */
  branch?: string
  /**
   * Shell every new pane here starts with, overriding the global setting.
   *
   * Per workspace because that is the grain the choice actually has: a project
   * built in WSL wants WSL panes, and the one next to it does not.
   */
  shell?: ShellKind
  /**
   * Which WSL distribution, when `shell` is `wsl`.
   *
   * A WSL workspace still stores a *Windows* path in `cwd` — the
   * `\\wsl.localhost\<distro>\…` share — so the file tree, git status, search
   * and diff all keep working with no notion of WSL at all. Only the spawn
   * translates it back to a Linux path.
   */
  wslDistro?: string
  /**
   * Which host, when `shell` is `ssh` — an alias from `~/.ssh/config`, or
   * anything else `ssh` would accept.
   *
   * The opposite of `wslDistro` in the way that matters. A WSL workspace keeps a
   * real local path in `cwd` and everything local keeps working; an SSH
   * workspace's directory is on another machine, so `cwd` here means the folder
   * to land in *there* and nothing local can read it. `isRemotePane` is what the
   * file tree, diff and compare panes check before assuming otherwise.
   */
  sshHost?: string
  /**
   * The note file this workspace's Notes tab opens.
   *
   * Defaults to `NOTES.md` in the workspace folder — per project, which is the
   * point: the note lives with the code it is about, so it is in the repo, in
   * your backups and open to whatever you already edit markdown with.
   */
  notesFile?: string
  /**
   * Whether this workspace shows the docked tree. Per workspace, not global —
   * a scratch workspace of shells rarely wants one, a project usually does.
   */
  treeVisible?: boolean
}

/** A pane holds either a shell or the file tree. */
/**
 * What a pane holds. Everything but `terminal` is an `AuxPane` — a pane with no
 * shell behind it, mounted through the one switch in `Terminals.ensureAux`.
 */
/**
 * The list is the source and the union is derived from it, rather than the
 * other way round. A persisted document has to be checked against these names
 * at runtime, and a hand-written second copy of the list is a copy that goes
 * out of date silently: a kind missing from the runtime check is not rejected,
 * it is read back as a terminal and then saved that way, so the tab is gone on
 * the next write. `Set<PaneKind>` is perfectly happy to be short, so the
 * compiler cannot catch it. Derived, it cannot happen.
 */
export const PANE_KINDS = [
  'terminal',
  'files',
  'reader',
  'search',
  'editor',
  'diff',
  'history',
  'ports',
  'browser',
  'compare',
  'images',
] as const

export type PaneKind = (typeof PANE_KINDS)[number]

/**
 * How the editor pane shows the file it has open.
 *
 * Chosen from the tab's right-click menu and remembered per pane, because which
 * one you want is a property of what you are doing with *this* file, not a
 * global preference. Absent — the ordinary case — means the extension decides,
 * so opening a `.json` gets you the JSON view without being asked.
 *
 * `markdown` formats the text as you type, with the syntax still visible and
 * still editable. `code` is the same idea with a language's grammar instead of
 * markdown's. `text` is no styling at all. `preview`, `csv` and `hex` are the
 * three that are not the file's own text: a rendered document, a grid, and
 * bytes.
 */
export type EditorMode = 'markdown' | 'code' | 'text' | 'preview' | 'json' | 'csv' | 'hex'

export const EDITOR_MODES: readonly EditorMode[] = [
  'markdown',
  'code',
  'text',
  'preview',
  'json',
  'csv',
  'hex',
]

export const EDITOR_MODE_LABELS: Record<EditorMode, string> = {
  markdown: 'Markdown (live)',
  code: 'Code',
  text: 'Plain text',
  preview: 'Rendered markdown',
  json: 'JSON',
  csv: 'Table (CSV/TSV)',
  hex: 'Hex',
}

/** Modes that show something other than the file's own text, so cannot edit it. */
export const READ_ONLY_MODES: readonly EditorMode[] = ['preview', 'hex']

/**
 * The name a pane kind is written under.
 *
 * Both builds share one workspace file, and a build that does not know a kind
 * rewrites it as a terminal — so renaming one in memory would have an older
 * build quietly demolish the tabs a newer one wrote. The editor pane was
 * `notes` for its whole life until it learned to open more than one file; on
 * disk it still is, and `readPaneKind` translates on the way back in.
 */
export function wireKind(kind: PaneKind | undefined): string {
  return kind === 'editor' ? 'notes' : (kind ?? 'terminal')
}

/**
 * The inverse of `wireKind`: a name from disk back into a `PaneKind`, or null
 * for one this build does not know.
 *
 * The only place either direction is implemented. There were three copies of
 * this list before — the state loader, the workspace-file importer, and the
 * union itself — and two of them had drifted: the workspace-file importer was
 * missing `compare` and `images`, so saving a workspace and loading it turned
 * those tabs into terminals, and it took `notes` at face value rather than
 * translating it, so a saved editor pane came back as a file tree.
 *
 * Nothing about that is catchable by the compiler, which is why it is one
 * function over one list rather than a convention to keep them in step.
 */
export function readWireKind(raw: unknown): PaneKind | null {
  if (raw === 'notes') return 'editor'
  return typeof raw === 'string' && (PANE_KINDS as readonly string[]).includes(raw)
    ? (raw as PaneKind)
    : null
}

/**
 * Whether a pane has a shell behind it.
 *
 * `kind` is optional for historical reasons — a pane written before there were
 * kinds is a terminal — so "is a terminal" is not `kind === 'terminal'`, and
 * with more than two kinds it is no longer `kind !== 'files'` either. Every
 * caller that means "somewhere I can write bytes" goes through here.
 */
export function isTerminalPane(pane: { kind?: PaneKind }): boolean {
  return !pane.kind || pane.kind === 'terminal'
}

/**
 * One pane. Splitting a tab adds panes; it never adds tabs.
 */
export interface PaneState {
  id: string
  /** Defaults to 'terminal' when absent, so older documents still load. */
  kind?: PaneKind
  /** Name set by the user on the pane header. Wins over the shell's title. */
  customTitle?: string | null
  /**
   * Folder this pane was last known to be in. For a shell it is tracked live
   * via shell integration; for the file tree it is the folder being browsed.
   * Persisted either way so a restored pane reopens in the right place.
   */
  cwd: string
  /** Title reported by the shell through OSC 0/2. */
  autoTitle: string
  /**
   * The shell this pane runs, when it was chosen for this pane specifically.
   *
   * Absent is the ordinary case and means "whatever my workspace runs" — so a
   * workspace switched to WSL takes its inheriting tabs with it, while a tab you
   * deliberately made a PowerShell tab stays one. Independence in both
   * directions, and it is absence that carries it: a value here is a decision,
   * and there is no way to record a decision that was never made.
   */
  shell?: ShellKind
  /**
   * The agent conversation this pane was last running, so closing the app and
   * reopening it comes back to the same one rather than a blank prompt.
   */
  agentSession?: AgentSession
  /**
   * The last command line submitted in this pane, so a restored pane can offer
   * it back. Reported by shell integration, which is the only thing that knows
   * where the prompt ends and the user's typing begins.
   */
  lastCommand?: string
  /**
   * Which WSL distribution this pane runs, when its shell is `wsl`. Absent
   * means the workspace's, and absent there means WSL's own default.
   */
  wslDistro?: string
  /**
   * Which host this pane runs on, when its shell is `ssh`. Absent means the
   * workspace's.
   */
  sshHost?: string
  /** The file a `reader` pane is showing. Absent for every other kind. */
  file?: string
  /** How an editor pane displays its file. Absent means "ask the extension". */
  editorMode?: EditorMode
  /** Whether long lines wrap. Absent means "prose wraps, code does not". */
  wordWrap?: boolean
  /** Whether the editor draws a line-number gutter. Absent means no. */
  lineNumbers?: boolean
  /**
   * Whether the editor draws a faint rule at the character limit. Absent means
   * no — it is a guide for files written to a column, not a fact about text.
   */
  columnGuide?: boolean
  /**
   * Whether this editor writes as you type. Absent means yes, except in hex,
   * where bytes are never written without being asked for.
   */
  autosave?: boolean
  /**
   * The page a `browser` pane is on, updated as you navigate so reopening it
   * comes back where you were rather than at the default. Absent for every
   * other kind, and on a host with no browser to open.
   */
  url?: string
  /**
   * The two files a `compare` pane is diffing, in that order: `compareLeft` is
   * the "before" side, so additions are what the right file has and the left
   * does not.
   *
   * Kept separate from `file` rather than reusing it for the left side. A
   * compare pane is not a file pane that happens to have a second path — it is
   * meaningless with only one — and a half-populated `file` would let a pane
   * restore into a state it cannot render.
   */
  compareLeft?: string
  compareRight?: string
  /**
   * How an `images` pane arranges and orders what it shows. Absent means "the
   * setting", so a pane you never touched follows the default as it changes and
   * one you did keeps what you set.
   */
  imageLayout?: ImageLayout
  imageSort?: ImageSort
  imageSortDesc?: boolean
  imageRecursive?: boolean
  imageFit?: boolean
  imageFilter?: ImageFilter
  /**
   * The seed behind the random order and the board's scatter.
   *
   * Persisted because a shuffle you liked is worth keeping, and because without
   * it every reopen — and every re-render — would deal a different hand. This is
   * the difference between "random" as an arrangement and "random" as a twitch.
   */
  imageSeed?: number
  /**
   * Where images have been dragged on the board, keyed by absolute path, in
   * fractions of the canvas rather than pixels so a resized pane keeps the
   * arrangement instead of pushing everything off the edge.
   *
   * Only what you moved yourself is recorded. Anything untouched is placed by
   * the packing each time, so a folder that gains a file does not need every
   * position rewritten — and a board you never dragged costs nothing in the
   * workspace file.
   */
  imageBoard?: Record<string, BoardPlacement>
}

/** One hand-placed image on the board, in fractions of the canvas. */
export interface BoardPlacement {
  x: number
  y: number
  /** Width as a fraction of canvas width; height follows the aspect ratio. */
  w: number
}

/**
 * A resumable agent conversation, as reported by the agent itself.
 *
 * The id is Claude Code's own session id, taken from the `SessionStart` hook —
 * not inferred from the folder. Two panes open on the same project are two
 * different conversations, and "the newest session in this folder" would
 * collapse them into one.
 */
export interface AgentSession {
  tool: 'claude'
  id: string
  /** When it was last reported, so a stale id can be aged out. */
  at: number
}

/**
 * How long a recorded session stays resumable. A conversation you last touched
 * a fortnight ago is not what you expect a pane to reopen into.
 */
export const AGENT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** One metered window of Claude Code usage. */
export interface UsageBucket {
  id: string
  label: string
  /** Percent of the limit consumed, one decimal. */
  percent: number
  /** ISO timestamp the window resets at, or null when it is not metered. */
  resetsAt: string | null
}

export interface UsageReport {
  /**
   * `ok` alone carries numbers. The rest are all "we do not know", kept
   * distinct so the panel can say *why* rather than showing a plausible zero.
   */
  status: 'ok' | 'signed-out' | 'expired' | 'unmetered' | 'error'
  buckets: UsageBucket[]
}

/** A process running under one of this app's panes. */
export interface ProcessInfo {
  pid: number
  parentPid: number
  name: string
  /** Full command line, capped. Empty when the OS would not hand it over. */
  commandLine: string
  /** TCP ports this process is listening on. */
  ports: number[]
  /** The pane whose shell it descends from. */
  paneId: string
  /** How deep below the pane's own shell, for indenting. */
  depth: number
}

/** One matching line from a workspace search. */
export interface SearchHit {
  /** Absolute path. */
  path: string
  line: number
  /** The matching line, trimmed and capped — this is drawn, not re-read. */
  text: string
}

/** One row in the file tree. */
export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  /** Epoch milliseconds. */
  modified: number
}

/**
 * Porcelain status letters keyed by absolute path: 'M' modified, 'A' added,
 * 'D' deleted, '?' untracked. Directories inherit the strongest status of
 * anything beneath them.
 */
export type GitStatusMap = Record<string, string>

/**
 * How panes are arranged inside a tab. A leaf is a single pane; a split holds
 * children laid out along one axis with fractional sizes that sum to 1.
 */
export type PaneNode =
  | { kind: 'leaf'; paneId: string }
  | { kind: 'split'; direction: 'row' | 'column'; sizes: number[]; children: PaneNode[] }

/** A horizontal tab within a workspace. */
export interface TerminalTabState {
  id: string
  /** Title set explicitly by the user via rename. Wins over the pane title. */
  customTitle: string | null
  panes: PaneState[]
  layout: PaneNode
  activePaneId: string
}

export type NotificationTrigger =
  | 'bell'
  | 'osc'
  | 'command-finished'
  | 'idle'
  | 'exit'
  | 'cli'
  | 'blocked'

export interface TerminalAlert {
  /** The pane that raised it — panes, not tabs, own shells. */
  paneId: string
  workspaceId: string
  trigger: NotificationTrigger
  title: string
  body: string
}

/** An alert once the renderer has recorded it for the notification panel. */
export interface NotificationRecord extends TerminalAlert {
  id: string
  at: number
  read: boolean
  /** Resolved at record time so the panel still reads well after a rename. */
  where: string
}

export interface NotificationSettings {
  enabled: boolean
  sound: boolean
  soundName: SoundName
  volume: number
  /** Only notify when the app window is unfocused or the pane isn't visible. */
  onlyWhenUnattended: boolean
  onBell: boolean
  onCommandFinished: boolean
  /** Commands shorter than this many seconds never notify on finish. */
  minCommandSeconds: number
  onIdle: boolean
  idleSeconds: number
  onExit: boolean
  /** Flash the taskbar button when a background pane needs attention. */
  flashTaskbar: boolean
}

export type SoundName = 'chime' | 'ping' | 'knock' | 'rise'

export interface Settings {
  shell: ShellKind
  customShellPath: string
  customShellArgs: string
  /** Inject OSC reporting into the shell for cwd tracking + command markers. */
  shellIntegration: boolean
  /**
   * The interface theme: app chrome, and the window properties that go with it
   * — transparency, backdrop, corner rounding, workspace markers.
   */
  themeId: string
  /**
   * The terminal theme, contributing its palette and nothing else: the five
   * core colours and the sixteen ANSI slots.
   *
   * Separate because these are the two things nobody publishes together. Every
   * shared colour scheme in the world — Ghostty, Windows Terminal, iTerm — is a
   * terminal palette with no opinion about a sidebar, which is why importing
   * one has to *invent* a chrome palette by mixing its background and
   * foreground. Splitting the selection means an imported scheme can be worn by
   * the terminal without dictating the app around it.
   *
   * Core and ANSI stay together on purpose: they are tuned against each other,
   * and a background from one scheme under an ANSI set from another is how text
   * ends up invisible.
   *
   * Absent means "same theme as the interface", which is what every existing
   * install has been doing.
   */
  terminalThemeId?: string
  /** Saved terminal palettes, including everything imported from Ghostty or WT. */
  customTerminalThemes?: TerminalTheme[]
  /** Saved interface themes: chrome, plus the window properties beside it. */
  customThemes: InterfaceTheme[]
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  scrollback: number
  /** Folder a workspace created from the + button starts in. Blank = home. */
  newWorkspaceDir: string
  /**
   * The page a new browser pane opens on.
   *
   * A setting rather than a constant because the answer is personal and it
   * changes: it is the dev server you usually run, or the docs you always have
   * open. Blank falls back to the built-in default.
   */
  browserHome: string
  /** Ctrl+C copies when there is a selection instead of sending SIGINT. */
  copyOnSelectionCtrlC: boolean
  confirmCloseRunning: boolean
  /** Show the current git branch beside each workspace. */
  showGitBranch: boolean
  /**
   * Show how many tabs each workspace holds, beside its name.
   *
   * Off by default: it is a number that changes constantly and answers a
   * question nobody asks, and the sidebar is calmer without it.
   */
  showTabCount: boolean
  /**
   * Extra columns beside each name in the file tree: how big a file is, and
   * when it last changed.
   *
   * Both off by default. The tree is a place to find a file and open a shell
   * next to it, not a file manager, and two columns of numbers is what turns a
   * narrow pane into something you have to read rather than glance at. They are
   * switched from the tree's own menu, where the folder you are looking at is.
   */
  treeShowSize: boolean
  treeShowModified: boolean
  /**
   * How the file tree orders each folder. Folders lead whatever this says.
   *
   * A setting rather than per-pane state: "newest first" is how you are working
   * that afternoon, not a property of one folder, and two trees side by side
   * sorted differently is a bug report waiting to happen.
   */
  treeSort: TreeSort
  treeSortDesc: boolean
  /**
   * What a new images pane starts as. Each pane then owns its own — you might
   * want one folder as a contact sheet and another as a board.
   */
  imageLayout: ImageLayout
  imageSort: ImageSort
  imageSortDesc: boolean
  /**
   * How images are resampled. `smooth` for photographs, `pixel` for pixel art,
   * where the blur a default filter adds is the thing being examined.
   */
  imageFilter: ImageFilter
  /** Include images in subfolders, not just the folder itself. */
  imageRecursive: boolean
  /**
   * Shrink the arrangement until all of it fits without scrolling.
   *
   * Off by default: with a hundred images "fits" means postage stamps, and the
   * useful default is a readable size you scroll through. It is the toggle you
   * reach for with a dozen references open at once, which is the PureRef case.
   */
  imageFit: boolean
  /**
   * Show Claude Code's 5-hour and 7-day limit usage in the status bar.
   *
   * Reads Anthropic's usage endpoint with the OAuth token Claude Code is
   * already signed in with, every few minutes. On by default because it is the
   * number you want before starting something long, and off is one switch away.
   */
  showUsageMonitor: boolean
  /**
   * Keep each pane's screen on disk so a restored pane comes back with what it
   * was showing. Only reached when the shell itself did not survive — see
   * `keepSessionsAlive`.
   */
  restoreScrollback: boolean
  /**
   * Whether shells outlive the app.
   *
   * On, the pseudo-terminals are owned by the session broker rather than by
   * this process, so quitting detaches and reopening reattaches to the same
   * live shells. Off, they run in-process and end with the window, which is
   * what this app did before the broker existed.
   *
   * Worth offering rather than assuming: a background process holding shells
   * open is exactly the kind of thing somebody may not want on a shared or
   * locked-down machine, and "my terminals keep running after I quit" is a
   * surprise if you did not ask for it.
   */
  keepSessionsAlive: boolean
  /**
   * What an editor does when the file under it changes on disk.
   *
   * `auto` re-reads a pane with nothing unsaved in it, which is what a file
   * changed by a build, a formatter or another program should look like: the
   * new text, without being asked about it. `ask` puts a bar up instead, for
   * anyone who would rather nothing moved under them.
   *
   * A pane *with* unsaved edits always asks, whatever this says. Both versions
   * matter then, and there is no answer the app can pick that is not a guess
   * about which one somebody wants to keep.
   */
  refreshChangedFiles: 'ask' | 'auto'
  /**
   * Re-enter the agent conversation a pane was in when it comes back, by
   * running `claude --resume <id>` at its first prompt. Needs the Claude Code
   * integration, which is what reports the session id in the first place.
   */
  resumeAgentSessions: boolean
  /**
   * Program that "Open in editor" hands a file to. Blank means whatever Windows
   * associates with the extension.
   *
   * The reader pane is read-only on purpose — editing means save semantics,
   * encodings, conflict handling and eventually a language server — so this is
   * how a file gets edited: by the editor you already use.
   */
  externalEditor: string
  /** "Open in ia_workspaces" on folder right-click. Writes to HKCU. */
  explorerContextMenu: boolean
  /** Which glyph marks a nested workspace. See `NestingMarker`. */
  nestingMarker: NestingMarker
  /**
   * Whether we may write outside our own data folder — currently `~/.claude`.
   * Asked once; `declined` is remembered so we stop asking, and switching back
   * to `declined` undoes whatever was installed.
   */
  agentIntegration: ConsentState
  /**
   * Look for a newer release once, shortly after the window opens.
   *
   * A check that runs on every launch is the only kind that catches an update
   * you were not already looking for, which is the point — but it is also a
   * network call the app makes without being asked, so it is a switch.
   */
  checkUpdatesAtStartup: boolean
  notifications: NotificationSettings
}

export type ConsentState = 'unset' | 'granted' | 'declined'

/**
 * The outcome of one update check.
 *
 * `unconfigured` is a state rather than an error on purpose: no release feed
 * has been chosen for this app yet, and "nowhere to look" is a different thing
 * from "looked and it failed". The UI says so plainly instead of showing a
 * failure the user cannot act on.
 */
export type UpdateCheck =
  | { state: 'current'; current: string }
  | { state: 'available'; current: string; latest: string; url?: string }
  | { state: 'unconfigured'; current: string }
  | { state: 'error'; current: string; error: string }

/**
 * The glyph marking a nested workspace in the sidebar.
 *
 * `hook` (⎿) is a bracket part rather than an arrow, so it reads as structure —
 * this row belongs to the one above — instead of as movement. `curve` (⤷) and
 * `corner` (↳) are the two arrows; the corner is in far more fonts, which
 * matters because ⤷ is missing from the sidebar's own font and has to borrow
 * one. `none` is for anyone who finds the indent enough.
 */
export type NestingMarker = 'hook' | 'curve' | 'corner' | 'none'

export const NESTING_GLYPHS: Record<NestingMarker, string> = {
  hook: '⎿',
  curve: '⤷',
  corner: '↳',
  none: '',
}

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

/** The full persisted document, written to userData/workspace.json. */
export interface PersistedState {
  version: number
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  sidebarWidth: number
  sidebarCollapsed: boolean
  /** Shared by every workspace that shows a docked tree. */
  treeWidth: number
  window: WindowState
  settings: Settings
}

/**
 * One shell the session broker is holding.
 *
 * Reported so that shells kept alive on the user's behalf are something they
 * can *see*. A background process quietly holding terminals open is a
 * reasonable thing to want and an unreasonable thing to have to take on trust —
 * and between a pane being removed and the orphan sweep noticing, this is the
 * only way to know a shell is still there.
 */
export interface HeldSession {
  /** The pane id it was started for. Still the handle used to end it. */
  id: string
  alive: boolean
  pid: number
  startedAt: number
  /** How many windows are currently showing it. */
  attached: number
}

export interface SessionHostInfo {
  /**
   * `broker` — shells outlive the app. `local` — they end with the window,
   * either by choice or because no broker could be started. `connecting` —
   * nothing has needed a shell yet, so the question has not been asked.
   */
  kind: 'broker' | 'local' | 'connecting'
  sessions: HeldSession[]
}

/** One archived pane transcript. See `src/main/vault.ts`. */
export interface VaultEntry {
  /** Absolute path to the text file, which the editor pane opens directly. */
  path: string
  label: string
  at: number
  bytes: number
}

/** One remembered command line. See `src/main/history.ts`. */
export interface HistoryEntry {
  command: string
  /** Where it was run, which is often the thing that identifies it. */
  cwd: string
  /** Epoch milliseconds of the most recent time it was submitted. */
  at: number
  /**
   * The pane it was last submitted in.
   *
   * The list is deliberately shared across panes, so this is not used to
   * partition it — it is what makes a "just this pane" filter possible without
   * a second store. Absent on entries written before it was recorded.
   */
  paneId?: string
}

/** One checkout of a repository. See `src/main/worktrees.ts`. */
export interface Worktree {
  /** Absolute path to the checkout. */
  path: string
  /** Branch name, or undefined for a detached HEAD. */
  branch?: string
  head?: string
  /** True for the repository's own main checkout, which cannot be removed. */
  main: boolean
  locked: boolean
  /** Git thinks the directory is gone. Still registered, still removable. */
  prunable: boolean
}

/**
 * One changed file, as the changes pane needs it.
 *
 * `picked` and `changed` are deliberately separate rather than one status
 * letter, because a file can be both at once: pick it, edit it again, and part
 * of it is going into the next save while part of it is not. Git's own
 * porcelain says this with two columns, and flattening them to one is how a
 * changes pane ends up quietly lying about what is about to be saved.
 */
export interface ChangedFile {
  /** Absolute path on disk. */
  path: string
  /** Path relative to the repository root, with forward slashes, as git says it. */
  repoPath: string
  /** What is picked (staged) for the next save: git's first porcelain letter. */
  picked: GitChange
  /** What is changed and *not* picked: git's second porcelain letter. */
  changed: GitChange
  /** Git has never been told about this file. */
  untracked: boolean
  /** Both sides changed the same lines, and git is waiting for an answer. */
  conflicted: boolean
  /** Where it came from, for a rename or a copy. */
  from?: string
}

/**
 * What happened to a file, in git's porcelain letters.
 *
 * Kept as git's own letters rather than translated here: this is data, the
 * translation is presentation, and a pane that receives "M" can decide whether
 * it has room for "changed" or only for one character.
 */
export type GitChange = '' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

/** Where a repository stands: everything the panes' headline says. */
export interface RepoStatus {
  /** Absolute path of the repository root, or '' when this folder is not in one. */
  root: string
  /** The line of saves (branch) you are on, or undefined when off to one side. */
  branch?: string
  /** True when sitting on one save rather than on a branch — a detached HEAD. */
  detached: boolean
  /** The short number (hash) of the save you are on. */
  head?: string
  /**
   * The same number in full.
   *
   * Kept beside the short one rather than replacing it, because the two are for
   * different things: the short one is what a person reads, and the full one is
   * what gets compared against `unsent` to answer "has this actually left this
   * machine" — a comparison that a seven-character prefix would get right until
   * the day a project grew two saves sharing one.
   */
  headFull?: string
  /** The branch on GitHub this one is paired with, like `origin/main`. */
  upstream?: string
  /** Saves you have that GitHub has not. */
  ahead: number
  /** Saves GitHub has that you have not. */
  behind: number
  /** Whether the repository has a copy elsewhere (a remote) at all. */
  hasRemote: boolean
  /** The URL of `origin`, shown so "GitHub" is never a guess. */
  remoteUrl?: string
  files: ChangedFile[]
  /**
   * The saves you have made that GitHub has not got, by full number (hash).
   *
   * The count alone would have done for the headline, but not for the picture:
   * this is what lets the history pane mark the exact rows that exist only on
   * this machine, which is the single most useful thing that pane can say and
   * the one people most often get wrong about git.
   */
  unsent: string[]
  /**
   * A rebase, merge or cherry-pick that stopped part-way and is waiting.
   *
   * The panes refuse to save or send while this is set, because a save made in
   * the middle of one of these means something different from an ordinary save
   * and the buttons would be lying about what they do.
   */
  inProgress?: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect'
  /**
   * The save you are standing on, named.
   *
   * Here so the two operations that act on it can say which one they mean —
   * "Add to 'fixed the parser'" rather than "Amend" — and undefined in a project
   * whose first save has not been made, which is the state the publish flow
   * exists for.
   */
  lastSave?: { sha: string; subject: string }
}

/**
 * Narrowing the list of saves down to the ones being looked for.
 *
 * Four separate fields rather than one search box, because they are four
 * genuinely different questions and git answers them with four different flags.
 * The one people reach for and never find is `content`: "when did this line of
 * code appear", which no amount of reading commit messages will answer.
 */
export interface HistoryFilter {
  /** Text in the save's message. */
  text?: string
  /** Who made it. */
  author?: string
  /** Only saves that touched this file, as a path inside the project. */
  path?: string
  /** Only saves where this text started or stopped appearing in the code. */
  content?: string
}

/**
 * A host's own command-line tool, and whether it can be used.
 *
 * Installed and signed in are separate because they need separate sentences:
 * one is "you could install this", the other is "run `gh auth login` once".
 */
export interface HostTool {
  /** The program name, which is also how the publish flow asks for it back. */
  command: string
  host: 'github' | 'gitlab'
  label: string
  installed: boolean
  signedIn: boolean
  /** What it said when it refused, for the times that is worth showing. */
  note?: string
}

/** One save (commit), as the history pane draws it. */
export interface Commit {
  sha: string
  short: string
  parents: string[]
  subject: string
  body: string
  author: string
  email: string
  /** Epoch milliseconds, so the renderer can say "2 hours ago" itself. */
  at: number
  /** Branch names, tags and HEAD pointing at this save. */
  refs: CommitRef[]
}

export interface CommitRef {
  name: string
  kind: 'head' | 'branch' | 'remote' | 'tag'
}

/** One line of saves (branch), local or on the copy elsewhere. */
export interface Branch {
  name: string
  /** True for the one you are on. */
  current: boolean
  /** True for a branch that lives on GitHub rather than here. */
  remote: boolean
  upstream?: string
  ahead: number
  behind: number
  /** The newest save on it, so the list can say when it was last touched. */
  head?: string
  at?: number
  subject?: string
  /** The folder a worktree has this branch checked out in, if one does. */
  checkedOutAt?: string
}

/**
 * What came back from an operation that changes something.
 *
 * `error` carries git's own message rather than one of ours — "contains
 * modified or untracked files, use --force to delete it" is precisely what the
 * user needs to read, and nothing we compose would beat it. `hint` is the
 * plain-English sentence the pane adds *beside* it, never instead of it.
 */
export interface GitResult {
  ok: boolean
  error?: string
  hint?: string
  /** Anything git said on the way, shown when it is worth reading. */
  output?: string
}

/** One agent whose hooks Settings can install, and whether they are in place. */
export interface AgentConfigInfo {
  id: string
  label: string
  /** Absolute path to the agent's own settings file, shown so it is not a mystery. */
  path: string
  exists: boolean
  hooksInstalled: boolean
  /** A step installing cannot do for the user, if this agent has one. */
  note?: string
}

export interface SpawnRequest {
  paneId: string
  workspaceId: string
  cwd: string
  shell: ShellKind
  cols: number
  rows: number
  /** Agent conversation to pick back up once the shell has drawn a prompt. */
  resumeSession?: AgentSession
  /** Which distribution, when `shell` is `wsl`. Blank means WSL's default. */
  wslDistro?: string
  /** Which host, when `shell` is `ssh`. Blank leaves the pane unspawned. */
  sshHost?: string
}

/**
 * Where a shell that is not on this machine connects to.
 *
 * Two shells need one, for different reasons, and passing them around as a
 * single value is what stops every function that carries one from growing a
 * second parameter and a second `if`. Both fields are optional and at most one
 * is ever set — `shellTargetFor` is what guarantees that.
 */
export interface ShellTarget {
  /** Which distribution, when the shell is `wsl`. */
  wslDistro?: string
  /** Which host, when the shell is `ssh`. */
  sshHost?: string
}

/**
 * Keeps only the field the chosen shell actually uses.
 *
 * The rule this enforces is that a target belongs to the shell that asked for
 * it. Switching a pane from WSL to zsh must forget the distribution, or
 * switching back later would silently reuse a distro you last chose months ago;
 * switching from WSL to SSH must not leave both fields set, or the persisted
 * document would say two contradictory things about one pane.
 */
export function shellTargetFor(
  shell: ShellKind | undefined,
  target: ShellTarget | undefined
): ShellTarget {
  if (shell === 'wsl') return target?.wslDistro ? { wslDistro: target.wslDistro } : {}
  if (shell === 'ssh') return target?.sshHost ? { sshHost: target.sshHost } : {}
  return {}
}

/**
 * Whether this pane's shell runs on a different machine.
 *
 * The question every local-filesystem feature has to ask before it uses a
 * pane's `cwd`. WSL deliberately answers false: its directories are real local
 * paths under `\\wsl.localhost\…`, which is the whole reason the file tree and
 * git status work inside a WSL workspace without knowing what WSL is. SSH
 * answers true, and there is nothing to be done about it — the folder is on
 * another machine and no local call can reach it.
 */
export function isRemoteShell(shell: ShellKind | undefined): boolean {
  return shell === 'ssh'
}

/** Payload pushed from main to renderer for every batch of PTY output. */
export interface PtyOutput {
  paneId: string
  data: string
}

export interface PtyExit {
  paneId: string
  exitCode: number
  signal?: number
}

/** Live cwd / title updates parsed out of the PTY stream in the main process. */
export interface TerminalMeta {
  paneId: string
  cwd?: string
  title?: string
  /** Reported by the agent's SessionStart hook; recorded against the pane. */
  agentSession?: AgentSession
  /** The command line just submitted, from shell integration's OSC 133;E. */
  lastCommand?: string
}

/**
 * Whether a pane is currently producing sustained output.
 *
 * Observed from throughput alone, so it is available for every pane including
 * the ones with no shell integration. It says a pane is busy; it deliberately
 * says nothing about *why* it stopped — that is what the declared agent state
 * below is for.
 */
export type PaneActivity = 'active' | 'idle'

/** State an agent declares about itself, never inferred. */
export type AgentRunState = 'blocked' | 'working' | 'idle' | 'unknown'

/**
 * One answer a blocked agent will accept.
 *
 * The agent supplies both the label a human reads and the exact bytes that
 * pick it, because we are a relay and not an interpreter: we do not know how to
 * answer a Claude Code permission prompt or somebody's custom menu, and
 * guessing would make us depend on their UI never changing.
 */
export interface AgentChoice {
  id: string
  label: string
  /** A key name from the closed vocabulary in `agentState.ts`. */
  key?: string
  /** Literal text, as an alternative to a key. */
  text?: string
  /** Picked when an answer names no choice. */
  isDefault?: boolean
}

export interface PaneAgentState {
  paneId: string
  state: AgentRunState
  /** True while the agent is parked on a human. */
  awaitingHuman: boolean
  /** Refcount, so a nested subagent finishing can't clear the outer run. */
  runDepth: number
  blockedReason: string | null
  choices: AgentChoice[]
  /** When an answer was last relayed in, or null. */
  answeredAt: number | null
  model?: string
  contextPct?: number
  tokens?: string
}

/** Pushed whenever a pane's observed activity or declared state changes. */
export interface PaneStatus {
  paneId: string
  activity?: PaneActivity
  agent?: PaneAgentState
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  sound: true,
  soundName: 'chime',
  volume: 0.5,
  onlyWhenUnattended: true,
  onBell: true,
  onCommandFinished: true,
  minCommandSeconds: 20,
  onIdle: false,
  idleSeconds: 30,
  onExit: false,
  flashTaskbar: true,
}

export const DEFAULT_SETTINGS: Settings = {
  shell: 'powershell',
  customShellPath: '',
  customShellArgs: '',
  shellIntegration: true,
  themeId: 'graphite',
  customThemes: [],
  customTerminalThemes: [],
  fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
  fontSize: 14,
  // Must be 1: any padding between rows breaks the box-drawing characters that
  // TUIs like Claude Code draw their frames with — `│` stops meeting the `│`
  // on the row below and the border comes out as dashes.
  lineHeight: 1,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 10000,
  // Blank means the home folder, which is the only sensible default on a
  // machine we know nothing about.
  newWorkspaceDir: '',
  browserHome: '',
  copyOnSelectionCtrlC: true,
  confirmCloseRunning: true,
  showGitBranch: true,
  showTabCount: false,
  treeShowSize: false,
  treeShowModified: false,
  treeSort: 'name',
  treeSortDesc: false,
  imageLayout: 'rows',
  imageSort: 'name',
  imageSortDesc: false,
  imageFilter: 'smooth',
  imageRecursive: false,
  imageFit: false,
  showUsageMonitor: true,
  restoreScrollback: true,
  keepSessionsAlive: true,
  refreshChangedFiles: 'auto',
  resumeAgentSessions: true,
  externalEditor: '',
  explorerContextMenu: false,
  nestingMarker: 'hook',
  agentIntegration: 'unset',
  checkUpdatesAtStartup: true,
  notifications: DEFAULT_NOTIFICATIONS,
}

/**
 * The colours a workspace can be marked with.
 *
 * Two rows of eight. The first row is the original set and stays first, so the
 * colour a workspace was assigned by position does not move when the palette
 * grows. The second is the same hues at a different weight plus the gaps the
 * first row left — pink, indigo, teal-green, brown — chosen to stay apart from
 * each other at 8px, which is the size the sidebar dot actually is.
 */
export const WORKSPACE_COLORS = [
  '#8f8f8f',
  '#7fb069',
  '#e8873a',
  '#b48ead',
  '#e0614f',
  '#54b0ac',
  '#d9a84e',
  '#6f9ec9',
  '#c9738f',
  '#4f9d5d',
  '#c25f2c',
  '#8b7fd4',
  '#a8443c',
  '#3d8f9e',
  '#a8862f',
  '#4a72a8',
] as const
