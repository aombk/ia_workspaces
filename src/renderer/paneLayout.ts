import type { PaneNode, TerminalTabState } from '../shared/types'

/**
 * What a tab's tree was built from.
 *
 * The layout tree carries every pane id and how they are arranged, so it
 * catches a split, a merge and a pane arriving from elsewhere. Kinds are
 * appended because a pane can change what it holds without moving — "Reopen
 * as" on a terminal, or an editor tab becoming a diff — and the built element
 * would otherwise be reused for the wrong thing.
 *
 * **Sizes are left out on purpose.** Dragging a divider resizes the built tree
 * itself and then writes the new fractions into the layout *in place*, without
 * a rebuild — so a signature that included them went stale the moment you let
 * go, and the next visit to the tab rebuilt the whole tree for nothing. That
 * rebuild is not free: a `<webview>` moved in the DOM is a `<webview>`
 * reloaded, so resizing a split beside a browser pane cost you the page.
 */
export function layoutSignature(tab: TerminalTabState): string {
  const kinds = tab.panes.map((p) => `${p.id}:${p.kind ?? 'terminal'}`).join(',')
  return `${shape(tab.layout)}|${kinds}`
}

function shape(node: PaneNode): string {
  if (node.kind === 'leaf') return node.paneId
  return `${node.direction}(${node.children.map(shape).join(',')})`
}
