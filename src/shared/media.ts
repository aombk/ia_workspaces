/**
 * Which files play, and how they reach the pane.
 *
 * The third of the same shape — `images.ts` for pictures, `docs.ts` for
 * documents, this for sound and video. All three exist for one reason, written
 * out at length in `main/imageProtocol.ts`: the renderer is a `file://`
 * document with an opaque origin, so it cannot load anything else off disk, and
 * widening the CSP to `file:` would hand that reach to every tag on the page.
 *
 * A scheme of its own rather than a fourth extension on the image one, for the
 * same reason documents got theirs: the directives are different. An image
 * arrives through `img-src`, a PDF through `object-src` and `frame-src`, and
 * these through `media-src`. Three schemes keep three grants separate, so a
 * tag injected into rendered markdown can reach exactly one of them.
 */
import { extensionOf } from './editorModes'
import { decodePathUrl, encodePathUrl } from './pathUrl'

/**
 * Sound Chromium decodes.
 *
 * Chosen the same way the image list was: by what the engine will actually
 * play, since that is what renders it. A format the decoder does not know is a
 * pane with a dead transport bar in it, which is worse than the file staying a
 * row in the tree.
 *
 * `m4a` and `aac` are AAC, which Chromium plays in the desktop builds Electron
 * ships. Absent, and deliberately: `wma`, `aiff`, `alac`, and the tracker and
 * module formats — real audio files that a browser engine will not open.
 */
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'] as const

/**
 * Video Chromium decodes.
 *
 * `mov` is here and is the one worth a word: it is a QuickTime container, but
 * the container is ISO base media — the same box layout as `mp4` — and the
 * codec inside is normally H.264. Chromium plays those. A `.mov` carrying
 * ProRes or an old Sorenson codec will not play, and that is a codec the engine
 * lacks rather than a container it refuses.
 *
 * Absent: `avi`, `mkv`, `wmv`, `flv`, `m2ts`. Common, and not decodable here.
 *
 * `ogv` was on this list and came off it: Theora is gone from Chromium, and
 * `canPlayType('video/ogg; codecs="theora"')` answers `""` in the Electron this
 * ships with. Offering it would be a pane with a dead transport bar, which
 * `images.ts` already argues is worse than the file simply not opening.
 */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm'] as const

const AUDIO_RE = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i')
const VIDEO_RE = new RegExp(`\\.(${VIDEO_EXTENSIONS.join('|')})$`, 'i')

export function isAudioPath(path: string): boolean {
  return AUDIO_RE.test(path)
}

export function isVideoPath(path: string): boolean {
  return VIDEO_RE.test(path)
}

export function isMediaPath(path: string): boolean {
  return isAudioPath(path) || isVideoPath(path)
}

/** Which element to build. Null when the file is neither. */
export function mediaKind(path: string): 'audio' | 'video' | null {
  if (isVideoPath(path)) return 'video'
  if (isAudioPath(path)) return 'audio'
  return null
}

/** The scheme sound and video are served over. Named in the CSP's `media-src`. */
export const MEDIA_SCHEME = 'iaw-media'

/** Encodes a path into a media URL. The codec itself lives in `pathUrl.ts`. */
export function encodeMediaPath(target: string): string {
  return encodePathUrl(MEDIA_SCHEME, target)
}

/** The inverse, for the handler. Null for anything that is not one of ours. */
export function decodeMediaPath(url: string): string | null {
  return decodePathUrl(MEDIA_SCHEME, url)
}

/**
 * The MIME type to answer with.
 *
 * Stated rather than guessed from the file, because a media element that is
 * handed a type it does not recognise gives up before it reads a frame, and the
 * failure looks identical to a broken file. The map is small on purpose: it
 * covers exactly the extensions above and nothing else can reach the handler.
 */
const TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  // `video/mp4` rather than `video/quicktime`, which is the type the file
  // actually is. Chromium does not recognise `video/quicktime` at all —
  // `canPlayType('video/quicktime')` answers `""`, the same as for a format it
  // has never heard of — while the container really is ISO base media and the
  // demuxer reads it happily once it agrees to look. Both types play in
  // practice; this is the one the engine will admit to supporting, so a
  // preflight check that ever gets added here does not reject a file that works.
  mov: 'video/mp4',
  webm: 'video/webm',
}

export function mediaContentType(path: string): string {
  // `extensionOf` already lowercases.
  return TYPES[extensionOf(path)] ?? 'application/octet-stream'
}

/**
 * A byte range parsed out of a `Range` header, clamped to a file of `size`.
 *
 * Here rather than in the handler because it is the part with arithmetic in it,
 * and an off-by-one in a range is not a crash — it is a video that stalls one
 * frame from the end, or a seek that lands in the wrong place. That is worth a
 * test, and a test wants a pure function.
 *
 * Only the single-range forms are handled, which is all a media element sends:
 * `bytes=0-`, `bytes=500-999`, and the suffix form `bytes=-500` meaning the
 * last 500 bytes. A multi-range request, a malformed one, or one that starts
 * past the end returns null, and the caller answers with the whole file or a
 * 416 as appropriate.
 */
export interface ByteRange {
  start: number
  end: number
}

export function parseRange(header: string | null, size: number): ByteRange | null {
  if (!header || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match

  // The suffix form: the last N bytes, and N larger than the file means all of
  // it rather than an error.
  if (rawStart === '') {
    if (rawEnd === '') return null
    const wanted = Number(rawEnd)
    if (!Number.isFinite(wanted) || wanted <= 0) return null
    return { start: Math.max(0, size - wanted), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return null
  // An absent end means "to the end of the file"; an end past it is clamped
  // rather than refused, which is what every server does and what the spec asks
  // for.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}
