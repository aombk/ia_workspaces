/**
 * The same dialog with a text field, for the one question that needs an answer
 * rather than a yes.
 *
 * Resolves to null when dismissed, and to the trimmed value otherwise — so an
 * empty box reads as a cancel, which is what pressing Enter on one means.
 */
export function promptDialog(opts: {
  title: string
  body: string
  placeholder?: string
  initial?: string
  confirmLabel?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('overlay') as HTMLElement
    const wasOverlayHidden = overlay.hidden
    overlay.hidden = false

    const panel = document.createElement('div')
    panel.className = 'settings-panel'
    panel.style.width = 'min(420px, calc(100vw - 48px))'
    panel.hidden = false

    const head = document.createElement('div')
    head.className = 'settings-head'
    const h2 = document.createElement('h2')
    h2.textContent = opts.title
    head.appendChild(h2)

    const body = document.createElement('div')
    body.className = 'settings-body'
    const p = document.createElement('p')
    p.style.margin = '4px 0 12px'
    p.style.fontSize = '13px'
    p.style.lineHeight = '1.5'
    p.style.color = 'var(--text-dim)'
    p.textContent = opts.body
    body.appendChild(p)

    const input = document.createElement('input')
    input.className = 'text-input'
    input.style.width = '100%'
    input.style.marginBottom = '18px'
    input.spellcheck = false
    input.placeholder = opts.placeholder ?? ''
    input.value = opts.initial ?? ''
    body.appendChild(input)

    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.justifyContent = 'flex-end'
    row.style.gap = '8px'

    const cancel = document.createElement('button')
    cancel.className = 'btn'
    cancel.textContent = 'Cancel'

    const ok = document.createElement('button')
    ok.className = 'btn primary'
    ok.textContent = opts.confirmLabel ?? 'Connect'

    row.append(cancel, ok)
    body.appendChild(row)
    panel.append(head, body)
    document.body.appendChild(panel)

    const finish = (result: string | null) => {
      window.removeEventListener('keydown', onKey, true)
      panel.remove()
      overlay.hidden = wasOverlayHidden
      resolve(result)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(null)
      } else if (e.key === 'Enter') {
        e.stopPropagation()
        finish(input.value.trim() || null)
      }
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', () => finish(input.value.trim() || null))
    window.addEventListener('keydown', onKey, true)
    queueMicrotask(() => input.focus())
  })
}

/** Minimal promise-based confirm, styled like the rest of the app. */
export function confirmDialog(opts: {
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('overlay') as HTMLElement
    const wasOverlayHidden = overlay.hidden
    overlay.hidden = false

    const panel = document.createElement('div')
    panel.className = 'settings-panel'
    panel.style.width = 'min(420px, calc(100vw - 48px))'
    panel.hidden = false

    const head = document.createElement('div')
    head.className = 'settings-head'
    const h2 = document.createElement('h2')
    h2.textContent = opts.title
    head.appendChild(h2)

    const body = document.createElement('div')
    body.className = 'settings-body'
    const p = document.createElement('p')
    p.style.margin = '4px 0 18px'
    p.style.fontSize = '13px'
    p.style.lineHeight = '1.5'
    p.style.color = 'var(--text-dim)'
    p.textContent = opts.body
    body.appendChild(p)

    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.justifyContent = 'flex-end'
    row.style.gap = '8px'

    const cancel = document.createElement('button')
    cancel.className = 'btn'
    cancel.textContent = 'Cancel'

    const ok = document.createElement('button')
    ok.className = 'btn primary'
    ok.textContent = opts.confirmLabel ?? 'Confirm'
    if (opts.danger) {
      ok.style.background = 'var(--danger)'
      ok.style.borderColor = 'var(--danger)'
    }

    row.append(cancel, ok)
    body.appendChild(row)
    panel.append(head, body)
    document.body.appendChild(panel)

    const finish = (result: boolean) => {
      window.removeEventListener('keydown', onKey, true)
      panel.remove()
      overlay.hidden = wasOverlayHidden
      resolve(result)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(false)
      } else if (e.key === 'Enter') {
        e.stopPropagation()
        finish(true)
      }
    }

    cancel.addEventListener('click', () => finish(false))
    ok.addEventListener('click', () => finish(true))
    window.addEventListener('keydown', onKey, true)
    queueMicrotask(() => ok.focus())
  })
}
