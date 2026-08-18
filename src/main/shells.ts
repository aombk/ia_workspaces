import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { parseWslPath, type WslAction } from '../shared/wsl'
import { parseSshConfig, sshArgs, type SshHost } from '../shared/ssh'
import {
  integrationScriptName,
  isWindows,
  platformKind,
  shellFallbackChain,
  type PlatformKind,
} from '../shared/platform'
import type { ShellKind, ShellProfile, Settings } from '../shared/types'

/**
 * Which shells exist, where they live, and how to launch one.
 *
 * The table and the integration scripts both live in `resources/` rather than
 * in this file. They used to be string literals here *and* in
 * the Tauri host's `shells.rs` — 72 lines of delicate PowerShell, kept in sync by
 * hand — and adding macOS and Linux would have turned two copies into six. Both
 * hosts now read the same files, so a fix to the prompt hook is a fix
 * everywhere and a new shell is a JSON entry.
 *
 * What stays in code is the part that genuinely is code: the three ways a shell
 * can be told to load a script. See `applyIntegration`.
 */

const PLATFORM: PlatformKind = platformKind(process.platform)

interface ShellSpec {
  kind: string
  label: string
  platforms: PlatformKind[]
  candidates: string[]
  args: string[]
  integration: 'none' | 'powershell-file' | 'bash-rcfile' | 'zsh-zdotdir'
  login: boolean
}

/**
 * Where `resources/` is, in both the dev tree and a packaged app.
 *
 * `process.resourcesPath` only exists in a packaged Electron, and the bundle
 * runs from `out/electron/main`, so the dev answer is three levels up. Checked
 * in that order because a packaged app has no repo above it to find.
 */
function resourcesDir(): string {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'resources') : ''
  if (packaged && existsSync(packaged)) return packaged
  return path.join(__dirname, '..', '..', '..', 'resources')
}

/**
 * Expands `${VAR}` against the environment.
 *
 * Returns null for an unset variable rather than substituting an empty string:
 * `${ProgramFiles}\PowerShell\7\pwsh.exe` with nothing to put in the hole
 * becomes a path that will never exist, and skipping the candidate outright is
 * both faster and easier to read in a log.
 */
function expand(candidate: string): string | null {
  let missing = false
  const out = candidate.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const value = process.env[name]
    if (!value) missing = true
    return value ?? ''
  })
  return missing ? null : out
}

let specs: ShellSpec[] | null = null

function loadSpecs(): ShellSpec[] {
  if (specs) return specs
  try {
    const raw = readFileSync(path.join(resourcesDir(), 'shells.json'), 'utf8')
    specs = (JSON.parse(raw) as { shells: ShellSpec[] }).shells
  } catch {
    // A missing or malformed table must not cost the user their terminal. The
    // fallbacks below are the two shells guaranteed to exist on their platform,
    // without integration — degraded, but a working pane.
    specs = isWindows(PLATFORM)
      ? [
          {
            kind: 'powershell',
            label: 'Windows PowerShell',
            platforms: ['windows'],
            candidates: ['${SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
            args: [],
            integration: 'none',
            login: false,
          },
        ]
      : [
          {
            kind: 'sh',
            label: 'sh',
            platforms: ['macos', 'linux'],
            candidates: ['/bin/sh'],
            args: [],
            integration: 'none',
            login: true,
          },
        ]
  }
  return specs
}

/** The first candidate that exists, or null when none of them do. */
function locate(spec: ShellSpec): string | null {
  for (const candidate of spec.candidates) {
    const full = expand(candidate)
    if (full && existsSync(full)) return full
  }
  return null
}

// ------------------------------------------------------------- script layout

interface Integration {
  /** The script itself, as an absolute path outside the asar. */
  script: string
  /** The generated ZDOTDIR handed to zsh, when the platform has one. */
  zdotdir: string | null
}

let integration: Integration | null = null

/**
 * Copies the integration files out of `resources/` and next to our config.
 *
 * They have to be real files on a real filesystem: the process that reads them
 * is the user's shell, which knows nothing about an asar archive, and on
 * Windows `-File` is the only PowerShell launch form that runs a script while
 * keeping the startup banner. Copying rather than pointing at `resources/`
 * directly also means a packaged app and a dev run behave identically.
 */
export function prepareIntegrationScript(userDataPath: string): void {
  const from = path.join(resourcesDir(), 'shell-integration')
  const name = integrationScriptName(PLATFORM)

  try {
    const script = path.join(userDataPath, name)
    copyFileSync(path.join(from, name), script)

    let zdotdir: string | null = null
    if (!isWindows(PLATFORM)) {
      zdotdir = path.join(userDataPath, 'zdotdir')
      mkdirSync(zdotdir, { recursive: true })
      // Dotfiles by name, and zsh reads exactly these four. A missing one is
      // simply a file zsh will not find, so a partial copy degrades rather
      // than breaking the shell.
      for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
        try {
          copyFileSync(path.join(from, 'zdotdir', file), path.join(zdotdir, file))
        } catch {
          /* skipped */
        }
      }
    }

    integration = { script, zdotdir }
  } catch {
    // The UI degrades gracefully: `integrated` comes back false and the
    // features that depend on markers stand down.
    integration = null
  }
}

