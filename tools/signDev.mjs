/**
 * Signs a `build_macos.sh --dev` app with an Apple Development certificate.
 *
 * The point is a signature that stays the same from one build to the next.
 * macOS files Accessibility, Screen Recording, Full Disk Access and the like
 * under the app's designated requirement, which for a signed app is its bundle
 * id plus the certificate that signed it. An unsigned build has none, so every
 * rebuild is a stranger and every grant has to be made again; a development
 * certificate lasts a year, so every rebuild in that year keeps them.
 *
 * Done here rather than by electron-builder because electron-builder outside
 * the App Store only looks for "Mac Developer" or "Developer ID Application"
 * certificates, and Apple has issued "Apple Development" ones for years now.
 * @electron/osx-sign is what electron-builder would have called anyway, so the
 * bundle is signed the same way as a release: inside out, hardened runtime, the
 * same entitlements, and the same `.pak` exclusion (see build_macos.sh for why).
 *
 * What it leaves out is the secure timestamp. Notarization needs one and
 * nothing else does, and it is a round trip to Apple per file signed — the
 * slowest part of signing, for something a development build never uses.
 *
 * Usage: node tools/signDev.mjs <path/to/App.app> "<Apple Development: …>"
 */
import { signAsync } from '@electron/osx-sign'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [app, identity] = process.argv.slice(2)
if (!app || !identity) {
  console.error('usage: node tools/signDev.mjs <App.app> "<signing identity>"')
  process.exit(2)
}

const entitlements = path.join(root, 'packaging/entitlements.mac.plist')
const inherit = path.join(root, 'packaging/entitlements.mac.inherit.plist')

await signAsync({
  app,
  identity,
  platform: 'darwin',
  // A function, not `[/\.pak$/]`: osx-sign 1.3's option check turns an array
  // into `undefined`, so a list here silently ignores nothing.
  ignore: (file) => file.endsWith('.pak'),
  // No provisioning profile and no app-group entitlement: those are for the
  // App Store, and osx-sign goes looking for both unless told not to.
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  optionsForFile: (file) => ({
    hardenedRuntime: true,
    timestamp: 'none',
    // The main executable gets the app's entitlements; every helper and
    // framework inside it gets the inherited set, as electron-builder does it.
    entitlements: file === app ? entitlements : inherit,
  }),
})
console.log(`[*] signed ${path.basename(app)} as ${identity}`)
