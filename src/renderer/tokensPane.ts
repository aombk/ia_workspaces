/**
 * What this workspace has spent on Claude, as a tab.
 *
 * The numbers lived on the sidebar row's tooltip before this, and a tooltip was
 * the wrong container from the start: what wants showing here is a *table* —
 * five classes of token, each with a count, a published rate and a cost — and a
 * table crammed into hover text is a table nobody reads. A tab can be left open
 * beside the work, scrolled, and pointed at.
 *
 * The five rows are Anthropic's own price columns, in its own order and its own
 * words, so a figure here can be checked against the page it came from. There is
 * deliberately **no total-tokens row**. Base input and cache hits differ in price
 * by a factor of ten, so adding them produces a number that is arithmetically
 * true and means nothing — it was the headline in an earlier version of this
 * feature and it is what made a project look like it had spent two billion of
 * something. The column that sums is the money.
 *
 * Everything is read from Claude Code's own transcripts on this disk. See
 * `tokenUsage.ts` for the counting and `tokenMonitor.ts` for how folders become
 * workspaces.
 */
import type { AuxPane } from './auxPane'
import { backend } from '../backend'
import { store } from './state'
import {
  CACHE_MULTIPLIERS,
  TOKEN_CLASS_LABELS,
  priceFor,
  type TokenTotals,
} from '../shared/types'
import {
  COST_CAVEAT,
  freshOf,
  latestTokens,
  money,
  sharingOn,
  tokenCount,
  watchTokens,
  workspaceTokens,
  type WorkspaceTokens,
} from './ui/tokenMonitor'

/**
 * How many conversations the pane lists.
 *
 * A workspace worked in all year has hundreds, and the question is always about
 * the recent ones. The row under the table says how many were left out, because
 * a list that silently stops is a list you cannot trust the top of either.
 */
const CONVERSATION_ROWS = 12

/**
 * The mark every estimated figure carries.
 *
 * Exactly one kind of number here is estimated, and it is worth being precise
 * about which. Every **token count** is measured: it is what Anthropic's own
 * response reported, copied out of the transcript unchanged. Every **cost** is
 * an estimate, for three separate reasons any one of which would be enough —
 * the price table is a hard-coded copy that goes stale the day Anthropic
 * changes a price; a subscription is not billed per token at all; and modifiers
 * this does not model, like US-pinned inference at 1.1x or the Batch API at
 * half, would move it again.
 *
 * So the tokens stand unmarked and every money figure is marked.
 */
const EST = '(est.)'

/**
 * Where the rates in this pane came from.
 *
 * Linked rather than merely cited, because the table here is a hard-coded copy
 * and the honest thing to do with a copy is to say where the original lives.
 * Anthropic has changed a price during this feature's own lifetime — Sonnet 5's
 * introductory rate became permanent — so this is not a hypothetical.
 */
const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'

