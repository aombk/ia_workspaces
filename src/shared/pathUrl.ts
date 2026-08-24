/**
 * Turning a path on disk into one URL segment, and back.
 *
 * Extracted from `images.ts` when documents needed the same trick over a
 * different scheme. The encoding is the interesting part and it is worth having
 * once: two copies of a base64url codec is two places for a Windows path to
 * come back wrong.
 *
 * base64url, and a single path segment, because the alternative is a decade of
 * escaping bugs: Windows paths carry backslashes, drive letters look like URL
 * schemes, and real filenames contain `#`, `?`, `%` and every kind of unicode.
 * Encoding the whole path once means the URL parser never sees any of it.
 *
 * `btoa` is not used directly on the string — it throws on any code point above
 * U+00FF, which is most of the filenames this has to survive — so the path goes
 * through UTF-8 first and `btoa` only ever sees bytes.
 */

/** The prefix every URL of `scheme` starts with. One host, `f`, meaning file. */
export function schemePrefix(scheme: string): string {
  return `${scheme}://f/`
}

/** Encodes a path into a URL on `scheme`. */
export function encodePathUrl(scheme: string, target: string): string {
  const bytes = new TextEncoder().encode(target)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return schemePrefix(scheme) + b64
}

/**
 * The body of a URL this file minted: base64url and nothing else.
 *
 * Checked before decoding rather than trusted, because `atob` is more
 * forgiving than `encodePathUrl` is: it accepts `+`, `/` and `=` too. A body
 * containing a literal `/` is two path segments, which is precisely the thing
 * the encoding exists to make impossible — so a URL shaped like one we could
 * never have produced is rejected as not ours, rather than decoded into
 * something plausible.
 */
const BASE64URL_BODY = /^[A-Za-z0-9_-]*$/

/**
 * The inverse, for a handler. Null for anything that is not one of ours.
 *
 * "Not ours" is meant strictly, and there are four ways to fail it: the wrong
 * scheme, a body that is not base64url, bytes that are not valid UTF-8, and
 * the empty path. The third is why the decoder is `fatal` — a non-fatal
 * `TextDecoder` substitutes U+FFFD and returns a *string*, so garbage would
 * come back as a path made of replacement characters and this function would
 * have quietly broken its own promise. The protocol handlers do check the
 * result again before serving anything, but a second line of defence should
 * not be the one doing the work.
 *
 * One known asymmetry, benign but real: `TextEncoder` replaces an unpaired
 * surrogate with U+FFFD on the way in, so a Windows filename carrying one
 * round-trips to a slightly different path. That resolves to a file which does
 * not exist — a miss, never a different file — which is the right direction for
 * the error to fall.
 */
export function decodePathUrl(scheme: string, url: string): string | null {
  const prefix = schemePrefix(scheme)
  if (!url.startsWith(prefix)) return null
  // A fragment is not part of what was encoded, and a handler has no business
  // failing over one. Normally it never gets this far — the engine strips it
  // before a request is made — but the reader pane hangs a counter off the end
  // of a PDF's URL to force a reload past the cache, and a decoder that broke
  // on that would turn a Reload button into a 400. Dropped rather than
  // tolerated, so what is checked below is exactly what was minted above.
  const hash = url.indexOf('#', prefix.length)
  const body = hash === -1 ? url.slice(prefix.length) : url.slice(prefix.length, hash)
  if (!BASE64URL_BODY.test(body)) return null
  const b64 = body.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    // `|| null` also covers the empty path, which no file has and which is
    // therefore indistinguishable from a failure as far as any caller cares.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) || null
  } catch {
    return null
  }
}
