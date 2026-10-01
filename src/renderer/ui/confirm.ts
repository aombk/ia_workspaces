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

/**
 * A question with more than two answers, in the same panel as `confirmDialog`.
 *
 * Escape is always the first choice whose `escape` is set — for the pane
 * permission prompt that is "Deny", so the reflex for getting a box out of the
 * way is also the safe one. Enter is deliberately not bound: with three
 * answers there is no single obvious one, and a stray Enter meant for a
 * terminal must not grant anything.
 */
export function choiceDialog<T extends string>(opts: {
  title: string
  body: string
  choices: { value: T; label: string; primary?: boolean; escape?: boolean }[]
}): Promise<T> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('overlay') as HTMLElement
    const wasOverlayHidden = overlay.hidden
    overlay.hidden = false

    const panel = document.createElement('div')
    panel.className = 'settings-panel choice-dialog'
    panel.style.width = 'min(460px, calc(100vw - 48px))'
    panel.hidden = false
    panel.setAttribute('role', 'alertdialog')
    panel.setAttribute('aria-label', opts.title)

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
    p.style.whiteSpace = 'pre-line'
    p.textContent = opts.body
    body.appendChild(p)

    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.justifyContent = 'flex-end'
    row.style.flexWrap = 'wrap'
    row.style.gap = '8px'

    const escapeValue = (opts.choices.find((c) => c.escape) ?? opts.choices[0]).value
    const finish = (value: T) => {
      window.removeEventListener('keydown', onKey, true)
      panel.remove()
      overlay.hidden = wasOverlayHidden
      resolve(value)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      finish(escapeValue)
    }

    let first: HTMLButtonElement | null = null
    for (const choice of opts.choices) {
      const btn = document.createElement('button')
      btn.className = 'btn' + (choice.primary ? ' primary' : '')
      btn.textContent = choice.label
      btn.dataset.choice = choice.value
      btn.addEventListener('click', () => finish(choice.value))
      row.appendChild(btn)
      if (choice.escape && !first) first = btn
    }

    body.appendChild(row)
    panel.append(head, body)
    document.body.appendChild(panel)
    window.addEventListener('keydown', onKey, true)
    // Focus on the refusal, for the same reason Escape picks it.
    queueMicrotask(() => first?.focus())
  })
}
