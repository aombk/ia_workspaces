/**
 * Serving document files to the renderer.
 *
 * The sibling of `imageProtocol.ts`, for the same reason and by the same means:
 * the renderer is loaded from `file://`, Chromium gives it an opaque origin, and
 * `<embed src="file:///…/plans.pdf">` is blocked. That file explains the
 * reasoning at length; `shared/docs.ts` explains why this is a second scheme
 * rather than a wider first one.
 *
 * Streaming matters more here than it does for images, not less. A drawing set
 * is routinely a hundred megabytes, and the `data:` URL route would base64 the
 * lot through IPC into the JS heap before the first page appeared.
 */
import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { DOCUMENT_SCHEME, decodeDocumentPath, isDocumentPath } from '../shared/docs'

/**
 * Must run before `app.whenReady`, like the image scheme — Electron refuses to
 * register a scheme's privileges once the first window exists.
 */
export function registerDocumentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DOCUMENT_SCHEME,
      privileges: { standard: false, secure: true, supportFetchAPI: false, bypassCSP: false },
    },
  ])
}

/** Must run after `app.whenReady`. */
export function serveDocuments(): void {
  protocol.handle(DOCUMENT_SCHEME, async (request) => {
    const target = decodeDocumentPath(request.url)
    if (!target) return new Response('bad request', { status: 400 })

    // As with images, the extension check is not the thing that makes this
    // safe — the renderer is ours and could ask for any path. It is here so a
    // bug on our side surfaces as a blank viewer rather than as this handler
    // handing an arbitrary file to a plugin document.
    if (!isDocumentPath(target)) return new Response('not a document', { status: 403 })

    try {
      const response = await net.fetch(pathToFileURL(target).toString())
      // `net.fetch` on a `file://` URL guesses the type from the extension and
      // is right about `.pdf` — but the viewer only appears for exactly this
      // type, so it is stated rather than relied upon.
      const headers = new Headers(response.headers)
      headers.set('content-type', 'application/pdf')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
