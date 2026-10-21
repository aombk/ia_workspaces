// JUCE binary XML, and the indent/compact pair that makes it readable.
//
// What has to be right is the round trip: a preset opened and saved without an
// edit must be byte-for-byte the file it was, and one saved with an edit must
// differ only by that edit — the plugin reading it back has no idea an editor
// was ever involved, and should not need one.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-juce-test-'))

await build({
  entryPoints: { files: 'src/main/files.ts', layout: 'src/shared/xmlLayout.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
  logLevel: 'silent',
})

const F = await import(`file://${out}/files.js`)
const { indentXml, compactXml } = await import(`file://${out}/layout.js`)

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

/** What `copyXmlToBinary` writes, built by hand so the test does not trust the code under test. */
const juceFile = (xml) => {
  const body = Buffer.from(xml, 'utf8')
  const header = Buffer.alloc(8)
  header.write('VC2!', 0, 'latin1')
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body, Buffer.from([0])])
}

const STATE =
  '<?xml version="1.0" encoding="UTF-8"?>\n\n<synth formatVersion="1"><PARAM id="gain" value="0.5"/>' +
  '<PARAM id="name" value="a &gt; b"/><Mod><Slot target="cutoff" blob="eQxFPwXu/+="/></Mod>' +
  '<Note>keep  this  text</Note><Empty></Empty><!-- a > comment --><Data><![CDATA[<raw>]]></Data></synth>'

console.log('Binary XML')

await check('the XML comes out of the frame exactly', () => {
  assert.equal(F.juceXmlOf(juceFile(STATE)), STATE)
})

await check('framing it again gives the same bytes', () => {
  assert.deepEqual(F.juceXmlBytes(STATE), juceFile(STATE))
})

await check('non-ASCII text is counted in bytes, not characters', () => {
  const xml = '<p name="Φίλτρο ✓"/>'
  assert.deepEqual(F.juceXmlBytes(xml), juceFile(xml))
  assert.equal(F.juceXmlOf(juceFile(xml)), xml)
})

await check('a file that only starts the same way is not one', () => {
  assert.equal(F.juceXmlOf(Buffer.from('VC2!')), null, 'too short')
  assert.equal(F.juceXmlOf(Buffer.from('<?xml version="1.0"?><a/>')), null, 'plain XML')
  const lying = juceFile('<a/>')
  lying.writeUInt32LE(1000, 4)
  assert.equal(F.juceXmlOf(lying), null, 'length past the end')
  const notText = juceFile('<a/>')
  notText[9] = 0xff
  assert.equal(F.juceXmlOf(notText), null, 'not UTF-8 inside')
})

await check('read and write through the disk, and the file is what JUCE wrote', async () => {
  const file = path.join(out, 'preset.synthpreset')
  fs.writeFileSync(file, juceFile(STATE))
  const xml = await F.readJuceXml(file)
  assert.equal(xml, STATE)
  await F.writeJuceXml(file, compactXml(indentXml(xml)))
  assert.deepEqual(fs.readFileSync(file), juceFile(STATE), 'unchanged after open-and-save')
})

await check('readText refuses it as not text, which is how the editor knows to look', async () => {
  const file = path.join(out, 'preset2.synthpreset')
  fs.writeFileSync(file, juceFile('<a/>'.replace('a', 'a x="é"')).fill(0xf2, 4, 5))
  await assert.rejects(F.readText(file), /not a UTF-8 text file/)
})

await check('a text file over the old two-megabyte limit now opens', async () => {
  const file = path.join(out, 'big.log')
  fs.writeFileSync(file, 'line of a log\n'.repeat(300_000))
  assert.equal((await F.readText(file)).length, 'line of a log\n'.length * 300_000)
})

console.log('\nLayout')

await check('one element to a line, indented by depth', () => {
  assert.equal(
    indentXml('<a><b x="1"/><c><d/></c></a>'),
    '<a>\n  <b x="1"/>\n  <c>\n    <d/>\n  </c>\n</a>'
  )
})

await check('text, attribute values, comments and CDATA are never touched', () => {
  const shown = indentXml(STATE)
  assert.match(shown, /<Note>keep {2}this {2}text<\/Note>/)
  assert.match(shown, /value="a &gt; b"/)
  assert.match(shown, /<!-- a > comment -->/)
  assert.match(shown, /<!\[CDATA\[<raw>\]\]>/)
  // The blank line the declaration was followed by is the file's own.
  assert.match(shown, /\?>\n\n<synth/)
})

await check('a > inside a quoted attribute does not end the tag', () => {
  assert.equal(indentXml('<a t="x>y"><b/></a>'), '<a t="x>y">\n  <b/>\n</a>')
})

await check('compact undoes indent exactly', () => {
  for (const xml of [STATE, '<a/>', '<a><b/></a>', '<r>' + '<p v="1"/>'.repeat(50) + '</r>']) {
    assert.equal(compactXml(indentXml(xml)), xml)
  }
})

await check('an edit survives the trip, and changes nothing else', () => {
  const edited = indentXml(STATE).replace('value="0.5"', 'value="0.75"')
  assert.equal(compactXml(edited), STATE.replace('value="0.5"', 'value="0.75"'))
})

await check('a three-megabyte one-line state lays out in well under a second', () => {
  const big = '<r>' + `<PARAM id="p" value="${'A'.repeat(2000)}"/>`.repeat(1500) + '</r>'
  const started = Date.now()
  assert.equal(compactXml(indentXml(big)), big)
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`)
})

fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
console.log(`\n${passed} checks passed`)
