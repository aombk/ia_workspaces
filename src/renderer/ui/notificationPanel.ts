import { store } from '../state'
import type { UiActions } from './actions'

let actions: UiActions

export function initNotificationPanel(a: UiActions): void {
  actions = a

  document.getElementById('notif-button')!.addEventListener('click', togglePanel)
  document.getElementById('notif-mark-all')!.addEventListener('click', () => {
    store.markAllNotificationsRead()
  })
  document.getElementById('notif-clear')!.addEventListener('click', () => store.clearNotifications())

  // Any click outside closes it, but not a click within the panel itself.
  window.addEventListener('mousedown', (e) => {
    const panel = document.getElementById('notif-panel') as HTMLElement
    if (panel.hidden) return
    const target = e.target
    if (!(target instanceof Node)) return
    if (panel.contains(target)) return
    if (document.getElementById('notif-button')!.contains(target)) return
    panel.hidden = true
  })
}

export function togglePanel(): void {
  const panel = document.getElementById('notif-panel') as HTMLElement
  panel.hidden = !panel.hidden
  if (!panel.hidden) renderNotifications()
}

export function closePanel(): void {
  ;(document.getElementById('notif-panel') as HTMLElement).hidden = true
}

export function isPanelOpen(): boolean {
  return !(document.getElementById('notif-panel') as HTMLElement).hidden
}

/** Jumps to the oldest unread, so repeated presses walk forward in order. */
export function jumpToOldestUnread(): boolean {
  const record = store.oldestUnread()
  if (!record) return false
  store.markNotificationRead(record.id)
  actions.jumpToPane(record.workspaceId, record.paneId)
  return true
}

export function renderNotifications(): void {
  const button = document.getElementById('notif-button')!
  const badge = document.getElementById('notif-badge')!
  const unread = store.unreadCount

  button.classList.toggle('has-unread', unread > 0)
  badge.textContent = unread > 99 ? '99+' : String(unread)
  badge.hidden = unread === 0

  const panel = document.getElementById('notif-panel') as HTMLElement
  if (panel.hidden) return

  const list = document.getElementById('notif-list')!
  list.replaceChildren()

  if (!store.notifications.length) {
    const empty = document.createElement('p')
    empty.className = 'notif-empty'
    empty.textContent = 'Nothing yet. Alerts from your terminals collect here.'
    list.appendChild(empty)
    return
  }

  for (const record of store.notifications) {
    const item = document.createElement('button')
    item.className = 'notif-item' + (record.read ? '' : ' unread')

    const head = document.createElement('div')
    head.className = 'notif-head'

    const title = document.createElement('span')
    title.className = 'notif-title'
    title.textContent = record.title
    head.appendChild(title)

    const when = document.createElement('span')
    when.className = 'notif-when'
    when.textContent = relativeTime(record.at)
    head.appendChild(when)
    item.appendChild(head)

    if (record.body) {
      const body = document.createElement('span')
      body.className = 'notif-body'
      body.textContent = record.body
      item.appendChild(body)
    }

    const where = document.createElement('span')
    where.className = 'notif-where'
    where.textContent = record.where
    item.appendChild(where)

    item.addEventListener('click', () => {
      store.markNotificationRead(record.id)
      actions.jumpToPane(record.workspaceId, record.paneId)
      closePanel()
    })

    list.appendChild(item)
  }
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
