import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { mergeHooks, stripHooks, type AgentHookSpec } from './agentHooks'

/**
 * Claude Code only rings the terminal bell when this is set; without it, it
 * sends a desktop notification on Ghostty/Kitty/iTerm2 only and stays silent
 * everywhere else. Verified against code.claude.com/docs/en/terminal-config.
 */
const NOTIF_KEY = 'preferredNotifChannel'
const NOTIF_VALUE = 'terminal_bell'

/**
 * Hooks that make Claude Code say *what* happened, given the absolute path to
 * our `iaw` shim.
 *
 * The terminal bell only ever means "attention"; these fire on the two events
 * worth interrupting for and carry a message, addressed at the exact pane
 * because `iaw` reads IAW_PANE_ID from the shell it inherits.
 *
 * `Notification` rather than `PermissionRequest`: it covers being asked to
 * approve a tool *and* the prompt sitting idle waiting to be answered, which is
 * the whole of "Claude wants you". Both would fire for an approval, and two
 * toasts for one event is worse than one.
 *
 * Event names verified against code.claude.com/docs/en/hooks.
 *
 * Absolute, and not the bare word, because a hook is run by whatever shell
 * Claude Code reaches for — Git Bash on Windows — from whatever directory it
 * happens to be in. `iaw` is only on the PATH of terminals *this app* spawned,
 * so a bare name works when Claude Code runs in one of our panes and fails with
 * `iaw: command not found` everywhere else. Since every Stop fires one, that
 * meant a wall of hook errors for anyone running Claude Code in an ordinary
 * terminal — or in one of ours after the app had been restarted underneath it.
 *
 * `--quiet` is the other half; see `cli.ts`. A notification that cannot be
 * delivered is not an error worth interrupting an agent for.
 */
export function hookEvents(iawPath: string): Record<string, string> {
  // Forward slashes: `sh` treats a backslash inside double quotes as an escape,
  // so a Windows path written the Windows way would not survive the trip.
  const iaw = `"${iawPath.replace(/\\/g, '/')}"`
  // `|| true` is the outermost guard, and it is not belt-and-braces: the shim
  // this names forwards to an executable that, in a portable build, lives in a
  // temp folder deleted when the app exits. `--quiet` can only silence failures
  // our own CLI is alive to report; this silences the ones where it never runs
  // at all. A best-effort notification must not be able to fail an agent's turn.
  const hush = ' 2>/dev/null || true'
  return {
    Notification: `${iaw} notify --quiet --title "Claude Code" --body "is waiting for you"${hush}`,
    Stop: `${iaw} notify --quiet --title "Claude Code" --body "finished responding"${hush}`,
    // Records the conversation id against the pane, so closing the app and
    // reopening it can resume this exact session rather than the newest one in
    // the folder. `iaw session` reads the id from the hook JSON on stdin.
    SessionStart: `${iaw} session --quiet${hush}`,
    // The same, on the event that means the conversation is real.
    //
    // `SessionStart` is startup: it hands out an id for a conversation nobody
    // has had yet, and Claude Code writes no transcript for a session that is
    // never spoken to. Resuming one of those is the "No conversation found
    // with session ID" a restored pane used to greet you with. This fires when
    // a prompt is submitted, which is also how a pane that moved on to a
    // second conversation records the one it is actually having.
    //
    // Nothing is printed on success, which matters here and nowhere else: what
    // a `UserPromptSubmit` hook writes to stdout is added to the agent's
    // context.
    UserPromptSubmit: `${iaw} session --quiet${hush}`,
  }
}

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

/**
 * Claude Code as the generic installer sees it.
 *
 * `matcherGroups` is true because Claude has matcher-based events —
 * `SessionStart` fires for startup, resume, clear and compact — and a group
 * with no matcher key never fires at all. That is precisely how the session id
 * went unrecorded for a while, while the Notification and Stop hooks, which are
 * not matcher-based, worked perfectly and hid it.
 */
const CLAUDE: AgentHookSpec = {
  id: 'claude',
  label: 'Claude Code',
  settingsPath,
  matcherGroups: true,
  commands: hookEvents,
}

