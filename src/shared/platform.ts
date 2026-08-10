/**
 * Every place this app differs by operating system, decided once.
 *
 * The rule that makes this work is that nothing here reads `process`, `os` or
 * the filesystem — same rule as the rest of `shared/`, and for the same reason:
 * the renderer imports this and runs in a browser context where none of those
 * exist. So the platform arrives as an argument. `src/main` passes
 * `process.platform`, the renderer gets it from `Backend.capabilities`,
 * and `platform.rs` answers the same questions on the Rust side from the same
 * table below.
 *
 * The thing to resist is adding a second `if (windows)` somewhere else. Six
 * scattered checks is how the codebase got two verbatim copies of a PowerShell
 * script; a branch belongs in this file or in `resources/shells.json`, and
 * nowhere else.
 */

/**
 * Ours, not Node's. `win32` is a lie on 64-bit and `darwin` names a kernel
 * nobody outside the terminal calls macOS, and both leak into UI strings.
 */
export type PlatformKind = 'windows' | 'macos' | 'linux'

/**
 * Maps a platform string onto ours.
 *
 * Unknown platforms answer `linux` rather than throwing. The BSDs and friends
 * are POSIX in every way this app touches — dotfiles, `ps`, `$HOME`, a login
 * shell — so treating them as Linux gets a working terminal, where refusing to
 * start gets a bug report. Nothing here is load-bearing enough to be worth
 * failing over.
 */
export function platformKind(raw: string): PlatformKind {
  if (raw === 'win32' || raw === 'windows') return 'windows'
  if (raw === 'darwin' || raw === 'macos') return 'macos'
  return 'linux'
}

/** Windows is the odd one out often enough to be worth naming. */
export function isWindows(p: PlatformKind): boolean {
  return p === 'windows'
}

/** macOS and Linux share nearly everything this app cares about. */
export function isPosix(p: PlatformKind): boolean {
  return p !== 'windows'
}

// ---------------------------------------------------------------- filesystem

export function pathSeparator(p: PlatformKind): string {
  return isWindows(p) ? '\\' : '/'
}

/**
 * What the platform calls the place deleted files wait in.
 *
 * Only ever used in UI strings, and only ever the platform's own word for it:
 * "moved to the Trash" on Windows sends people looking for a folder that is not
 * there, and the whole point of the message is that it tells you where to go
 * and get the file back.
 */
export function trashName(p: PlatformKind): string {
  return isWindows(p) ? 'Recycle Bin' : 'Trash'
}

/**
 * What goes between entries in `$PATH`.
 *
 * Windows uses the semicolon because the colon was already spoken for by drive
 * letters. Getting this wrong does not fail loudly — it produces one PATH entry
 * that is every directory concatenated, so nothing on it is found and the shell
 * simply cannot see `iaw`.
 */
export function pathListSeparator(p: PlatformKind): string {
  return isWindows(p) ? ';' : ':'
}

/**
 * An environment block with exactly one PATH, our bin directory in front of it.
 *
 * The de-duplication is the whole point, and it is a Windows problem. Windows
 * spells the variable `Path` and looks it up case-insensitively; Node's
 * `process.env` is an ordinary object that reports the key as the OS wrote it.
 * So spreading `process.env` and then setting `PATH` produces **two keys for one
 * variable**, and `CreateProcess` passes both to the child. Nothing rejects
 * that, and nothing warns: consumers simply disagree about which one is real.
 *
 * Two failures came out of exactly that, and neither looked like a PATH bug:
 *
 * - PowerShell and cmd read `Path`, which is the copy *without* our bin
 *   directory, so `iaw` was not on the PATH in any PowerShell pane. It appeared
 *   to work only because Git Bash resolves the other key, and Claude Code runs
 *   its hooks through `sh`.
 * - `git` prepends its own `usr/bin` to the PATH it hands to the MSYS `sh` it
 *   spawns for `git-submodule` and friends. That prepend landed on one key
 *   while `sh` read the other, so those helpers ran with no POSIX utilities at
 *   all — `git fetch` and `git pull` died on a missing `basename`, printing
 *   nothing and exiting 128, while `git --version` and `git status` (pure C
 *   builtins that shell out to nothing) worked perfectly.
 *
 * The name is preserved rather than normalised: a child that has always seen
 * `Path` should keep seeing `Path`. Only the duplication is removed.
 */
