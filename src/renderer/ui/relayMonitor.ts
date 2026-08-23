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
import type { Relay, RelayPresence, RelayPublishEntry } from '../../shared/types'

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
 * How long a project nobody is looking at may go unchecked.
 *
 * Checking one costs a `git status`, which on Windows is a process creation
 * plus whatever the antivirus does to it — `git.ts` documents measuring 26 of
 * 66 concurrent `git.exe` processes coming from this app. Asking every
 * workspace every minute meant sixteen of those a minute on a machine with
 * sixteen workspaces, to discover sixteen times a minute that nothing had
 * changed.
 *
 * So the project on screen is checked every sweep and the rest are checked
 * rarely. Little is lost: a project nobody is looking at changes because *you*
 * changed it, and the three moments where that is true — a git operation
 * finishing, the window regaining focus, switching workspace — each force a
 * sweep of their own already.
 */
const STALE_MS = 10 * 60 * 1000

/**
 * How many neglected projects are checked per sweep.
 *
 * Spread rather than done together: sixteen `git status` calls in one tick is
 * the same burst whether it happens every minute or every ten, and the point of
 * this is to stop the app producing bursts at all.
 */
const IDLE_PER_SWEEP = 2

/** When each workspace folder was last asked about. */
const checkedAt = new Map<string, number>()

/**
 * Where the commands come from, registered rather than imported.
 *
 * `paneHistory.ts` owns the cache and already imports this file for the other
 * direction, so importing it back would make a cycle. A seam the owner fills in
 * costs one line and cannot be got wrong by module ordering.
 */
let commandsFor: ((cwd: string) => string[]) | null = null

export function setCommandSource(fn: (cwd: string) => string[]): void {
  commandsFor = fn
}

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

let latest: Relay = { machine: '', keys: {}, byProject: {}, commandsByProject: {}, problem: 'off' }
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
function entries(): RelayPublishEntry[] {
  const focused = document.hasFocus()
  const active = store.activeWorkspace?.id
  const sharing = store.settings.shareCommands
  const now = Date.now()

  // The one on screen, always: it is the only project that can be changing
  // while nobody has told us so.
  const wanted = store.workspaces.filter((workspace) => workspace.id === active)

  // Then a couple of the most neglected. Sorted by how long each has gone
  // unchecked, so every project comes round in turn rather than the same two
  // being picked forever.
  const idle = store.workspaces
    .filter((workspace) => workspace.id !== active)
    .map((workspace) => ({ workspace, at: checkedAt.get(workspace.cwd) ?? 0 }))
    .filter(({ at }) => now - at > STALE_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, IDLE_PER_SWEEP)
  for (const { workspace } of idle) wanted.push(workspace)

  for (const workspace of wanted) checkedAt.set(workspace.cwd, now)

  return wanted.map((workspace) => ({
    cwd: workspace.cwd,
    name: workspace.name,
    open: focused && workspace.id === active,
    // Only when asked for. The main process refuses to write them without a
    // passphrase as well, so there are two independent gates on the one payload
    // that cannot be un-published.
    commands: sharing ? (commandsFor?.(workspace.cwd) ?? undefined) : undefined,
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
/**
 * What every other machine has run in the project this folder belongs to.
 *
 * Empty unless commands are being shared and this machine's passphrase opens
 * what the others wrote — see `shareCrypto.ts`. Each entry says which machine
 * it came from, because a command that only makes sense on a Mac is worth being
 * able to recognise before it lands on a Windows prompt.
 */
export function commandsElsewhere(cwd: string): { label: string; commands: string[] }[] {
  const key = latest.keys[cwd]
  if (!key) return []
  return latest.commandsByProject[key] ?? []
}

export function othersFor(cwd: string): RelayPresence[] {
  const key = latest.keys[cwd]
  if (!key) return []
  return (latest.byProject[key] ?? []).filter((record) => record.machine !== latest.machine)
}

/**
 * Whether another machine has work you have not seen, and what to say about it.
 *
 * The whole of what Relay reports now. Everything that is committed and pushed
 * is not news and gets no mark: a badge that appears on every workspace is a
 * badge nobody reads, and the pane this replaced reported the calm case at
 * equal length, which is what made it hard to read at a glance.
 *
 * Null means nothing to say, which is the ordinary answer and must stay cheap —
 * this runs for every workspace on every sidebar render.
 */
export function relayWarning(cwd: string): { title: string } | null {
  const others = othersFor(cwd).filter((record) => record.unsent || record.changed.length)
  if (!others.length) return null

  const lines: string[] = []
  for (const record of others) {
    lines.push(`${record.label} — ${stale(record.at)}`)
    if (record.branch) lines.push(`  on branch ${record.branch} (line of saves)`)
    if (record.unsent) {
      const shown = record.unsentSubjects.slice(0, SUBJECTS_SHOWN)
      const rest = record.unsent - shown.length
      const named = shown.map((subject) => `“${subject}”`).join(', ')
      lines.push(
        `  ${plural(record.unsent, 'unpushed commit')} (saves not sent)${named ? `: ${named}` : ''}${
          rest > 0 ? `, and ${rest} more` : ''
        }`
      )
    }
    if (record.behind) lines.push(`  ${plural(record.behind, 'commit')} behind (saves not brought in)`)
    if (record.changed.length) {
      lines.push(`  ${plural(record.changed.length, 'uncommitted file')} (changed, not saved):`)
      for (const file of record.changed.slice(0, FILES_SHOWN)) lines.push(`    ${file}`)
      const rest = record.changed.length - FILES_SHOWN
      if (rest > 0) lines.push(`    and ${rest} more`)
    }
    if (record.untracked) lines.push(`  ${plural(record.untracked, 'untracked file')} (new to git)`)
  }

  // Said once at the end rather than per line. Everything above is what some
  // other machine last managed to report, and the reason it is worth a mark at
  // all is that this machine cannot see over there now.
  lines.push('')
  lines.push('Reported by that machine into your shared folder. Nothing here can reach it.')
  return { title: lines.join('\n') }
}

/** Files listed in the tooltip before the rest become a count. */
const FILES_SHOWN = 6

/** Unsent save messages listed before the rest become a count. */
const SUBJECTS_SHOWN = 3

/**
 * The one line the Git pane shows about the other machines.
 *
 * Lives here rather than in `git/` because it is Relay's sentence and Relay's
 * rules — past tense, timestamped, never a claim about right now. The Git pane
 * asks for it and places it; what it is allowed to say is decided in one file.
 *
 * Null when there is nothing worth a line, which is the ordinary case.
 */
export function relayLineFor(cwd: string): string | null {
  const others = othersFor(cwd).filter((record) => record.unsent || record.changed.length)
  if (!others.length) return null

  const worst = others[0]
  const parts: string[] = []
  if (worst.unsent) parts.push(`${plural(worst.unsent, 'unpushed commit')} (saves not sent)`)
  if (worst.changed.length)
    parts.push(`${plural(worst.changed.length, 'uncommitted file')} (changed, not saved)`)
  if (!parts.length) return null

  const where = worst.branch ? ` on ${worst.branch}` : ''
  const rest = others.length > 1 ? `, and ${others.length - 1} other machine${others.length > 2 ? 's' : ''}` : ''
  return `${worst.label} had ${parts.join(' and ')}${where}, ${stale(worst.at)}${rest}.`
}

/** "1 save", "2 saves" — the plural nobody should have to think about. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
