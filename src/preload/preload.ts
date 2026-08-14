import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import { platformKind } from '../shared/platform'
import { encodeImagePath } from '../shared/images'
import type { SshHost } from '../shared/ssh'
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
  AgentConfigInfo,
  HistoryEntry,
  VaultEntry,
  Worktree,
  SessionHostInfo,
  SystemStats,
  UsageReport,
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
} from '../shared/types'

/**
 * The single seam between the UI and whatever runtime is hosting it.
 *
 * The renderer imports nothing from Electron and never sees a channel name —
 * it only calls these methods. Porting to another shell means
 * reimplementing this one object against that runtime's IPC, leaving every
 * component untouched.
 */
const api = {
  /**
   * Which OS, read here because this is the last place that knows for certain.
   *
   * `process` exists on this side of the bridge and not on the other, and a
   * plain value rather than a method because the renderer needs it while
   * building its backend, before any IPC round trip could have returned.
   */
  platform: platformKind(process.platform),

  loadState: (): Promise<unknown> => ipcRenderer.invoke(IPC.loadState),
  saveState: (state: unknown): Promise<void> => ipcRenderer.invoke(IPC.saveState, state),

  listShells: (): Promise<ShellProfile[]> => ipcRenderer.invoke(IPC.listShells),
  pickFolder: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke(IPC.pickFolder, defaultPath),
  pickSaveFile: (opts: { title: string; defaultName: string }): Promise<string | null> =>
    ipcRenderer.invoke(IPC.pickSaveFile, opts),
  pickOpenFile: (opts: { title: string; anyFile?: boolean }): Promise<string | null> =>
    ipcRenderer.invoke(IPC.pickOpenFile, opts),
  homeDir: (): Promise<string> => ipcRenderer.invoke(IPC.homeDir),
  appVersion: (): Promise<string> => ipcRenderer.invoke(IPC.appVersion),
  /**
   * The real path of a file dragged in from Explorer.
   *
   * Electron removed `File.path` in 32, so a dropped file arrives as a `File`
   * with a name and no location. `webUtils` is the replacement, and it only
   * exists on this side of the bridge — hence a preload method rather than the
   * renderer reaching for it.
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  gitBranch: (cwd: string): Promise<string | undefined> => ipcRenderer.invoke(IPC.gitBranch, cwd),
  setTranslucent: (translucent: boolean, backdrop: string): Promise<void> =>
    ipcRenderer.invoke(IPC.setTranslucent, translucent, backdrop),
  readDir: (dir: string, showHidden: boolean): Promise<FileEntry[]> =>
    ipcRenderer.invoke(IPC.readDir, dir, showHidden),
  listImages: (
    dir: string,
    recursive: boolean,
    showHidden: boolean
  ): Promise<{ files: FileEntry[]; truncated: boolean }> =>
    ipcRenderer.invoke(IPC.listImages, dir, recursive, showHidden),
  // Built here rather than fetched: it is a pure function of the path, and an
  // async call per image would make the gallery render twice.
  imageUrl: (path: string): string => encodeImagePath(path),
  readText: (path: string): Promise<string> => ipcRenderer.invoke(IPC.readText, path),
  fileStamp: (path: string): Promise<{ mtime: number; size: number } | null> =>
    ipcRenderer.invoke(IPC.fileStamp, path),
  readBytes: (path: string): Promise<{ base64: string; size: number; truncated: boolean }> =>
    ipcRenderer.invoke(IPC.readBytes, path),
  patchBytes: (path: string, offset: number, base64: string): Promise<void> =>
    ipcRenderer.invoke(IPC.patchBytes, path, offset, base64),
  gitDiff: (cwd: string, path: string, untracked: boolean): Promise<string> =>
    ipcRenderer.invoke(IPC.gitDiff, cwd, path, untracked),
  compareFiles: (left: string, right: string): Promise<string> =>
    ipcRenderer.invoke(IPC.compareFiles, left, right),
  search: (cwd: string, query: string, caseSensitive: boolean): Promise<SearchHit[]> =>
    ipcRenderer.invoke(IPC.search, cwd, query, caseSensitive),
  processes: (): Promise<ProcessInfo[]> => ipcRenderer.invoke(IPC.processes),
  sessionHost: (): Promise<SessionHostInfo> => ipcRenderer.invoke(IPC.sessionHost),
  agentHooks: (): Promise<AgentConfigInfo[]> => ipcRenderer.invoke(IPC.agentHooks),
  commandHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.commandHistory),
  vaultList: (): Promise<VaultEntry[]> => ipcRenderer.invoke(IPC.vaultList),
  vaultFolder: (): Promise<string> => ipcRenderer.invoke(IPC.vaultFolder),
  worktreeList: (cwd: string): Promise<Worktree[]> => ipcRenderer.invoke(IPC.worktreeList, cwd),
  worktreeAt: (cwd: string): Promise<Worktree | null> => ipcRenderer.invoke(IPC.worktreeAt, cwd),
  worktreeAdd: (
    cwd: string,
    branch: string,
    dir: string
  ): Promise<{ ok: boolean; path?: string; created?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.worktreeAdd, cwd, branch, dir),
  worktreeRemove: (cwd: string, dir: string, force: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.worktreeRemove, cwd, dir, force),
  worktreeSuggest: (cwd: string, branch: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.worktreeSuggest, cwd, branch),
  /**
   * The git panes' whole surface.
   *
   * Grouped rather than flat, unlike the older `gitStatus`/`gitDiff` pair beside
   * it, because there are two dozen of these and a flat namespace of
   * `gitSomething` reads like a pile rather than like one feature.
   */
  git: {
    repoStatus: (cwd: string): Promise<RepoStatus> => ipcRenderer.invoke(IPC.gitRepoStatus, cwd),
    history: (cwd: string, limit?: number, filter?: HistoryFilter): Promise<Commit[]> =>
      ipcRenderer.invoke(IPC.gitHistory, cwd, limit, filter),
    branches: (cwd: string): Promise<Branch[]> => ipcRenderer.invoke(IPC.gitBranches, cwd),
    fileDiff: (cwd: string, repoPath: string, opts: { picked?: boolean; untracked?: boolean }): Promise<string> =>
      ipcRenderer.invoke(IPC.gitFileDiff, cwd, repoPath, opts),
    pickedDiff: (cwd: string): Promise<string> => ipcRenderer.invoke(IPC.gitPickedDiff, cwd),
    commitDiff: (cwd: string, sha: string, repoPath?: string): Promise<string> =>
      ipcRenderer.invoke(IPC.gitCommitDiff, cwd, sha, repoPath),
    commitFiles: (cwd: string, sha: string): Promise<ChangedFile[]> =>
      ipcRenderer.invoke(IPC.gitCommitFiles, cwd, sha),
    pick: (cwd: string, paths: string[]): Promise<GitResult> => ipcRenderer.invoke(IPC.gitPick, cwd, paths),
    unpick: (cwd: string, paths: string[]): Promise<GitResult> => ipcRenderer.invoke(IPC.gitUnpick, cwd, paths),
    save: (cwd: string, message: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitSave, cwd, message),
    send: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitSend, cwd),
    peek: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitPeek, cwd),
    bringIn: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitBringIn, cwd),
    goTo: (cwd: string, branch: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitGoTo, cwd, branch),
    startBranch: (cwd: string, name: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.gitStartBranch, cwd, name),
    applyLines: (cwd: string, patch: string, direction: 'pick' | 'unpick'): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.gitApplyLines, cwd, patch, direction),
    undoLastSave: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitUndoLastSave, cwd),
    amend: (cwd: string, message: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitAmend, cwd, message),
    revert: (cwd: string, sha: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitRevert, cwd, sha),
    tag: (cwd: string, sha: string, name: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.gitTag, cwd, sha, name),
    init: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitInit, cwd),
    setOrigin: (cwd: string, url: string): Promise<GitResult> => ipcRenderer.invoke(IPC.gitSetOrigin, cwd, url),
    hostTools: (cwd: string): Promise<HostTool[]> => ipcRenderer.invoke(IPC.gitHostTools, cwd),
    createOnline: (
      cwd: string,
      opts: { command: string; name: string; private: boolean; description?: string }
    ): Promise<GitResult> => ipcRenderer.invoke(IPC.gitCreateOnline, cwd, opts),
  },
  setAgentHooks: (id: string, enabled: boolean): Promise<{ ok: boolean; error?: string; path: string }> =>
    ipcRenderer.invoke(IPC.setAgentHooks, id, enabled),
  wslDistros: (): Promise<string[]> => ipcRenderer.invoke(IPC.wslDistros),
  sshHosts: (): Promise<SshHost[]> => ipcRenderer.invoke(IPC.sshHosts),
  claudeUsage: (retry?: boolean): Promise<UsageReport> => ipcRenderer.invoke(IPC.claudeUsage, retry),
  systemStats: (opts?: { drives?: boolean }): Promise<SystemStats> =>
    ipcRenderer.invoke(IPC.systemStats, opts),
  weather: (req: WeatherRequest): Promise<WeatherReading> => ipcRenderer.invoke(IPC.weather, req),
  gitStatus: (cwd: string): Promise<GitStatusMap> => ipcRenderer.invoke(IPC.gitStatus, cwd),
  isDirectory: (dir: string): Promise<boolean> => ipcRenderer.invoke(IPC.isDirectory, dir),
  files: {
    createDirectory: (parent: string, name: string): Promise<string> =>
      ipcRenderer.invoke(IPC.createDirectory, parent, name),
    createFile: (parent: string, name: string): Promise<string> =>
      ipcRenderer.invoke(IPC.createFile, parent, name),
    writeText: (path: string, content: string): Promise<void> =>
      ipcRenderer.invoke(IPC.writeText, path, content),
    openWith: (program: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.openWith, program, path),
    rename: (target: string, name: string): Promise<string> =>
      ipcRenderer.invoke(IPC.renameEntry, target, name),
    remove: (target: string, permanent = false): Promise<void> =>
      ipcRenderer.invoke(IPC.removeEntry, target, permanent),
    copy: (source: string, destDir: string): Promise<string> =>
      ipcRenderer.invoke(IPC.copyEntry, source, destDir),
    move: (source: string, destDir: string): Promise<string> =>
      ipcRenderer.invoke(IPC.moveEntry, source, destDir),
  },

  pty: {
    spawn: (req: SpawnRequest): Promise<{ ok: boolean; error?: string; shell?: string }> =>
      ipcRenderer.invoke(IPC.ptySpawn, req),
    write: (id: string, data: string): Promise<void> => ipcRenderer.invoke(IPC.ptyWrite, id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IPC.ptyResize, id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ptyKill, id),
    isBusy: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.ptyIsBusy, id),
  },

  agent: {
    answer: (paneId: string, choiceId?: string): Promise<{ ok: boolean; error?: string; label?: string }> =>
      ipcRenderer.invoke(IPC.agentAnswer, paneId, choiceId),
    state: (paneId?: string): Promise<PaneAgentState[]> => ipcRenderer.invoke(IPC.agentState, paneId),
  },

  /** Absolute path of a clipboard image written to a temp file, or null. */
  pasteImage: (): Promise<string | null> => ipcRenderer.invoke(IPC.pasteImage),

  contextMenu: {
    get: (): Promise<boolean> => ipcRenderer.invoke(IPC.getContextMenu),
    set: (enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.setContextMenu, enabled),
  },

  notify:(opts: { title: string; body: string; paneId: string; workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC.notify, opts),
  setBadge: (count: number): Promise<void> => ipcRenderer.invoke(IPC.setBadge, count),
  relaunch: (): Promise<void> => ipcRenderer.invoke(IPC.relaunch),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
  openInExplorer: (target: string): Promise<void> => ipcRenderer.invoke(IPC.openInExplorer, target),
  revealItem: (target: string): Promise<void> => ipcRenderer.invoke(IPC.revealItem, target),

  claude: {
    readConfig: (): Promise<{ path: string; exists: boolean; bellEnabled: boolean; hooksInstalled: boolean; raw: string }> =>
      ipcRenderer.invoke(IPC.readClaudeConfig),
    setIntegration: (enabled: boolean): Promise<{ ok: boolean; error?: string; path: string }> =>
      ipcRenderer.invoke(IPC.setClaudeIntegration, enabled),
  },

  window: {
    // Sync because wireWindowControls() runs during startup and has to know
    // straight away whether Windows is drawing the caption buttons.
    usesNativeOverlay: ipcRenderer.sendSync(IPC.usesNativeOverlay) as boolean,
    setOverlayColors: (color: string, symbolColor: string): Promise<void> =>
      ipcRenderer.invoke(IPC.setOverlayColors, color, symbolColor),
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    maximizeToggle: () => ipcRenderer.invoke(IPC.windowMaximizeToggle),
    close: () => ipcRenderer.invoke(IPC.windowClose),
  },

  on: {
    ptyData: (cb: (p: PtyOutput) => void) => subscribe(IPC.onPtyData, cb),
    ptyExit: (cb: (p: PtyExit) => void) => subscribe(IPC.onPtyExit, cb),
    ptyMeta: (cb: (p: TerminalMeta) => void) => subscribe(IPC.onPtyMeta, cb),
    paneStatus: (cb: (s: PaneStatus) => void) => subscribe(IPC.onPaneStatus, cb),
    openFolder: (cb: (folder: string) => void) => subscribe(IPC.onOpenFolder, cb),
    alert: (cb: (a: TerminalAlert) => void) => subscribe(IPC.onAlert, cb),
    focusTerminal: (cb: (p: { workspaceId: string; paneId: string }) => void) =>
      subscribe(IPC.onFocusTerminal, cb),
    windowFocus: (cb: (focused: boolean) => void) => subscribe(IPC.onWindowFocus, cb),
    externalState: (cb: (state: unknown) => void) => subscribe(IPC.onExternalState, cb),
    gitProgress: (cb: (p: GitProgress) => void) => subscribe(IPC.onGitProgress, cb),
  },
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

contextBridge.exposeInMainWorld('iaw', api)

export type IaWorkspacesApi = typeof api
