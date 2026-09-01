/**
 * Every prompt you have ever sent, searchable, as a tab.
 *
 * The thing a terminal loses that a chat client keeps. Six weeks after asking
 * an agent to work out why a build was failing on one machine only, what
 * survives is a folder full of changes and no record of the question — the
 * scrollback is gone with the pane, and the answer, which was three paragraphs
 * of reasoning, went with it. Except that it did not: Claude Code wrote every
 * word of it to this disk, and has been doing so all along.
 *
 * So this configures nothing, asks for nothing, and sends nothing anywhere. It
 * reads the conversations already on the machine — see `main/turns.ts` — and
 * puts a search box in front of them.
 *
 * **Across every project, and that is the point.** A prompt search narrowed to
 * the folder you are standing in is a search you have to already know the
 * answer to; "when did I last deal with a notarisation failure" is a question
 * about a year, not about a directory. The workspace filter is there for when
 * you do know, and off by default.
 *
 * **Picking one types it without sending it.** The same rule the runbook and
 * the history box follow, for the same reason: a prompt you sent six weeks ago
 * may have been "delete the staging bucket", and putting it in front of the
 * Enter key on somebody's behalf is not a decision this app gets to make.
 */
import type { AuxPane } from './auxPane'
import { store } from './state'
import { latestTurns, refreshTurnsNow, watchTurns } from './ui/turnMonitor'
import { describeTurn, modelName } from './ui/turnFacts'
import { typeIntoPane } from './ui/paneInput'
import { parseQuery, matches, type Query } from '../shared/promptQuery'
import type { AgentTurn } from '../shared/types'

/**
 * How many results are drawn.
 *
 * A search that matches two thousand prompts has not narrowed anything, and
 * drawing all of them costs a second of layout to say so. The count above the
 * list is the honest answer to "how many"; the list is the answer to "which".
 */
const SHOWN = 200

export class PromptsPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly summary: HTMLDivElement
  private readonly body: HTMLDivElement
  private readonly hereBox: HTMLInputElement
  private unwatch: (() => void) | null = null
  private disposed = false
  /** Kept so a repaint from the poll does not lose what is being typed. */
  private query = ''
  /**
   * Starts scoped to this project.
   *
   * The pane still searches everything — that is the point of it, and the box
   * is one click away — but the question you have while looking at a project is
   * nearly always about that project, and opening on four hundred prompts from
   * everywhere makes you narrow before you can read anything.
   */
  private here = true

  constructor(readonly paneId: string) {
    this.element = document.createElement('div')
    this.element.className = 'prompts-pane'

    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent =
      'Every prompt you have sent Claude Code on this machine, across every project, read from its ' +
      'own transcripts. Picking one puts it on the prompt without sending it.'
    this.element.appendChild(about)

    const bar = document.createElement('div')
    bar.className = 'prompts-bar'

    this.input = document.createElement('input')
    this.input.type = 'search'
    this.input.className = 'prompts-input'
    this.input.placeholder = 'Search every prompt'
    this.input.title = SYNTAX
    this.input.addEventListener('input', () => {
      this.query = this.input.value
      this.render()
    })
    bar.appendChild(this.input)

    const here = document.createElement('label')
    here.className = 'prompts-here'
    here.title = 'Only prompts sent in this workspace’s folder, or below it.'
    this.hereBox = document.createElement('input')
    this.hereBox.type = 'checkbox'
    this.hereBox.checked = this.here
    this.hereBox.addEventListener('change', () => {
      this.here = this.hereBox.checked
      this.render()
    })
    here.appendChild(this.hereBox)
    here.appendChild(document.createTextNode('this project'))
    bar.appendChild(here)

    this.element.appendChild(bar)

    this.summary = document.createElement('div')
    this.summary.className = 'prompts-summary'
    this.element.appendChild(this.summary)

    this.body = document.createElement('div')
    this.body.className = 'prompts-body'
    this.element.appendChild(this.body)

    this.render()
    this.unwatch = watchTurns(() => this.render())
    // The index is normally kept warm by turns ending. Somebody opening this
    // pane may not have run an agent for an hour, and the first scan of the
    // session is the slow one.
    refreshTurnsNow()
  }

  dispose(): void {
    this.disposed = true
    this.unwatch?.()
    this.unwatch = null
  }

  private render(): void {
    if (this.disposed) return
    const index = latestTurns()
    this.body.replaceChildren()

    if (!index) {
      // Not "no prompts". The first scan reads every transcript on the disk, and
      // "still reading" must not look like "you have never said anything".
      this.summary.textContent = 'Reading the transcripts…'
      return
    }
    if (index.status === 'none') {
      this.summary.textContent = ''
      this.body.appendChild(
        note(
          'Nothing to search yet. This reads the conversations Claude Code writes under ' +
            '~/.claude/projects, so a machine it has never run on has none — and a conversation ' +
            'is written when its first turn finishes, not when it starts.'
        )
      )
      return
    }

    const query = parseQuery(this.query)
    const root = this.here ? (store.workspaceOfPane(this.paneId)?.cwd ?? null) : null
    const found = index.turns.filter(
      (turn) => (!root || under(turn.cwd, root)) && matches(turn, query)
    )

    this.summary.replaceChildren()
    this.summary.appendChild(countLine(found, index.turns.length, SHOWN))

    if (!found.length) {
      this.body.appendChild(
        note(
          this.query.trim()
            ? 'No prompt matches that. The box takes bare words (all must appear), "a phrase in quotes", ' +
              '-a word to exclude, and project:name, after:2026-01-01, before:…, has:image.'
            : 'No prompts in this project yet.'
        )
      )
      return
    }

    // Grouped by the day they were sent, because that is the axis anybody
    // searching their own history is actually navigating: "some time in
    // February" narrows a list far faster than any word you can remember typing.
    let day = ''
    for (const turn of found.slice(0, SHOWN)) {
      const key = dayOf(turn.at)
      if (key !== day) {
        day = key
        const heading = document.createElement('div')
        heading.className = 'prompts-day'
        heading.textContent = key
        this.body.appendChild(heading)
      }
      this.body.appendChild(this.row(turn, query))
    }
  }

  private row(turn: AgentTurn, query: Query): HTMLElement {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'prompts-row'
    row.title = 'Put this on the prompt. It is not sent.'

    const text = document.createElement('span')
    text.className = 'prompts-text'
    // The matched words are marked rather than the row being merely correct:
    // in a list of forty prompts about the same project, which words matched is
    // the whole of why this one is here.
    highlight(text, turn.prompt + (turn.clipped ? ' …' : ''), query)
    row.appendChild(text)

    const facts = document.createElement('span')
    facts.className = 'prompts-facts'
    const where = leaf(turn.cwd)
    const parts: string[] = []
    if (where) parts.push(where)
    if (turn.branch && turn.branch !== 'main' && turn.branch !== 'master') parts.push(turn.branch)
    parts.push(time(turn.at))
    facts.textContent = parts.join(' · ')
    row.appendChild(facts)

    const strip = document.createElement('span')
    strip.className = 'prompts-strip'
    // The same wording the pane strip uses, quieter and one line down. A turn
    // is described the same way wherever it is described — see `turnFacts.ts`.
    strip.textContent = describeTurn(turn)
      .map((f) => f.text)
      .join('  ·  ')
    strip.title = `${modelName(turn.model)}\n${turn.cwd}`
    row.appendChild(strip)

    row.addEventListener('click', () => {
      const target = store.activeTab?.activePaneId
      void typeIntoPane(target, turn.prompt)
    })
    return row
  }
}

