// What bringing in would change, and which of those files you changed too.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-incoming-'))
const outfile = path.join(sandbox, 'gitIncoming.mjs')
await build({ entryPoints: ['src/shared/gitIncoming.ts'], bundle: true, platform: 'node', format: 'esm', outfile })
const { parseNameStatus, parseNameOnly, bothChanged, namedList } = await import(`file://${outfile}`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`  ok ${name}`)
}

check('git -z name-status reads as files, odd names included', () => {
  assert.deepEqual(parseNameStatus('M\0src/a b.ts\0A\0new\nline.txt\0D\0gone.txt\0'), [
    { repoPath: 'src/a b.ts', change: 'M' },
    { repoPath: 'new\nline.txt', change: 'A' },
    { repoPath: 'gone.txt', change: 'D' },
  ])
  assert.deepEqual(parseNameStatus(''), [])
  assert.deepEqual(parseNameOnly('a\0b\0'), ['a', 'b'])
})

check('only files both sides touched, and where they are here', () => {
  const incoming = [{ repoPath: 'a', change: 'M' }, { repoPath: 'b', change: 'M' }, { repoPath: 'C', change: 'M' }, { repoPath: 'd', change: 'M' }]
  const r = bothChanged(incoming, ['a', 'c', 'x'], ['c', 'b'], true)
  assert.deepEqual(r, [
    { repoPath: 'a', here: 'unsaved' },
    { repoPath: 'b', here: 'unsent' },
    { repoPath: 'C', here: 'both' },
  ])
  assert.deepEqual(bothChanged(incoming, ['c'], [], false), [], 'case counts where the disk says it does')
})

check('a long list is cut with a count', () => {
  assert.equal(namedList(['a', 'b']), 'a, b')
  assert.equal(namedList(['a', 'b', 'c', 'd', 'e', 'f'], 4), 'a, b, c, d and 2 more')
})

console.log(`\n${passed} checks passed`)
