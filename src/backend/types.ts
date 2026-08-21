import type { BackdropMaterial } from '../shared/themes'
import type { PlatformKind } from '../shared/platform'
import type { SshHost } from '../shared/ssh'
import type { WslAction } from '../shared/wsl'
import type {
  FileEntry,
  GitStatusMap,
  PaneAgentState,
  PaneStatus,
  PtyExit,
  PtyOutput,
  ShellProfile,
  SpawnRequest,
  TerminalAlert,
  TerminalMeta,
  SearchHit,
  ProcessInfo,
  SystemStats,
  UsageReport,
  TokenReport,
  SharedTokens,
  TokenPublishEntry,
  SessionHostInfo,
  AgentConfigInfo,
  Worktree,
  HistoryEntry,
  VaultEntry,
  RepoStatus,
  Commit,
  Branch,
  ChangedFile,
  GitResult,
  GitProgress,
  HistoryFilter,
  HostTool,
  WeatherReading,
  WeatherRequest,
  LatestReleaseResult,
  Relay,
  RelayPublishEntry,
} from '../shared/types'

/**
 * What a host can do that another might not.
 *
 * Every runtime used to be able to do everything, and the seam was the better
 * for it — a feature either existed in both or did not exist. An embedded
 * browser was the first thing that genuinely could not be levelled, which is
 * why this exists at all: Electron has `<webview>`, a real DOM element that
 * inherits the split layout for free, and the two runtimes that could not
 * match it were both eventually dropped over it. Wails had no second webview;
 * Tauri had one the OS composited *over* the window, with no z-order, so it
 * hid whenever a menu or a toast was up.
 *
 * There is one runtime now, so nothing here currently varies. It stays because
 * the alternative is components reaching for Electron directly, and that is the
 * thing that would actually make a future runtime impossible rather than merely
 * a piece of work.
 */
export interface Capabilities {
  /**
   * How this host can show a web page in a pane, if at all.
   *
   * - `dom` — an element in our own document (Electron's `<webview>`). It is
   *   laid out, clipped, hidden and stacked by the same CSS as everything else,
   *   so a browser pane needs no special handling anywhere.
   * - `null` — no second webview exists here, and the pane kind is not offered.
   */
  browser: 'dom' | null

  /**
   * Which OS the host is running on.
   *
   * Here rather than sniffed from the user agent, because the renderer has no
   * business guessing and both hosts already know the answer for certain.
   * `shared/platform.ts` turns it into the actual decisions — which modifier is
   * the app's, how a shortcut is written, whether the opacity slider has
   * anything to do — so this stays a fact rather than a policy.
   */
  platform: PlatformKind
}

/**
 * Everything the UI needs from its host runtime.
 *
 * The renderer talks only to this interface, so the same components run on
 * any host. Adding a runtime means writing one file that satisfies
 * this contract — no component changes.
 *
 * Persisted state crosses this boundary as opaque JSON: the renderer owns the
 * schema and normalises on load, so a host process never needs to understand
 * (or accidentally truncate) the document.
 */
export interface Backend {
  readonly name: 'electron'
  readonly capabilities: Capabilities

  loadState(): Promise<unknown>
  saveState(state: unknown): Promise<void>
  /** Fires when another ia_workspaces instance writes the shared workspace file. */
  onExternalStateChange(cb: (state: unknown) => void): () => void