export interface ClaudeConfigInfo {
  path: string
  exists: boolean
  bellEnabled: boolean
  hooksInstalled: boolean
  raw: string
}

export function readClaudeSettings(): ClaudeConfigInfo {
  const file = settingsPath()
  if (!existsSync(file)) {
    return { path: file, exists: false, bellEnabled: false, hooksInstalled: false, raw: '' }
  }
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Only used to count what is missing, so the path does not matter here.
    const { added } = mergeHooks(CLAUDE, parsed.hooks, '')
    return {
      path: file,
      exists: true,
      bellEnabled: parsed[NOTIF_KEY] === NOTIF_VALUE,
      // Nothing left to add means every hook we install is already there.
      hooksInstalled: added === 0,
      raw,
    }
  } catch {
    return { path: file, exists: true, bellEnabled: false, hooksInstalled: false, raw: '' }
  }
}

/**
 * Installs or removes our Claude Code integration.
 *
 * Every write we make outside our own data folder has an exact inverse, and
 * both directions go through here. An integration you cannot turn off is not a
 * setting, it is damage — and the user's `settings.json` is theirs.
 *
 * The original is backed up before either direction touches it.
 */
/**
 * What the user's config looked like before we touched it.
 *
 * Only the one key needs recording. `preferredNotifChannel` may already hold a
 * value the user chose — someone who works on a Mac too might have it set to
 * `iterm2_with_bell` — and without a note of that, uninstalling would delete a
 * setting we merely overwrote. Kept in our own folder rather than in theirs,
 * because a config file is not a place to leave bookkeeping.
 */
interface PriorState {
  /** The value the key held before we installed, or null if it was absent. */
  notifChannel: string | null
}

function priorStatePath(stateDir: string): string {
  return path.join(stateDir, 'claude-integration.json')
}

function readPriorState(stateDir: string): PriorState | null {
  try {
    return JSON.parse(readFileSync(priorStatePath(stateDir), 'utf8')) as PriorState
  } catch {
    return null
  }
}

export function setClaudeIntegration(
  enabled: boolean,
  stateDir: string,
  iawPath: string
): { ok: boolean; error?: string; path: string } {
  const file = settingsPath()
  try {
    let config: Record<string, unknown> = {}

    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8')
      if (raw.trim()) {
        try {
          config = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return { ok: false, error: 'settings.json is not valid JSON — not touching it', path: file }
        }
      }
      copyFileSync(file, file + '.iaw-backup')
    } else {
      if (!enabled) return { ok: true, path: file } // nothing of ours to remove
      mkdirSync(path.dirname(file), { recursive: true })
    }

    if (enabled) {
      // Recorded on the first install only: installing twice must not overwrite
      // the note with our own value.
      if (!readPriorState(stateDir)) {
        const existing = config[NOTIF_KEY]
        const prior: PriorState = {
          notifChannel: typeof existing === 'string' ? existing : null,
        }
        try {
          mkdirSync(stateDir, { recursive: true })
          writeFileSync(priorStatePath(stateDir), JSON.stringify(prior), 'utf8')
        } catch {
          // Without the note we can still install; uninstall just falls back to
          // removing the key, which is the old behaviour.
        }
      }
      config[NOTIF_KEY] = NOTIF_VALUE
      config.hooks = mergeHooks(CLAUDE, config.hooks, iawPath).hooks
    } else {
      const prior = readPriorState(stateDir)
      // Only ever touch the key if it still holds the value we put there — the
      // user may have changed it since, and that choice is theirs.
      if (config[NOTIF_KEY] === NOTIF_VALUE) {
        if (prior?.notifChannel) config[NOTIF_KEY] = prior.notifChannel
        else delete config[NOTIF_KEY]
      }
      const { hooks } = stripHooks(CLAUDE, config.hooks)
      if (hooks) config.hooks = hooks
      else delete config.hooks
      try {
        unlinkSync(priorStatePath(stateDir))
      } catch {
        /* never recorded */
      }
    }

    writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), path: file }
  }
}