const SYNTAX = [
  'bare words       every one must appear',
  '"a phrase"       exactly that, in that order',
  '-word            must not appear',
  'project:name     the folder it was sent in',
  'after:2026-01-15 · before:2026-02-01',
  'has:image        prompts that carried a picture',
].join('\n')

function note(text: string): HTMLElement {
  const el = document.createElement('p')
  el.className = 'prompts-note'
  el.textContent = text
  return el
}

/**
 * How many matched, and whether the list is all of them.
 *
 * The useful question when a list looks short is "is that all of them", and the
 * useful question when it looks long is "am I seeing all of these". One line
 * answers both, and says when it has stopped drawing rather than trailing off.
 */
function countLine(found: AgentTurn[], total: number, shown: number): HTMLElement {
  const el = document.createElement('span')
  if (found.length === total) el.textContent = `${total} prompts`
  else el.textContent = `${found.length} of ${total} prompts`
  if (found.length > shown) el.textContent += ` — showing the newest ${shown}`
  return el
}

/**
 * Whether a conversation's folder is inside a workspace's.
 *
 * Inside rather than equal, so a session started in a subfolder counts towards
 * the project above it rather than vanishing — the same rule the token monitor
 * uses to turn folders into workspaces.
 */
function under(cwd: string, root: string): boolean {
  const a = norm(cwd)
  const b = norm(root)
  return a === b || a.startsWith(`${b}/`)
}

/**
 * Path comparison as the filesystem means it, not as JavaScript does.
 *
 * Windows writes separators both ways round and does not care about case, so
 * the same folder arrives spelled three ways across a week of use.
 */
function norm(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function leaf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/** `Today`, `Yesterday`, or the date — the way somebody scanning would say it. */
function dayOf(at: number): string {
  if (!at) return 'undated'
  const when = new Date(at)
  const today = new Date()
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(when, today)) return 'Today'
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (same(when, yesterday)) return 'Yesterday'
  return when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
}

function time(at: number): string {
  return at ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''
}

/**
 * The prompt, with what matched marked in it.
 *
 * Built as text nodes and `<mark>` elements rather than as a string of HTML —
 * this is somebody's own prose, arriving from a file, and the one thing it must
 * never be is parsed as markup.
 */
function highlight(host: HTMLElement, text: string, query: Query): void {
  const spans = query.spans(text)
  if (!spans.length) {
    host.textContent = text
    return
  }
  let at = 0
  for (const span of spans) {
    if (span.from > at) host.appendChild(document.createTextNode(text.slice(at, span.from)))
    const mark = document.createElement('mark')
    mark.textContent = text.slice(span.from, span.to)
    host.appendChild(mark)
    at = span.to
  }
  if (at < text.length) host.appendChild(document.createTextNode(text.slice(at)))
}