  listShells(): Promise<ShellProfile[]>
  pickFolder(defaultPath?: string): Promise<string | null>
  /**
   * Native Save As, for writing a workspace file. Returns the chosen path, or
   * null when the dialog was dismissed.
   *
   * The host owns the dialog rather than the renderer choosing a folder and
   * building a name, because only the host can offer the overwrite warning and
   * the file-type filter people expect from one.
   */
  pickSaveFile(opts: { title: string; defaultName: string }): Promise<string | null>
  /**
   * Native Open.
   *
   * `anyFile` picks the filter: without it the dialog offers workspace files,
   * which is what "Load workspaces…" wants and exactly what the editor does
   * not — an editor that will not show you a `.ts` is not an editor.
   */
  pickOpenFile(opts: { title: string; anyFile?: boolean }): Promise<string | null>
  /** Default folder for a workspace created without picking one. */
  homeDir(): Promise<string>
  /**
   * The running app's version, as shipped.
   *
   * Comes from the host rather than from a constant compiled into the renderer:
   * the build already carries it — Electron from package.json, another host from the
   * executable's own metadata — and a second copy would be the one that goes
   * stale.
   */
  appVersion(): Promise<string>
  /**
   * The newest published release on GitHub, or null before there is one.
   *
   * Asked of the host because the renderer's CSP allows no outbound request.
   * What to *do* about the answer — whether it is newer, whether it is worth a
   * toast — stays in `renderer/updates.ts`.
   */
  latestRelease(): Promise<LatestReleaseResult>
  /**
   * The path of a file dropped in from outside the app, or '' if this runtime
   * cannot say.
   *
   * A drag from our own file tree carries its path in the drag data and needs
   * none of this. A drag from Explorer carries a `File`, and getting a location
   * out of one is host-specific: Electron has `webUtils`, while another window
   * runs with `dragDropEnabled: false` so that dragging tabs and panes works,
   * which leaves the webview handling OS drops and it does not expose paths.
   * Callers must have a way through that does not depend on this.
   */
  pathForFile(file: File): string
  /** Current git branch for a folder, or undefined outside a repo. */
  gitBranch(cwd: string): Promise<string | undefined>
  /** Directory listing for the file tree, folders first. */
  readDir(dir: string, showHidden: boolean): Promise<FileEntry[]>
  /**
   * Every image at or beneath a folder, flat, for the images pane.
   *
   * Distinct from `readDir` because the recursive case is not the renderer's to
   * assemble: walking a deep tree a directory at a time is thousands of round
   * trips for a result that is mostly discarded. `truncated` reports that a
   * ceiling was hit, so the pane can say it is showing part of a folder rather
   * than implying it is all of one.
   */
  listImages(
    dir: string,
    recursive: boolean,
    showHidden: boolean
  ): Promise<{ files: FileEntry[]; truncated: boolean }>
  /**
   * A URL an `<img>` can load for a file on disk.
   *
   * Pure string building, and synchronous, because the alternative shapes the
   * whole pane: an async call per image would mean a gallery that renders in
   * two passes and re-flows as the URLs arrive. What scheme this produces is
   * the host's business — `imageProtocol.ts` explains why it is not `file:`.
   */
  imageUrl(path: string): string
  /** A file as UTF-8 text. Rejects folders, oversized files and binaries. */
  readText(path: string): Promise<string>
  /**
   * Modification time and size, for noticing that something else wrote to a
   * file an editor is holding open. Null if it is not there, or is a folder.
   *
   * Cheap on purpose: this is polled per open editor for as long as the app
   * runs, so it must not read the file to answer.
   */
  fileStamp(path: string): Promise<{ mtime: number; size: number } | null>
  /**
   * A file as raw bytes, for the hex view — the one pane whose whole job is the
   * things `readText` refuses.
   *
   * Base64 because it crosses an IPC boundary that is JSON on two of the three
   * hosts. Large files are cut short rather than refused: the first megabyte of
   * an executable is exactly what someone opening one in hex wants to see, and
   * `size` is reported so the view can say what it is not showing.
   */
  readBytes(path: string): Promise<{ base64: string; size: number; truncated: boolean }>
  /**
   * Overwrites bytes in place, at an offset, without touching the rest.
   *
   * A patch rather than a whole-file write, and that is the whole point: the
   * hex view only ever loads the front of a large file, so writing back what it
   * holds would truncate everything it never read. Nothing here can change a
   * file's length.
   */
  patchBytes(path: string, offset: number, base64: string): Promise<void>
  /** Unified diff against HEAD. Empty path means the whole working tree. */
  gitDiff(cwd: string, path: string, untracked: boolean): Promise<string>
  /**
   * Unified diff between two arbitrary files. Neither has to be tracked, or
   * inside a repository at all.
   */
  compareFiles(left: string, right: string): Promise<string>
  /** Literal-string search beneath a folder. Honours .gitignore in a repo. */
  search(cwd: string, query: string, caseSensitive: boolean): Promise<SearchHit[]>
  /** Everything running under this app's panes, with its listening ports. */
  processes(): Promise<ProcessInfo[]>
  /**
   * What is holding the shells, and which ones it holds.
   *
   * Includes sessions no pane in this window claims — the ones left behind by
   * a workspace removed while the app was closed. They are invisible
   * otherwise, and a shell nobody can see is a shell nobody can end.
   */
  sessionHost(): Promise<SessionHostInfo>
  /**
   * Hook installers for agents other than Claude Code.
   *
   * The agent protocol takes no tool name and never did — `iaw notify` learns
   * which pane it is in from the environment, not from the caller. This is what
   * makes that a fact rather than a claim: a second installer, with nothing
   * agent-specific in it beyond the event names.
   */
  /**
   * Every command line submitted in any pane, newest first, deduplicated.
   *
   * Collected for free from the `133;E` marker the shell integration already
   * emits — the app was recording the most recent one per pane so a restored
   * agent pane could be resumed, and this simply keeps more of them.
   */
  commandHistory(): Promise<HistoryEntry[]>

