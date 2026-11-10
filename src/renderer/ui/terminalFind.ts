/**
 * The terminal's find bar (Ctrl+F), in two modes.
 *
 * **Terminal** searches the pane's buffer: every match marked, the current one
 * stronger, the view taken to it, and "3 of 12" beside the box.
 *
 * **Conversation** is for a Claude pane, and is what it opens in when Claude
 * Code is drawing full screen — because then the buffer is one screenful and a
 * search of it finds nothing older than the last page. It searches the
 * conversation's own transcript instead (see `shared/conversationSearch.ts`)
 * and lists the messages that match, newest first; Enter walks down the list,
 * and the one it is on opens in full with its matches marked. It cannot move
 * Claude's own view — that scrolling is Claude Code's — so the message is shown
 * here, where it can be read and copied.
 */
import { backend } from '../../backend'
import { store } from '../state'
import type { TerminalManager } from '../terminals'
import { markPieces, snippetOf, type ConversationFind } from '../../shared/conversationSearch'

type Mode = 'terminal' | 'conversation'

let terminals: TerminalManager
let mode: Mode = 'terminal'
let found: ConversationFind | null = null
let current = 0
let asked = 0
let timer: ReturnType<typeof setTimeout> | undefined

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function transcript(): string | undefined {
  const pane = store.activePane
  return pane?.agentSession?.tool === 'claude' ? pane.agentSession.transcript : undefined
}

export function initTerminalFind(manager: TerminalManager): void {
  terminals = manager
  const input = el<HTMLInputElement>('find-input')

  terminals.findResults = (index, count) => {
    if (mode !== 'terminal') return
    if (!input.value) return setCount('')
    if (!count) return setCount('No results', true)
    setCount(index < 0 ? `${count}+ results` : `${index + 1} of ${count}`)
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      closeTerminalFind()
    } else if (mode === 'conversation' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      step(e.key === 'ArrowDown' ? 1 : -1)
    }
  })
  input.addEventListener('input', () => search(true))

  el('find-next').addEventListener('click', () => step(1))
  el('find-prev').addEventListener('click', () => step(-1))
  el('find-close').addEventListener('click', closeTerminalFind)
  el('find-where').addEventListener('click', () => {
    setMode(mode === 'terminal' ? 'conversation' : 'terminal')
    search(false)
    input.focus()
  })
}

export function openTerminalFind(): void {
  el('findbar').hidden = false
  // A Claude pane drawing full screen has nothing above its screen to search:
  // its conversation is the only place the older text still is.
  setMode(transcript() && terminals.activeIsFullScreen() ? 'conversation' : 'terminal')
  const input = el<HTMLInputElement>('find-input')
  input.focus()
  input.select()
  if (input.value) search(false)
}

export function closeTerminalFind(): void {
  el('findbar').hidden = true
  el('find-results').hidden = true
  clearTimeout(timer)
  asked++
  terminals.clearSearch()
  terminals.focusActive()
}

function setMode(next: Mode): void {
  mode = next
  const where = el<HTMLButtonElement>('find-where')
  where.hidden = !transcript()
  where.textContent = next === 'conversation' ? 'Conversation' : 'Terminal'
  where.title =
    next === 'conversation'
      ? "Searching everything said in this Claude conversation. Click to search the terminal's text instead."
      : "Searching the terminal's text. Click to search the whole Claude conversation instead."
  el<HTMLInputElement>('find-input').placeholder = next === 'conversation' ? 'Find in conversation…' : 'Find in terminal…'
  if (next === 'conversation') terminals.clearSearch()
  else el('find-results').hidden = true
  found = null
  setCount('')
}

function setCount(text: string, none = false): void {
  const count = el('find-count')
  count.textContent = text
  count.classList.toggle('none', none)
}

function search(typing: boolean): void {
  const query = el<HTMLInputElement>('find-input').value
  if (mode === 'terminal') {
    if (!query) {
      terminals.clearSearch()
      setCount('')
    } else if (!terminals.findNext(query, typing)) {
      setCount('No results', true)
    }
    return
  }

  clearTimeout(timer)
  const ask = ++asked
  if (!query.trim()) {
    found = null
    setCount('')
    el('find-results').hidden = true
    return
  }
  const file = transcript()
  if (!file) return setCount('No conversation', true)
  // A keystroke at a time would read the file a keystroke at a time.
  timer = setTimeout(async () => {
    const result = await backend().findInConversation(file, query).catch(() => null)
    if (ask !== asked) return
    if (!result) {
      found = null
      setCount('Not readable', true)
      el('find-results').hidden = true
      return
    }
    found = result
    current = 0
    drawResults(query)
  }, typing ? 140 : 0)
}

function step(by: number): void {
  const query = el<HTMLInputElement>('find-input').value
  if (!query) return
  if (mode === 'terminal') {
    if (by > 0) terminals.findNext(query)
    else terminals.findPrevious(query)
    return
  }
  if (!found || !found.hits.length) return search(false)
  current = (current + by + found.hits.length) % found.hits.length
  drawResults(query)
}

function drawResults(query: string): void {
  const list = el('find-results')
  list.replaceChildren()
  if (!found) return

  if (!found.messages) {
    setCount('No results', true)
    list.hidden = true
    return
  }
  const where = found.messages === 1 ? '1 message' : `${found.messages} messages`
  setCount(`${current + 1} of ${found.hits.length < found.messages ? `${found.hits.length}+` : found.messages} · ${found.matches} in ${where}`)

  found.hits.forEach((hit, i) => {
    const row = document.createElement('div')
    row.className = `find-hit${i === current ? ' current' : ''}`

    const head = document.createElement('div')
    head.className = 'find-hit-head'
    const who = document.createElement('span')
    who.className = `find-hit-who ${hit.who}`
    who.textContent = hit.who === 'you' ? 'You' : hit.who === 'claude' ? 'Claude' : 'Summary (compacted)'
    head.appendChild(who)
    const when = document.createElement('span')
    when.className = 'find-hit-when'
    when.textContent = hit.at ? whenOf(hit.at) : ''
    head.appendChild(when)
    if (hit.count > 1) {
      const n = document.createElement('span')
      n.className = 'find-hit-when'
      n.textContent = `${hit.count}×`
      head.appendChild(n)
    }
    row.appendChild(head)

    const body = document.createElement('div')
    body.className = i === current ? 'find-hit-text full' : 'find-hit-text'
    for (const piece of markPieces(i === current ? hit.text : snippetOf(hit.text, query), query)) {
      if (piece.match) {
        const mark = document.createElement('mark')
        mark.textContent = piece.text
        body.appendChild(mark)
      } else {
        body.appendChild(document.createTextNode(piece.text))
      }
    }
    row.appendChild(body)

    row.addEventListener('mousedown', (e) => {
      // A click in the open message is for selecting its text.
      if (i === current) return
      e.preventDefault()
      current = i
      drawResults(query)
    })
    list.appendChild(row)
  })
  list.hidden = false

  const open = list.querySelector<HTMLElement>('.find-hit.current')
  open?.scrollIntoView({ block: 'nearest' })
  // The first match inside a long message, rather than the top of it.
  open?.querySelector('mark')?.scrollIntoView({ block: 'nearest' })
}

function whenOf(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString()} ${time}`
}
