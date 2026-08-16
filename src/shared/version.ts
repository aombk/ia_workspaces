/**
 * Comparing two version strings, and nothing else.
 *
 * Its own file because it is the one part of the update check that can be
 * wrong without anything failing — a build that quietly stops offering updates
 * looks exactly like a build with no updates to offer — and a file that imports
 * nothing is a file a test can bundle on its own.
 */

/** A plain dotted number, and nothing else: `1`, `1.2`, `1.2.0`. */
const PLAIN = /^\d+(\.\d+)*$/

/**
 * Whether `latest` is a version after `current`.
 *
 * Compared field by field as numbers, so 1.10.0 is after 1.9.0 — which string
 * comparison gets backwards, and which is the release everybody discovers it
 * on. A missing field counts as 0, so 1.2 and 1.2.0 are the same version.
 *
 * A `latest` that is not a plain dotted number is never newer. Ranking
 * `1.2.0-beta.1` against `1.2.0` is a decision with two defensible answers and
 * this makes neither: it declines, so a pre-release tag cannot offer itself to
 * somebody running the stable build. `tools/release.mjs` does not produce those
 * tags, and GitHub's own "latest" already skips releases marked pre-release —
 * this is the third guard, and the only one that survives a hand-made tag.
 */
export function isNewer(latest: string, current: string): boolean {
  if (!PLAIN.test(latest.trim())) return false
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const a = parts(latest)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}
