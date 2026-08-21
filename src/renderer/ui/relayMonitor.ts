/**
 * The one thing that keeps this machine's account in the shared folder current,
 * and everyone else's on screen.
 *
 * Nothing else drives Relay. There is no agent, no scheduled task and no
 * background service to install on three machines: the app writes its own record
 * while it is running, and stops writing when it stops running. That last part
 * is not a gap to be closed — it is the fact the whole pane is built around. A
 * machine that is switched off has no news, and the honest way to say so is a
 * timestamp, which is why every record carries one and why `stale` below exists.
 *
 * The sweep costs one `git status` per workspace that is a repository, so it is
 * a minute apart rather than the two and a half seconds `repoWatch.ts` uses for
 * the one repository somebody is looking at. *Reading* every other machine's
 * record happens on every one of those sweeps, unconditionally — which is how a
 * machine notices what another one published without watching the folder, and
 * why giving this window focus re-reads immediately. *Writing* is the rare half:
 * `relay.ts` puts nothing on the disk at all for a project nobody has touched.
 */
import { backend } from '../../backend'
import { store } from '../state'
import type { Relay, RelayPresence } from '../../shared/types'

/** Between sweeps. One `git status` per repository workspace, so: not often. */
const POLL_MS = 60 * 1000

/**
 * How long after launch the first sweep runs.
 *
 * Startup is already spawning shells and reading a workspace document, and the
 * answer to "what was the laptop doing" is not needed in the first second of a
 * session. It is needed before the first coffee, which this comfortably beats.
 */
const FIRST_SWEEP_MS = 5000

/**
 * Past this, a record's `open` flag is not to be believed.
 *
 * `open` means "this workspace was on screen when this was written", and since
 * `relay.ts` keeps no heartbeat, a record only gets rewritten when something
 * about the project changes. So a machine left running on an untouched
 * repository goes quiet, and its last record claims to be open indefinitely.
 *
 * This window is what stops that claim being repeated as fact. It is two of
 * `relay.ts`'s settle delays plus a sweep — long enough that a machine actually
 * being worked on keeps re-qualifying, since working on it is what changes the
 * description. It errs one way only: a machine genuinely in use but idle for
 * five minutes stops being called in use, which is a silence rather than a lie.
 */
const LIVE_MS = 2 * 2 * 60 * 1000 + POLL_MS

let latest: Relay = { machine: '', keys: {}, byProject: {}, problem: 'off' }
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

/** Everything the shared folder knows, as of the last sweep. */
export function latestRelay(): Relay {
  return latest
}

/** Whether Relay is on at all — that is, whether a shared folder is set. */
export function relayOn(): boolean {
  return latest.problem !== 'off'
}

/** Called whenever a sweep lands, for anything that draws one. */
export function watchRelay(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Sweeps now rather than waiting for the timer.
 *
 * Called on the four occasions where a minute is too long to wait: the app
 * starting, the window being given focus, a git operation finishing, and the
 * shared folder being changed in settings. The first three are all moments when
 * either what this machine has to say just changed, or somebody has just turned
 * their attention to what the others said.
 */
export function refreshRelayNow(): void {
  void sweep()
}

/** Starts the sweeps. Called once, from the app's own start-up. */
export function initRelayMonitor(): void {
  if (timer) return
  timer = setTimeout(() => void sweep(), FIRST_SWEEP_MS)
  // Coming back to the window is the moment somebody wants to know what the
  // other machines have been doing, and also the moment this one has news worth
  // publishing — you have just sat down at it.
  window.addEventListener('focus', () => void sweep())
}

async function sweep(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  try {
    latest = await backend().relay(store.settings.sharedDir ?? '', entries())
  } catch {
    // An unreachable share — an unmounted drive, a network that is down. The
    // last good answer stays on screen with its timestamps, which is the right
    // thing to show: those records were true when they were written whether or
    // not the folder can be reached this minute.
  }
  for (const fn of listeners) fn()
  timer = setTimeout(() => void sweep(), POLL_MS)
}

/**
 * Every workspace, and which one is being looked at.
 *
 * All of them, not just the ones that are repositories — `relay.ts` asks git
 * and drops the ones that are not, which is the only place that can answer it
 * without a second round trip. A workspace counts as open only when the window
 * has focus: an app left running behind a browser all afternoon is not somebody
 * working on that project, and reporting it as such to two other machines is
 * how a warning learns to be ignored.
 */
function entries() {
  const focused = document.hasFocus()
  const active = store.activeWorkspace?.id
  return store.workspaces.map((workspace) => ({
    cwd: workspace.cwd,
    name: workspace.name,
    open: focused && workspace.id === active,
  }))
}

/**
 * How out of date a record is, in the words a person would use.
 *
 * Every rendering of a record must carry one of these. A machine's account is
 * always the past tense — see `relay.ts` — and the difference between "four
 * minutes ago" and "on Tuesday" is most of what makes it useful.
 */
export function stale(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** True while that machine's `open` flag is recent enough to mean anything. */
export function live(record: RelayPresence, now = Date.now()): boolean {
  return record.open && now - record.at < LIVE_MS
}

/**
 * Every other machine's account of the project in this folder.
 *
 * This machine's own record is dropped, because it is the one thing on screen
 * that the screen already shows better — the git pane beside it is 2.5 seconds
 * old rather than up to a minute, and a row repeating it worse is a row that
 * will eventually contradict it.
 */
export function othersFor(cwd: string): RelayPresence[] {
  const key = latest.keys[cwd]
  if (!key) return []
  return (latest.byProject[key] ?? []).filter((record) => record.machine !== latest.machine)
}
