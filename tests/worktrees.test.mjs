// Worktrees, against a real git in a throwaway repository.
//
// Not mocked, because everything worth getting wrong here is git's behaviour
// rather than ours: which record `--porcelain` puts first, whether a branch
// that already exists needs a different command, and — the one that matters —
// that removing a worktree with uncommitted work in it is refused. A fake git
// would agree with whatever this file assumed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

// Resolved, because on macOS the temp folder is reached through a symlink
// (/var -> /private/var) and git always reports the path it really is. Testing
// against the unresolved name compares a symlink to its target and fails there
// and nowhere else.
const out = path.join(fs.realpathSync(os.tmpdir()), 'iaw-worktree-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { worktrees: 'src/main/worktrees.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const W = await import(`file://${out}/worktrees.js`)

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

// ------------------------------------------------------------------ parsing
console.log('Porcelain parsing')
{
  check('the first record is the main checkout', () => {
    // Nothing in the output says which one is main — it is first, and that is
    // the only signal. Getting it wrong would offer the repository itself for
    // removal.
    const parsed = W.parseWorktrees(
      [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /repo-feature',
        'HEAD def456',
        'branch refs/heads/feature/thing',
        '',
      ].join('\n')
    )
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0].main, true)
    assert.equal(parsed[1].main, false)
    assert.equal(parsed[1].branch, 'feature/thing', 'refs/heads/ is stripped')
  })

  check('a detached worktree has a head and no branch', () => {
    const parsed = W.parseWorktrees(
      ['worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '', 'worktree /d', 'HEAD bbb', 'detached', ''].join('\n')
    )
    assert.equal(parsed[1].branch, undefined)
    assert.equal(parsed[1].head, 'bbb')
  })

  check('locked and prunable are flags, not values', () => {
    const parsed = W.parseWorktrees(
      ['worktree /repo', 'HEAD a', '', 'worktree /gone', 'HEAD b', 'prunable gitdir file points to non-existent location', 'locked', ''].join('\n')
    )
    assert.equal(parsed[1].prunable, true)
    assert.equal(parsed[1].locked, true)
  })

  check('a trailing record with no blank line is still returned', () => {
    // Real output ends with a blank line, but trusting that would make the last
    // worktree vanish the day it does not.
    const parsed = W.parseWorktrees('worktree /repo\nHEAD a\nbranch refs/heads/main')
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].branch, 'main')
  })

  check('empty output is no worktrees, not a crash', () => {
    assert.deepEqual(W.parseWorktrees(''), [])
  })
}

// -------------------------------------------------------------- branch names
console.log('Branch name guards')
{
  const repo = path.join(out, 'unused')
  for (const bad of ['', '  ', 'has space', 'tilde~1', 'caret^', 'colon:x', 'star*', '-leading', 'a..b', 'back\\slash']) {
    // Refused before git sees them: git's message for these talks about ref
    // formats and never mentions what the user typed.
    const res = await W.addWorktree(repo, { branch: bad, dir: path.join(out, 'x') })
    assert.equal(res.ok, false, `"${bad}" should be refused`)
  }
  passed++
  console.log('  ok', 'unusable branch names are refused before git runs')
}

// ---------------------------------------------------------- against real git
console.log('Against a real repository')
{
  const repo = path.join(out, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const g = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })

  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'test@example.invalid')
  g('config', 'user.name', 'iaw tests')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\n')
  g('add', '.')
  g('commit', '-q', '-m', 'first')

  await checkAsync('a fresh repository has one worktree, and it is main', async () => {
    const list = await W.listWorktrees(repo)
    assert.equal(list.length, 1)
    assert.equal(list[0].main, true)
    assert.equal(list[0].branch, 'main')
  })

  await checkAsync('repoRoot finds the checkout from inside it', async () => {
    const root = await W.repoRoot(repo)
    assert.equal(path.resolve(root), path.resolve(repo))
  })

  await checkAsync('a folder outside any repository has no worktrees', async () => {
    assert.deepEqual(await W.listWorktrees(os.tmpdir()), [])
  })

  const wtDir = path.join(out, 'repo-feature')
  await checkAsync('adding creates the branch and the checkout', async () => {
    const res = await W.addWorktree(repo, { branch: 'feature/thing', dir: wtDir })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.created, true, 'the branch did not exist, so it was created')
    assert.ok(fs.existsSync(path.join(wtDir, 'file.txt')), 'the tree is checked out')
  })

  await checkAsync('it shows up as a non-main worktree', async () => {
    const list = await W.listWorktrees(repo)
    assert.equal(list.length, 2)
    const feature = list.find((w) => w.branch === 'feature/thing')
    assert.ok(feature)
    assert.equal(feature.main, false)
  })

  await checkAsync('worktreeAt identifies the folder, and never the main one', async () => {
    const found = await W.worktreeAt(wtDir)
    assert.ok(found, 'the worktree folder resolves')
    assert.equal(found.branch, 'feature/thing')
    assert.equal(await W.worktreeAt(repo), null, 'the main checkout is not a removable worktree')
  })

  await checkAsync('a subdirectory of a worktree resolves to it', async () => {
    const sub = path.join(wtDir, 'nested', 'deeper')
    fs.mkdirSync(sub, { recursive: true })
    const found = await W.worktreeAt(sub)
    assert.equal(found?.branch, 'feature/thing')
  })

  await checkAsync('adding the same branch again is refused, with git saying why', async () => {
    const res = await W.addWorktree(repo, { branch: 'feature/thing', dir: path.join(out, 'again') })
    assert.equal(res.ok, false)
    assert.match(res.error, /already (checked out|used)/i)
  })

  await checkAsync('a dirty worktree is NOT removed', async () => {
    // The refusal is the feature. It is the only thing between "close a
    // workspace" and "lose an afternoon".
    fs.writeFileSync(path.join(wtDir, 'unsaved.txt'), 'work in progress\n')
    const res = await W.removeWorktree(repo, wtDir, false)
    assert.equal(res.ok, false)
    assert.match(res.error, /modified or untracked|use --force/i)
    assert.ok(fs.existsSync(wtDir), 'and the folder is still there')
  })

  await checkAsync('forcing removes it, and the branch survives', async () => {
    const res = await W.removeWorktree(repo, wtDir, true)
    assert.equal(res.ok, true, res.error)
    assert.equal(fs.existsSync(wtDir), false)
    const branches = g('branch', '--list', 'feature/thing')
    assert.match(branches, /feature\/thing/, 'removing a worktree must not delete the branch')
  })

  await checkAsync('an existing branch is checked out rather than recreated', async () => {
    const res = await W.addWorktree(repo, { branch: 'feature/thing', dir: wtDir })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.created, false, 'the branch already existed')
    await W.removeWorktree(repo, wtDir, true)
  })

  check('the suggested folder is a sibling named for the branch', () => {
    const suggested = W.suggestWorktreeDir(repo, 'feature/thing')
    assert.equal(path.dirname(suggested), path.dirname(repo))
    assert.match(path.basename(suggested), /^repo-feature-thing$/)
  })
}

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
