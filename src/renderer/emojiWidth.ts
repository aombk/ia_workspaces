/**
 * How wide an emoji is, agreed with the programs running inside the terminal.
 *
 * xterm's Unicode 11 tables widen emoji *codepoints* — `🚀` is two cells — but
 * not emoji *presentation sequences*: a character that is a plain glyph on its
 * own and an emoji when followed by U+FE0F. `⚠` is one cell, `⚠️` is two, and
 * xterm scores both as one.
 *
 * Every Node command-line program measures its own output with `string-width`,
 * which has said two for years. So a line carrying five `⚠️` is laid out five
 * columns wider than this terminal stores it, and when the program repaints
 * part of that line the fragment lands over the wrong cells — leaving the tail
 * of the previous frame standing, mid-word. Measured on both sides before this
 * was written: xterm 1, `string-width` 2.
 *
 * The fix is one field of one property value, and everything else is delegated
 * to the real Unicode 11 table rather than a second copy of it.
 */
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { Terminal, IUnicodeVersionProvider } from '@xterm/xterm'

/** Variation Selector-16: "draw the character before me as an emoji." */
const VS16 = 0xfe0f

/**
 * How xterm packs a character's properties into one number.
 *
 * Bit 0 is "joins the cluster before me", bits 1-2 are the width, the rest is
 * parser state this has no business touching. Not part of the public API —
 * `IUnicodeVersionProvider.charProperties` returns the packed number and gives
 * no way to read or build one — so the layout is reproduced here and pinned by
 * `tests/logic.test.mjs`, which checks it against what the real Unicode 11
 * provider actually returns rather than trusting this comment.
 */
const JOIN_BIT = 0b001
const WIDTH_FIELD = 0b110
const WIDTH_SHIFT = 1

function widthOf(value: number): number {
  return (value >> WIDTH_SHIFT) & 0b11
}

function joins(value: number): boolean {
  return (value & JOIN_BIT) === JOIN_BIT
}

function withWidth(value: number, width: number): number {
  return (value & ~WIDTH_FIELD) | ((width & 0b11) << WIDTH_SHIFT)
}

/** The name this version registers under. */
export const EMOJI_WIDTH_VERSION = '11-emoji'

/**
 * The Unicode 11 provider, borrowed from the addon that owns it.
 *
 * The addon exports only itself; its provider is a private class it hands to
 * `unicode.register` when it activates. So it is activated against a stand-in
 * that does nothing but catch the argument — which is a smaller and more honest
 * dependency than pasting a copy of the Unicode 11 width tables into this repo
 * and letting the two drift apart.
 */
function unicode11(): IUnicodeVersionProvider {
  let caught: IUnicodeVersionProvider | null = null
  const sink = { unicode: { register: (p: IUnicodeVersionProvider) => (caught = p) } }
  new Unicode11Addon().activate(sink as unknown as Terminal)
  if (!caught) throw new Error('the Unicode 11 addon registered no provider')
  return caught
}

/**
 * Unicode 11, with emoji presentation sequences counted as two cells.
 *
 * Only U+FE0F is touched, and only where it already joins a single-cell
 * cluster. Everything else — the width tables, the combining marks, the joining
 * rules — is the addon's answer, unread and unchanged.
 *
 * Deliberately *not* extended to zero-width-joiner sequences (a family emoji
 * built from several people) or to flags. Those disagree too, and each needs
 * its own cluster rule to get right; guessing at them here would trade a
 * measured bug for an unmeasured one. U+FE0F is what CLI output is full of.
 */
export function emojiWidthProvider(inner = unicode11()): IUnicodeVersionProvider {
  return {
    version: EMOJI_WIDTH_VERSION,
    wcwidth: (codepoint) => inner.wcwidth(codepoint),
    charProperties(codepoint, preceding) {
      const value = inner.charProperties(codepoint, preceding)
      if (codepoint !== VS16) return value
      // A VS16 that joins nothing is a stray selector, and one that joins
      // something already two cells wide is asking for what it has.
      if (!joins(value) || widthOf(value) !== 1) return value
      return withWidth(value, 2)
    },
  }
}

/** Registers the version above on a terminal and makes it the active one. */
export function useEmojiWidth(term: Terminal): void {
  term.unicode.register(emojiWidthProvider())
  term.unicode.activeVersion = EMOJI_WIDTH_VERSION
}
