/**
 * One question about one repository, asked once however many panes want it.
 *
 * The two git panes each ran their own timer — 2.5 seconds and 3 seconds — and
 * each timer spawned a `git status` for the same folder. With both open that is
 * two processes a second for one answer, and on Windows each one is a process
 * creation plus whatever the antivirus does to it. `src/main/git.ts` already
 * documents measuring 26 of 66 concurrent `git.exe` processes coming from this
 * app; this is the other half of that problem, from the renderer's side.
 *
 * So: one watcher per repository root, shared by everything looking at it,
 * ref-counted so it stops the moment the last pane goes. Two panes on the same
 * folder now cost exactly what one did.
 *
 * Visibility is asked of the subscribers rather than assumed. A pane on a
 * workspace tab nobody is looking at is as unseen as a minimised window, and
 * the old panes each had to remember to check — here a watcher with no visible
 * subscriber simply does not run, and a pane that forgets to implement the
 * check is merely wasteful rather than wrong.
 */
import { backend } from '../../backend'
import type { RepoStatus } from '../../shared/types'
import { readRemote, type RemoteInfo } from '../../shared/gitHosts'

/** How often the status is re-read while something visible is watching. */
const POLL_MS = 2500

/** What a watcher hands out: git's answer, plus the one thing derived from it. */
export interface RepoSnapshot {
  status: RepoStatus
  /**
   * Where the copy online is, read from the remote's address.
   *
   * Derived here rather than in each view because every label that used to say
   * "GitHub" needs it, and parsing the same URL in four places is four chances
   * to disagree about what a self-hosted GitLab is called.
   */
  remote: RemoteInfo | null
}

export interface RepoSubscriber {
  /** False for a pane on a tab nobody is looking at, or in a minimised window. */
  isVisible(): boolean
  onSnapshot(snapshot: RepoSnapshot): void
}

interface Watch {
  root: string
  subscribers: Set<RepoSubscriber>
  timer: ReturnType<typeof setInterval> | null
  /** Guards against a slow `git status` overlapping the next tick. */
  busy: boolean
  last: RepoSnapshot | null
  /** Everything that can change what is drawn, as one string. */
  signature: string
}

const watches = new Map<string, Watch>()

/**
 * Starts watching a folder, and returns the way to stop.
 *
 * The subscriber is called immediately with the last known answer when there is
 * one, which is what makes switching between two panes on the same repository
 * instant rather than a fresh round trip into an empty pane.
 */
export function watchRepo(root: string, subscriber: RepoSubscriber): () => void {
  let watch = watches.get(root)
  if (!watch) {
    watch = { root, subscribers: new Set(), timer: null, busy: false, last: null, signature: '' }
    watches.set(root, watch)
  }
  watch.subscribers.add(subscriber)

  if (watch.last) subscriber.onSnapshot(watch.last)
  if (!watch.timer) {
    watch.timer = setInterval(() => void tick(root, false), POLL_MS)
    window.addEventListener('focus', onWindowFocus)
  }
  void tick(root, true)

  return () => {
    const current = watches.get(root)
    if (!current) return
    current.subscribers.delete(subscriber)
    if (current.subscribers.size) return
    if (current.timer) clearInterval(current.timer)
    watches.delete(root)
    if (!watches.size) window.removeEventListener('focus', onWindowFocus)
  }
}

/**
 * Asks again right now, whatever the timer was going to do.
 *
 * Called after every operation, and with `force` — an operation that changed
 * nothing still has to redraw, or the buttons it disabled while it ran stay
 * disabled until something else happens to change.
 */
export function refreshRepo(root: string): Promise<void> {
  return tick(root, true)
}

/**
 * Drops the remembered answer so the next draw is not the previous one.
 *
 * Wanted after an operation whose result the *signature* cannot see — picking a
 * few lines out of a file leaves the file's porcelain letters exactly as they
 * were, and without this the pane would decide nothing had changed and leave
 * the old patch on screen.
 */
export function invalidateRepo(root: string): void {
  const watch = watches.get(root)
  if (watch) watch.signature = ''
}

const onWindowFocus = () => {
  for (const root of watches.keys()) void tick(root, true)
}

async function tick(root: string, force: boolean): Promise<void> {
  const watch = watches.get(root)
  if (!watch || watch.busy) return
  if (!force && (document.hidden || !anyVisible(watch))) return

  watch.busy = true
  let status: RepoStatus
  try {
    status = await backend().git.repoStatus(root)
  } catch {
    // A failed round trip is not news: the folder may have gone, or the main
    // process may be busy starting up. The last good answer stays on screen.
    return
  } finally {
    watch.busy = false
  }
  // Unsubscribed while the call was in flight.
  if (!watches.has(root)) return

  const signature = signatureOf(status)
  if (signature === watch.signature) return
  watch.signature = signature

  const snapshot: RepoSnapshot = { status, remote: status.remoteUrl ? readRemote(status.remoteUrl) : null }
  watch.last = snapshot
  for (const subscriber of watch.subscribers) subscriber.onSnapshot(snapshot)
}

function anyVisible(watch: Watch): boolean {
  for (const subscriber of watch.subscribers) if (subscriber.isVisible()) return true
  return false
}

/**
 * Everything a view draws from, flattened.
 *
 * Redrawing a list of four hundred rows every two and a half seconds would
 * fight the scroll position and the selection for no reason, so the views are
 * only told when one of these actually moved.
 */
function signatureOf(status: RepoStatus): string {
  return [
    status.root,
    status.branch,
    status.headFull,
    status.upstream,
    status.ahead,
    status.behind,
    status.inProgress,
    status.hasRemote,
    status.remoteUrl,
    status.unsent.length,
    status.lastSave?.sha,
    ...status.files.map((f) => `${f.picked}${f.changed}${f.untracked ? '?' : ''}${f.repoPath}`),
  ].join('\n')
}
