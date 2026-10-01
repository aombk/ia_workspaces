/**
 * How this app runs git: where to find it, and what it refuses to let a
 * repository run on its behalf.
 *
 * ## Why this is a module
 *
 * Every git call the app makes used to spell its own environment, and they
 * drifted. The resolved PATH (see `toolPath.ts`) reached the git pane's calls
 * and not the file tree's, so a Mac launched from the Dock with only Homebrew's
 * git found nothing for the explorer markers, the diff and the search, while
 * the git pane beside them worked. One place to say it, so it cannot drift.
 *
 * ## Why git needs telling what not to run
 *
 * A repository's own `.git/config` can name programs for git to run, and the
 * app runs git on its own initiative — `git status` for the explorer's markers
 * and the git pane, every few seconds, on whatever folder a workspace points
 * at. Two of those settings fire on calls this app makes unprompted:
 *
 * - `core.fsmonitor` names a command that `git status` runs to ask what
 *   changed. Unpack an archive containing a `.git` with one set, open the
 *   folder, and that command runs — nobody typed `git` at all.
 * - `diff.external`, and diff drivers named in `.gitattributes`, are run by
 *   `git diff` in place of git's own diff.
 *
 * So the first is switched off for every call, and diffs are asked for with
 * `--no-ext-diff`. Neither costs anything a person would notice: the fsmonitor
 * is a speed-up for enormous repositories, and the app's status is already
 * rate-limited and cached. What a person runs in a terminal is untouched —
 * this is only about what the app runs without being asked.
 */
import { toolPath } from './toolPath'

/** Placed before the subcommand on every git call the app makes. */
export const SAFE_GIT_ARGS: readonly string[] = ['-c', 'core.fsmonitor=false']

/** `git <safe flags> ...args`, ready for `execFile('git', …)`. */
export function gitArgs(args: readonly string[]): string[] {
  return [...SAFE_GIT_ARGS, ...args]
}

/**
 * The environment git runs with: the resolved PATH, and never a prompt.
 *
 * A credential prompt has no terminal to appear in here, so it would hang the
 * call until its timeout and then say nothing useful; switched off, git fails
 * at once with a message that can be shown.
 */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: toolPath(), GIT_TERMINAL_PROMPT: '0', ...extra }
}