  /**
   * Transcripts of panes that have been closed.
   *
   * Plain text files, so nothing new is needed to use them: the editor pane
   * opens one, and the search pane searches the whole folder. Written at the
   * one moment the content would otherwise be discarded — closing a pane, which
   * is also the moment its scrollback buffer is deleted.
   */
  vault: {
    list(): Promise<VaultEntry[]>
    /** The folder they live in — point the search pane at it. */
    folder(): Promise<string>
  }

  /**
   * Git worktrees, for running an agent per branch.
   *
   * No new concept in the workspace model: a worktree is a workspace whose
   * folder happens to be one, so the file tree, changes pane, search and branch
   * display all work on it already. Only making one and cleaning one up need a
   * host.
   */
  worktrees: {
    list(cwd: string): Promise<Worktree[]>
    /** The worktree containing this folder, or null. Never the main checkout. */
    at(cwd: string): Promise<Worktree | null>
    add(
      cwd: string,
      branch: string,
      dir: string
    ): Promise<{ ok: boolean; path?: string; created?: boolean; error?: string }>
    /** Refused when the checkout is dirty unless `force`; the error says why. */
    remove(cwd: string, dir: string, force: boolean): Promise<{ ok: boolean; error?: string }>
    /** A sibling folder named for the branch, or null outside a repository. */
    suggest(cwd: string, branch: string): Promise<string | null>
  }

  /**
   * The git panes' surface: reading where a repository stands, and the three
   * steps that move work along it.
   *
   * Separate from the older `gitStatus` and `gitDiff` above, which stay because
   * the file tree's change markers and the compare pane want exactly what they
   * already return and nothing more. What is here is what a pane offering to
   * *change* something needs: staged and unstaged told apart, ahead and behind
   * counted, and every operation reporting git's own message when it says no.
   *
   * Nothing in here can destroy work. There is no discard, no hard reset and no
   * force push, deliberately — see `src/main/git.ts`.
   */
  git: {
    /** Branch, ahead/behind, and every changed file, from one call. */
    repoStatus(cwd: string): Promise<RepoStatus>
    /** Saves across every branch, newest first, for the picture. */
    history(cwd: string, limit?: number, filter?: HistoryFilter): Promise<Commit[]>
    branches(cwd: string): Promise<Branch[]>
    /** One file's changed lines, from whichever of the three places it is in. */
    fileDiff(cwd: string, repoPath: string, opts: { picked?: boolean; untracked?: boolean }): Promise<string>
    /** Everything picked, as one patch: exactly what the next save will hold. */
    pickedDiff(cwd: string): Promise<string>
    commitDiff(cwd: string, sha: string, repoPath?: string): Promise<string>
    commitFiles(cwd: string, sha: string): Promise<ChangedFile[]>
    /** Picks files for the next save. Empty picks everything changed. */
    pick(cwd: string, paths: string[]): Promise<GitResult>
    /** Takes them back out. Never touches a file on disk. */
    unpick(cwd: string, paths: string[]): Promise<GitResult>
    save(cwd: string, message: string): Promise<GitResult>
    /** The one operation that leaves this machine. */
    send(cwd: string): Promise<GitResult>
    /** Looks at what is new on GitHub without touching anything here. */
    peek(cwd: string): Promise<GitResult>
    bringIn(cwd: string): Promise<GitResult>
    goTo(cwd: string, branch: string): Promise<GitResult>
    startBranch(cwd: string, name: string): Promise<GitResult>
    /**
     * Picks or unpicks exactly the lines in a patch the renderer cut down.
     * `--cached` either way, so no file on disk is touched.
     */
    applyLines(cwd: string, patch: string, direction: 'pick' | 'unpick'): Promise<GitResult>
    /** Undoes the last save and keeps every file (`reset --soft`). Never `--hard`. */
    undoLastSave(cwd: string): Promise<GitResult>
    /** Puts what is picked into the save that already exists. Refused once sent. */
    amend(cwd: string, message: string): Promise<GitResult>
    /** Undoes one save by making a new one that puts it back. Safe at any age. */
    revert(cwd: string, sha: string): Promise<GitResult>
    tag(cwd: string, sha: string, name: string): Promise<GitResult>
    /** Starts tracking a folder that git has never been told about. */
    init(cwd: string): Promise<GitResult>
    /** Points the project at its copy online. Refuses to move one already set. */
    setOrigin(cwd: string, url: string): Promise<GitResult>
    /** Which host CLIs are installed and signed in, for the one-button publish. */
    hostTools(cwd: string): Promise<HostTool[]>
    /** Makes the project online with the host's own tool, and sends everything. */
    createOnline(
      cwd: string,
      opts: { command: string; name: string; private: boolean; description?: string }
    ): Promise<GitResult>
  }

