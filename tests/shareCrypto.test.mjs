// Encrypting commands for the shared folder, and stripping the secrets in them.
//
// Two claims worth pinning. That a sealed blob is unreadable without the
// passphrase and unmodifiable with it — the second matters as much as the
// first, because a file in a synced folder is a file other things can touch.
// And that redaction catches the shapes it claims to, which is testable in a
// way "is this secret" is not.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-crypto-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { crypto: 'src/main/shareCrypto.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const { seal, unseal, redact } = await import(`file://${out}/crypto.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const PASS = 'correct horse battery staple'

check('what goes in comes back out', () => {
  const text = JSON.stringify({ commands: ['npm test', 'git push'] })
  assert.equal(unseal(seal(text, PASS), PASS), text)
})

check('the wrong passphrase gets nothing, not a guess', () => {
  assert.equal(unseal(seal('npm test', PASS), 'not the passphrase'), null)
})

check('the plaintext is not in the blob', () => {
  const blob = seal('psql postgres://me@host/db', PASS)
  assert.ok(!blob.includes('postgres'), 'a blob you can read is not encryption')
  assert.ok(blob.startsWith('iaw1.'), 'and it says what it is, so a later format can differ')
})

check('two seals of the same text differ', () => {
  // A fresh salt and nonce each time. Without it, identical files in the folder
  // would announce that two machines ran the same commands.
  assert.notEqual(seal('ls', PASS), seal('ls', PASS))
})

check('a blob altered in the folder fails rather than decrypting to something else', () => {
  const blob = seal('npm test', PASS)
  const body = blob.slice('iaw1.'.length)
  const raw = Buffer.from(body, 'base64')
  raw[raw.length - 1] ^= 0xff
  assert.equal(unseal(`iaw1.${raw.toString('base64')}`, PASS), null)
})

check('anything that is not ours is declined quietly', () => {
  for (const junk of ['', 'not a blob', 'iaw1.', 'iaw1.####', '{"commands":[]}']) {
    assert.equal(unseal(junk, PASS), null, `refused: ${JSON.stringify(junk)}`)
  }
})

// ------------------------------------------------------------------ redaction

const gone = (input, secret) => {
  const out = redact(input)
  assert.ok(!out.includes(secret), `${JSON.stringify(secret)} survived in ${JSON.stringify(out)}`)
  return out
}

check('a password in a connection string goes', () => {
  const out = gone('psql postgres://me:hunter2@db.example.com/app', 'hunter2')
  assert.ok(out.includes('postgres://me'), 'and what it was still says what to run')
})

check('a bearer token goes', () => {
  gone('curl -H "Authorization: Bearer sk-ant-abc123def456" https://api', 'sk-ant-abc123def456')
})

check('secret-shaped flags go, whatever the flag is called', () => {
  gone('deploy --token=ghp_abcdefghijklmnop1234', 'ghp_abcdefghijklmnop1234')
  gone('mysql --password hunter2 -h host', 'hunter2')
  gone('tool --api-key="abcd1234efgh"', 'abcd1234efgh')
})

check('keys are caught by their own shape, with no flag to go on', () => {
  gone('echo sk-ant-api03-XYZ123456789', 'sk-ant-api03-XYZ123456789')
  gone('aws configure AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE')
})

check('an environment assignment that names a secret goes', () => {
  gone('GITHUB_TOKEN=ghp_zzzzzzzzzzzzzzzzzzzz npm publish', 'ghp_zzzzzzzzzzzzzzzzzzzz')
  gone('DB_PASSWORD=hunter2 ./run.sh', 'hunter2')
})

check('an ordinary command is left exactly as it was', () => {
  for (const command of [
    'npm run release',
    'git commit -m "fixed the parser"',
    'ls -a',
    './build_windows.bat',
  ]) {
    assert.equal(redact(command), command)
  }
})

console.log(`\n${passed} checks passed`)