export function withBinDir(
  base: Record<string, string | undefined>,
  binDir: string | null,
  p: PlatformKind
): Record<string, string> {
  const out: Record<string, string> = {}
  // Windows writes `Path`; POSIX writes `PATH`. Either is only a default — a
  // block that already carries one keeps whatever spelling it used.
  let key = isWindows(p) ? 'Path' : 'PATH'
  let value = ''

  for (const [name, entry] of Object.entries(base)) {
    if (entry === undefined) continue
    if (/^path$/i.test(name)) {
      // A block that somehow arrives already doubled collapses here too, which
      // is the case this function exists to make impossible downstream.
      key = name
      value = entry
      continue
    }
    out[name] = entry
  }

  out[key] = binDir ? `${binDir}${pathListSeparator(p)}${value}` : value
  return out
}

/** Joins without `node:path`, which this module cannot import. */
export function joinPath(p: PlatformKind, ...parts: string[]): string {
  const sep = pathSeparator(p)
  return parts
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep)
}

/**
 * A directory that is certain to exist, for when nothing better is known.
 *
 * The renderer needs a synchronous answer — a pane being repaired on load, a
 * workspace whose folder was deleted, the very first workspace on a fresh
 * install — and the home directory arrives over IPC, too late for those. So
 * this is the platform's root, which is always there and always valid.
 *
 * It used to be `'C:\\'`, written out at six call sites. On macOS that is not a
 * path at all: the pane would fail to spawn, or silently land somewhere else.
 */
export function fallbackCwd(p: PlatformKind): string {
  return isWindows(p) ? 'C:\\' : '/'
}

/** The last segment of a path, either separator, so it works on foreign paths. */
export function baseName(full: string): string {
  const cut = Math.max(full.lastIndexOf('\\'), full.lastIndexOf('/'))
  return cut === -1 ? full : full.slice(cut + 1)
}

/**
 * Where persisted state lives.
 *
 * `env` and `home` are passed in rather than read, so this stays pure and the
 * CLI can compute the same path without booting Electron — the two used to
 * spell `%APPDATA%\ia_workspaces` out separately and could drift.
 *
 * macOS uses Application Support rather than `~/.config`: it is where a GUI app
 * belongs, it is what Migration Assistant and Time Machine expect, and a user
 * looking for their workspace file will look there. Linux honours
 * `XDG_CONFIG_HOME` and falls back to the spec's default.
 */
export function dataDir(p: PlatformKind, env: Record<string, string | undefined>, home: string): string {
  const app = 'ia_workspaces'
  if (p === 'windows') return joinPath(p, env.APPDATA || joinPath(p, home, 'AppData', 'Roaming'), app)
  if (p === 'macos') return joinPath(p, home, 'Library', 'Application Support', app)
  return joinPath(p, env.XDG_CONFIG_HOME || joinPath(p, home, '.config'), app)
}

/**
 * Whether a directory entry is hidden, given what the OS will tell us.
 *
 * Two unrelated mechanisms wearing one name. Windows has a file attribute and
 * says nothing about the leading dot; POSIX has the dot convention and no
 * attribute. A cross-platform checkout carries both — a `.git` directory on
 * Windows is hidden by convention here even though its attribute may be unset,
 * which is what a developer expects to see in a file tree.
 */
export function isHiddenEntry(name: string, hasHiddenAttribute = false): boolean {
  if (hasHiddenAttribute) return true
  return name.startsWith('.')
}

// -------------------------------------------------------------------- shells

/**
 * The shell a fresh install gets.
 *
 * Not a constant in `DEFAULT_SETTINGS`, because that value is written into
 * workspace files that move between machines. A file saved on Windows says
 * `powershell`; opened on macOS, `resolveShell` walks its fallback chain and
 * lands here rather than on a dead tab. That portability is the whole point of
 * the workspace file being a couple of kilobytes of readable JSON.
 */
export function defaultShellKind(p: PlatformKind): string {
  if (p === 'windows') return 'powershell'
  // zsh has been the macOS default since Catalina; Linux is overwhelmingly
  // bash. Both are only a preference — the chain falls through to `sh`, which
  // is the one thing guaranteed present.
  return p === 'macos' ? 'zsh' : 'bash'
}

