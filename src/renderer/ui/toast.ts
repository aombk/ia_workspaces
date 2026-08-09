type ToastKind = 'info' | 'warn' | 'error'

const host = () => document.getElementById('toast-host') as HTMLDivElement

/**
 * In-app toast, used both for app messages and as the visible half of a
 * terminal alert when the window is already in front (a desktop notification
 * for a window you are looking at is just noise).
 */
export function showToast(
  title: string,
  body: string,
  opts: { kind?: ToastKind; timeout?: number; onClick?: () => void } = {}
): void {
  const toast = document.createElement('div')
  toast.className = 'toast' + (opts.kind && opts.kind !== 'info' ? ` ${opts.kind}` : '')

  const titleEl = document.createElement('div')
  titleEl.className = 'toast-title'
  titleEl.textContent = title
  toast.appendChild(titleEl)

  if (body) {
    const bodyEl = document.createElement('div')
    bodyEl.className = 'toast-body'
    bodyEl.textContent = body
    bodyEl.title = body
    toast.appendChild(bodyEl)
  }

  const dismiss = () => {
    toast.remove()
    clearTimeout(timer)
  }

  toast.addEventListener('click', () => {
    opts.onClick?.()
    dismiss()
  })

  host().appendChild(toast)
  const timer = setTimeout(dismiss, opts.timeout ?? 5000)
}
