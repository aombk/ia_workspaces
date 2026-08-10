/**
 * Putting a git word on screen with its plain meaning attached.
 *
 * The panes could have gone one of two ways: hide git's vocabulary behind
 * friendly buttons, or print it with a translation every time. The first is
 * what most git clients do, and it produces someone who can use that one client
 * and cannot read a single sentence git prints, cannot follow any answer
 * online, and is stuck the moment they leave the buttons. So: the second.
 *
 * Both orders exist here, and which one to use is a real decision rather than a
 * preference:
 *
 * - `plainWord` — the plain word first, git's in brackets. For anything the app
 *   is saying in its own voice: a button, a heading, a count. "Save (commit)".
 * - `gitWordFirst` — git's word first, the plain one in brackets. For anything
 *   that is quoting git: a status line, a ref name, an error. There, the git
 *   word is the thing on screen elsewhere and swapping it out would make the
 *   pane and the terminal beside it disagree.
 *
 * Every one of them carries the whole explanation as a tooltip, so the meaning
 * is one hover away and never occupies the layout.
 */
import { GIT_WORDS, WORD_GROUPS, gitWord, tooltipFor } from '../../shared/gitWords'

function build(first: string, second: string, term: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'gw'
  el.title = tooltipFor(term)
  el.appendChild(document.createTextNode(first))
  const alt = document.createElement('span')
  alt.className = 'gw-alt'
  alt.textContent = ` (${second})`
  el.appendChild(alt)
  return el
}

/**
 * A word this glossary does not carry, printed plainly.
 *
 * Never a throw and never an empty element: the terms come from a table we
 * wrote, but they are passed as strings, and a pane that vanished over a typo
 * would be a worse outcome than one that prints the word untranslated.
 */
function bare(term: string): HTMLElement {
  const el = document.createElement('span')
  el.textContent = term
  return el
}

/** Plain word first: `save (commit)`. The app speaking. */
export function plainWord(term: string): HTMLElement {
  const word = gitWord(term)
  return word ? build(word.plain, word.term, term) : bare(term)
}

/** Git's word first: `staged (picked)`. Git speaking, with a translation. */
export function gitWordFirst(term: string): HTMLElement {
  const word = gitWord(term)
  return word ? build(word.term, word.plain, term) : bare(term)
}

/**
 * A button that says what it does, and shows the git command it runs.
 *
 * The stronger half of teaching the vocabulary, and the half that was missing:
 * brackets on a heading teach you a *word*, but the thing you eventually need
 * is the command, and there is exactly one moment when you are guaranteed to
 * care what `git commit` means — the moment you are about to press the button
 * that does it. So the command rides along on every button, dim and in a
 * monospace face so it reads as machinery rather than as label.
 *
 * This is what `git_ia` does at the prompt: it prints the command it is about
 * to run and then asks. After a few times you know it, and the day you need to
 * type it into a terminal you already have.
 */
export function gitButton(
  label: string,
  command: string,
  opts: { className?: string; title?: string } = {}
): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = opts.className ?? 'diff-btn'

  const text = document.createElement('span')
  text.textContent = label
  button.appendChild(text)

  const cmd = document.createElement('code')
  cmd.className = 'gw-cmd'
  cmd.textContent = command
  button.appendChild(cmd)

  if (opts.title) button.title = opts.title
  return button
}

/**
 * Attaches a git word's full meaning to something already drawn.
 *
 * For the places where the words are already in the label and adding brackets
 * would make it unreadable — a button that says "Send to GitHub" does not want
 * to say "Send (push) to GitHub (origin)" as well, but it should still explain
 * itself on hover.
 */
export function explain(el: HTMLElement, ...terms: string[]): void {
  el.title = terms.map(tooltipFor).join('\n\n')
}

/**
 * The whole glossary, in a panel — `git ia words`, in the app.
 *
 * Worth having as one screen rather than only as tooltips, because tooltips
 * answer "what is this word" and this answers "what are the words". The first
 * time through, that ordering is the difference between a list of definitions
 * and an explanation.
 */
export function showGlossary(): void {
  const overlay = document.getElementById('overlay') as HTMLElement
  const wasHidden = overlay.hidden
  overlay.hidden = false

  const panel = document.createElement('div')
  panel.className = 'settings-panel glossary-panel'
  panel.hidden = false

  const head = document.createElement('div')
  head.className = 'settings-head'
  const h2 = document.createElement('h2')
  h2.textContent = 'Git words, in plain words'
  head.appendChild(h2)
  const close = document.createElement('button')
  close.className = 'btn'
  close.textContent = 'Close'
  close.style.marginLeft = 'auto'
  head.appendChild(close)

  const body = document.createElement('div')
  body.className = 'settings-body glossary-body'

  const rule = document.createElement('p')
  rule.className = 'glossary-rule'
  rule.textContent =
    'The plain word is in brackets every time, including inside the other explanations — a glossary that explains jargon with jargon is a closed loop with extra steps.'
  body.appendChild(rule)

  for (const group of WORD_GROUPS) {
    const section = document.createElement('section')
    section.className = 'glossary-group'

    const title = document.createElement('h3')
    title.textContent = group.title
    section.appendChild(title)

    const note = document.createElement('p')
    note.className = 'glossary-note'
    note.textContent = group.note
    section.appendChild(note)

    for (const word of GIT_WORDS.filter((w) => w.group === group.id)) {
      const row = document.createElement('div')
      row.className = 'glossary-row' + (word.destroys ? ' destroys' : '')

      const left = document.createElement('div')
      left.className = 'glossary-term'
      const term = document.createElement('code')
      term.textContent = word.term
      left.appendChild(term)
      const plain = document.createElement('span')
      plain.className = 'glossary-plain'
      plain.textContent = word.plain
      left.appendChild(plain)

      const meaning = document.createElement('div')
      meaning.className = 'glossary-meaning'
      // textContent throughout: this is prose we wrote, but the pane it opens
      // over renders file contents, and one rule for both is one rule to keep.
      meaning.textContent = word.meaning

      row.append(left, meaning)
      section.appendChild(row)
    }
    body.appendChild(section)
  }

  panel.append(head, body)
  document.body.appendChild(panel)

  const finish = () => {
    window.removeEventListener('keydown', onKey, true)
    panel.remove()
    overlay.hidden = wasHidden
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    finish()
  }
  close.addEventListener('click', finish)
  overlay.addEventListener('click', finish, { once: true })
  window.addEventListener('keydown', onKey, true)
}
