/**
 * Line endings, in and out.
 *
 * The editor works in `\n` and nothing else. A `\r` that reaches the document
 * is not cosmetic: the editing surface is `white-space: pre-wrap`, where a
 * carriage return is a line break, so it draws a line that `split('\n')` says
 * is not there — and from that point the line numbers, the caret arithmetic and
 * the repainting all disagree with what is on screen.
 *
 * So text is normalised at every door: from disk, from the clipboard, from the
 * DOM. What the file used is remembered separately and put back when it is
 * written, because editing one word of a CRLF file should not rewrite every
 * line of it.
 */

/** Every line ending as `\n`. Handles CRLF and lone CR alike. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Back to CRLF, for a file that came that way. */
export function toCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n')
}

/**
 * Which line ending a file is written with.
 *
 * By majority rather than by first occurrence: mixed files exist, and the
 * question actually being answered is "what should a line I add look like",
 * which the bulk of the file answers better than its first line does. A file
 * with no line endings at all — one line, or empty — gets `\n`, because there
 * is nothing to preserve and that is what a new file should be.
 */
export function dominantEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}
