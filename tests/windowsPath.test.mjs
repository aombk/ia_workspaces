// The PATH a Windows pane starts with, rebuilt from the registry.
//
// Explorer can hand the app a PATH with the whole user half missing, and every
// pane inherited it: `claude` was "not recognized" in a pane and found at once
// in Windows Terminal. What is pinned here is the reading of `reg.exe` output
// and the `%VAR%` expansion, the two parts that fail quietly.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-winpath-'))
const outfile = path.join(sandbox, 'windowsPath.mjs')
await build({
  entryPoints: ['src/main/windowsPath.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  external: ['electron'],
})

const { parseRegPath, expandWindowsVars, registryMergedPath } = await import(`file://${outfile}`)

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

console.log('Windows PATH')

await check('reads the value, spaces and all', () => {
  const out = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    C:\\Program Files\\x;%USERPROFILE%\\bin',
    '',
  ].join('\r\n')
  assert.equal(parseRegPath(out), 'C:\\Program Files\\x;%USERPROFILE%\\bin')
})

await check('a plain REG_SZ is read too', () => {
  assert.equal(parseRegPath('    Path    REG_SZ    C:\\a'), 'C:\\a')
})

await check('no Path line is nothing, not an empty PATH', () => {
  assert.equal(parseRegPath('HKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_SZ    C:\\t\r\n'), undefined)
})

await check('expansion ignores case and leaves unknown names as written', () => {
  const env = { USERPROFILE: 'C:\\Users\\k' }
  assert.equal(expandWindowsVars('%userprofile%\\bin;%NOPE%\\x', env), 'C:\\Users\\k\\bin;%NOPE%\\x')
})

if (process.platform === 'win32') {
  await check('what the registry adds comes after what was inherited', async () => {
    const inherited = os.tmpdir()
    const merged = await registryMergedPath(inherited, process.env)
    assert.equal(merged.split(';')[0], inherited)
    assert.ok(merged.split(';').length > 1, 'the registry added something')
  })
}

console.log(`${passed} passed`)