export class TokensPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly body: HTMLDivElement
  private unwatch: (() => void) | null = null
  private disposed = false

  constructor(
    readonly paneId: string,
    private readonly workspaceId: string
  ) {
    this.element = document.createElement('div')
    this.element.className = 'tokens-pane'

    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent =
      'What Claude Code has spent in this workspace, counted from the conversation transcripts it ' +
      'writes on this machine. Nothing is sent anywhere to work this out.'
    this.element.appendChild(about)

    this.body = document.createElement('div')
    this.body.className = 'tokens-body'
    this.element.appendChild(this.body)

    this.render()
    // Redrawn when a new count lands rather than on a clock of its own: the
    // scan already runs once a minute for everything that wants it.
    this.unwatch = watchTokens(() => this.render())
  }

  /** Cheap and idempotent: the store changing can rename the workspace. */
  sync(): void {
    this.render()
  }

  private render(): void {
    if (this.disposed) return
    const workspace = store.workspaces.find((w) => w.id === this.workspaceId)
    const spent = workspaceTokens(this.workspaceId)

    this.body.replaceChildren()

    if (!latestTokens()) {
      // The first scan reads every transcript on the disk. Saying so is the
      // difference between a slow answer and an apparently empty one.
      this.body.appendChild(this.note('Reading Claude Code’s transcripts…'))
      return
    }
    if (!spent) {
      this.body.appendChild(
        this.note(
          workspace
            ? `No Claude Code conversations have been recorded in ${workspace.cwd} yet, so there is nothing to count.`
            : 'This workspace is gone.'
        )
      )
      return
    }

    this.body.appendChild(this.headline(spent))
    this.body.appendChild(this.billedTable(spent))
    this.body.appendChild(this.recent(spent))
    if (spent.models.length) this.body.appendChild(this.models(spent))
    this.body.appendChild(this.machines(spent))
    this.body.appendChild(this.conversations(spent))
    if (spent.folders.length > 1) this.body.appendChild(this.folders(spent))
  }

  /**
   * The individual conversations, newest first.
   *
   * A different question from everything above it: not "is this project
   * expensive" but "which chat got expensive", which is the one you can still do
   * something about — start a fresh one, or stop letting this one grow. This
   * briefly lived on a terminal tab's hover text and is here instead, so that
   * every figure in the feature is in one place.
   *
   * Capped, because a workspace worked in for a year has hundreds and the
   * question is always about the recent ones. The cap says so rather than
   * quietly truncating.
   */
  private conversations(t: WorkspaceTokens): HTMLElement {
    const report = latestTokens()
    const mine = (report?.sessions ?? [])
      .filter((s) => t.folders.includes(s.cwd))
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

    const card = this.card('conversations')
    if (!mine.length) {
      card.appendChild(this.note('No conversations recorded for this workspace yet.'))
      return card
    }

    const shown = mine.slice(0, CONVERSATION_ROWS)
    const table = document.createElement('table')
    table.className = 'tokens-table'
    const body = document.createElement('tbody')
    for (const session of shown) {
      const tr = document.createElement('tr')
      // The id is Claude Code's own, and the short form is enough to match a
      // row against `claude --resume`. Full id in the tooltip for when it isn't.
      tr.title = `${session.id}\n${session.cwd}`
      tr.appendChild(this.cell(session.lastAt ? ago(session.lastAt) : 'unknown'))
      tr.appendChild(this.cell(`${tokenCount(freshOf(session.totals))} new`, 'num'))
      tr.appendChild(this.cell(money(session.cost) + ' ' + EST, 'num'))
      tr.appendChild(this.cell(`${session.totals.messages.toLocaleString()} replies`, 'num rate'))
      body.appendChild(tr)
    }
    table.appendChild(body)
    card.appendChild(table)

    if (mine.length > shown.length) {
      card.appendChild(
        this.note(`The ${shown.length} most recent of ${mine.length} conversations in this workspace.`)
      )
    }
    return card
  }

  /**
   * The two numbers worth remembering, before any of the detail.
   *
   * "New" is everything except cache hits — the material this workspace
   * actually produced, as opposed to the same conversation being sent up again
   * on every reply. The row underneath says exactly that, so the word is never
   * left to be guessed at.
   */
  private headline(t: WorkspaceTokens): HTMLElement {
    const card = this.card('')
    const row = document.createElement('div')
    row.className = 'tokens-headline'
    row.append(
      this.figure(
        tokenCount(t.fresh),
        'new tokens',
        'Everything except cache hits: what this workspace actually produced. Measured, not estimated — this is the ' +
          'count Anthropic’s own response reported.'
      ),
      this.figure(money(t.cost), `at API prices ${EST}`, COST_CAVEAT),
      this.figure(t.totals.messages.toLocaleString(), 'replies', 'How many times Claude answered — one API call each.'),
      this.figure(
        tokenCount(t.totals.messages ? t.fresh / t.totals.messages : 0),
        'new per reply',
        'The average amount of new material in a single reply.'
      )
    )
    card.appendChild(row)
    return card
  }

  /** The five price columns, as a table you can check against the price list. */
  private billedTable(t: WorkspaceTokens): HTMLElement {
    const card = this.card('what you were billed for')
    // The rates in this table are a copy, and a copy of a price is a thing that
    // goes out of date. The link is how you check it, and it is here rather than
    // in a settings panel or a README because here is where the doubt occurs.
    card.appendChild(this.link(PRICING_URL, 'Anthropic’s price list ↗'))

    const table = document.createElement('table')
    table.className = 'tokens-table'

    const head = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const [label, className] of [
      ['', ''],
      ['tokens', 'num'],
      ['per million', 'num'],
      [`cost ${EST}`, 'num'],
    ] as Array<[string, string]>) {
      const th = document.createElement('th')
      th.textContent = label
      if (className) th.className = className
      headRow.appendChild(th)
    }
    head.appendChild(headRow)
    table.appendChild(head)

    const rates = this.rates(t.models)
    const body = document.createElement('tbody')
    const rows: Array<[string, number, number | null, number, string]> = [
      [
        TOKEN_CLASS_LABELS.input,
        t.totals.input,
        rates?.input ?? null,
        t.costs.input,
        'Text sent for the first time — not served from, or written to, the cache.',
      ],
      [
        TOKEN_CLASS_LABELS.cacheWrite5m,
        t.totals.cacheWrite5m,
        rates ? rates.input * CACHE_MULTIPLIERS.write5m : null,
        t.costs.cacheWrite5m,
        'Context stored so the next reply can reuse it. Costs 1.25× base input, and pays for itself after one reuse.',
      ],
      [
        TOKEN_CLASS_LABELS.cacheWrite1h,
        t.totals.cacheWrite1h,
        rates ? rates.input * CACHE_MULTIPLIERS.write1h : null,
        t.costs.cacheWrite1h,
        'The same, kept for an hour instead of five minutes. Costs 2× base input, and needs two reuses to pay for itself.',
      ],
      [
        TOKEN_CLASS_LABELS.cacheRead,
        t.totals.cacheRead,
        rates ? rates.input * CACHE_MULTIPLIERS.read : null,
        t.costs.cacheRead,
        'The conversation so far, sent up again on every single reply, and served from cache at a tenth of the price. ' +
          'This is almost always the biggest count here and rarely the biggest cost.',
      ],
      [
        TOKEN_CLASS_LABELS.output,
        t.totals.output,
        rates?.output ?? null,
        t.costs.output,
        'What Claude wrote. The smallest count and often the largest cost — output is five times base input.',
      ],
    ]

    for (const [label, tokens, rate, cost, why] of rows) {
      const tr = document.createElement('tr')
      tr.title = why
      tr.appendChild(this.cell(label))
      tr.appendChild(this.cell(tokens.toLocaleString(), 'num'))
      tr.appendChild(this.cell(rate === null ? '—' : perMillion(rate), 'num rate'))
      tr.appendChild(this.cell(money(cost), 'num'))
      body.appendChild(tr)
    }
    table.appendChild(body)

    const foot = document.createElement('tfoot')
    const total = document.createElement('tr')
    total.appendChild(this.cell('total'))
    total.appendChild(this.cell('', 'num'))
    total.appendChild(this.cell('', 'num'))
    total.appendChild(this.cell(money(t.cost), 'num'))
    foot.appendChild(total)
    table.appendChild(foot)

    card.appendChild(table)

    card.appendChild(
      this.note(
        'The token counts are measured, not estimated — they are what Anthropic’s own response reported, copied out ' +
          'of the transcript unchanged. Only the money is an estimate.'
      )
    )
    card.appendChild(this.note(COST_CAVEAT))
    if (t.unpricedModels.length) {
      card.appendChild(
        this.note(
          `No published price in this build for ${t.unpricedModels.join(', ')}, so those replies count towards the ` +
            'tokens and not towards the cost.'
        )
      )
    }
    return card
  }

  /** Published rates, when a single model did the work. */
  private rates(models: string[]): { input: number; output: number } | null {
    if (models.length !== 1) return null
    return priceFor(models[0])
  }

  private recent(t: WorkspaceTokens): HTMLElement {
    const card = this.card('recently')
    const row = document.createElement('div')
    row.className = 'tokens-headline'
    row.append(
      this.figure(tokenCount(t.today), 'today', 'New tokens since midnight, on this machine.'),
      this.figure(tokenCount(t.week), 'last 7 days', 'New tokens over the past week, on this machine.'),
      this.figure(
        t.busiest ? tokenCount(t.busiest.tokens) : '—',
        t.busiest ? `busiest — ${prettyDay(t.busiest.day)}` : 'busiest day',
        'The heaviest single day in the last month.'
      ),
      this.figure(t.lastAt ? ago(t.lastAt) : '—', 'last active', 'When this workspace last spoke to Claude.')
    )
    card.appendChild(row)
    if (t.machines.length) {
      card.appendChild(
        this.note('These four are this machine’s own: other machines report totals, not a calendar.')
      )
    }
    return card
  }

  /** Which models did the work, and what each cost. */
  private models(t: WorkspaceTokens): HTMLElement {
    const card = this.card('models')
    const table = document.createElement('table')
    table.className = 'tokens-table'
    const body = document.createElement('tbody')

    for (const model of t.models) {
      const totals = this.modelTotals(model)
      const tr = document.createElement('tr')
      tr.appendChild(this.cell(model))
      tr.appendChild(this.cell(totals ? `${tokenCount(freshOf(totals))} new` : '—', 'num'))
      const price = priceFor(model)
      tr.appendChild(
        this.cell(price ? `${perMillion(price.input)} in · ${perMillion(price.output)} out` : 'no price', 'num rate')
      )
      body.appendChild(tr)
    }
    table.appendChild(body)
    card.appendChild(table)
    return card
  }

  /** This model's totals across every folder this workspace owns. */
  private modelTotals(model: string): TokenTotals | null {
    const report = latestTokens()
    if (!report) return null
    const spent = workspaceTokens(this.workspaceId)
    if (!spent) return null
    const out: TokenTotals = {
      input: 0,
      output: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      messages: 0,
    }
    let found = false
    for (const project of report.projects) {
      if (!spent.folders.includes(project.cwd)) continue
      const totals = project.byModel[model]
      if (!totals) continue
      found = true
      out.input += totals.input
      out.output += totals.output
      out.cacheWrite5m += totals.cacheWrite5m
      out.cacheWrite1h += totals.cacheWrite1h
      out.cacheRead += totals.cacheRead
      out.messages += totals.messages
    }
    return found ? out : null
  }

  /** Where the numbers came from — and, when sharing is off, where they did not. */
  private machines(t: WorkspaceTokens): HTMLElement {
    const card = this.card('machines')
    if (!t.machines.length) {
      card.appendChild(
        this.note(
          sharingOn()
            ? 'Counted on this machine. No other machine has reported this project yet — they appear here once they do.'
            : 'Counted on this machine only. If you work on this project from another computer, point both at a shared ' +
              'folder in Settings and their totals are pooled here. Only totals travel, never a conversation.'
        )
      )
      return card
    }

    const table = document.createElement('table')
    table.className = 'tokens-table'
    const body = document.createElement('tbody')
    for (const machine of t.machines) {
      const tr = document.createElement('tr')
      tr.appendChild(this.cell(machine.label + (machine.self ? ' (this machine)' : '')))
      tr.appendChild(this.cell(`${tokenCount(machine.fresh)} new`, 'num'))
      tr.appendChild(this.cell(money(machine.cost) + ' ' + EST, 'num'))
      tr.appendChild(this.cell(machine.self ? 'live' : `reported ${ago(machine.at)}`, 'num rate'))
      body.appendChild(tr)
    }
    table.appendChild(body)
    card.appendChild(table)
    return card
  }

  /**
   * Every folder that counted towards this workspace.
   *
   * Shown only when there is more than one, and there usually is: a conversation
   * started in `src` is recorded against `src`, not against the workspace root.
   * Without this the total looks bigger than the folder you were thinking of,
   * with no way to find out why.
   */
  private folders(t: WorkspaceTokens): HTMLElement {
    const card = this.card(`folders counted (${t.folders.length})`)
    const list = document.createElement('div')
    list.className = 'tokens-folders'
    for (const folder of [...t.folders].sort()) {
      const row = document.createElement('div')
      row.textContent = folder
      list.appendChild(row)
    }
    card.appendChild(list)
    card.appendChild(
      this.note(
        'Claude Code records a conversation against the folder it was started in, so a session begun in a subfolder ' +
          'counts towards this workspace rather than disappearing.'
      )
    )
    return card
  }

  // ------------------------------------------------------------- small pieces

  private card(title: string): HTMLElement {
    const card = document.createElement('section')
    card.className = 'tokens-card'
    if (title) {
      const h = document.createElement('h3')
      h.textContent = title
      card.appendChild(h)
    }
    return card
  }

  private figure(value: string, label: string, why: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'tokens-figure'
    el.title = why
    const v = document.createElement('span')
    v.className = 'tokens-figure__value'
    v.textContent = value
    const l = document.createElement('span')
    l.className = 'tokens-figure__label'
    l.textContent = label
    el.append(v, l)
    return el
  }

  private cell(text: string, className = ''): HTMLElement {
    const td = document.createElement('td')
    td.textContent = text
    if (className) td.className = className
    return td
  }

  private note(text: string): HTMLElement {
    const el = document.createElement('p')
    el.className = 'tokens-note'
    el.textContent = text
    return el
  }

  /**
   * A link out to the browser.
   *
   * A button rather than an `<a>`: the renderer's CSP allows no navigation, so
   * an anchor would either do nothing or replace the app with a web page. The
   * host opens it in the real browser, which is where a price list belongs.
   */
  private link(url: string, label: string): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'tokens-link'
    el.textContent = label
    el.title = url
    el.addEventListener('click', () => void backend().openExternal(url))
    return el
  }

  dispose(): void {
    this.disposed = true
    this.unwatch?.()
    this.unwatch = null
  }
}

/** `$5` or `$0.50` — whole dollars stay whole, fractions keep their cents. */
function perMillion(rate: number): string {
  return rate >= 1 ? `$${rate}` : `$${rate.toFixed(2)}`
}

/** `12 Aug`, or `12 Aug 2025` once the year stops being obvious. */
function prettyDay(key: string): string {
  const at = new Date(`${key}T00:00:00`)
  if (Number.isNaN(at.getTime())) return key
  const sameYear = at.getFullYear() === new Date().getFullYear()
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** "3 hours ago". */
function ago(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
