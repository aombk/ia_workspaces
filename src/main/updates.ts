/**
 * The newest published release, read from GitHub.
 *
 * The *policy* — when to check, what is worth interrupting somebody for, how
 * each outcome reads — lives in `renderer/updates.ts` and is not repeated here.
 * This is only the lookup, and it is in the host because the renderer runs under
 * a CSP whose `connect-src` allows nothing but `self` and the IPC origins: a
 * fetch from that side is blocked before it leaves.
 *
 * The releases are made by `tools/release.mjs`, which tags `v` and the version
 * in `package.json`. So the tag is the version with a `v` in front, and taking
 * it off again is the whole of the translation.
 *
 * Unauthenticated, deliberately. GitHub allows sixty of these an hour per
 * address, which is sixty launches an hour, and a token would mean this app
 * holding a credential for the sake of a version string.
 */
import { net } from 'electron'
import type { LatestReleaseResult } from '../shared/types'

/** The repository the releases live in. */
const REPO = 'aombk/ia_workspaces'

/**
 * Long enough for a slow connection, short enough that a launch is not held up.
 *
 * Nothing waits on this — the startup check is fired and forgotten, and the
 * settings panel shows its own "checking" state — but a request with no
 * deadline is a socket that can stay open until the app quits.
 */
const TIMEOUT_MS = 6000

export async function latestRelease(): Promise<LatestReleaseResult> {
  try {
    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${REPO}/releases/latest`
    )
    // A repository with no published release answers 404, and that is not a
    // failure — it is a build from before the first release, or one whose only
    // release is still a draft. Drafts and prereleases are excluded by this
    // endpoint, which is why it is the one asked.
    if (response.status === 404) return { ok: true, release: null }
    if (response.status === 403) {
      return { ok: false, error: 'GitHub is rate-limiting this address. Try again in an hour.' }
    }
    if (!response.ok) return { ok: false, error: `GitHub answered ${response.status}.` }

    const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown }
    const tag = typeof body.tag_name === 'string' ? body.tag_name : ''
    if (!tag) return { ok: false, error: 'GitHub answered without a tag name.' }

    return {
      ok: true,
      release: {
        version: tag.replace(/^v/i, ''),
        url: typeof body.html_url === 'string' ? body.html_url : `https://github.com/${REPO}/releases`,
      },
    }
  } catch (err) {
    // Offline is the ordinary case here, not an exception worth dressing up.
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * `net.fetch` rather than Node's, for the reason the docs give: it goes through
 * Chromium's own stack, so a machine whose proxy is configured in the system
 * is a machine where this works without being told about the proxy.
 */
async function fetchWithTimeout(url: string): Promise<Response> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    return await net.fetch(url, {
      signal: abort.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub asks for one and answers 403 without it.
        'User-Agent': 'ia_workspaces',
      },
    })
  } finally {
    clearTimeout(timer)
  }
}
