// Runs every *.test.mjs in this folder, each in its own process, all at once.
//
// Separate processes because the Claude Code test redirects HOME to a sandbox,
// and a suite that can leak that into another suite is a suite that will
// eventually write to somebody's real config.
//
// Concurrent because almost all of the time here is esbuild bundling the real
// TypeScript, seven times over, and a machine with cores to spare was running
// them one after another. Safe to overlap: every suite builds into a temp
// folder of its own, and nothing in here touches the repo.
//
// Node's own test runner would do the process isolation too; it is skipped
// because the point of these files is to bundle the real TypeScript with
// esbuild and exercise it, which needs no framework and keeps the dependency
// list at what the app already ships.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const files = fs
  .readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

// esbuild is itself threaded, so more suites in flight than cores just makes
// them take turns. In practice there are fewer suites than cores and this cap
// never bites.
const lanes = Math.max(1, Math.min(files.length, os.availableParallelism?.() ?? os.cpus().length))

/** Finished suites by index, held until it is their turn to be printed. */
const done = new Array(files.length).fill(null)
let printed = 0
let failed = 0

/**
 * Prints finished suites in file order.
 *
 * Output is buffered rather than inherited: seven suites writing to one console
 * at once produces a transcript in which no single suite can be read. Held in
 * order rather than by finishing time so a failure is always in the same place
 * on the page, whichever suite happened to be quickest today.
 */
function flush() {
  while (printed < files.length && done[printed]) {
    const { file, output } = done[printed]
    process.stdout.write(`\n─── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}\n`)
    process.stdout.write(output)
    printed++
  }
}

function runSuite(index) {
  return new Promise((resolve) => {
    const file = files[index]
    // cwd is the repo root so the suites can point esbuild at src/ paths.
    const child = spawn(process.execPath, [path.join(here, file)], { cwd: root })

    // One buffer for both streams: a suite's assertions and its stack traces
    // belong in the order they were written, not in two separate blocks.
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))

    child.on('exit', (code) => {
      if (code !== 0) failed++
      done[index] = { file, output }
      flush()
      resolve()
    })
  })
}

let next = 0
await Promise.all(
  Array.from({ length: lanes }, async () => {
    while (next < files.length) await runSuite(next++)
  })
)

console.log()
if (failed) {
  console.error(`${failed} of ${files.length} suite${files.length === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log(`${files.length} suite${files.length === 1 ? '' : 's'} passed`)