// -------------------------------------------------------------------- lookup

export function listShells(settings: Settings): ShellProfile[] {
  const profiles: ShellProfile[] = loadSpecs()
    .filter((spec) => spec.platforms.includes(PLATFORM))
    .map((spec) => {
      const found = locate(spec)
      return {
        kind: spec.kind as ShellKind,
        label: spec.label,
        path: found ?? expand(spec.candidates[0]) ?? spec.candidates[0],
        args: spec.args,
        supportsIntegration: spec.integration !== 'none',
        available: found !== null,
      }
    })

  profiles.push({
    kind: 'custom',
    label: settings.customShellPath ? path.basename(settings.customShellPath) : 'Custom…',
    path: settings.customShellPath,
    args: parseArgs(settings.customShellArgs),
    supportsIntegration: false,
    available: Boolean(settings.customShellPath) && existsSync(settings.customShellPath),
  })

  return profiles
}

/** Splits a settings string into argv, honouring double quotes. */
function parseArgs(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) out.push(m[1] ?? m[2])
  return out
}

/** Installed WSL distributions, in `wsl --list` order. */
export async function listWslDistros(): Promise<string[]> {
  return wslList(['--list', '--quiet'])
}

/**
 * Start a distribution, stop one, or stop all of them.
 *
 * `start` runs the shortest possible command in the distribution and lets it
 * exit: the VM it had to boot to run `true` stays up, which is the whole point,
 * and there is no pane left over from the starting. `terminate` and `shutdown`
 * are `wsl.exe`'s own words for the two sizes of stopping.
 *
 * The error text is `wsl.exe`'s, not ours. "There is no distribution with the
 * supplied name" says more than anything this layer could invent.
 */
export async function controlWsl(
  action: WslAction,
  distro?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!isWindows(PLATFORM)) return { ok: false, error: 'WSL runs only on Windows.' }
  if (action !== 'shutdown' && !distro) return { ok: false, error: 'No distribution given.' }

  const args =
    action === 'shutdown'
      ? ['--shutdown']
      : action === 'terminate'
        ? ['--terminate', distro!]
        : ['-d', distro!, '--', 'true']

  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      args,
      { env: { ...process.env, WSL_UTF8: '1' }, windowsHide: true },
      (err, _out, stderr) => {
        if (!err) return resolve({ ok: true })
        resolve({ ok: false, error: (stderr || err.message).trim() || 'WSL refused.' })
      }
    )
  })
}

/**
 * The distributions with their VM already up, in `wsl --list` order.
 *
 * The distinction the "start WSL?" question needs: starting a distribution
 * costs seconds and a chunk of memory that stays taken until `wsl --shutdown`,
 * while opening one that is already running costs nothing worth asking about.
 */
export async function listRunningWslDistros(): Promise<string[]> {
  return wslList(['--list', '--running', '--quiet'])
}

/**
 * A `wsl.exe --list` variant, as trimmed names.
 *
 * `WSL_UTF8=1` because `wsl.exe` otherwise writes UTF-16LE, which every one of
 * the runtimes would then have to decode by hand. Answers empty off Windows,
 * where the settings panel simply has no WSL section to fill — and empty on
 * failure, which reads as "nothing installed" rather than an error the menus
 * would have no way to show.
 */
async function wslList(args: string[]): Promise<string[]> {
  if (!isWindows(PLATFORM)) return []
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      'wsl.exe',
      args,
      { env: { ...process.env, WSL_UTF8: '1' }, windowsHide: true },
      (_err, out) => resolve(out ?? '')
    )
  })
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Hosts from `~/.ssh/config`, in file order.
 *
 * The SSH counterpart of `listWslDistros`, and the same shape of answer: a list
 * the tab menu turns into one entry each. Empty when there is no config, which
 * is not an error — it means the menu offers only "Other host…".
 *
 * Read on demand rather than cached. The file is small, this runs when a menu
 * opens, and someone who has just added a host expects it to be there.
 */
