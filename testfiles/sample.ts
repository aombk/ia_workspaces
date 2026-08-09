/**
 * A TypeScript file, for the Code view.
 *
 * Block comment above, line comments below, strings in three quote styles,
 * numbers in a few shapes, and keywords that should colour.
 */
import { readFile } from 'node:fs/promises'

const GREETING = 'hello'          // a line comment after code
const TEMPLATE = `a ${GREETING} template`
const QUOTED = "double quotes, with a // that is not a comment"
const ESCAPED = 'it\'s escaped'

const DECIMAL = 42
const FLOAT = 1.5e3
const HEX = 0xdeadbeef
const BIG = 1_000_000

export interface Point {
  x: number
  y: number
}

export async function load(path: string): Promise<Point[]> {
  const text = await readFile(path, 'utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [x, y] = line.split(',').map(Number)
      return { x, y }
    })
}

/* An unterminated-looking case:
   this comment spans several lines, and the highlighter has to carry that
   state across each one of them. */
export const done = true
