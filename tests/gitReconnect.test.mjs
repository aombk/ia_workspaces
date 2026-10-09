// Joining a folder copied without its `.git` back up with the project online.
//
// Against a real git and a real bare "online" repository, because the promise
// being tested is about what ends up on disk: the history comes back, the
// branch is the one online, and not one of the folder's files is touched.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-reconnect-'))
await build({
  entryPoints: { git: 'src/main/git.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const G = await import(`file://${out}/git.js`)

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

/** A bare "online" repository on `branch` with one save, and a copy of its files with no `.git`. */
function setup(name, branch) {
  const base = path.join(out, name)
  const online = path.join(base, 'online.git')
  const work = path.join(base, 'work')
  const copy = path.join(base, 'copy')
  fs.mkdirSync(work, { recursive: true })
  git(base, 'init', '--bare', `--initial-branch=${branch}`, online)
  git(work, 'init', `--initial-branch=${branch}`)
  git(work, 'config', 'user.email', 'test@example.com')
  git(work, 'config', 'user.name', 'Test Person')
  git(work, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n')
  fs.writeFileSync(path.join(work, 'b.txt'), 'two\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-m', 'first')
  git(work, 'remote', 'add', 'origin', online)
  git(work, 'push', '-q', 'origin', branch)

  fs.mkdirSync(copy)
  fs.writeFileSync(path.join(copy, 'a.txt'), 'one\nedited on the other machine\n')
  fs.writeFileSync(path.join(copy, 'b.txt'), 'two\n')
  fs.writeFileSync(path.join(copy, 'new.txt'), 'never saved\n')
  return { online, copy }
}

const snapshot = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((n) => n !== '.git')
      .map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')])
  )

console.log('Reconnecting')

await check('brings the history back and changes no file', async () => {
  const { online, copy } = setup('basic', 'main')
  const before = snapshot(copy)
  const res = await G.reconnect(copy, online)
  assert.equal(res.ok, true, res.hint ?? res.error)
  assert.deepEqual(snapshot(copy), before)
  assert.equal(git(copy, 'log', '--format=%s'), 'first')
  assert.equal(git(copy, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main')
  const status = git(copy, 'status', '--porcelain')
  assert.match(status, /^ ?M a\.txt$/m)
  assert.match(status, /^\?\? new\.txt$/m)
  assert.doesNotMatch(status, /b\.txt/)
})

await check('takes the branch name from online', async () => {
  const { online, copy } = setup('master', 'master')
  const res = await G.reconnect(copy, online)
  assert.equal(res.ok, true, res.hint ?? res.error)
  assert.equal(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master')
})

await check('a bad address leaves the folder exactly as it was', async () => {
  const { copy } = setup('bad', 'main')
  const before = snapshot(copy)
  const res = await G.reconnect(copy, path.join(out, 'nowhere.git'))
  assert.equal(res.ok, false)
  assert.equal(fs.existsSync(path.join(copy, '.git')), false)
  assert.deepEqual(snapshot(copy), before)
})

await check('an empty project online is refused and undone', async () => {
  const base = path.join(out, 'empty')
  fs.mkdirSync(path.join(base, 'copy'), { recursive: true })
  git(base, 'init', '--bare', 'online.git')
  const res = await G.reconnect(path.join(base, 'copy'), path.join(base, 'online.git'))
  assert.equal(res.ok, false)
  assert.equal(fs.existsSync(path.join(base, 'copy', '.git')), false)
})

await check('refuses a folder that is already a repository', async () => {
  const { online } = setup('already', 'main')
  const repo = path.join(out, 'already', 'work')
  const res = await G.reconnect(repo, online)
  assert.equal(res.ok, false)
  assert.equal(git(repo, 'log', '--format=%s'), 'first')
})

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
