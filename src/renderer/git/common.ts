/**
 * The small things both git views need, and one thing the rest of the app does.
 *
 * Split out of the panes rather than left in one of them, because the compare
 * pane and the search pane each imported a helper from `diffPane` — which meant
 * a pane that has nothing to do with git could not be opened without loading
 * the whole changes pane. A file of four functions is the honest home for them.
 */
import { backend } from '../../backend'
import { fallbackCwd } from '../../shared/platform'
import { store } from '../state'

/**
 * Which colour a diff line gets.
 *
 * Order matters and is not obvious: `+++` and `---` are the file headings, not
 * an added and a removed line, and testing for `+` first would paint every
 * patch's heading green.
 */
export function classify(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

/**
 * A patch as coloured text.
 *
 * `textContent` on every line, always — this is the content of files we did not
 * write, and a patch that happens to contain markup is the most ordinary thing
 * in the world in a project that has any HTML in it.
 */
export function patchElement(text: string): HTMLPreElement {
  const pre = document.createElement('pre')
  pre.className = 'diff-text'
  for (const line of text.split('\n')) {
    const span = document.createElement('span')
    span.className = `diff-line diff-line--${classify(line)}`
    span.textContent = line || ' '
    pre.appendChild(span)
  }
  return pre
}

/**
 * The folder a git pane should watch.
 *
 * The workspace's folder first and the pane's own second: a git pane is about a
 * project, and a pane that happened to be opened from a subfolder should still
 * answer about the whole of it.
 */
export function gitRoot(paneId: string): string {
  return (
    store.workspaceOfPane(paneId)?.cwd ??
    store.pane(paneId)?.cwd ??
    fallbackCwd(backend().capabilities.platform)
  )
}

/** The same rule, under the name the search pane reads it by. */
export const searchRoot = gitRoot

export function workspaceOf(paneId: string): string {
  return store.workspaceOfPane(paneId)?.id ?? ''
}

/** Shorthand for the many small text nodes the bilingual headings are built from. */
export function text(value: string): Text {
  return document.createTextNode(value)
}

/**
 * "2 hours ago", and never "in 3 seconds".
 *
 * A save made by a machine whose clock is a little ahead — which happens on any
 * shared repository — would otherwise be reported as being from the future, and
 * that reads as a bug rather than as a clock.
 */
export function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.round(days / 30.4)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = (days / 365).toFixed(1).replace(/\.0$/, '')
  return `${years} year${years === '1' ? '' : 's'} ago`
}
