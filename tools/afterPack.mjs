/**
 * Runs once the app is packed and before it is signed.
 *
 * Two jobs: brand the Windows executable (`stampExe.mjs`), and flip Electron's
 * fuses — switches compiled into the binary that the binary can no longer be
 * talked out of at runtime.
 *
 * ## Which fuses, and why not the rest
 *
 * An unflipped Electron binary will run code handed to it by anyone who can
 * start it with the right environment: `NODE_OPTIONS=--require …`, or
 * `--inspect` to attach a debugger. Code run that way runs *as this app* — on a
 * Mac, with whatever this app was granted in System Settings (Accessibility,
 * Full Disk Access — the sort of thing people do grant a terminal). Those two
 * doors are closed here, and the app is told to load its own code only from its
 * packed archive.
 *
 * `RunAsNode` is left on, knowingly. The `iaw` CLI and the shell broker are this
 * same binary started with `ELECTRON_RUN_AS_NODE` (see `controlServer.ts` and
 * `hostEntry.ts`), and switching it off would break both. Closing that door too
 * means shipping them as a separate executable, which is a larger change than a
 * fuse.
 *
 * Before signing, because flipping a fuse edits the binary and an edited binary
 * fails its signature. electron-builder signs after this hook, so the order is
 * right as long as this stays an `afterPack`.
 */
import path from 'node:path'
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'
import { stamp } from './stampExe.mjs'

/** The executable electron-builder just produced, per platform. */
function binaryOf(context) {
  const name = context.packager.appInfo.productFilename
  switch (context.electronPlatformName) {
    case 'darwin':
    case 'mas':
      return path.join(context.appOutDir, `${name}.app`, 'Contents', 'MacOS', name)
    case 'win32':
      return path.join(context.appOutDir, `${name}.exe`)
    default:
      return path.join(context.appOutDir, context.packager.executableName)
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    await stamp(binaryOf(context))
  }

  // A universal Mac build packs each architecture into a `-temp` folder, then
  // merges the two — and this hook runs for all three. The merge insists that
  // everything but the executables be byte-identical, and re-signing each half
  // after flipping its fuses gave the two halves different signature files, so
  // the merge refused. Flipped once, on the merged app, instead.
  if (context.electronPlatformName === 'darwin' && /-temp$/.test(context.appOutDir)) return

  await flipFuses(binaryOf(context), {
    version: FuseVersion.V1,
    // Required by the CLI and the shell broker. See above.
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Signing comes next and covers the change; on a Mac without a signing
    // identity electron-builder still ad-hoc signs, which is what this asks
    // for on Apple silicon, where an unsigned edited binary will not launch.
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
  })
}
