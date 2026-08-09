/**
 * Puts the app's icon and name onto the packaged .exe.
 *
 * electron-builder does this itself, as part of the step that also signs the
 * binary — and that step needs a code-signing toolchain it cannot unpack on a
 * machine without Developer Mode, which it treats as fatal. The project turns
 * the whole step off (`build.win.signAndEditExecutable`), and the cost used to
 * be an executable calling itself "Electron 43.2.0" and wearing Electron's
 * icon. Nothing here signs anything, so none of that toolchain is needed: this
 * runs rcedit over the packed exe on its own.
 *
 * Wired in as electron-builder's `afterPack` hook, so it lands before the
 * installer and the portable bundle are built around the packed folder — both
 * then carry the branded exe. The artifacts themselves are deliberately left
 * alone: an NSIS installer and a portable SFX both keep data appended past the
 * end of the PE image, and rewriting their resources is how you corrupt it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rcedit } from 'rcedit'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const ICON = path.join(root, 'packaging', 'icons', 'icon.ico')

/** Icon plus the version resource Explorer reads in a file's Properties. */
export async function stamp(exe) {
  await rcedit(exe, {
    icon: ICON,
    'file-version': pkg.version,
    'product-version': pkg.version,
    'version-string': {
      CompanyName: pkg.author,
      // Task Manager's "Name" column is FileDescription, not ProductName — so
      // this is the app's name as far as most people ever see it. It used to be
      // `pkg.description`, which put the whole one-line pitch ("Workspace-
      // oriented terminal for Windows, macOS and Linux: …") on every one of the
      // app's processes, six rows of it, and no "ia_workspaces" anywhere.
      FileDescription: pkg.productName,
      ProductName: pkg.productName,
      InternalName: pkg.productName,
      OriginalFilename: path.basename(exe),
      LegalCopyright: `Copyright © ${pkg.author}. ${pkg.license} licence.`,
    },
  })
  console.log(`[stamp] ${path.relative(root, exe)}`)
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  await stamp(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`))
}
