// Every custom property the stylesheet uses is one the stylesheet defines.
//
// CSS fails silently. `background: var(--surface-1)` where nothing defines
// `--surface-1` is not an error, not a warning, and not visible in a diff — the
// declaration is simply dropped and the element renders with no background. It
// went unnoticed on `.tokens-card` for as long as that card has existed, and
// was found by accident while writing a different pane.
//
// A variable with a fallback — `var(--x, y)` — is deliberately allowed: that is
// the form that says "this may not exist", and it degrades to something chosen.
// A bare `var(--x)` is a claim that `--x` is defined, and this checks the claim.
import assert from 'node:assert/strict'
import fs from 'node:fs'

const css = fs.readFileSync('src/renderer/styles.css', 'utf8')

/** Every `--name:` that appears as a declaration, anywhere in any block. */
const defined = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]))

/** Every bare `var(--name)`, excluding the ones carrying their own fallback. */
const used = new Map()
for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
  if (m[2] === ',') continue
  const line = css.slice(0, m.index).split('\n').length
  if (!used.has(m[1])) used.set(m[1], line)
}

const missing = [...used].filter(([name]) => !defined.has(name))

console.log(`  ${defined.size} custom properties defined, ${used.size} used without a fallback`)
assert.deepEqual(
  missing.map(([name, line]) => `styles.css:${line} uses ${name}, which nothing defines`),
  [],
  'a var() with no fallback and no definition renders as nothing at all'
)
console.log('  ok every var() without a fallback resolves')
console.log('\n1 check passed')