/**
 * Shells to try, in order, when the requested one is missing.
 *
 * Ends somewhere that always exists on each platform: `cmd.exe` ships with
 * Windows and `/bin/sh` is required by POSIX, so the chain cannot run out.
 */
export function shellFallbackChain(p: PlatformKind): string[] {
  if (p === 'windows') return ['powershell', 'pwsh', 'cmd']
  return p === 'macos' ? ['zsh', 'bash', 'sh'] : ['bash', 'zsh', 'sh']
}

/**
 * The file in `resources/shell-integration/` for a platform.
 *
 * One POSIX script covers macOS and Linux, and zsh and bash within them: the
 * hook mechanism differs (`precmd`/`preexec` against `PROMPT_COMMAND`) but that
 * is a branch inside the script, where it can be read next to the thing it
 * varies, rather than a second file to keep in sync.
 */
export function integrationScriptName(p: PlatformKind): string {
  return isWindows(p) ? 'powershell.ps1' : 'posix.sh'
}

// ----------------------------------------------------------------- processes

/**
 * A command printing `pid ppid` per line for every process.
 *
 * The pid map needs the whole table to walk a process's ancestry back to a
 * pane, and only when the environment-variable path has already failed — which
 * is why it can afford to shell out at all. `ps` answers in milliseconds where
 * CIM takes a few hundred, so the POSIX side of this is the cheap one.
 */
export function processTableCommand(p: PlatformKind): { file: string; args: string[] } {
  if (p === 'windows') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
    }
  }
  // `=` empties each column header, so there is no banner line to skip and the
  // output is the same shape as the Windows branch produces.
  return { file: 'ps', args: ['-Ax', '-o', 'pid=,ppid='] }
}

// ----------------------------------------------------------------------- ipc

/**
 * A conservative ceiling on the length of a unix socket path.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux, NUL included,
 * and the failure is not a graceful one: `bind` truncates or fails with
 * ENAMETOOLONG, so the server ends up listening somewhere other than where it
 * said it would. The limit is bytes rather than characters, and a home
 * directory can hold multi-byte names, so the check leaves room to be wrong.
 */
const SOCKET_PATH_MAX = 100

/**
 * The directory a POSIX socket of ours belongs in.
 *
 * Linux has a place designed for exactly this — `$XDG_RUNTIME_DIR` is per-user,
 * tmpfs, mode 0700, and emptied when the session ends, so a socket left behind
 * by a crash cannot outlive the login. macOS has no equivalent that is both
 * short and durable, so the data directory does the job there.
 *
 * Windows never reaches this: a named pipe lives in a kernel namespace and has
 * no path on disk at all.
 */
export function ipcRuntimeDir(
  p: PlatformKind,
  env: Record<string, string | undefined>,
  home: string
): string {
  if (p === 'linux' && env.XDG_RUNTIME_DIR) {
    return joinPath(p, env.XDG_RUNTIME_DIR, 'ia_workspaces')
  }
  return dataDir(p, env, home)
}

/**
 * Where one of our IPC servers listens, and what a client should connect to.
 *
 * The two platforms do not merely spell this differently — they are different
 * mechanisms. Windows has a named pipe, which is a kernel object with no
 * presence on the filesystem; POSIX has a socket, which is a file, in a
 * directory, subject to a path length limit and to whatever cleans that
 * directory out.
 *
 * This exists because the control server spelled the Windows form
 * unconditionally. On macOS and Linux `net.listen()` took that literally and
 * created a socket file *named* `\\.\pipe\iaw-electron-1234`, relative to
 * whatever the process's working directory happened to be — which worked only
 * for as long as every `iaw` caller shared that directory.
 *
 * `tmp` is the fallback for a home directory deep enough to overrun the socket
 * path limit. It is second choice rather than first because the temp directory
 * is the one place something else may delete the socket out from under a
 * running server.
 */
