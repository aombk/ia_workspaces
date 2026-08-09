/**
 * Serving image files to the renderer.
 *
 * The renderer is loaded from `file://`, and Chromium gives every `file://`
 * document an opaque origin — so the `img-src 'self'` in our CSP does *not*
 * cover other files on disk, and `<img src="file:///C:/photos/cat.png">` is
 * blocked. Loosening the CSP to allow `file:` wholesale would hand the same
 * reach to anything that ever manages to inject a tag, including markdown we
 * render and pages the browser pane visits.
 *
 * The other obvious route is the one the hex view already uses — read the bytes
 * over IPC and build a `data:` URL — and it is wrong here for reasons of scale
 * rather than principle. `readBytes` truncates at a megabyte, which is under
 * the size of one photograph off a phone; base64 inflates by a third; and a
 * folder of two hundred images would land the lot in the JS heap as strings,
 * decoded by us instead of by the image pipeline.
 *
 * So: a scheme of our own, allowed by exactly one CSP directive, handled by
 * streaming the file. Chromium decodes it natively, caches it, and never holds
 * it in our heap. A 60 MB panorama costs the same renderer memory as a thumbnail.
 *
 * The URL format lives in `shared/images.ts`, because preload builds these and
 * must not import anything from Electron's main-process surface.
 */
import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { IMAGE_SCHEME, decodeImagePath, isImagePath } from '../shared/images'

/**
 * Must run before `app.whenReady` — Electron refuses to register a scheme's
 * privileges once the first window exists, which is the whole reason this is
 * separate from `serveImages`.
 *
 * `secure` with `bypassCSP: false` is the combination that matters: the scheme
 * is trusted enough to load from a secure context, and is still subject to the
 * page's CSP, so the `img-src` entry in index.html stays a real control rather
 * than a formality.
 */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_SCHEME,
      privileges: { standard: false, secure: true, supportFetchAPI: false, bypassCSP: false },
    },
  ])
}

/** Must run after `app.whenReady`. */
export function serveImages(): void {
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const target = decodeImagePath(request.url)
    if (!target) return new Response('bad request', { status: 400 })

    // The extension check is not what makes this safe — the renderer is ours,
    // and a compromised one could ask for any path it liked. It is here so that
    // a bug on our side surfaces as a broken image rather than as this handler
    // quietly serving a private key to an `<img>` tag someone injected.
    if (!isImagePath(target)) return new Response('not an image', { status: 403 })

    try {
      return await net.fetch(pathToFileURL(target).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
