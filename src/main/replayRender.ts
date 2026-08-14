/**
 * The last screen, reconstructed, instead of every frame that ever drew it.
 *
 * Filtering the saved stream (see `replaySafe.ts`) makes it safe to replay. It
 * does not make it *right*, and the second half of the same bug report is about
 * that: text arriving with huge gaps in it, words spread across the line, a
 * screen that plainly is not what the pane last showed.
 *
 * Two causes, one fix. The first is that a full-screen program does not print
 * its screen, it *paints* it — cursor to a position, write, cursor somewhere
 * else, write again, and again for the next frame. Replaying that stream gives
 * you every frame it ever drew, one after another, which is why a restored pane
 * showed `thinking…` and the answer that replaced it. The second is that all
 * that painting is in absolute coordinates for the width the pane had *then*,
 * and a pane restored at a different width has every one of them land in the
 * wrong column. Measured, at 60 columns, a screen painted for 100:
 *
 *     through  it  anyway,  so  it        →  through·cit80·canyway,·cso80·cit80
 *
 * which is the reported symptom exactly.
 *
 * So the stream is replayed into an offscreen terminal *at the width it was
 * written for* — which is why the size is saved beside the bytes; see
 * `ScrollbackStore` — and what comes back out is that terminal's final screen.
 * Frames collapse into the one that survived them, absolute positioning is
 * resolved against the width that made sense of it, and the output reflows like
 * ordinary text because it no longer contains a single absolute move.
 *
 * `@xterm/headless` is the same parser the pane itself uses, which is the point:
 * anything it renders identically to the live terminal is by definition what the
 * pane showed. It is a dependency of this app rather than of the machine — it
 * installs with `npm install` and is bundled into the build, so nobody
 * installing the packaged app installs anything.
 *
 * Everything here is best-effort and says so by returning null. A serialiser
 * that throws, a saved size that was never recorded, a version of the packages
 * that will not load — each is a reason to fall back to the filtered stream,
 * which is worse-looking and equally safe. The bug this was written for is fixed
 * by the filter alone; this is the part that makes the result *readable*.
 */
import { stripInteractive } from './replaySafe'

/**
 * Longest a reconstruction may take before it is abandoned.
 *
 * This is on the path between a pane being created and its shell appearing, so
 * it has a ceiling by construction. A 64 KB ring parses in single-digit
 * milliseconds; anything that takes a second is a stream shaped in a way this
 * was not written for, and the filtered replay is right there.
 */
const RENDER_TIMEOUT_MS = 1000

/**
 * Rows of history to keep and to emit.
 *
 * Generous rather than tuned: the ring that feeds this is capped in bytes
 * already, so the only thing a low number here could do is throw away scrollback
 * that survived everything else.
 */
const SCROLLBACK_ROWS = 5000

/**
 * The saved stream as the screen it produced, or null to use it as it is.
 *
 * `cols` is the pane's width when the bytes were written, and without a real one
 * there is nothing to gain here: reconstructing at a guessed width produces the
 * same mangling as replaying at a guessed width, with a dependency in the way.
 */
export async function renderReplay(raw: string, cols: number | null, rows: number | null): Promise<string | null> {
  if (!raw || !cols || cols < 2 || !rows || rows < 1) return null

  let Terminal: typeof import('@xterm/headless').Terminal
  let SerializeAddon: typeof import('@xterm/addon-serialize').SerializeAddon
  try {
    // Required rather than imported so that a build without these — or a broken
    // install of them — costs the reconstruction and not the app.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ;({ Terminal } = require('@xterm/headless') as typeof import('@xterm/headless'))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ;({ SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize'))
  } catch {
    return null
  }

  // Filtered on the way in, not just on the way out. A stream that still
  // contains `?1049h` would have the offscreen terminal reconstruct the screen
  // in its alternate buffer, and what came back would be the wrong one.
  const clean = stripInteractive(raw)

  const terminal = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: SCROLLBACK_ROWS,
  })

  try {
    const serializer = new SerializeAddon()
    terminal.loadAddon(serializer)

    const written = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), RENDER_TIMEOUT_MS)
      terminal.write(clean, () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!written) return null

    const screen = serializer.serialize({ scrollback: SCROLLBACK_ROWS })
    // Filtered again on the way out, and this is not redundant: the serialiser's
    // job is to reproduce terminal *state*, so where the stream had left mouse
    // reporting on it dutifully writes `?1003h` into its output — which is the
    // whole bug, arriving by a second route. Measured, not assumed.
    const safe = stripInteractive(screen)
    // An empty reconstruction of a non-empty stream is a reconstruction that
    // went wrong, and the raw bytes are a better answer than a blank pane.
    return safe.trim() ? safe : null
  } catch {
    return null
  } finally {
    try {
      terminal.dispose()
    } catch {
      /* already gone */
    }
  }
}