export function ipcAddress(
  p: PlatformKind,
  name: string,
  dirs: { runtime: string; tmp: string }
): string {
  if (isWindows(p)) return `\\\\.\\pipe\\iaw-${name}`
  const preferred = joinPath(p, dirs.runtime, `${name}.sock`)
  if (preferred.length <= SOCKET_PATH_MAX) return preferred
  return joinPath(p, dirs.tmp, `iaw-${name}.sock`)
}

/**
 * Whether an address names a Windows pipe rather than a file.
 *
 * The difference matters to exactly two callers: a stale socket *file* has to
 * be unlinked before a server can bind over it, and a pipe must never be — the
 * path does not exist on disk, so an unlink would either fail or delete
 * something else entirely.
 */
export function isPipeAddress(address: string): boolean {
  return address.startsWith('\\\\.\\pipe\\') || address.startsWith('//./pipe/')
}

// ------------------------------------------------------------------ keyboard

/**
 * Which modifier means "the app is talking to you".
 *
 * On macOS this genuinely improves the one shortcut that was always awkward:
 * Windows has to decide whether `Ctrl+C` is copy or interrupt by looking at
 * whether text is selected, while macOS copies with `Cmd+C` and leaves `Ctrl+C`
 * to mean interrupt, always. Terminal users have thirty years of muscle memory
 * for that and it costs nothing to honour.
 */
export function primaryModifier(p: PlatformKind): 'meta' | 'ctrl' {
  return p === 'macos' ? 'meta' : 'ctrl'
}

/** Whether a keyboard event carries this platform's app modifier. */
export function hasPrimaryModifier(
  p: PlatformKind,
  e: { ctrlKey: boolean; metaKey: boolean }
): boolean {
  return p === 'macos' ? e.metaKey : e.ctrlKey
}

/**
 * How a shortcut should be written in menus and the command palette.
 *
 * Symbols on macOS because that is what every other Mac app shows and a Mac
 * user reads `⌘K` faster than `Cmd+K`; words elsewhere.
 */
export function modifierLabel(p: PlatformKind): { primary: string; shift: string; alt: string; joiner: string } {
  if (p === 'macos') return { primary: '⌘', shift: '⇧', alt: '⌥', joiner: '' }
  return { primary: 'Ctrl', shift: 'Shift', alt: 'Alt', joiner: '+' }
}

// ------------------------------------------------------- host-only behaviour

/**
 * Whether a platform has the quirks these subsystems exist to handle.
 *
 * Each of these is a real Windows-only phenomenon rather than a feature we
 * chose not to port, and saying so here keeps the guard at the call site down
 * to one honest question:
 *
 * - `explorerMenu` writes `HKCU\Software\Classes` keys. macOS would be a Finder
 *   service and Linux a `.desktop` action — different enough to be their own
 *   feature, not a branch.
 * - `phantomExit` compensates for node-pty's ConPTY backend raising `exit` when
 *   the conout socket closes. A POSIX pty reports the child's real status, so
 *   there is nothing to second-guess.
 * - `scrollbackRetries` covers Windows sharing-violation codes on rename; POSIX
 *   rename is atomic and does not fail that way.
 * - `ptyClearsOnStart` is ConPTY painting its fresh screen buffer: the first
 *   bytes out of a new pseudoconsole are `ESC[2J ESC[H`, which erase whatever
 *   the pane already had on it. A POSIX pty writes nothing of its own, so the
 *   shell's first output simply follows what is there.
 */
export function hasQuirk(
  p: PlatformKind,
  // Named at the call site rather than read here: all four are Windows today,
  // and the value of the argument is that `hasQuirk(PLATFORM, 'phantomExit')`
  // says why the guard exists where `isWindows(PLATFORM)` would not. If one of
  // these ever turns out to have a macOS or Linux analogue, this is where it
  // stops being a lie.
  _quirk: 'explorerMenu' | 'phantomExit' | 'scrollbackRetries' | 'ptyClearsOnStart'
): boolean {
  return isWindows(p)
}

/**
 * Whether the window can have a translucent backdrop.
 *
 * macOS has had NSVisualEffectView forever and Windows 11 has acrylic. Linux
 * has no portable equivalent — it depends on the compositor, and a request that
 * silently does nothing is worse than an opacity slider that is honestly
 * absent, so the setting hides itself there.
 */
export function supportsBackdrop(p: PlatformKind): boolean {
  return p !== 'linux'
}