  agents: {
    list(): Promise<AgentConfigInfo[]>
    set(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string; path: string }>
  }
  /** Installed WSL distributions, for the workspace shell picker. */
  wslDistros(): Promise<string[]>
  /**
   * The distributions that are running right now.
   *
   * Asked before opening a WSL workspace, so the app only warns about starting
   * WSL when it would actually be started. Empty off Windows.
   */
  wslRunning(): Promise<string[]>
  /**
   * Start a distribution, stop one, or stop all of them.
   *
   * The memory a running distribution holds is not given back until it is
   * stopped, which is why stopping is offered at all — see `WslAction`.
   */
  wslControl(action: WslAction, distro?: string): Promise<{ ok: boolean; error?: string }>
  /** Hosts from `~/.ssh/config`, for the shell menus. Empty if there is none. */
  sshHosts(): Promise<SshHost[]>
  /** Claude Code's own usage limits, for the status bar monitor. */
  /**
   * The usage limits, or why they are not available.
   *
   * `retry` is for the one recoverable failure: on macOS the login lives in the
   * keychain, and a dismissed permission dialog is remembered so the poll does
   * not raise another every five minutes. Passing true forgets that refusal, so
   * the next read asks again. Nothing else about the call changes.
   */
  claudeUsage(retry?: boolean): Promise<UsageReport>
  /**
   * What each project has spent, read from Claude Code's transcripts on disk.
   *
   * The counterpart to `claudeUsage`, and the opposite kind of call: no network,
   * no account, nothing sent anywhere. Scanning is incremental, so this is cheap
   * to poll after the first one.
   */
  claudeTokens(): Promise<TokenReport>
  /**
   * Publishes this machine's per-project totals to a folder shared between your
   * machines, and returns every machine's.
   *
   * A blank `dir` is the feature switched off, and answers with an empty share
   * rather than an error. Only totals are written — never a transcript.
   */
  shareTokens(dir: string, entries: TokenPublishEntry[]): Promise<SharedTokens>
  /**
   * Publishes what this machine is part-way through into the shared folder, and
   * returns every machine's account of every project.
   *
   * A blank `dir` is the feature switched off, and answers with `problem: 'off'`
   * rather than an error — a caller must be able to tell that apart from a
   * folder nobody has written into yet. Reports only: nothing here moves work
   * between machines, and nothing here runs a git operation that changes one.
   */
  relay(dir: string, entries: RelayPublishEntry[]): Promise<Relay>
  /**
   * Hands these files to the operating system as a drag.
   *
   * Replaces the drag in progress rather than adding to it — the caller must
   * have called `preventDefault` on the `dragstart` first. Answers whether it
   * started, because a refusal means the caller's own drag is still the one
   * happening and it should behave accordingly.
   */
  startFileDrag(paths: string[]): Promise<boolean>
  /**
   * Machine load, memory, disks, network and GPU, for the monitor pane and the
   * sidebar strip. One sample per call — the rates inside it are measured
   * against the previous call, so a caller that polls irregularly gets rates
   * over its own interval rather than a fixed one.
   */
  /**
   * One sample of what the machine is doing.
   *
   * `drives` false skips the disk throughput and health probe entirely, which
   * is the one expensive part — 246ms of PowerShell against the rest of the
   * sample's 129ms. The panel passes false when its drives block is hidden, so
   * turning a block off buys back real work rather than only tidying up.
   */
  systemStats(opts?: { drives?: boolean }): Promise<SystemStats>
  /**
   * The weather and air where you said you are.
   *
   * Answers `{ error: 'no-location' }` without touching the network until a
   * place is set, which is the only third-party call this app makes.
   */
  weather(req: WeatherRequest): Promise<WeatherReading>
  /** Working-tree status for the file tree's change markers. */
  gitStatus(cwd: string): Promise<GitStatusMap>
  /** True when the path exists and is a directory — validates the path bar. */
  isDirectory(dir: string): Promise<boolean>
  files: {
    createDirectory(parent: string, name: string): Promise<string>
    /** An empty file. Refuses to overwrite one that already exists. */
    createFile(parent: string, name: string): Promise<string>
    /**
     * Replaces a file's contents with UTF-8 text, creating it if needed.
     *
     * Unlike `createFile` this does overwrite — it is what the notes editor
     * saves through, where overwriting the file you are editing is the point.
     */
    writeText(path: string, content: string): Promise<void>
    /** Launches a program with one file as its argument. */
    openWith(program: string, path: string): Promise<void>
    rename(target: string, name: string): Promise<string>
    /**
     * Moves to the platform's trash, where the user can get it back.
     *
     * `permanent` bypasses it and unlinks, which is not recoverable. Either way
     * the caller is responsible for confirming first, and for saying which of
     * the two is about to happen — they are very different promises.
     *
     * Rejects rather than falling back if the trash is unavailable for that
     * path; see the handler in `main.ts`.
     */
    remove(target: string, permanent?: boolean): Promise<void>
    /**
     * Copies a file or folder into a directory, never overwriting: a name
     * already in use gains a `(2)`, which is what makes copy-and-paste into the
     * same folder mean "duplicate". Returns where it landed.
     */
    copy(source: string, destDir: string): Promise<string>
    /** The same, moving. Returns where it landed. */
    move(source: string, destDir: string): Promise<string>
  }
  /**
   * Asks the host for a translucent window so theme opacity shows the desktop,
   * and which backdrop material Windows should composite behind it.
   */
  setTranslucent(translucent: boolean, backdrop: BackdropMaterial): Promise<void>

