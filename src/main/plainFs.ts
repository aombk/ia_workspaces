/**
 * The filesystem as it is on disk, for code that walks folders you chose.
 *
 * Electron patches `fs` so that an `.asar` archive reads as a folder — which
 * is how the app loads its own code, and wrong for everything else. Touch an
 * archive through the patched `fs`, even just to `stat` it for a size column,
 * and Electron opens it and keeps the handle for the life of the process. The
 * file tree showing a project's `out/` folder was enough: packaging the app
 * then failed because the running copy held the new build's `app.asar` open,
 * and nothing on screen said why. Deleting or copying a folder with one in it
 * goes through the same patch and treats the archive as a directory.
 *
 * `original-fs` is Electron's unpatched module. Outside Electron — the test
 * suites run these files under plain Node — the ordinary one is already that.
 * Loaded through `createRequire` so the bundler leaves the name alone rather
 * than trying to resolve a module that only exists inside Electron.
 */
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'

export const plainFs: typeof nodeFs = process.versions.electron
  ? (createRequire(__filename)('original-fs') as typeof nodeFs)
  : nodeFs
