import { backend } from '../backend'
import { store } from './state'
import { showToast } from './ui/toast'
import type { UpdateCheck } from '../shared/types'

/**
 * Version reporting and update checks.
 *
 * The policy lives here — when to check, what counts as worth interrupting for,
 * how each outcome reads — and it is finished. What is not decided is where a
 * newer release is looked up, so that is isolated to `fetchLatest` below and
 * nothing else has to change when it is chosen.
 */

let cachedVersion: string | null = null

/** Asked of the host once; it cannot change while the app is running. */
export async function appVersion(): Promise<string> {
  cachedVersion ??= await backend().appVersion()
  return cachedVersion
}

/**
 * Where a newer release would be looked up. Deliberately not implemented.
 *
 * The mechanism has not been chosen — a GitHub releases feed, a JSON manifest
 * on a server, an updater plugin — and inventing one would mean
 * shipping a network call to an address that does not exist, which fails in a
 * way that looks like a bug rather than like a decision still to be made.
 *
 * To wire it up, return `available` or `current` from whichever source wins.
 * The fetch itself belongs in the host, not here: the renderer runs under a CSP
 * whose `connect-src` allows only `self` and the IPC origins, so an outbound
 * request from this file is blocked before it leaves. Add a method to the
 * Backend contract, implement it in `main/`, and call it
 * from this function.
 */
async function fetchLatest(current: string): Promise<UpdateCheck> {
  return { state: 'unconfigured', current }
}

/** Never throws: a failed check is an outcome the UI knows how to show. */
export async function checkForUpdates(): Promise<UpdateCheck> {
  const current = await appVersion()
  try {
    return await fetchLatest(current)
  } catch (err) {
    return { state: 'error', current, error: err instanceof Error ? err.message : String(err) }
  }
}

/** One line of prose per outcome, shared by the panel and the startup toast. */
export function describeUpdate(result: UpdateCheck): string {
  switch (result.state) {
    case 'available':
      return `Version ${result.latest} is available. You have ${result.current}.`
    case 'current':
      return `Up to date — ${result.current} is the latest.`
    case 'unconfigured':
      return 'No update source is configured for this build yet.'
    case 'error':
      return `Could not check: ${result.error}`
  }
}

/**
 * The check that runs shortly after launch.
 *
 * Silent unless there is genuinely something new. A failed check says nothing:
 * the network being down is not the user's problem to act on, and an app that
 * reports "you are up to date" on every launch teaches you to dismiss its
 * notices unread — which is the wrong reflex for the one launch that matters.
 */
export async function checkForUpdatesAtStartup(): Promise<void> {
  if (!store.settings.checkUpdatesAtStartup) return

  const result = await checkForUpdates()
  if (result.state !== 'available') return

  const url = result.url
  showToast(`Version ${result.latest} is available`, `You are running ${result.current}.`, {
    timeout: 12000,
    ...(url ? { onClick: () => void backend().openExternal(url) } : {}),
  })
}
