/**
 * Refuses to ship a universal .app that is not actually universal.
 *
 * Every way this build has failed so far failed *quietly*. electron-builder
 * packages, signs and writes a .dmg whether or not the thing inside runs on
 * both architectures, and the machine doing the building is — by construction —
 * the one architecture that works. The first person to find out is a user on
 * the other one, and what they see is a bounce in the Dock and nothing else,
 * because node-pty's require runs before any window is created.
 *
 * So the claim on the tin gets checked before the artifact leaves the build:
 *
 *   - the executables carry both slices, which is what `universal` is supposed
 *     to mean and what @electron/universal's lipo pass is supposed to produce
 *   - both macOS node-pty prebuilds are inside the bundle, which lipo cannot
 *     tell you about because they are not merged — they are two separate
 *     single-architecture files, picked between at runtime by name:
 *
 *         require(`@lydell/node-pty-${process.platform}-${process.arch}`)
 *
 *     npm prunes whichever one does not match the build machine, on every
 *     install; tools/ensurePtyArches.mjs puts it back. This is the check that
 *     notices when that stops working — an electron-builder or node-pty upgrade
 *     could reintroduce the gap without either of them reporting an error, and
 *     empirically electron-builder logs "installing native dependencies
 *     arch=x64" while doing no such thing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const app = path.join(root, 'out', 'electron-pack', 'mac-universal', 'ia_workspaces.app')

const REQUIRED_SLICES = ['x86_64', 'arm64']

/** Prebuild package name -> the one architecture its binary may contain. */
const REQUIRED_PREBUILDS = {
  'node-pty-darwin-x64': 'x86_64',
  'node-pty-darwin-arm64': 'arm64',
}

const problems = []

/** `lipo -archs`, as a list. Anything unreadable is a problem, not an empty list. */
function archsOf(file) {
  return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/)
}

if (!existsSync(app)) {
  // Not a soft skip: this runs immediately after a build that was asked for a
  // universal target, so a missing bundle means that build did not do what it
  // said, and every check below would vacuously pass.
  problems.push(`no universal .app at ${path.relative(root, app)} — the mac target is set to "universal", so this should exist`)
} else {
  const fatBinaries = [
    path.join(app, 'Contents', 'MacOS', 'ia_workspaces'),
    path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
  ]

  for (const binary of fatBinaries) {
    const where = path.relative(app, binary)
    if (!existsSync(binary)) {
      problems.push(`${where} is missing from the bundle`)
      continue
    }
    let archs
    try {
      archs = archsOf(binary)
    } catch (err) {
      problems.push(`could not read the architectures of ${where}: ${err.message.trim()}`)
      continue
    }
    const missing = REQUIRED_SLICES.filter((arch) => !archs.includes(arch))
    if (missing.length) {
      problems.push(`${where} is ${archs.join('+')} — missing ${missing.join(' and ')}. The universal merge did not happen.`)
    }
  }

  // Located by walking the bundle rather than by a fixed path: electron-builder
  // installs these nested under node-pty's own node_modules, and that layout is
  // its business and has changed before. What matters is that the files are in
  // there somewhere, with the right architecture in each.
  let found = []
  try {
    found = execFileSync(
      'find',
      [app, '-path', '*@lydell*', '-name', '*.node'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
  } catch (err) {
    problems.push(`could not search the bundle for node-pty prebuilds: ${err.message.trim()}`)
  }

  for (const [pkg, expected] of Object.entries(REQUIRED_PREBUILDS)) {
    const hit = found.find((file) => file.includes(`${pkg}/`))
    if (!hit) {
      problems.push(`@lydell/${pkg} is not in the bundle — node-pty will throw MODULE_NOT_FOUND on ${expected === 'x86_64' ? 'Intel' : 'Apple Silicon'} before any window opens. Check tools/ensurePtyArches.mjs.`)
      continue
    }
    let archs
    try {
      archs = archsOf(hit)
    } catch (err) {
      problems.push(`could not read the architectures of ${path.relative(app, hit)}: ${err.message.trim()}`)
      continue
    }
    // Equality rather than inclusion: a prebuild holding the *wrong* single
    // architecture is the failure this whole file exists for, and one holding
    // both would mean something merged a file that is chosen by name and should
    // never have been merged.
    if (archs.length !== 1 || archs[0] !== expected) {
      problems.push(`@lydell/${pkg} contains ${archs.join('+')}, expected ${expected} alone`)
    }
  }
}

if (problems.length) {
  console.error('\n[x] the packaged .app is not universal:\n')
  for (const problem of problems) console.error(`      - ${problem}`)
  console.error('')
  process.exit(1)
}

console.log('  both slices in the executables, both node-pty prebuilds in the bundle')
