/**
 * Gathers the finished artifact into build/.
 *
 * Each toolchain insists on its own output location — esbuild and
 * electron-builder differ, and electron-builder's staging directory is full of
 * things nobody should ship. Rather than fight them, they write under out/ and
 * the one file you would actually run gets copied here.
 *
 * build/ holds runnable artifacts and nothing else, so anything else found
 * there is cleared: an installer from back when those were built, a binary
 * under an older name, or a `.dmg` left over from a run on another platform.
 * What remains is what this run produced.
 *
 * This used to collect two of everything, one per runtime. Tauri is gone; the
 * shape stayed, because the platform differences below are real and did not
 * come from having had two hosts.
 */
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const buildDir = path.join(root, 'build')
const electronPack = path.join(root, 'out', 'electron-pack')

/**
 * electron-builder puts the version in the file name, so this has to know it.
 *
 * Read rather than written down: it was written down, and a version bump then
 * left this looking for a file nobody makes any more — which reads as "the
 * build produced nothing" rather than "the collector is out of date".
 */
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

const installerDir = path.join(root, 'out', 'installer')

/**
 * Which .dmg to collect, of the several a mac build may have made.
 *
 * The mac target builds `universal`, so `-universal.dmg` is the answer and it
 * is right on every machine. The per-architecture names are kept behind it
 * because an older staging tree may still hold them, and because getting this
 * wrong is silent: electron-builder names only the non-default architecture —
 * arm64 gets a `-arm64` suffix, x64 gets none — so the obvious
 * `ia_workspaces-${version}.dmg` is specifically the *Intel* build. Collecting
 * that on an Apple Silicon machine hands you something that runs under Rosetta,
 * which is not what "the one file you would actually run" means, and it threw
 * away the arm64 build sitting right beside it. Hence host architecture, not a
 * fixed choice, among the fallbacks.
 */
function macDmg() {
  const candidates = [
    `ia_workspaces-${version}-universal.dmg`,
    ...(process.arch === 'arm64' ? [`ia_workspaces-${version}-arm64.dmg`] : []),
    `ia_workspaces-${version}.dmg`,
  ]
  for (const name of candidates) {
    const full = path.join(electronPack, name)
    if (existsSync(full)) return full
  }
  // Nothing built. Named anyway so the miss is reported against the file the
  // build was meant to produce rather than against an empty string.
  return path.join(electronPack, candidates[candidates.length - 1])
}

/**
 * What each platform's toolchain produces, and what to call it here.
 *
 * Two per platform now, and they are not alternatives. The **portable** build
 * is the one you run without installing — a stick, a machine you do not own, a
 * five-minute look at the thing. The **installer** is for a machine that is
 * yours: a stable path under a publisher folder, a menu entry, an uninstaller.
 *
 * Windows is the only one whose portable deliverable is a bare executable. A
 * macOS `.app` is a directory whose binary will not run on its own, so there it
 * is the .dmg — which is also what gets notarized and stapled. A Linux AppImage
 * likewise needs its libraries gathered around it.
 *
 * Anything absent is skipped quietly rather than failing the run: Inno Setup is
 * not installed everywhere, and a machine without it should still produce a
 * portable build.
 */
const ARTIFACTS = {
  win32: [
    [path.join(electronPack, `ia_workspaces ${version}.exe`), 'ia_workspaces.exe'],
    [path.join(installerDir, 'ia_workspaces-setup.exe'), 'ia_workspaces-setup.exe'],
  ],
  darwin: [
    [macDmg(), 'ia_workspaces.dmg'],
    [path.join(installerDir, 'ia_workspaces.pkg'), 'ia_workspaces.pkg'],
  ],
  linux: [
    [path.join(electronPack, `ia_workspaces-${version}.AppImage`), 'ia_workspaces.AppImage'],
    [path.join(installerDir, 'ia_workspaces-linux.tar.gz'), 'ia_workspaces-linux.tar.gz'],
  ],
}

const wanted = ARTIFACTS[process.platform] ?? ARTIFACTS.linux
const keep = new Set(wanted.map(([, name]) => name))

await mkdir(buildDir, { recursive: true })

for (const entry of await readdir(buildDir, { withFileTypes: true })) {
  if (entry.isFile() && !keep.has(entry.name)) {
    await rm(path.join(buildDir, entry.name), { force: true })
    console.log(`  ${entry.name.padEnd(30)} cleared — not produced by this run`)
  }
}

const collected = []
for (const [source, name] of wanted) {
  if (!existsSync(source)) continue
  const to = path.join(buildDir, name)
  try {
    await copyFile(source, to)
  } catch (err) {
    // Windows locks a running executable, so copying over one you launched from
    // build/ fails; macOS reports the same situation as ETXTBSY. Say so rather
    // than failing the whole build.
    const code = err?.code
    if (code === 'EBUSY' || code === 'EPERM' || code === 'ETXTBSY') {
      console.warn(`  ${name.padEnd(30)} skipped — currently running, close it and re-run collect`)
      continue
    }
    throw err
  }
  const { size } = await stat(to)
  collected.push([name, size])
}

if (!collected.length) {
  console.log('[collect] nothing to collect yet — run a packaging script first')
  process.exit(0)
}

console.log('\nbuild/')
for (const [name, size] of collected) {
  console.log(`  ${name.padEnd(30)} ${(size / 1024 / 1024).toFixed(1)} MB`)
}
