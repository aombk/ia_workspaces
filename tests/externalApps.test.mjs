// Splitting a program's arguments, and reading a workspace's programs back.
//
// The first is a field somebody types into, so the cases that matter are the
// ones where a shell would do something and this must not: a path with spaces,
// a quoted argument, an ampersand.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-externalapps-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { externalApps: 'src/main/externalApps.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  outdir: out,
})

const { splitArgs } = await import(`file://${out}/externalApps.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

check('plain words are arguments', () => {
  assert.deepEqual(splitArgs('--open --new'), ['--open', '--new'])
})

check('nothing in, nothing out', () => {
  assert.deepEqual(splitArgs(''), [])
  assert.deepEqual(splitArgs('   '), [])
})

check('quotes group a path with spaces, and are not kept', () => {
  assert.deepEqual(splitArgs(String.raw`"C:/Program Files/x/y.jucer" --open`), [
    'C:/Program Files/x/y.jucer',
    '--open',
  ])
})

check('an empty quoted argument survives as an empty argument', () => {
  assert.deepEqual(splitArgs('--name "" --last'), ['--name', '', '--last'])
})

check('single quotes group too', () => {
  assert.deepEqual(splitArgs("--title 'my project'"), ['--title', 'my project'])
})

check('nothing is interpreted — this is a field, not a shell', () => {
  assert.deepEqual(splitArgs('a&b'), ['a&b'])
  assert.deepEqual(splitArgs('$HOME %USERPROFILE%'), ['$HOME', '%USERPROFILE%'])
  assert.deepEqual(splitArgs('*.wav'), ['*.wav'])
  assert.deepEqual(splitArgs('C:/a/b'), ['C:/a/b'])
})

check('runs of whitespace collapse rather than making empty arguments', () => {
  assert.deepEqual(splitArgs('  one   two\tthree '), ['one', 'two', 'three'])
})

console.log(`\n${passed} checks passed`)