export function listSshHosts(): SshHost[] {
  try {
    return parseSshConfig(readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8'))
  } catch {
    return []
  }
}

export interface ResolvedShell {
  file: string
  args: string[]
  /** False when we could not inject integration — the UI degrades gracefully. */
  integrated: boolean
  /**
   * Environment the shell needs on top of the pane's own. Only zsh uses it, and
   * only because zsh has no way to be handed an rc file on the command line.
   */
  env: Record<string, string>
}

/**
 * Picks the executable and argv for a terminal.
 *
 * The fallback chain is what makes workspace files portable. One saved on
 * Windows records `shell: "powershell"`; opened on a Mac, that kind does not
 * exist, so this walks the platform's chain and lands on zsh rather than
 * handing back a dead tab. The chain ends somewhere guaranteed to exist —
 * `cmd.exe` on Windows, `/bin/sh` everywhere else — so it cannot run out.
 */
export function resolveShell(
  kind: ShellKind,
  settings: Settings,
  remote?: { distro?: string; host?: string; cwd?: string }
): ResolvedShell {
  const profiles = listShells(settings)
  const wanted = profiles.find((p) => p.kind === kind && p.available)

  let chosen = wanted
  if (!chosen) {
    for (const fallback of shellFallbackChain(PLATFORM)) {
      chosen = profiles.find((p) => p.kind === fallback && p.available)
      if (chosen) break
    }
  }

  if (!chosen) {
    // Nothing on the chain exists, which should be impossible. Name the
    // platform's guaranteed shell and let the spawn report the real error.
    const last = isWindows(PLATFORM) ? 'cmd.exe' : '/bin/sh'
    return { file: last, args: [], integrated: false, env: {} }
  }

  const spec = loadSpecs().find((s) => s.kind === chosen!.kind)

  // SSH takes the host and, if the pane has one, a directory to land in on the
  // far side. The pane's `cwd` is a remote path here rather than a local one,
  // which is why it is passed through untouched — there is nothing local to
  // resolve it against, and `usableDirectory` must not have been asked.
  if (chosen.kind === 'ssh') {
    const host = remote?.host?.trim()
    if (!host) {
      // No host means nothing to connect to. Reported rather than guessed: the
      // alternative is `ssh` opening its usage text in a pane that then dies.
      return { file: chosen.path, args: [], integrated: false, env: {} }
    }
    return {
      file: chosen.path,
      args: [...sshArgs(host, remote?.cwd), ...chosen.args],
      integrated: false,
      env: {},
    }
  }

  // WSL is launched by name and told where to land, rather than relying on the
  // share path it inherits as a cwd: --cd takes the Linux path, which is the
  // one the distribution actually understands.
  if (chosen.kind === 'wsl') {
    const inside = remote?.cwd ? parseWslPath(remote.cwd) : null
    const distro = remote?.distro || inside?.distro
    return {
      file: chosen.path,
      args: [
        ...(distro ? ['-d', distro] : []),
        ...(inside ? ['--cd', inside.path] : []),
        ...chosen.args,
      ],
      integrated: false,
      env: {},
    }
  }

  const wantsIntegration =
    settings.shellIntegration && chosen.supportsIntegration && integration !== null

  const base: ResolvedShell = {
    file: chosen.path,
    args: [...(spec?.login ? ['-l'] : []), ...chosen.args],
    integrated: false,
    env: {},
  }

  if (!wantsIntegration || !spec) return base
  return applyIntegration(base, spec, chosen.args)
}

/**
 * Turns a plain launch into an integrated one.
 *
 * Three mechanisms, because the shells genuinely offer three and none of them
 * generalises:
 *
 * - **PowerShell** takes the script as an argument. `-NoExit` keeps the session
 *   interactive afterwards and `-ExecutionPolicy Bypass` stops a machine policy
 *   from breaking startup. `-File` specifically, because `-Command` and
 *   `-EncodedCommand` both suppress the startup banner.
 * - **bash** takes `--rcfile`, which *replaces* ~/.bashrc rather than adding to
 *   it — our script sources theirs. `-i` is needed alongside it because
 *   `--rcfile` is only consulted by an interactive shell.
 * - **zsh** has nothing of the kind, so the way in is `$ZDOTDIR`: point it at a
 *   directory of our own and let the files there hand control back. That is why
 *   this returns an environment as well as an argv.
 */
function applyIntegration(base: ResolvedShell, spec: ShellSpec, extra: string[]): ResolvedShell {
  const script = integration!.script

  switch (spec.integration) {
    case 'powershell-file':
      return {
        ...base,
        args: ['-ExecutionPolicy', 'Bypass', '-NoExit', '-File', script, ...extra],
        integrated: true,
      }

    case 'bash-rcfile':
      return {
        ...base,
        args: [...(spec.login ? ['-l'] : []), '--rcfile', script, '-i', ...extra],
        integrated: true,
      }

    case 'zsh-zdotdir': {
      if (!integration!.zdotdir) return base
      return {
        ...base,
        integrated: true,
        env: {
          ZDOTDIR: integration!.zdotdir,
          // Where zsh would have looked without us, so our .zshrc can hand
          // back. `$ZDOTDIR` if they set one, otherwise home, which is what
          // zsh's own default is.
          IAW_USER_ZDOTDIR: process.env.ZDOTDIR || os.homedir(),
          IAW_INTEGRATION_SCRIPT: script,
        },
      }
    }

    default:
      return base
  }
}
