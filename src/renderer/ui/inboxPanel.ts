/**
 * "Waiting for you", as a panel rather than a tab.
 *
 * It lists every agent in the app, so it is not a property of any one
 * workspace — putting it in a tab meant opening it inside a project that had
 * nothing to do with most of what it showed. It lives with the sidebar's own
 * controls instead, and slides over like the notification panel.
 *
 * The list itself is `InboxPane`, unchanged: the same rows, the same relayed
 * answers. Only where it is mounted moved.
 */
import { InboxPane, type InboxPaneHooks } from '../inboxPane'
import { store } from '../state'

let pane: InboxPane | null = null

const root = () => document.getElementById('inbox-panel') as HTMLElement
const button = () => document.getElementById('open-inbox') as HTMLElement
const count = () => document.getElementById('inbox-count') as HTMLElement

export function initInbox(hooks: InboxPaneHooks): void {
  pane = new InboxPane('inbox-panel', hooks)
  root().replaceChildren(pane.element)

  // A click anywhere else dismisses it, the way the notification panel does.
  document.addEventListener('mousedown', (e) => {
    if (root().hidden) return
    const target = e.target as HTMLElement
    if (root().contains(target) || button().contains(target)) return
    closeInbox()
  })
}

export function toggleInbox(): void {
  if (root().hidden) openInbox()
  else closeInbox()
}

export function openInbox(): void {
  root().hidden = false
  button().classList.add('active')
  pane?.sync()
}

export function closeInbox(): void {
  root().hidden = true
  button().classList.remove('active')
}

export function inboxIsOpen(): boolean {
  return !root().hidden
}

/**
 * Keeps the sidebar button's badge current, and the list if it is open.
 *
 * The badge is the whole reason this is reachable without opening anything:
 * the number of agents stuck on you is the thing you want visible, and the
 * list is what you open when it is not zero.
 */
export function renderInbox(): void {
  const waiting = store.blockedPanes().length
  const badge = count()
  badge.hidden = waiting === 0
  badge.textContent = String(waiting)
  button().classList.toggle('has-waiting', waiting > 0)
  if (!root().hidden) pane?.sync()
}
