// Where the app looks for programs it did not spawn a shell for.
//
// A GUI process on macOS inherits launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin`
// — so `gh` in `/opt/homebrew/bin` is invisible to an app opened from the Dock
// and perfectly visible to the same build started from a terminal. The publish
// panel asks `gh auth status` to decide whether it can make a project in one
// click, and from the packaged app that answered ENOENT with `gh` installed and
// signed in.
//
// The ordering is the part worth pinning: places are only ever *added*, never
// put in front of what the process already had, or a project's own tools would
// stop winning for an app started from its terminal.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-toolpath-'))
const outfile = path.join(sandbox, 'toolPath.mjs')
await build({
  entryPoints: ['src/main/toolPath.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  external: ['electron'],
})

const { mergePaths, primeToolPath, toolPath } = await import(`file://${outfile}`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

// Every folder exists unless a test says otherwise.
const all = () => true

console.log('Tool PATH')

check('the inherited PATH keeps its order and stays in front', () => {
  const merged = mergePaths(['/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin'], ':', all)
  assert.equal(merged, '/usr/bin:/bin:/opt/homebrew/bin')
})

check('a folder mentioned twice is kept once, at its first place', () => {
  const merged = mergePaths(['/a:/b:/a', '/b:/c'], ':', all)
  assert.equal(merged, '/a:/b:/c')
})

// A PATH is read on every spawn, and a folder that is not there is a `stat`
// each time for nothing.
check('folders that do not exist are dropped', () => {
  const merged = mergePaths(['/a:/gone', '/b'], ':', (dir) => dir !== '/gone')
  assert.equal(merged, '/a:/b')
})

check('a source that is missing or empty contributes nothing', () => {
  const merged = mergePaths([undefined, '', '/a::/b', '   '], ':', all)
  assert.equal(merged, '/a:/b')
})

check('the separator is the platform\u2019s, not a hard-coded colon', () => {
  const merged = mergePaths(['C:\\bin;C:\\tools', 'C:\\other'], ';', all)
  assert.equal(merged, 'C:\\bin;C:\\tools;C:\\other')
})

// The whole point, end to end: given the PATH a Dock launch gets, the resolved
// one has to reach the places things are actually installed.
await (async () => {
  const before = process.env.PATH
  process.env.PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter)
  try {
    const resolvedPath = await primeToolPath()
    const dirs = resolvedPath.split(path.delimiter)

    check('a GUI PATH still reaches the folders a login shell knows', () => {
      // Whatever this machine has: the login shell's answer, the known folders,
      // or both. What must not happen is ending up with launchd's four.
      assert.ok(dirs.length >= 4)
      assert.ok(dirs.includes('/usr/bin'), 'the inherited folders survive')
      if (process.platform !== 'win32') {
        assert.ok(
          dirs.length > 4 || !fs.existsSync('/opt/homebrew/bin'),
          'a machine with Homebrew installed must end up with more than launchd gave us'
        )
      }
    })

    check('the resolved PATH is what callers are handed', () => {
      assert.equal(toolPath(), resolvedPath)
    })

    check('every folder in it is real', () => {
      for (const dir of dirs) assert.ok(fs.existsSync(dir), `${dir} does not exist`)
    })
  } finally {
    process.env.PATH = before
  }
})()

console.log(`\n${passed} checks passed`)
fs.rmSync(sandbox, { recursive: true, force: true })
