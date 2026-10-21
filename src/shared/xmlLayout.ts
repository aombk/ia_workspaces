/**
 * Puts one-line XML on separate lines for reading, and takes it off again.
 *
 * A JUCE plugin writes its state as a single line — a preset can be one line
 * three megabytes long — which nobody can read and which the editor cannot lay
 * out quickly either. So it is shown indented, one element to a line, and
 * written back compact.
 *
 * Whitespace is only ever added where there was none: between a `>` and the
 * `<` straight after it. Text inside an element, attribute values, comments
 * and CDATA are copied through exactly, so `compactXml(indentXml(x)) === x` for
 * any XML that has no line break sitting directly between two tags already —
 * which a JUCE state, written on one line, never does — and an edit changes
 * only what was edited. One that does have such a break loses it on save,
 * which is whitespace between elements and means nothing to a parser.
 */

const INDENT = '  '

/** The index just past the markup that starts at `at` (a tag, comment, CDATA, or declaration). */
function markupEnd(xml: string, at: number): number {
  if (xml.startsWith('<!--', at)) {
    const close = xml.indexOf('-->', at + 4)
    return close < 0 ? xml.length : close + 3
  }
  if (xml.startsWith('<![CDATA[', at)) {
    const close = xml.indexOf(']]>', at + 9)
    return close < 0 ? xml.length : close + 3
  }
  // A `>` inside a quoted attribute value is part of the value, not the end.
  let quote = ''
  for (let i = at + 1; i < xml.length; i++) {
    const c = xml[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return i + 1
    }
  }
  return xml.length
}

export function indentXml(xml: string): string {
  const out: string[] = []
  let depth = 0
  // Whether the last thing written was markup, so the next markup may go on a
  // line of its own. After text it may not: that would change the text.
  let afterMarkup = false
  let i = 0
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const next = xml.indexOf('<', i)
      const end = next < 0 ? xml.length : next
      out.push(xml.slice(i, end))
      afterMarkup = false
      i = end
      continue
    }
    const end = markupEnd(xml, i)
    const tag = xml.slice(i, end)
    const closing = tag.startsWith('</')
    const opening = !closing && !tag.endsWith('/>') && !tag.startsWith('<?') && !tag.startsWith('<!')
    if (closing) depth = Math.max(depth - 1, 0)
    if (afterMarkup) out.push('\n' + INDENT.repeat(depth))
    out.push(tag)
    if (opening) depth++
    afterMarkup = true
    i = end
  }
  return out.join('')
}

/**
 * Takes out what `indentXml` put in: a newline and spaces between `>` and `<`.
 *
 * Exactly that shape and nothing looser, so a blank line the file already had —
 * the one JUCE writes after its `<?xml ?>` declaration — survives the trip.
 */
export function compactXml(xml: string): string {
  return xml.replace(/>\n *</g, '><')
}
