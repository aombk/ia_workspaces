import { build, context } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const watch = args.includes('--watch')
const launchElectron = args.includes('--electron')

// Everything intermediate lives under out/; only finished artifacts reach build/.
const electronOut = path.join(root, 'out', 'electron')
// Where the Rust host's copy of the renderer lands. `src-tauri/tauri.conf.json`
// points its `frontendDist` here.
const tauriOut = path.join(root, 'out', 'tauri')

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
}

/** Native modules and Electron itself are resolved at runtime, not bundled. */
const nodeExternals = ['electron', '@lydell/node-pty']

const electronTargets = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/main/main.ts')],
    outfile: path.join(electronOut, 'main/main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: nodeExternals,
  },
  {
    // The `iaw` CLI, bundled separately so the shim can run it as plain Node
    // (ELECTRON_RUN_AS_NODE) instead of booting Chromium. See cliEntry.ts.
    ...common,
    entryPoints: [path.join(root, 'src/main/cliEntry.ts')],
    outfile: path.join(electronOut, 'cli/cli.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: nodeExternals,
  },
  {
    // The session broker. Its own bundle because it is its own process: the
    // app re-executes this binary with ELECTRON_RUN_AS_NODE pointed at this
    // file, exactly as the `iaw` shim does, so that quitting the app takes
    // Chromium down and leaves the shells running here.
    ...common,
    entryPoints: [path.join(root, 'src/host/hostEntry.ts')],
    outfile: path.join(electronOut, 'host/host.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: nodeExternals,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/preload/preload.ts')],
    outfile: path.join(electronOut, 'preload/preload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: nodeExternals,
  },
  {
    // The browser pane's guest preload. Separate from the renderer's because it
    // runs inside somebody else's web page and shares none of its API surface.
    ...common,
    entryPoints: [path.join(root, 'src/preload/webviewPreload.ts')],
    outfile: path.join(electronOut, 'preload/webviewPreload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: nodeExternals,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/renderer/entry.electron.ts')],
    outfile: path.join(electronOut, 'renderer/renderer.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    loader: { '.ttf': 'dataurl', '.woff2': 'dataurl' },
  },
]

// The same renderer, bundled for the parked hosts. Only with `--hosts`: they
// are kept, not developed, and a second copy of a 1.6 MB bundle on every build
// is a cost the host that ships should not pay. See src-tauri/README.md.
if (process.argv.includes('--hosts')) {
  electronTargets.push({
    ...common,
    entryPoints: [path.join(root, 'src/renderer/entry.tauri.ts')],
    outfile: path.join(tauriOut, 'renderer/renderer.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    loader: { '.ttf': 'dataurl', '.woff2': 'dataurl' },
  })
}

async function copyStatic() {
  const html = await readFile(path.join(root, 'src/renderer/index.html'), 'utf8')
  const outputs = process.argv.includes('--hosts') ? [electronOut, tauriOut] : [electronOut]
  for (const out of outputs) {
    await mkdir(path.join(out, 'renderer'), { recursive: true })
    await writeFile(path.join(out, 'renderer/index.html'), html)
  }
}

/**
 * The macOS temperature helper, compiled in place of being shipped prebuilt.
 *
 * Skipped entirely off macOS — there is no such sensor API to call and no
 * compiler to assume — and skipped without failing where the command line tools
 * are absent, because a missing temperature is a missing row and a build that
 * stops is a build nobody can run. See `src/native/macsensors.c`.
 *
 * Both architectures in one pass. `clang` takes repeated `-arch` and emits a
 * universal binary directly, which matters because the app ships as one: a
 * helper built for the machine that packaged it would refuse to run for half the
 * people who install it, and refuse silently, since a bad architecture looks
 * exactly like a missing file from the other side of `spawn`.
 *
 * Lands in `resources/`, which `extraResources` already copies wholesale, so
 * there is no packaging entry to keep in step with this.
 *
 * It does need one line of packaging config, and the reason is worth writing
 * down because the error it prevents reads as the opposite of the truth.
 * `@electron/universal` builds the app once per architecture and merges the two,
 * and for every Mach-O file it finds it compares the two copies: different means
 * "run lipo on them", identical means "somebody shipped a single-architecture
 * binary in both builds", which is a real and serious mistake — so it refuses,
 * with `Detected file … that's the same in both x64 and arm64 builds`. This file
 * is identical in both because it is *already* universal, which is the one case
 * that looks exactly like the mistake and is its opposite. `mac.x64ArchFiles`
 * in `package.json` is how you say so, and it selects the branch that keeps the
 * file as it is rather than lipo-ing it with itself.
 *
 * That is a claim rather than a guarantee, so it is checked instead of trusted:
 * `tools/verifyUniversal.mjs` opens the packaged binary and fails the build if
 * both slices are not actually in there.
 */
async function buildMacSensors() {
  if (process.platform !== 'darwin') return
  const outDir = path.join(root, 'resources', 'bin')
  await mkdir(outDir, { recursive: true })

  const done = await new Promise((resolve) => {
    const clang = spawn(
      'clang',
      [
        '-O2',
        '-arch', 'arm64',
        '-arch', 'x86_64',
        // The oldest macOS the app supports. Without it clang targets whatever
        // built it and the binary refuses to launch on anything older.
        '-mmacosx-version-min=11.0',
        '-o', path.join(outDir, 'macsensors'),
        path.join(root, 'src/native/macsensors.c'),
        '-framework', 'CoreFoundation',
        '-framework', 'IOKit',
      ],
      { stdio: 'inherit' }
    )
    clang.on('error', () => resolve(false))
    clang.on('exit', (code) => resolve(code === 0))
  })

  console.log(done ? '[build] macsensors (universal)' : '[build] macsensors skipped — no working clang')
}

const targets = electronTargets

if (watch) {
  await copyStatic()
  await buildMacSensors()
  const contexts = await Promise.all(targets.map((t) => context(t)))
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('[build] watching…')
  if (launchElectron) {
    const electron = (await import('electron')).default
    spawn(electron, ['.'], { stdio: 'inherit', cwd: root }).on('exit', () => process.exit(0))
  }
} else {
  await rm(electronOut, { recursive: true, force: true })
  await copyStatic()
  await Promise.all([...targets.map((t) => build(t)), buildMacSensors()])
  console.log('[build] done')
}