  pty: {
    spawn(req: SpawnRequest): Promise<{ ok: boolean; error?: string }>
    write(paneId: string, data: string): Promise<void>
    resize(paneId: string, cols: number, rows: number): Promise<void>
    kill(paneId: string): Promise<void>
    isBusy(paneId: string): Promise<boolean>
  }

  agent: {
    /**
     * Relays one of a blocked pane's own declared choices into it. Refused
     * unless that pane is currently blocked and published that choice.
     */
    answer(paneId: string, choiceId?: string): Promise<{ ok: boolean; error?: string; label?: string }>
    state(paneId?: string): Promise<PaneAgentState[]>
  }

  /** Writes a clipboard image to a temp file and returns its path, or null. */
  pasteImage(): Promise<string | null>

  contextMenu: {
    get(): Promise<boolean>
    set(enabled: boolean): Promise<{ ok: boolean; error?: string }>
  }

  notify(opts: { title: string; body: string; paneId: string; workspaceId: string }): Promise<void>
  setBadge(count: number): Promise<void>
  /**
   * Quits and starts again.
   *
   * For the settings that are fixed when the window is constructed — real
   * transparency, square window corners — where there is nothing to apply and
   * the only honest offer is to do it properly.
   */
  relaunch(): Promise<void>

  openExternal(url: string): Promise<void>
  openInExplorer(target: string): Promise<void>
  /**
   * Opens the folder around a file with the item selected.
   *
   * Not the same as `openInExplorer`, which runs the file with whatever the OS
   * associates — for an image that is a viewer, and there is no way back to
   * where the file lives. Both are worth having and neither substitutes.
   */
  revealItem(target: string): Promise<void>

  claude: {
    readConfig(): Promise<{ path: string; exists: boolean; bellEnabled: boolean; hooksInstalled: boolean; raw: string }>
    /** Installs the bell setting and our hooks, or removes exactly those again. */
    setIntegration(enabled: boolean): Promise<{ ok: boolean; error?: string; path: string }>
  }

  window: {
    minimize(): void
    maximizeToggle(): void
    close(): void
    /** True when the runtime draws its own window controls in the title bar. */
    readonly usesNativeOverlay: boolean
    /**
     * Repaints native caption buttons for the current theme.
     *
     * Only meaningful where `usesNativeOverlay` is true; elsewhere the buttons
     * are ours and follow the CSS variables like the rest of the UI.
     */
    setOverlayColors(color: string, symbolColor: string): void
  }

  on: {
    ptyData(cb: (p: PtyOutput) => void): () => void
    ptyExit(cb: (p: PtyExit) => void): () => void
    ptyMeta(cb: (p: TerminalMeta) => void): () => void
    /** Observed activity and declared agent state, per pane. */
    paneStatus(cb: (s: PaneStatus) => void): () => void
    /** Explorer's "Open in ia_workspaces" handed us a folder. */
    openFolder(cb: (folder: string) => void): () => void
    alert(cb: (a: TerminalAlert) => void): () => void
    focusTerminal(cb: (p: { workspaceId: string; paneId: string }) => void): () => void
    windowFocus(cb: (focused: boolean) => void): () => void
    /** What git is doing, while it is doing it. See `GitProgress`. */
    gitProgress(cb: (p: GitProgress) => void): () => void
  }
}
