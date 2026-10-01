/**
 * The renderer's document, merged with the fields only main writes.
 *
 * The renderer sends the whole workspace document on every save, and its copy
 * of the window's position and size is the one it read at launch — main records
 * a move or a resize straight into the store (`persistBounds` in `main.ts`), and
 * nothing tells the renderer. So every save after a move put the launch-time
 * bounds back, and the app reopened wherever it had opened before, almost never
 * where it was left.
 *
 * A pure function, apart from `main.ts`, so the rule can be tested without a
 * window to move: an offscreen test window cannot be resized from outside.
 */

/** Fields of the workspace document that main owns and the renderer only reads. */
export const MAIN_OWNED_FIELDS: readonly string[] = ['window']

/**
 * The document to store when the renderer sends `next`, given what main holds.
 * Returns null for anything that is not a document at all.
 */
export function mergeRendererState(current: unknown, next: unknown): Record<string, unknown> | null {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return null
  const merged = { ...(next as Record<string, unknown>) }
  const held = (current && typeof current === 'object' ? current : {}) as Record<string, unknown>
  for (const field of MAIN_OWNED_FIELDS) {
    if (held[field] !== undefined) merged[field] = held[field]
  }
  return merged
}
