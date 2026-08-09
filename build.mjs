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

async function copyStatic() {
  const html = await readFile(path.join(root, 'src/renderer/index.html'), 'utf8')
  await mkdir(path.join(electronOut, 'renderer'), { recursive: true })
  await writeFile(path.join(electronOut, 'renderer/index.html'), html)
}

const targets = electronTargets

if (watch) {
  await copyStatic()
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
  await Promise.all(targets.map((t) => build(t)))
  console.log('[build] done')
}
