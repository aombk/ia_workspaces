/**
 * Which files are documents the reader can show whole, and how they reach it.
 *
 * "Document" here means a file the engine renders itself, page furniture and
 * all, rather than one we read into a string and mark up. Today that is PDF and
 * only PDF: Chromium has a viewer for it, and nothing else on disk gets that
 * treatment for free.
 *
 * It is a set rather than a constant because the pane already asks the question
 * in the shape "is this one of those", and because the next one — an engine
 * that learns another format, or a host that brings its own viewer — should be
 * a line here rather than a new branch in the reader.
 */
import { decodePathUrl, encodePathUrl } from './pathUrl'

export const DOCUMENT_EXTENSIONS = ['pdf'] as const

const DOCUMENT_RE = new RegExp(`\\.(${DOCUMENT_EXTENSIONS.join('|')})$`, 'i')

export function isDocumentPath(path: string): boolean {
  return DOCUMENT_RE.test(path)
}

/**
 * The scheme documents are served over, and why it is not the image one.
 *
 * `imageProtocol.ts` explains why a scheme exists at all: the renderer is a
 * `file://` document with an opaque origin, so it cannot load other files off
 * disk and we will not open the CSP to `file:` wholesale.
 *
 * A second scheme rather than another extension on the first, because the two
 * are governed by different CSP directives. An image arrives through `img-src`;
 * a PDF arrives through an `<embed>`, which is `object-src`. Serving both over
 * `iaw-img:` would mean naming that scheme in `object-src` too — and every
 * `<img>` on the page would then be one injected tag away from being an
 * embedded plugin document. Two schemes keep the two grants separate.
 */
export const DOCUMENT_SCHEME = 'iaw-doc'

/** Encodes a path into a document URL. */
export function encodeDocumentPath(target: string): string {
  return encodePathUrl(DOCUMENT_SCHEME, target)
}

/** The inverse, for the handler. Null for anything that is not one of ours. */
export function decodeDocumentPath(url: string): string | null {
  return decodePathUrl(DOCUMENT_SCHEME, url)
}
