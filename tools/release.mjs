/**
 * Publishes a GitHub release for the version in package.json.
 *
 * A release on GitHub is two things: a git tag, and files attached to it. This
 * does both, and it exists because doing them by hand goes wrong in the same
 * three ways every time — the tag is pushed before the commit it names, the
 * artifacts uploaded are yesterday's, or the notes are written twice and differ
 * from CHANGELOG.md.
 *
 * The version is not an argument. `package.json` is the one place it is
 * written — electron-builder reads it, `collect.mjs` reads it for the file names
 * electron-builder produces, and now the tag is `v` and that. A version passed
 * on the command line is a version that can disagree with the binaries sitting
 * in build/, which is exactly the mistake worth making impossible.
 *
 * **Two machines, one release.** Windows and macOS artifacts are built on the
 * machines that can sign them, so the first run creates the release and every
 * run after it uploads into the one already there. Which is which is not a flag:
 * the release either exists for this tag or it does not, and the answer is asked
 * of GitHub rather than remembered.
 *
 * Usage:
 *   npm run release                 tag, push, create or update the release
 *   npm run release -- --dry-run    say what it would do and touch nothing
 *   npm run release -- --draft      create it unpublished, to look at first
 *   npm run release -- --assets     upload build/ into an existing release only
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const buildDir = path.join(root, 'build')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const draft = args.includes('--draft')
const assetsOnly = args.includes('--assets')

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const tag = `v${version}`

/** Runs a command and hands back its output, or throws with what it printed. */
function run(file, argv, opts = {}) {
  return execFileSync(file, argv, { cwd: root, encoding: 'utf8', ...opts }).trim()
}

/** Runs a command for its exit code alone. Stderr is swallowed on purpose. */
function ok(file, argv) {
  try {
    execFileSync(file, argv, { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function fail(problem, remedy) {
  console.error(`\n[release] ${problem}`)
  if (remedy) console.error(`          ${remedy}`)
  process.exit(1)
}

// ------------------------------------------------------------------ preflight

// Every check runs before anything is written. A release that gets half way —
// tag pushed, upload refused — is one somebody has to unpick by hand, and
// unpicking a pushed tag means deleting it in two places.

if (!ok('gh', ['--version'])) {
  fail(
    'the GitHub CLI is not installed.',
    'winget install GitHub.cli   (then `gh auth login` once)'
  )
}
if (!ok('gh', ['auth', 'status'])) {
  fail('the GitHub CLI is installed but not signed in.', 'gh auth login')
}

const dirty = run('git', ['status', '--porcelain'])
if (dirty) {
  fail(
    'the working tree has uncommitted changes.',
    'A tag names a commit, so what is released must be committed first.'
  )
}

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
// Pushed, not merely committed. A tag pointing at a commit only this machine
// has is a release nobody else can check out — GitHub accepts the tag and the
// source link 404s.
if (!ok('git', ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`])) {
  fail(
    `HEAD is not on origin/${branch}.`,
    `git push origin ${branch}   — then run this again.`
  )
}

/**
 * The notes, taken from CHANGELOG.md rather than written here.
 *
 * The section for this version, from its heading to the next one. Fragments in
 * changelog.d are folded into that file by `collect-changelog.mjs`, so a
 * missing section nearly always means that step has not been run — and the
 * release notes would otherwise be silently empty for a version that has a
 * changelog sitting right there.
 */
function notesFor(v) {
  const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => headingVersion(line) === v)
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => headingVersion(line) !== null)
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

/**
 * The version a `##` heading names, or null if the line is not one.
 *
 * Both spellings, because the file has both: `collect-changelog.mjs` writes
 * `## [1.1.0] — 2026-08-16`, and the first release was written by hand as
 * `## 1.0.0`. Matching only the bare form meant this refused every version the
 * generator had produced — with the section sitting right there in the file.
 */
function headingVersion(line) {
  const match = /^##\s+\[?([0-9][^\]\s]*)\]?/.exec(line)
  return match ? match[1] : null
}

const notes = notesFor(version)
if (!notes) {
  const pending = existsSync(path.join(root, 'changelog.d'))
    ? readdirSync(path.join(root, 'changelog.d')).filter((n) => n.endsWith('.md') && n !== 'README.md')
    : []
  fail(
    `CHANGELOG.md has no "## ${version}" section.`,
    pending.length
      ? `node tools/collect-changelog.mjs ${version}   — ${pending.length} fragment${pending.length === 1 ? '' : 's'} waiting in changelog.d/`
      : 'Add the section, or bump the version in package.json.'
  )
}

// What is in build/ is what this release ships. Read rather than listed from a
// table of platform artifacts: `collect.mjs` already owns that decision, and a
// second list here would be a second thing to update when a target is added.
const assets = existsSync(buildDir)
  ? readdirSync(buildDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(buildDir, entry.name))
  : []

if (!assets.length) {
  fail(
    'build/ is empty.',
    'Run build_windows.bat or build_macos.sh first — a release with no files is not one.'
  )
}

// A binary older than the commit being tagged is the quiet failure this catches:
// it uploads, it installs, and it is not the code in the release.
const headAt = Number(run('git', ['log', '-1', '--format=%ct'])) * 1000
const stale = assets.filter((file) => statSync(file).mtimeMs < headAt)

const exists = ok('gh', ['release', 'view', tag])

// ----------------------------------------------------------------- the report

console.log(`\n  version   ${version}   (package.json)`)
console.log(`  tag       ${tag}${exists ? '   — release exists, uploading into it' : '   — new release'}`)
console.log(`  branch    ${branch}`)
console.log('\n  build/')
for (const file of assets) {
  const { size, mtimeMs } = statSync(file)
  const mark = mtimeMs < headAt ? '  ← older than HEAD' : ''
  console.log(`    ${path.basename(file).padEnd(30)} ${(size / 1024 / 1024).toFixed(1).padStart(6)} MB${mark}`)
}
if (stale.length) {
  console.log('\n  Some artifacts predate the commit being tagged. Rebuild if that is not deliberate.')
}

if (dryRun) {
  console.log('\n[release] --dry-run: nothing was tagged, pushed or uploaded.\n')
  process.exit(0)
}

// ------------------------------------------------------------------- do it

if (!exists && !assetsOnly) {
  // Annotated rather than lightweight: a release tag is a record of what was
  // shipped and when, and `git describe` only walks annotated ones by default.
  if (!ok('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])) {
    run('git', ['tag', '-a', tag, '-m', `${tag}`])
    console.log(`\n  tagged ${tag}`)
  }
  run('git', ['push', 'origin', tag])
  console.log(`  pushed ${tag}`)

  // `--verify-tag` is what keeps the two ends honest: the tag is already on
  // origin at this point, and gh is told to use that one rather than quietly
  // creating a second from whatever the default branch happens to be.
  run('gh', [
    'release',
    'create',
    tag,
    ...assets,
    '--title',
    `ia_workspaces ${version}`,
    '--notes',
    notes,
    '--verify-tag',
    ...(draft ? ['--draft'] : []),
  ])
  console.log('  created the release')
} else {
  if (!exists) fail(`there is no release for ${tag} yet.`, 'Drop --assets to create it.')
  // `--clobber` so re-running after a rebuild replaces the file rather than
  // failing on the name — the second machine's run, and every fix-up after it.
  run('gh', ['release', 'upload', tag, ...assets, '--clobber'])
  console.log(`\n  uploaded ${assets.length} file${assets.length === 1 ? '' : 's'} into ${tag}`)
}

const url = run('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'])
console.log(`\n  ${url}\n`)
