/**
 * Serving sound and video to the renderer.
 *
 * The third sibling of `imageProtocol.ts` and `docProtocol.ts`, for the reason
 * the first of them sets out at length. What is different here is the `Range`
 * header, and it is not an optimisation.
 *
 * A media element does not download a file and then play it. It asks for the
 * first few hundred kilobytes, reads the header, and from then on asks for the
 * byte ranges it needs — and every seek is a fresh range request. A handler
 * that answers `200` with the whole body to all of them still *plays*, which is
 * what makes this easy to get wrong: the bug does not show up until someone
 * drags the scrubber on a file big enough to matter, and then the player
 * re-downloads the entire video to move by a second. On a 4 GB screen capture
 * that is the difference between instant and unusable.
 *
 * So this answers `206 Partial Content` with exactly the slice asked for, and
 * advertises `Accept-Ranges: bytes` so the element knows it can. The arithmetic
 * lives in `shared/media.ts` next to its tests, because an off-by-one in a
 * range is not a crash — it is a video that stalls one frame from the end.
 */
import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import {
  MEDIA_SCHEME,
  decodeMediaPath,
  isMediaPath,
  mediaContentType,
  parseRange,
} from '../shared/media'

/**
 * Must run before `app.whenReady`, like the other two.
 *
 * **`standard: true`, and this one is not a matter of taste.** The image and
 * document schemes are registered non-standard and work perfectly; a `<video>`
 * on a non-standard scheme fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` even though
 * the range requests are answered correctly and `canPlayType` says the codec is
 * supported. Measured, not guessed: the same file over `file://` plays, over
 * this scheme with `standard: false` gives error 4, and over this scheme with
 * `standard: true` plays. Nothing else in the privilege set changes the result.
 *
 * The reason is that a standard scheme is hierarchical and gets a real origin,
 * and Chromium's media stack wants one before it will hand a stream to a
 * decoder. Escaping the origin is not a new risk here: `decodePathUrl` accepts
 * a base64url body and nothing else, so `..` and `/` cannot appear in a URL we
 * would decode.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, bypassCSP: false },
    },
  ])
}

/** Must run after `app.whenReady`. */
export function serveMedia(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const target = decodeMediaPath(request.url)
    if (!target) return new Response('bad request', { status: 400 })

    // As with the other two, the extension check is not what makes this safe —
    // the renderer is ours and could ask for any path. It is here so a bug on
    // our side surfaces as a pane that will not play rather than as this
    // handler streaming a private key into a `<video>`.
    if (!isMediaPath(target)) return new Response('not media', { status: 403 })

    let size: number
    try {
      const info = await stat(target)
      if (!info.isFile()) return new Response('not a file', { status: 404 })
      size = info.size
    } catch {
      return new Response('not found', { status: 404 })
    }

    const type = mediaContentType(target)
    const range = parseRange(request.headers.get('range'), size)

    // No `Range`, or one we do not serve: the whole file, and the header that
    // tells the element it may ask for parts next time.
    if (!range) {
      return new Response(toWeb(createReadStream(target)), {
        status: 200,
        headers: {
          'content-type': type,
          'content-length': String(size),
          'accept-ranges': 'bytes',
        },
      })
    }

    const length = range.end - range.start + 1
    return new Response(toWeb(createReadStream(target, { start: range.start, end: range.end })), {
      status: 206,
      headers: {
        'content-type': type,
        'content-length': String(length),
        'accept-ranges': 'bytes',
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
      },
    })
  })
}

/**
 * A Node stream as the web stream `Response` wants.
 *
 * Cast because Node's `ReadableStream` and the DOM's are structurally the same
 * object here but come from two different type declarations — `@types/node`
 * ships its own, and the renderer's DOM lib ships the other.
 */
function toWeb(stream: ReturnType<typeof createReadStream>): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream
}
