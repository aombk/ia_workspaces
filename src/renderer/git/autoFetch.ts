/**
 * When projects are fetched without anyone pressing peek.
 *
 * Three moments, each its own setting: shortly after the app starts, every
 * so many minutes, and when a git pane is shown or clicked into. They exist
 * because Relay can only see work another machine has *not* pushed. Work it
 * has pushed is on the remote, and this machine learns about it only by
 * fetching — until then the git pane says "nothing to bring in" with complete
 * confidence and no information.
 *
 * This file only decides *when*. Whether a fetch actually happens — throttled
 * per checkout, backed off after a failure, never asking for a password — is
 * decided by the host, so the three triggers cannot add up to more than one
 * fetch per repository however they overlap.
 */
import { backend } from '../../backend'
import { hostLabel, readRemote } from '../../shared/gitHosts'
import type { FetchNews } from '../../shared/types'
import { store } from '../state'
import { refreshRelayNow } from '../ui/relayMonitor'
import { showToast } from '../ui/toast'
import { fetchNewsToast } from './common'
import { invalidateRepo, refreshRepo } from './repoWatch'

/** Long enough that starting the app is not also a burst of network traffic. */
const START_DELAY_MS = 20_000

/** How often the timer checks whether a sweep is due. */
const TICK_MS = 60_000

/** A git pane shown twice in a minute fetches once. */
const PANE_MIN_AGE_MS = 2 * 60 * 1000

/** Bounds on the interval, whatever a settings file says. */
const MIN_MINUTES = 1
const MAX_MINUTES = 24 * 60

let lastSweep = 0
let started = false

/** The interval in minutes, or 0 for never. */
export function fetchInterval(): number {
  const raw = Number(store.settings.gitFetchEveryMinutes)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(raw)))
}

/**
 * Every workspace folder this machine can fetch for.
 *
 * Not one whose shells run over SSH: its folder is a path on another machine,
 * and whatever happens to exist at that path here is not that project.
 */
function folders(): string[] {
  const seen = new Set<string>()
  for (const workspace of store.workspaces) {
    if (!workspace.cwd || workspace.shell === 'ssh') continue
    seen.add(workspace.cwd)
  }
  return [...seen]
}

/** Fetches one folder, and redraws whatever shows it if anything arrived. */
async function fetchOne(cwd: string, minAgeMs: number): Promise<boolean> {
  try {
    const res = await backend().git.backgroundFetch(cwd, minAgeMs)
    if (res.status !== 'fetched' || !res.root) return false
    invalidateRepo(res.root)
    await refreshRepo(res.root)
    if (res.arrived) announce(res.root, res.arrived)
    return true
  } catch {
    // A host without this call, or a folder that vanished. Nothing to say:
    // nobody asked for this fetch.
    return false
  }
}

/**
 * Says what a fetch nobody asked for brought.
 *
 * Only ever new saves — `arrived` is measured against where the branch online
 * stood before this fetch — so a project left behind for a week is announced
 * once, when its saves land, and not on every sweep after. A fetch that found
 * nothing stays silent, as it always has.
 */
function announce(root: string, news: FetchNews): void {
  void backend()
    .git.repoStatus(root)
    .then((status) => {
      const where = hostLabel(status.remoteUrl ? readRemote(status.remoteUrl) : null)
      const { title, body } = fetchNewsToast(news, where)
      const project = root.split(/[\\/]/).filter(Boolean).pop() ?? root
      showToast(`${project}: ${title}`, body, { timeout: 15000 })
    })
    .catch(() => {})
}

/**
 * Every project, once. The host queues them two at a time, so this simply
 * hands them all over and waits.
 */
async function sweep(minAgeMs: number): Promise<void> {
  lastSweep = Date.now()
  const results = await Promise.all(folders().map((cwd) => fetchOne(cwd, minAgeMs)))
  // Behind counts just changed, and they are part of this machine's record.
  if (results.some(Boolean)) refreshRelayNow()
}

/** Starts the startup fetch and the interval. Once per app. */
export function initAutoFetch(): void {
  if (started) return
  started = true

  setTimeout(() => {
    if (store.settings.gitFetchOnStart) void sweep(0)
    // Counted from now either way, so the first interval sweep is a full
    // interval after starting rather than straight after the startup one.
    lastSweep = Date.now()
  }, START_DELAY_MS)

  setInterval(() => {
    const minutes = fetchInterval()
    if (!minutes) return
    const every = minutes * 60_000
    if (Date.now() - lastSweep < every) return
    // A little under the interval, so a project fetched a few seconds into
    // the last sweep is not skipped by this one for being a few seconds young.
    void sweep(every - TICK_MS / 2)
  }, TICK_MS)
}

/** A git pane was shown or clicked into. */
export function fetchForGitPane(cwd: string): void {
  if (!store.settings.gitFetchOnGitPane || !cwd) return
  void fetchOne(cwd, PANE_MIN_AGE_MS).then((arrived) => {
    if (arrived) refreshRelayNow()
  })
}
