import { backend } from '../backend'
import { store } from './state'
import { showToast } from './ui/toast'
import { isNewer } from '../shared/version'
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
 * Where a newer release is looked up: the GitHub releases of this repository.
 *
 * The releases are published by `tools/release.mjs`, which tags `v` and the
 * version in package.json — so the tag with its `v` removed is a version that
 * can be compared with the running one, and `main/updates.ts` does the removing.
 *
 * The fetch is the host's, not this file's: the renderer runs under a CSP whose
 * `connect-src` allows only `self` and the IPC origins, so an outbound request
 * from here is blocked before it leaves. What stays here is the decision, which
 * is the part worth reading in one place.
 *
 * A repository with nothing published yet reads as `unconfigured` rather than
 * as an error, because that is what it is: this build is newer than any release,
 * and there is nothing for somebody to act on.
 */
async function fetchLatest(current: string): Promise<UpdateCheck> {
  const result = await backend().latestRelease()
  if (!result.ok) return { state: 'error', current, error: result.error }
  if (!result.release) return { state: 'unconfigured', current }

  const { version: latest, url } = result.release
  return isNewer(latest, current)
    ? { state: 'available', current, latest, url }
    : { state: 'current', current }
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
