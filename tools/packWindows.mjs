/**
 * The Windows packaging step, arranged around where the time actually goes.
 *
 * Measured on a release build of this tree, before any of this existed:
 *
 *   typecheck            1.5 s
 *   tests                5.3 s
 *   bundle               0.2 s
 *   electron-builder    87.0 s   ← of which `dir` is 3.7 s and `portable` is 85
 *   installer (ISCC)    19.7 s
 *
 * So "the Windows build is slow" is one number: the portable exe is an NSIS
 * self-extracting archive, NSIS compresses with LZMA on exactly one thread, and
 * it is being asked to compress a third of a gigabyte of Electron. Nothing else
 * in the run is worth optimising — the typecheck and the tests together are
 * seven seconds and they are the two steps you would least want to lose.
 *
 * Three things happen here about it:
 *
 * 1. `--fast` stops after the unpacked tree, which takes about four seconds.
 *    That tree is a *runnable app* — out\electron-pack\win-unpacked\ — so for
 *    the loop of "change something, look at it in a real packaged build" the
 *    other hundred seconds were producing a file you deleted. This is the one
 *    that matters day to day.
 *
 * 2. The portable exe and the installer are built at the same time. They both
 *    read the unpacked tree and neither writes to it, they are separate
 *    processes, and the machine has cores to spare precisely because NSIS will
 *    not use them. That is the twenty seconds of ISCC gone from the wall clock.
 *
 * 3. `electronLanguages` in package.json cuts 47 MB of unread Chromium locales
 *    out of the tree before either compressor sees it. Chromium ships 54 locale
 *    .pak files; this app's own text is English only, so the other 53 buy a
 *    translated context menu and cost a seventh of the tree — 357 MB down to
 *    311. (The rationale is here rather than beside the setting because
 *    electron-builder validates its config against a strict schema and rejects
 *    a `//comment` key outright, which is a build failure for a sentence.)
 *
 * Both artifacts are still built by default, because both still ship. This
 * changes when they are waited for, not whether they are made.
 *
 * Three gears, and the middle one is the point:
 *
 *   --fast          ~7s    unpacked tree only, a runnable app
 *   --no-portable  ~25s    installer, which is what most people install
 *   (neither)     ~105s    both artifacts
 *
 * Nothing here makes NSIS faster, because nothing can: its LZMA is
 * single-threaded by design and no flag changes that. Of the 311 MB tree it is
 * compressing, 215 MB is the Electron binary, which is not ours to shrink. The
 * measured alternatives were both bad trades — `compression: store` turns 85
 * seconds into 5 and an 86 MB portable exe into 311, and dropping the DirectX
 * shader compiler saves 26 MB for about seven seconds. So the answer is to run
 * it less often rather than to run it faster.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const fast = args.includes('--fast') || process.env.FAST === '1'
const skipInstaller = fast || process.env.SKIP_INSTALLER === '1'
/**
 * The middle gear, and the one that was missing.
 *
 * The portable exe is the eighty-five seconds. The installer is twenty. There
 * was a way to skip the cheap one and a way to skip both, and no way to skip
 * the expensive one — so a release that only needed the installer still paid
 * for an NSIS run whose output went straight in the bin.
 */
const skipPortable = args.includes('--no-portable') || process.env.SKIP_PORTABLE === '1'

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/**
 * Inno Setup, wherever this machine put it.
 *
 * Absent is not fatal and never has been: a machine without it should still
 * produce the portable exe and be told what it did not produce, rather than
 * failing a run over a tool that is not a dependency of the thing it did build.
 */
function findISCC() {
  const candidates = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files (x86)\\Inno Setup 7\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * One child process, its output prefixed so two of them at once stay readable.
 *
 * The prefix is the whole reason this is not just `spawn(..., 'inherit')`: with
 * NSIS and ISCC running together, interleaved unlabelled lines are how you spend
 * ten minutes debugging the wrong compressor.
 */
function run(tag, command, commandArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    // `shell` for `npx`, which on Windows is a .cmd and unspawnable without one;
    // never for ISCC, whose path is "C:\Program Files\..." — cmd.exe splits an
    // unquoted command at the first space and reports that 'C:\Program' is not a
    // recognised command, which is a sentence that has cost everyone an hour.
    const child = spawn(command, commandArgs, {
      cwd: root,
      shell: opts.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const relay = (stream) => {
      let held = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        held += chunk
        const lines = held.split(/\r?\n/)
        held = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) console.log(`  [${tag}] ${line}`)
      })
      stream.on('end', () => {
        if (held.trim()) console.log(`  [${tag}] ${held}`)
      })
    }
    relay(child.stdout)
    relay(child.stderr)

    child.on('error', reject)
    child.on('close', (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      if (code === 0) {
        console.log(`  [${tag}] done in ${secs}s`)
        resolve()
      } else {
        reject(new Error(`${tag} failed (exit ${code}) after ${secs}s`))
      }
    })
  })
}

// ── the unpacked tree, which everything else is built out of ────────────────
// Sequential and first by necessity: the portable archive and the installer are
// both nothing but this directory, compressed two different ways.
const unpacked = path.join('out', 'electron-pack', 'win-unpacked')

console.log(`[*] unpacked tree${fast ? ' (--fast: this is all that is built)' : ''}`)
await run('dir', 'npx', ['electron-builder', '--win', 'dir'], { shell: true })

if (fast) {
  console.log('')
  console.log('=== fast build done ===')
  console.log(`    run it: out\\electron-pack\\win-unpacked\\ia_workspaces.exe`)
  console.log('    (no portable exe and no installer — drop --fast for those)')
  process.exit(0)
}

// ── the two artifacts, at the same time ─────────────────────────────────────
// `--prepackaged` is not an optimisation here, it is what makes running these
// two at once *correct*. Without it electron-builder re-runs the whole pack
// step before building the portable target — rewriting win-unpacked, in place,
// while ISCC is part-way through compressing the files in it. That is a torn
// installer built from two different versions of the tree, and it would have
// been intermittent and blamed on Inno. With it, both processes only ever read.
const iscc = findISCC()
const jobs = []

if (skipPortable) {
  console.log('[*] skipping portable exe (SKIP_PORTABLE=1) — the 85s one')
} else {
  jobs.push(
    run('portable', 'npx', ['electron-builder', '--win', 'portable', '--prepackaged', unpacked], {
      shell: true,
    }).then(() => 'portable')
  )
}

if (skipInstaller) {
  console.log('[*] skipping installer (SKIP_INSTALLER=1)')
} else if (!iscc) {
  console.log('[!] Inno Setup not found — portable exe only.')
  console.log('    Install it from https://jrsoftware.org/isdl.php to build the installer.')
} else {
  jobs.push(
    run('installer', iscc, [
      '/Q',
      `/DMyAppVersion=${version}`,
      path.join('installer', 'ia_workspaces.iss'),
    ]).then(() => 'installer')
  )
}

if (!jobs.length) {
  console.log('')
  console.log('=== nothing left to package ===')
  console.log(`    the unpacked tree is at ${unpacked}`)
  process.exit(0)
}

console.log(
  `[*] packaging ${jobs.length === 2 ? 'portable exe and installer together' : jobs.length === 1 && skipPortable ? 'installer' : 'portable exe'}`
)

// allSettled rather than all: with two long compressors running, the one that
// succeeded should still be on disk and reported, and the failure should name
// which of them it was rather than whichever rejected first.
const results = await Promise.allSettled(jobs)
const failures = results.filter((r) => r.status === 'rejected')
for (const failure of failures) console.error(`[x] ${failure.reason.message}`)
if (failures.length) process.exit(1)
