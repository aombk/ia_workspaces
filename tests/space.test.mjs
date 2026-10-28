// The space pane's host side, against real folders and a real git.
//
// Not mocked, for the same reason as the worktree suite: what matters here is
// what actually happens on disk. That `clean` refuses a folder that only looks
// regenerable, that a trimmed history really is smaller and still has your
// files, that nothing is rewritten when the backup cannot be written — a fake
// filesystem would agree with whatever this file assumed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(fs.realpathSync(os.tmpdir()), 'iaw-space-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { space: 'src/main/space.ts', rules: 'src/shared/space.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const S = await import(`file://${out}/space.js`)
const R = await import(`file://${out}/rules.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}
const checkAsync = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

const write = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim()

/** A repository with `n` commits, a second branch, a tag and a stash. */
function makeRepo(name, n) {
  const dir = path.join(out, name)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  for (let i = 1; i <= n; i++) {
    write(path.join(dir, 'file.txt'), `version ${i}\n${'filler '.repeat(2000)}${i}`)
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `commit ${i}`)
  }
  git(dir, 'branch', 'side', 'HEAD~1')
  git(dir, 'tag', 'v1', 'HEAD~2')
  write(path.join(dir, 'file.txt'), 'stashed work')
  git(dir, 'stash', '-q')
  return dir
}

// ------------------------------------------------------------------- rules
console.log('Which folders are regenerable')
{
  const none = () => false
  check('node_modules needs a package.json beside it', () => {
    assert.ok(R.matchRegenerable('node_modules', ['package.json', 'src'], none))
    assert.equal(R.matchRegenerable('node_modules', ['src'], none), null)
  })
  check('a virtualenv is known by what is inside it, not its name', () => {
    assert.ok(R.matchRegenerable('.venv', [], (f) => f === 'pyvenv.cfg'))
    assert.equal(R.matchRegenerable('.venv', [], none), null)
  })
  check('a CMake build is ticked; a web build is offered but not ticked', () => {
    assert.equal(R.matchRegenerable('build', ['CMakeLists.txt'], none).suggested, true)
    assert.equal(R.matchRegenerable('build', ['package.json'], none).suggested, false)
    assert.equal(R.matchRegenerable('build', ['notes.md'], none), null)
  })
  check('an Xcode project marks its build folder by extension', () => {
    assert.ok(R.matchRegenerable('build', ['App.xcodeproj'], none))
  })
  check('the keep list covers a path and everything under it', () => {
    const keep = R.parseKeepList('# comment\nnode_modules/\n./dist # release\n')
    assert.deepEqual(keep, ['node_modules', 'dist'])
    assert.ok(R.isKept('node_modules', keep))
    assert.ok(R.isKept('dist/app', keep))
    assert.ok(!R.isKept('distant', keep))
  })
}

// ----------------------------------------------------------------- measure
console.log('Measuring')
const proj = path.join(out, 'proj')
{
  write(path.join(proj, 'package.json'), '{}')
  write(path.join(proj, 'src/index.js'), 'console.log(1)')
  write(path.join(proj, 'node_modules/a/index.js'), 'a'.repeat(100_000))
  // Inside a regenerable folder: belongs to it, never listed on its own.
  write(path.join(proj, 'node_modules/a/build/CMakeLists.txt'))
  write(path.join(proj, 'node_modules/a/build/build/x'))
  write(path.join(proj, 'dist/app.js'), 'b'.repeat(50_000))
  write(path.join(proj, 'lib/build/notes.md'), 'not a build')
  write(path.join(proj, 'native/CMakeLists.txt'))
  write(path.join(proj, 'native/build/obj.o'), 'c'.repeat(20_000))
  write(path.join(proj, 'py/.venv/pyvenv.cfg'))
  write(path.join(proj, 'py/.venv/lib/site.py'), 'd'.repeat(10_000))
  write(path.join(proj, '.devpark'), 'dist\n')

  await checkAsync('finds each regenerable folder once, and nothing inside them', async () => {
    const r = await S.measure(proj)
    const rels = r.regenerables.map((x) => x.rel).sort()
    assert.deepEqual(rels, ['dist', 'native/build', 'node_modules', 'py/.venv'])
    assert.ok(r.bytes >= r.regenerables.reduce((s, x) => s + x.bytes, 0))
    assert.ok(r.files >= 10)
  })
  await checkAsync('marks what the keep list protects', async () => {
    const r = await S.measure(proj)
    assert.equal(r.regenerables.find((x) => x.rel === 'dist').kept, true)
    assert.equal(r.regenerables.find((x) => x.rel === 'node_modules').kept, false)
  })
  await checkAsync('a missing folder is an error, not a zero', async () => {
    const r = await S.measure(path.join(out, 'nope'))
    assert.ok(r.error)
  })
}

// ------------------------------------------------------------------- clean
console.log('Cleaning')
{
  await checkAsync('refuses a folder that only has the name', async () => {
    const res = await S.clean(proj, [path.join(proj, 'lib/build')])
    assert.equal(res.ok, false)
    assert.ok(fs.existsSync(path.join(proj, 'lib/build/notes.md')))
  })
  await checkAsync('refuses anything outside the project, and the project itself', async () => {
    assert.equal((await S.clean(proj, [out])).ok, false)
    assert.equal((await S.clean(proj, [proj])).ok, false)
    assert.equal((await S.clean(proj, [path.join(proj, '..', 'proj', '..')])).ok, false)
    assert.ok(fs.existsSync(proj))
  })
  await checkAsync('refuses what the keep list protects', async () => {
    const res = await S.clean(proj, [path.join(proj, 'dist')])
    assert.equal(res.ok, false)
    assert.ok(fs.existsSync(path.join(proj, 'dist/app.js')))
  })
  await checkAsync('deletes what it recognises and says how much', async () => {
    const res = await S.clean(proj, [path.join(proj, 'node_modules'), path.join(proj, 'native/build')])
    assert.equal(res.ok, true, res.error)
    assert.ok(res.freedBytes > 100_000)
    assert.ok(!fs.existsSync(path.join(proj, 'node_modules')))
    assert.ok(!fs.existsSync(path.join(proj, 'native/build')))
    assert.ok(fs.existsSync(path.join(proj, 'src/index.js')))
    assert.ok(fs.existsSync(path.join(proj, 'native/CMakeLists.txt')))
  })
}

// --------------------------------------------------------------------- git
console.log('Git history')
{
  await checkAsync('reports branches, tags, stashes and a missing local remote', async () => {
    const dir = makeRepo('info', 4)
    git(dir, 'remote', 'add', 'origin', path.join(out, 'gone'))
    const g = await S.gitInfo(dir)
    assert.equal(g.repo, true)
    assert.equal(g.branch, 'main')
    assert.equal(g.commits, 4)
    assert.equal(g.branches, 2)
    assert.equal(g.tags, 1)
    assert.equal(g.stashes, 1)
    assert.equal(g.remotes[0].missing, true)
    assert.ok(g.gitBytes > 0)
  })

  await checkAsync('a folder inside a repository is not a repository of its own', async () => {
    const dir = makeRepo('outer', 3)
    fs.mkdirSync(path.join(dir, 'sub'))
    assert.equal((await S.gitInfo(path.join(dir, 'sub'))).repo, false)
  })

  await checkAsync('compact keeps every commit', async () => {
    const dir = makeRepo('compact', 5)
    const res = await S.gitCompact(dir)
    assert.equal(res.ok, true, res.error)
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '5')
    assert.equal(git(dir, 'tag'), 'v1')
  })

  await checkAsync('nothing is rewritten without a backup that verifies', async () => {
    const dir = makeRepo('nobackup', 5)
    const head = git(dir, 'rev-parse', 'HEAD')
    const res = await S.gitTrim(dir, 2, '')
    assert.equal(res.ok, false)
    const bad = await S.gitTrim(dir, 2, path.join(out, 'no-such-folder', 'x.bundle'))
    assert.equal(bad.ok, false)
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head)
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '5')
  })

  await checkAsync('keep last N: same files, N commits, the rest gone, backup restores it all', async () => {
    const dir = makeRepo('trim', 6)
    write(path.join(dir, 'uncommitted.txt'), 'still here')
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}')
    const subjects = git(dir, 'log', '-3', '--format=%s')
    const bundle = path.join(out, 'trim.bundle')
    const res = await S.gitTrim(dir, 3, bundle)
    assert.equal(res.ok, true, res.error)
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '3')
    assert.equal(git(dir, 'rev-parse', 'HEAD^{tree}'), tree)
    assert.equal(git(dir, 'log', '-3', '--format=%s'), subjects)
    assert.equal(git(dir, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main')
    assert.equal(fs.readFileSync(path.join(dir, 'uncommitted.txt'), 'utf8'), 'still here')
    assert.equal(git(dir, 'fsck', '--no-dangling', '--no-progress'), '')
    // The backup is the whole history, branches and tags included.
    const restored = path.join(out, 'restored')
    git(out, 'clone', '-q', bundle, restored)
    assert.equal(git(restored, 'rev-list', '--count', 'origin/main'), '6')
    assert.equal(git(restored, 'tag'), 'v1')
  })

  await checkAsync('squash leaves one commit holding the same files', async () => {
    const dir = makeRepo('squash', 5)
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}')
    const before = (await S.gitInfo(dir)).gitBytes
    const res = await S.gitTrim(dir, 1, path.join(out, 'squash.bundle'))
    assert.equal(res.ok, true, res.error)
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1')
    assert.equal(git(dir, 'rev-parse', 'HEAD^{tree}'), tree)
    assert.match(git(dir, 'log', '-1', '--format=%s'), /^Squashed history: 5 commits/)
    assert.ok((await S.gitInfo(dir)).gitBytes <= before)
  })

  await checkAsync('refuses to rewrite on a detached HEAD or with linked worktrees', async () => {
    const dir = makeRepo('refuse', 4)
    git(dir, 'checkout', '-q', '--detach')
    assert.equal((await S.gitTrim(dir, 1, path.join(out, 'r1.bundle'))).ok, false)
    git(dir, 'checkout', '-q', 'main')
    git(dir, 'worktree', 'add', '-q', path.join(out, 'refuse-wt'), 'side')
    assert.equal((await S.gitTrim(dir, 1, path.join(out, 'r2.bundle'))).ok, false)
    assert.equal((await S.gitRemove(dir, path.join(out, 'r3.bundle'))).ok, false)
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '4')
  })

  await checkAsync('remove deletes .git after backing it up, and leaves the files', async () => {
    const dir = makeRepo('remove', 3)
    const bundle = path.join(out, 'remove.bundle')
    const res = await S.gitRemove(dir, bundle)
    assert.equal(res.ok, true, res.error)
    assert.ok(!fs.existsSync(path.join(dir, '.git')))
    assert.ok(fs.existsSync(path.join(dir, 'file.txt')))
    assert.ok(fs.statSync(bundle).size > 0)
  })
}

// ---------------------------------------------------------------- compress
if (S.compressor() === 'ready') {
  console.log('Compressing (afsctool is installed)')
  await checkAsync('shrinks on disk and every file reads back the same', async () => {
    const dir = path.join(out, 'squeeze')
    const text = 'the same line, over and over\n'.repeat(20_000)
    for (let i = 0; i < 5; i++) write(path.join(dir, `f${i}.txt`), text)
    const before = await S.measure(dir)
    const res = await S.compress(dir)
    assert.equal(res.ok, true, res.error)
    const after = await S.measure(dir)
    assert.ok(after.bytes < before.bytes, `${after.bytes} < ${before.bytes}`)
    assert.equal(after.apparentBytes, before.apparentBytes)
    for (let i = 0; i < 5; i++) assert.equal(fs.readFileSync(path.join(dir, `f${i}.txt`), 'utf8'), text)
  })
} else {
  console.log(`Compressing skipped: ${S.compressor()}`)
}

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
