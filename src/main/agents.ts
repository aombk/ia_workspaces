/**
 * The agents whose hooks Settings can install, and the commands they run.
 *
 * The README has always said the agent protocol takes no tool name and should
 * work for anything that can run `iaw` — while shipping exactly one installer,
 * which made it a claim rather than a fact. This is the file that closes that
 * gap: a second entry, with genuinely nothing agent-specific below the event
 * names.
 *
 * Claude Code keeps its own module. It carries a bell setting and a prior-state
 * record that no other agent needs, and folding those in here would mean an
 * options bag whose fields are empty for everyone but one.
 */
import os from 'node:os'
import path from 'node:path'
import type { AgentHookSpec } from './agentHooks'

/**
 * The command each hook runs, given the absolute path to our shim.
 *
 * Three things about the shape are load-bearing, and all three were learned the
 * hard way on the Claude installer:
 *
 * - **Forward slashes.** A hook is run by whatever shell the agent reaches for
 *   — Git Bash on Windows — and `sh` treats a backslash inside double quotes as
 *   an escape, so a Windows path written the Windows way does not survive.
 * - **Absolute, not the bare word.** `iaw` is only on the PATH of terminals
 *   this app spawned. A bare name works inside one of our panes and fails with
 *   `command not found` everywhere else, which for a Stop hook means an error
 *   on every single turn.
 * - **`|| true` outermost.** The shim forwards to an executable that, in a
 *   portable build, lives in a temp folder deleted when the app exits.
 *   `--quiet` silences the failures our CLI is alive to report; this silences
 *   the ones where it never runs at all. A best-effort notification must never
 *   be able to fail somebody's turn.
 */
function notifyCommands(
  iawPath: string,
  label: string,
  events: { waiting: string; done: string; session?: string }
): Record<string, string> {
  const iaw = `"${iawPath.replace(/\\/g, '/')}"`
  const hush = ' 2>/dev/null || true'
  const out: Record<string, string> = {
    [events.waiting]: `${iaw} notify --quiet --title "${label}" --body "is waiting for you"${hush}`,
    [events.done]: `${iaw} notify --quiet --title "${label}" --body "finished responding"${hush}`,
  }
  if (events.session) out[events.session] = `${iaw} session --quiet${hush}`
  return out
}

/**
 * Gemini CLI — `~/.gemini/settings.json`.
 *
 * The same JSON `hooks` shape as Claude Code but with its own event names, and
 * without matcher groups: Gemini has no matcher-based events, and writing an
 * empty `matcher` key into a config that does not expect one is the sort of
 * thing that turns into a support question.
 *
 * `SessionStart` is subscribed for the notification only, not for `iaw session`
 * — resuming a conversation is Claude-specific by construction (the restored
 * pane re-enters with `claude --resume <id>`), so recording a Gemini session id
 * would store something nothing can act on.
 */
export const GEMINI: AgentHookSpec = {
  id: 'gemini',
  label: 'Gemini CLI',
  settingsPath: () => path.join(os.homedir(), '.gemini', 'settings.json'),
  matcherGroups: false,
  commands: (iawPath) =>
    notifyCommands(iawPath, 'Gemini CLI', { waiting: 'Notification', done: 'AfterAgent' }),
}

/**
 * Codex CLI — `~/.codex/hooks.json`.
 *
 * The file is the same `hooks` object Claude and Gemini use, so the installer
 * needs nothing new. What Codex adds is a second gate: since 0.129 every hook
 * is checked against a `trusted_hash` in `[hooks.state."<key>"]` in
 * `~/.codex/config.toml`, and a hook without a matching entry sits in the
 * review pile and **never fires**.
 *
 * We deliberately do not write that entry, and the reasoning is worth keeping.
 * The hash is a sha256 over a canonical JSON form of the hook definition that
 * has to be byte-identical to what `codex-rs` produces — a shape nobody has
 * documented, that other projects have obtained by reading Codex's source, and
 * that is free to change in any release. Forging it has exactly two outcomes:
 * it works, or the hook silently does nothing while the UI claims it is
 * installed. The second is the worse failure this app can ship, because the
 * whole feature is "tell me when the agent needs me" and a silent one is
 * indistinguishable from an agent that never needed you.
 *
 * Codex already has the honest path: it notices the unapproved hook and asks.
 * One `/hooks` in Codex, once, and the approval is real rather than
 * reconstructed — and it keeps working when the hash format moves.
 */
export const CODEX: AgentHookSpec = {
  id: 'codex',
  label: 'Codex CLI',
  settingsPath: () => path.join(os.homedir(), '.codex', 'hooks.json'),
  matcherGroups: false,
  commands: (iawPath) =>
    notifyCommands(iawPath, 'Codex CLI', { waiting: 'PermissionRequest', done: 'Stop' }),
  note:
    'Codex checks each hook against a trust entry before running it, so it will ' +
    'ask you to approve this one — run /hooks in Codex once and it is live. We ' +
    'do not write that entry ourselves: the hash format is undocumented and ' +
    'changes between releases, and getting it wrong makes the hook silently ' +
    'never fire while this screen claims it is installed.',
}

/** Everything Settings offers beyond Claude Code, in the order it lists them. */
export const AGENTS: readonly AgentHookSpec[] = [CODEX, GEMINI]

export function agentById(id: string): AgentHookSpec | undefined {
  return AGENTS.find((a) => a.id === id)
}
