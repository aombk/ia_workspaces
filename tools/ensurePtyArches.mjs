/**
 * Puts every macOS node-pty prebuild into node_modules before a universal pack.
 *
 * @lydell/node-pty picks its native binary at *runtime*, by name:
 *
 *     require(`@lydell/node-pty-${process.platform}-${process.arch}`)
 *
 * so a build has to carry the package for every architecture it claims to run
 * on. npm will not install them: each prebuild declares its own `cpu`, and npm
 * prunes the ones that do not match the machine doing the installing — on every
 * install, including `npm ci`. `--force` does not turn that off, and asking for
 * the other one with `--cpu=x64` re-resolves the whole tree for x64 and drops
 * the native one instead, leaving the same hole pointing the other way.
 *
 * So the missing prebuild is fetched here, straight from the registry, rather
 * than declared as a dependency it would only be deleted again. `npm pack`
 * downloads a tarball without consulting `cpu`, which is the whole trick.
 *
 * This ran because a universal .dmg is one binary for both architectures, and
 * an Intel Mac opening a build made on Apple Silicon would otherwise throw
 * MODULE_NOT_FOUND out of node-pty's first require — before any window, so it
 * reads as "the app does not start" rather than as a missing terminal backend.
 *
 * Idempotent: a prebuild that is already unpacked is left alone, so the common
 * case is a couple of stat calls and no network.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const ARCHES = ['darwin-arm64', 'darwin-x64']

/**
 * Versions come from node-pty's own optionalDependencies rather than from a
 * constant here, so a bump to node-pty cannot leave this pinning prebuilds that
 * do not match the loader that will require them.
 *
 * Read off disk rather than require()d: node-pty's `exports` map does not list
 * "./package.json", and Node honours that refusal even for its own manifest.
 */
const { optionalDependencies } = JSON.parse(
  readFileSync(path.join(root, 'node_modules', '@lydell', 'node-pty', 'package.json'), 'utf8'),
)

for (const arch of ARCHES) {
  const name = `@lydell/node-pty-${arch}`
  const dest = path.join(root, 'node_modules', '@lydell', `node-pty-${arch}`)

  if (existsSync(dest)) {
    console.log(`  ${name.padEnd(38)} present`)
    continue
  }

  const version = optionalDependencies?.[name]
  if (!version) {
    // Not a platform node-pty ships for. Reported rather than thrown: this list
    // is ours, and node-pty dropping an architecture should not stop a build
    // for the architectures it kept.
    console.warn(`  ${name.padEnd(38)} not offered by node-pty — skipped`)
    continue
  }

  console.log(`  ${name.padEnd(38)} fetching ${version}`)
  const staging = await mkdtemp(path.join(tmpdir(), 'pty-prebuild-'))
  try {
    // --silent, or npm's own progress output lands in the middle of this list.
    execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', staging, '--silent'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    const [tarball] = await readdir(staging)
    if (!tarball) throw new Error(`npm pack produced nothing for ${name}@${version}`)

    // Every npm tarball unpacks to a directory called "package"; that is the
    // thing that becomes node_modules/@lydell/node-pty-<arch>.
    execFileSync('tar', ['-xzf', path.join(staging, tarball), '-C', staging])
    await rename(path.join(staging, 'package'), dest)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
