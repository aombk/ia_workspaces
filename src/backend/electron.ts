import type { Backend } from './types'
import type { IaWorkspacesApi } from '../preload/preload'

declare global {
  interface Window {
    iaw: IaWorkspacesApi
  }
}

/**
 * Electron implementation of the Backend contract. All it does is forward to
 * the preload bridge — the interesting work lives in the main process.
 */
export function createElectronBackend(): Backend {
  const api = window.iaw

  return {
    name: 'electron',
    // `<webview>` is a DOM element, so a browser pane joins the split layout
    // like any other pane rather than floating over it.
    capabilities: { browser: 'dom', platform: api.platform },

    loadState: () => api.loadState(),
    saveState: (state) => api.saveState(state),
    onExternalStateChange: (cb) => api.on.externalState(cb),

    listShells: () => api.listShells(),
    pickFolder: (defaultPath) => api.pickFolder(defaultPath),
    pickSaveFile: (opts) => api.pickSaveFile(opts),
    pickOpenFile: (opts) => api.pickOpenFile(opts),
    homeDir: () => api.homeDir(),
    appVersion: () => api.appVersion(),
    pathForFile: (file) => api.pathForFile(file),
    gitBranch: (cwd) => api.gitBranch(cwd),
    setTranslucent: (translucent, backdrop) => api.setTranslucent(translucent, backdrop),
    readDir: (dir, showHidden) => api.readDir(dir, showHidden),
    listImages: (dir, recursive, showHidden) => api.listImages(dir, recursive, showHidden),
    imageUrl: (path) => api.imageUrl(path),
    readText: (path) => api.readText(path),
    fileStamp: (path) => api.fileStamp(path),
    readBytes: (path) => api.readBytes(path),
    patchBytes: (path, offset, base64) => api.patchBytes(path, offset, base64),
    gitDiff: (cwd, path, untracked) => api.gitDiff(cwd, path, untracked),
    compareFiles: (left, right) => api.compareFiles(left, right),
    search: (cwd, query, caseSensitive) => api.search(cwd, query, caseSensitive),
    processes: () => api.processes(),
    wslDistros: () => api.wslDistros(),
    sshHosts: () => api.sshHosts(),
    claudeUsage: () => api.claudeUsage(),
    gitStatus: (cwd) => api.gitStatus(cwd),
    isDirectory: (dir) => api.isDirectory(dir),
    files: {
      createDirectory: (parent, name) => api.files.createDirectory(parent, name),
      createFile: (parent, name) => api.files.createFile(parent, name),
      writeText: (path, content) => api.files.writeText(path, content),
      openWith: (program, path) => api.files.openWith(program, path),
      rename: (target, name) => api.files.rename(target, name),
      remove: (target, permanent) => api.files.remove(target, permanent),
      copy: (source, destDir) => api.files.copy(source, destDir),
      move: (source, destDir) => api.files.move(source, destDir),
    },

    pty: {
      spawn: (req) => api.pty.spawn(req),
      write: (paneId, data) => api.pty.write(paneId, data),
      resize: (paneId, cols, rows) => api.pty.resize(paneId, cols, rows),
      kill: (paneId) => api.pty.kill(paneId),
      isBusy: (paneId) => api.pty.isBusy(paneId),
    },

    agent: {
      answer: (paneId, choiceId) => api.agent.answer(paneId, choiceId),
      state: (paneId) => api.agent.state(paneId),
    },

    pasteImage: () => api.pasteImage(),

    contextMenu: {
      get: () => api.contextMenu.get(),
      set: (enabled) => api.contextMenu.set(enabled),
    },

    notify: (opts) => api.notify(opts),
    setBadge: (count) => api.setBadge(count),
    relaunch: () => api.relaunch(),

    openExternal: (url) => api.openExternal(url),
    openInExplorer: (target) => api.openInExplorer(target),
    revealItem: (target) => api.revealItem(target),

    claude: {
      readConfig: () => api.claude.readConfig(),
      setIntegration: (enabled) => api.claude.setIntegration(enabled),
    },

    window: {
      minimize: () => void api.window.minimize(),
      maximizeToggle: () => void api.window.maximizeToggle(),
      close: () => void api.window.close(),
      // Electron draws real Windows caption buttons via titleBarOverlay —
      // except over a transparent window, where Windows refuses and the app
      // draws its own instead.
      usesNativeOverlay: api.window.usesNativeOverlay,
      setOverlayColors: (color, symbolColor) => void api.window.setOverlayColors(color, symbolColor),
    },

    on: {
      ptyData: (cb) => api.on.ptyData(cb),
      ptyExit: (cb) => api.on.ptyExit(cb),
      ptyMeta: (cb) => api.on.ptyMeta(cb),
      paneStatus: (cb) => api.on.paneStatus(cb),
      openFolder: (cb) => api.on.openFolder(cb),
      alert: (cb) => api.on.alert(cb),
      focusTerminal: (cb) => api.on.focusTerminal(cb),
      windowFocus: (cb) => api.on.windowFocus(cb),
    },
  }
}
