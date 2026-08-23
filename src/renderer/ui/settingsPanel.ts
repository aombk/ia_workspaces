import { backend } from '../../backend'
import { store } from '../state'
import { playSound, SOUND_OPTIONS } from '../sound'
import { renderThemeSection } from './themeEditor'
import { showToast } from './toast'
import { confirmDialog } from './confirm'
import { DEFAULT_URL } from '../browserPane'
import { refreshUsageNow } from './usageMonitor'
import { refreshRelayNow } from './relayMonitor'
import { refreshTokensNow } from './tokenMonitor'
import { syncSystemStrip } from './systemStrip'
import { appVersion, checkForUpdates, describeUpdate } from '../updates'
import type { AgentConfigInfo } from '../../shared/types'
import type { ShellProfile, Settings, SoundName } from '../../shared/types'

let onChange: (() => void) | null = null
let shells: ShellProfile[] = []

/**
 * What the search box holds, kept outside the render.
 *
 * The panel rebuilds itself whenever a theme is edited, and a filter that
 * vanished every time you changed a colour would be worse than no filter. It is
 * cleared when the panel is opened, not when it is redrawn.
 */
let query = ''


/**
 * Offers the restart a setting needs, rather than mentioning that it needs one.
 *
 * Declining is a real answer and costs nothing: the setting is saved either
 * way, and it applies the next time the app starts.
 */
async function offerRestart(body: string): Promise<void> {
  const ok = await confirmDialog({
    title: 'Restart now?',
    body,
    confirmLabel: 'Restart',
  })
  if (ok) void backend().relaunch()
}

export function initSettingsPanel(cb: () => void): void {
  onChange = cb
  document.getElementById('overlay')!.addEventListener('click', closeSettings)
}

export function isSettingsOpen(): boolean {
  return !document.getElementById('settings-panel')!.hidden
}

export async function openSettings(): Promise<void> {
  shells = await backend().listShells()
  query = ''
  document.getElementById('overlay')!.hidden = false
  document.getElementById('settings-panel')!.hidden = false
  await render()
  // Focused on open, so the panel can be driven by typing what you came for.
  // Only here — `refreshSettings` redraws under a theme edit, and stealing the
  // caret mid-edit would be its own bug.
  document.querySelector<HTMLInputElement>('.settings-search')?.focus()
}

export function closeSettings(): void {
  document.getElementById('overlay')!.hidden = true
  document.getElementById('settings-panel')!.hidden = true
}

/** Re-renders in place when open, so live theme edits stay visible. */
export async function refreshSettings(): Promise<void> {
  if (isSettingsOpen()) await render()
}

// --------------------------------------------------------------- field helpers

function section(title: string, ...children: Node[]): HTMLElement {
  const el = document.createElement('section')
  el.className = 'settings-section'
  const h = document.createElement('h3')
  h.textContent = title
  el.append(h, ...children)
  return el
}

/**
 * Past this much explanation, the control moves below the text.
 *
 * A settings row is two columns — what it is on the left, what changes it on
 * the right — and that only works while the left column is a line or two. A
 * paragraph beside a single text box gives a tall column of prose with one
 * field floating in the middle of an empty half, which is what this avoids.
 *
 * Measured in characters rather than lines because the panel is a fixed width,
 * so the two are the same thing here.
 */
const STACK_HINT_AT = 200

function field(name: string, hint: string, control: Node): HTMLElement {
  const row = document.createElement('div')
  row.className = 'field' + (hint.length > STACK_HINT_AT ? ' stacked' : '')

  const label = document.createElement('div')
  label.className = 'field-label'
  const nameEl = document.createElement('span')
  nameEl.className = 'name'
  nameEl.textContent = name
  label.appendChild(nameEl)
  if (hint) {
    const hintEl = document.createElement('span')
    hintEl.className = 'hint'
    hintEl.textContent = hint
    label.appendChild(hintEl)
  }

  const wrap = document.createElement('div')
  wrap.className = 'field-control'
  wrap.appendChild(control)

  row.append(label, wrap)
  return row
}


/**
 * A passphrase you can set and clear but never read.
 *
 * Write-only by design: there is no IPC that returns one, so no panel can show
 * it and no screenshot of this page can leak it. The row says whether one is
 * set, which is the whole of what somebody needs to know here.
 */
function passphraseRow(): HTMLElement {
  const row = document.createElement('div')
  row.className = 'settings-folder'
  // Greyed out rather than taken away when sharing is off: the row keeps its
  // place, and a control that is there and unavailable says "this belongs to
  // the switch above" in a way an empty gap never does.
  const live = store.settings.shareCommands
  if (!live) row.title = 'Switch on “Share the commands you run between machines” first.'

  const input = document.createElement('input')
  input.type = 'password'
  input.placeholder = 'not set — commands are not shared'
  input.spellcheck = false
  input.autocomplete = 'off'
  row.appendChild(input)

  const state = document.createElement('span')
  state.className = 'field-value'
  row.appendChild(state)

  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'btn'
  save.textContent = 'Set'
  row.appendChild(save)

  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'btn'
  clear.textContent = 'Clear'
  row.appendChild(clear)

  const refresh = (): void => {
    input.disabled = !live
    save.disabled = !live
    void backend()
      .hasSharePassphrase()
      .then((has) => {
        state.textContent = live ? (has ? 'set on this machine' : 'not set') : 'not needed while sharing is off'
        input.placeholder = has ? 'set — type a new one to replace it' : 'not set — commands are not shared'
        clear.disabled = !has || !live
      })
      .catch(() => {
        state.textContent = ''
      })
  }
  refresh()

  save.addEventListener('click', () => {
    const value = input.value
    if (!value) return
    void backend()
      .setSharePassphrase(value)
      .then(() => {
        input.value = ''
        refresh()
        refreshRelayNow()
      })
  })

  clear.addEventListener('click', () => {
    void backend()
      .setSharePassphrase('')
      .then(() => {
        input.value = ''
        refresh()
        refreshRelayNow()
      })
  })

  return row
}

function toggle(checked: boolean, onToggle: (next: boolean) => void): HTMLElement {
  const btn = document.createElement('button')
  btn.className = 'switch'
  btn.setAttribute('role', 'switch')
  btn.setAttribute('aria-checked', String(checked))
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true'
    btn.setAttribute('aria-checked', String(next))
    onToggle(next)
  })
  return btn
}

/**
 * The Explorer verb toggle, driven by the registry rather than by our settings.
 *
 * The keys can be removed by an uninstaller, a cleanup tool, or the user, so a
 * remembered boolean would drift out of sync with reality. Reading the actual
 * state means the switch always shows what is true; the setting is only a
 * record of the last thing we were asked to do.
 */
function contextMenuToggle(): HTMLElement {
  const btn = toggle(false, (next) => {
    void backend()
      .contextMenu.set(next)
      .then((res) => {
        if (res.ok) {
          store.updateSettings({ explorerContextMenu: next })
          return
        }
        btn.setAttribute('aria-checked', String(!next))
        showToast('Could not update Explorer menu', res.error ?? 'Unknown error', { kind: 'error' })
      })
  })
  void backend()
    .contextMenu.get()
    .then((installed) => btn.setAttribute('aria-checked', String(installed)))
  return btn
}

function number(value: number, min: number, max: number, onInput: (n: number) => void): HTMLElement {
  const input = document.createElement('input')
  input.type = 'number'
  input.value = String(value)
  input.min = String(min)
  input.max = String(max)
  input.addEventListener('change', () => {
    const n = Math.max(min, Math.min(max, Number(input.value) || min))
    input.value = String(n)
    onInput(n)
  })
  return input
}

function text(value: string, placeholder: string, onInput: (v: string) => void): HTMLElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value
  input.placeholder = placeholder
  input.spellcheck = false
  input.addEventListener('change', () => onInput(input.value))
  return input
}

/**
 * A path, with the native folder picker beside it.
 *
 * The field stays typeable — a network share is quicker pasted than browsed to,
 * and a picker is no help at all on a path that is not mounted right now — but
 * the button is what people reach for, and a settings row that makes you type
 * `\\nas\backup\claude` by hand is a settings row nobody completes.
 */
function folder(value: string, placeholder: string, onPick: (v: string) => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'settings-folder'

  const input = text(value, placeholder, onPick) as HTMLInputElement
  row.appendChild(input)

  const browse = document.createElement('button')
  browse.type = 'button'
  browse.className = 'btn'
  browse.textContent = 'Choose…'
  browse.addEventListener('click', () => {
    void backend()
      .pickFolder(input.value || undefined)
      .then((chosen) => {
        if (!chosen) return
        input.value = chosen
        onPick(chosen)
      })
  })
  row.appendChild(browse)

  // Clearing is switching the feature off, and it needs to be as easy as
  // switching it on — a path you can only replace is a path you cannot remove.
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'btn'
  clear.textContent = 'Clear'
  clear.disabled = !value
  clear.addEventListener('click', () => {
    input.value = ''
    onPick('')
  })
  row.appendChild(clear)

  return row
}

function select<T extends string>(
  options: { value: T; label: string; disabled?: boolean }[],
  value: T,
  onPick: (v: T) => void
): HTMLElement {
  const el = document.createElement('select')
  for (const opt of options) {
    const o = document.createElement('option')
    o.value = opt.value
    o.textContent = opt.label
    o.disabled = Boolean(opt.disabled)
    el.appendChild(o)
  }
  el.value = value
  el.addEventListener('change', () => onPick(el.value as T))
  return el
}

/** Something the panel reports rather than edits. */
function value(text: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'field-value'
  el.textContent = text
  return el
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'btn' + (primary ? ' primary' : '')
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

function patch(next: Partial<Settings>): void {
  store.updateSettings(next)
  onChange?.()
}

function patchNotif(next: Partial<Settings['notifications']>): void {
  store.updateNotifications(next)
  onChange?.()
}

// -------------------------------------------------------------------- render

/**
 * The wheel scrolls the panel. Always the panel.
 *
 * A `<select>`, a number box and a range slider all treat the wheel as *input*:
 * roll it over the shell dropdown on the way past and you have silently changed
 * which shell every new terminal opens with, with no click and nothing to undo.
 * Nobody has ever wanted that. Capture phase, so it is taken before the control
 * sees it, and the scroll it would have caused is done by hand.
 *
 * `overscroll-behavior` in the stylesheet handles the other half: reaching the
 * end of the list must not start scrolling the terminal behind the panel.
 */
function wireWheel(panel: HTMLElement): void {
  panel.addEventListener(
    'wheel',
    (e) => {
      const target = e.target as HTMLElement | null
      if (!target?.closest('select, input[type="range"], input[type="number"]')) return
      e.preventDefault()
      panel.scrollTop += e.deltaY
    },
    { passive: false, capture: true }
  )
}

// -------------------------------------------------------------------- search

/**
 * Applied rather than `hidden`, because `.field` sets `display: flex` and an
 * author rule beats the `[hidden]` the browser's own stylesheet provides.
 */
const FILTERED = 'settings-filtered-out'

function searchBox(): HTMLElement {
  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'settings-search'
  input.placeholder = 'Search settings'
  input.value = query
  input.spellcheck = false
  input.setAttribute('aria-label', 'Search settings')
  input.addEventListener('input', () => applyFilter(input.value))
  return input
}

/**
 * Empties the search box, and says whether there was anything in it.
 *
 * Escape clears the filter before it closes the panel — a mistyped search
 * should cost one key rather than a reopen. It cannot be a listener on the box:
 * the app reads Escape in the capture phase at the window, so nothing inside
 * the panel ever gets the chance to claim it. The app's handler asks this
 * first instead, and closes only when the answer is that there was nothing to
 * clear.
 */
export function clearSettingsSearch(): boolean {
  const input = document.querySelector<HTMLInputElement>('.settings-search')
  if (!input?.value) return false
  input.value = ''
  applyFilter('')
  return true
}

/**
 * Every word a row can be found by.
 *
 * `textContent` covers the label, the hint and the text of every option in a
 * dropdown. It does not cover what is *typed* into a box — an input's value is
 * a property and not a child node — so the fields are read as well, which is
 * what makes the custom shell command or the notification sound findable by
 * what they are currently set to rather than only by what they are called.
 */
function haystack(el: Element): string {
  const parts = [el.textContent ?? '']
  for (const input of el.querySelectorAll<HTMLInputElement>('input')) {
    parts.push(input.value, input.placeholder)
  }
  return parts.join(' ').toLowerCase()
}

/**
 * Narrows the panel to the rows that match, in place.
 *
 * A section heading matches on behalf of everything under it: typing
 * "notifications" is a request for that whole group, not for the one row that
 * happens to repeat the word. Sections left with nothing showing are hidden
 * outright, so the result reads as a short list rather than a page of headings.
 */
function applyFilter(next: string): void {
  query = next
  const body = document.querySelector('.settings-body')
  if (!body) return

  const needle = query.trim().toLowerCase()
  let shown = 0

  for (const sec of body.querySelectorAll<HTMLElement>('.settings-section')) {
    const heading = sec.querySelector('h3')?.textContent?.toLowerCase() ?? ''
    const wholeSection = !needle || heading.includes(needle)
    let hits = 0
    for (const row of sec.children) {
      if (row.tagName === 'H3') continue
      const match = wholeSection || haystack(row).includes(needle)
      row.classList.toggle(FILTERED, !match)
      if (match) hits++
    }
    sec.classList.toggle(FILTERED, hits === 0)
    shown += hits
  }

  const empty = body.querySelector<HTMLElement>('.settings-empty')
  if (empty) {
    empty.classList.toggle(FILTERED, shown > 0)
    empty.textContent = `Nothing in Settings matches “${query.trim()}”.`
  }
}

async function render(): Promise<void> {
  const panel = document.getElementById('settings-panel')!
  const s = store.settings
  const scroll = panel.scrollTop
  panel.replaceChildren()
  // The panel element outlives its contents, so this is wired once.
  if (!panel.dataset.wheelWired) {
    wireWheel(panel)
    panel.dataset.wheelWired = 'yes'
  }

  const head = document.createElement('div')
  head.className = 'settings-head'
  const h2 = document.createElement('h2')
  h2.textContent = 'Settings'
  head.append(h2, searchBox(), button('Done', closeSettings, true))
  panel.appendChild(head)

  const body = document.createElement('div')
  body.className = 'settings-body'
  panel.appendChild(body)

  // ------------------------------------------------------------------ theme
  const themeHost = document.createElement('div')
  renderThemeSection(themeHost)
  body.appendChild(section('Theme', themeHost))

  // ------------------------------------------------------------------ shell
  const shellOptions = shells.map((p) => ({
    value: p.kind,
    label: p.available ? p.label : `${p.label} (not installed)`,
    disabled: !p.available && p.kind !== 'custom',
  }))

  const shellRows: Node[] = [
    field(
      'Default shell',
      'Used for new terminals. Existing panes keep the shell they started with.',
      select(shellOptions, s.shell, (kind) => patch({ shell: kind }))
    ),
  ]

  if (s.shell === 'custom') {
    shellRows.push(
      field(
        'Custom shell path',
        'Full path to the executable.',
        text(s.customShellPath, 'C:\\path\\to\\shell.exe', (v) => patch({ customShellPath: v }))
      ),
      field(
        'Custom shell arguments',
        'Space separated; quote arguments containing spaces.',
        text(s.customShellArgs, '', (v) => patch({ customShellArgs: v }))
      )
    )
  }

  shellRows.push(
    field(
      'Shell integration',
      'Tracks each pane\u2019s folder so restored panes reopen in place, and detects when a command finishes. PowerShell only.',
      toggle(s.shellIntegration, (v) => patch({ shellIntegration: v }))
    )
  )
  body.appendChild(section('Shell', ...shellRows))

  // ------------------------------------------------------------------- text
  body.appendChild(
    section(
      'Text',
      field('Font family', '', text(s.fontFamily, 'Cascadia Mono', (v) => patch({ fontFamily: v }))),
      field('Font size', '', number(s.fontSize, 8, 32, (n) => patch({ fontSize: n }))),
      field('Line height', '', number(s.lineHeight, 1, 2, (n) => patch({ lineHeight: n }))),
      field(
        'Cursor style',
        '',
        select(
          [
            { value: 'bar' as const, label: 'Bar' },
            { value: 'block' as const, label: 'Block' },
            { value: 'underline' as const, label: 'Underline' },
          ],
          s.cursorStyle,
          (v) => patch({ cursorStyle: v })
        )
      ),
      field('Blinking cursor', '', toggle(s.cursorBlink, (v) => patch({ cursorBlink: v }))),
      field(
        'Scrollback',
        'Lines kept per pane.',
        number(s.scrollback, 1000, 200000, (n) => patch({ scrollback: n }))
      )
    )
  )

  // ---------------------------------------------------------------- behaviour
  body.appendChild(
    section(
      'Behaviour',
      field(
        'Folder for new workspaces',
        'Where a workspace made with + starts. Leave blank for your home folder.',
        text(s.newWorkspaceDir, 'your home folder', (v) => patch({ newWorkspaceDir: v }))
      ),
      field(
        'Draw with the processor instead of the graphics card',
        'Off, and off is right on any machine with a graphics card — it is faster at what a ' +
          'terminal does. On is for the machine where memory matters more than speed: the ' +
          'graphics process alone can hold a few hundred megabytes, and this gives most of it ' +
          'back. Terminals then draw through the browser’s own renderer, which is slower on a ' +
          'full-screen program repainting constantly and no different at a prompt. Also worth ' +
          'trying if your graphics driver is unstable. Takes effect after a restart.',
        // The one setting the app cannot apply to itself: Electron reads it
        // before the window exists. Saying "takes effect after a restart" and
        // leaving the user to go and find the restart was the whole of it
        // before — so the offer is made here, where the decision was made.
        toggle(s.useSoftwareRendering, (v) => {
          patch({ useSoftwareRendering: v })
          void offerRestart(
            v
              ? 'Drawing moves to the processor after a restart, and the graphics process gives its memory back.'
              : 'Drawing returns to the graphics card after a restart.'
          )
        })
      ),
      field(
        'Scrollback kept for panes you are not looking at',
        'The largest thing this app holds is terminal buffers, and they only ever grow — a pane ' +
          'that once printed ten thousand lines keeps them until you close it, which is around ' +
          'twenty-four megabytes each at a wide window. After half an hour off screen a pane is ' +
          'cut back to this many lines. It genuinely discards them: switching back does not bring ' +
          'them back, which is why it is a number you choose. Set it to 0 to never trim, or to the ' +
          'same as your scrollback for the same effect. The panes holding the most are usually the ' +
          'ones you opened once, watched a build in, and never returned to.',
        number(s.hiddenScrollback, 0, 100000, (v) => patch({ hiddenScrollback: v }))
      ),
      field(
        'Release an idle agent’s shell after',
        'Ends the shell of an agent pane left off screen this long, and about half a gigabyte ' +
          'with it. The pane keeps its screen; the next key resumes the conversation. Never a ' +
          'plain shell, and never one that is working or waiting on you. 0 to switch it off.',
        number(s.idleAgentRelease, 0, 1440, (v) => patch({ idleAgentRelease: v }))
      ),
      field(
        'Coins in the monitor’s crypto block',
        'Written as you would say them: btc, eth, ltc. Prices come from CoinGecko every couple ' +
          'of minutes, and only while the block is on — right-click the monitor to show it.',
        text(s.cryptoCoins, 'btc, eth, ltc', (v) => patch({ cryptoCoins: v }))
      ),
      field(
        'Currency for the crypto block',
        'Three letters — eur, usd, gbp, or anything else CoinGecko will quote in.',
        text(s.cryptoCurrency, 'eur', (v) => patch({ cryptoCurrency: v }))
      ),
      field(
        'Dragging a file out of the app',
        'What other programs receive when you drag a row out of the file tree. ' +
          '“The file itself” starts the same kind of drag Explorer does, so it can ' +
          'be dropped into FileZilla to upload, onto a message to send, or into an ' +
          'email to attach. “Its location” sends the path as text, which is what a ' +
          'terminal wants typed at a prompt. Either way, dropping onto this app’s ' +
          'own panes works as it always did.',
        select(
          [
            { value: 'file', label: 'file drag' },
            { value: 'path', label: 'path drag' },
            { value: 'auto', label: 'auto' },
          ],
          s.fileDrag,
          (v) => patch({ fileDrag: v as Settings['fileDrag'] })
        )
      ),
      field(
        'Ctrl+C copies when text is selected',
        'With no selection it still sends an interrupt.',
        toggle(s.copyOnSelectionCtrlC, (v) => patch({ copyOnSelectionCtrlC: v }))
      ),
      field(
        'Confirm before closing a busy terminal',
        'Asks first if a command is still running.',
        toggle(s.confirmCloseRunning, (v) => patch({ confirmCloseRunning: v }))
      ),
      field(
        'Nested workspace marker',
        'The glyph before a workspace that sits inside another. The indent says ' +
          'the same thing, but only by comparison with the row above — and that ' +
          'row is often scrolled away, or nested itself.',
        select(
          [
            { value: 'hook', label: '⎿   bracket' },
            { value: 'curve', label: '⤷   curved arrow' },
            { value: 'corner', label: '↳   square arrow' },
            { value: 'none', label: 'none — indent only' },
          ],
          s.nestingMarker,
          (v) => patch({ nestingMarker: v as Settings['nestingMarker'] })
        )
      ),
      // "Show git branch" and "Show tab counts" used to live here. They are on
      // the sidebar's own right-click now, under "Sidebar shows", beside the new
      // token count — decisions about what that list displays belong where the
      // list is, not three panels away from it. See `showsMenu` in `sidebar.ts`.
      field(
        'A folder your machines share',
        'A synced drive or a network share every computer you work from can see. ' +
          'Two things use it. Token counts are pooled, so a project you work on ' +
          'from two machines adds up to one number on both. And Relay marks a ' +
          'workspace when another machine has unpushed commits (saves not sent) ' +
          'or uncommitted files (changed, not saved) in it — nothing is marked ' +
          'when everything is committed and pushed. Only descriptions travel: ' +
          'counts, branch names, and the paths of files git already tracks. Never ' +
          'a conversation, never a file’s contents, never the name of a file git ' +
          'is not tracking. Blank is off.',
        folder(s.sharedDir, 'not shared — this machine only', (v) => {
          patch({ sharedDir: v })
          refreshTokensNow()
          refreshRelayNow()
        })
      ),
      field(
        'Share the commands you run between machines',
        'Adds a third setting to each terminal’s history switch — “everywhere” — so Up can recall ' +
          'a command you ran on another machine in the same project. This is the one thing Relay ' +
          'publishes that is genuinely dangerous in the clear: a command line carries bearer tokens, ' +
          'database passwords and whatever was pasted into it, and a synced folder keeps version ' +
          'history that outlives any deletion. So commands are never written unencrypted, and this ' +
          'does nothing at all until a passphrase is set below. Before they are encrypted they are ' +
          'also stripped of the obvious secret shapes — tokens, passwords in connection strings, ' +
          '--token= flags — which is a second line of defence and not a guarantee, because a secret ' +
          'that looks like an ordinary argument cannot be recognised by anything.',
        // `patch` redraws the panel, which matters here more than elsewhere:
        // the passphrase row below greys out with this switch, and every
        // terminal's history control stops offering "everywhere" — see
        // `availableScopes`.
        toggle(s.shareCommands, (v) => {
          patch({ shareCommands: v })
          refreshRelayNow()
          // `patch` repaints the app but not this panel, and the row under
          // this switch changes with it.
          void refreshSettings()
        })
      ),
      field(
        'Passphrase for shared commands',
        'The same passphrase, typed on each of your machines. It never travels through the shared ' +
          'folder — only what it encrypts does — so a machine you have not typed it on simply sees ' +
          'nothing, which is not an error. Stored here through your operating system’s own keychain ' +
          'where there is one. It cannot be shown again once set: type a new one to replace it, or ' +
          'clear it to switch sharing off. What encryption does not hide: file sizes, timestamps, ' +
          'which machines are involved, and that two of them work on the same project. Nor does it ' +
          'retract anything published before it was turned on.',
        passphraseRow()
      ),
      field(
        'Claude Code usage in the status bar',
        'How much of your 5-hour session and 7-day limits is used, and when ' +
          'each resets. Read from Anthropic using the sign-in Claude Code ' +
          'already has; nothing is stored and nothing is sent anywhere else.',
        toggle(s.showUsageMonitor, (v) => {
          patch({ showUsageMonitor: v })
          refreshUsageNow()
        })
      ),
      field(
        'This machine in the sidebar',
        'Processor, memory, the fullest disk and network traffic, under the ' +
          'Claude rows. Read from counters the system keeps for every program — ' +
          'nothing is installed and no driver is loaded. Off by default because ' +
          'it starts a small process every few seconds; the Machine pane shows ' +
          'the same readings with graphs, and only while it is open.',
        toggle(s.showSystemMonitor, (v) => {
          patch({ showSystemMonitor: v })
          syncSystemStrip()
        })
      ),
      field(
        'Keep shells running after you quit',
        'A small background process owns the terminals, so quitting detaches ' +
          'instead of killing and reopening puts you back in the same shells ' +
          'with the same processes still running. Closing a pane, a tab or a ' +
          'workspace still ends its shells, and nothing survives a restart of ' +
          'the machine. Turn this off and shells end with the window, as they ' +
          'used to. Takes effect the next time the app starts.',
        toggle(s.keepSessionsAlive, (v) => patch({ keepSessionsAlive: v }))
      ),
      field(
        'Restore what each pane was showing',
        'Keeps the last screen on disk, for the times the shell itself did not ' +
          'survive — after a machine restart, or with the setting above off. ' +
          'A reopened pane comes back with the output you were reading.',
        toggle(s.restoreScrollback, (v) => patch({ restoreScrollback: v }))
      ),
      field(
        'Refresh changed files',
        'When something else writes to a file an editor tab has open. ' +
          'Automatic re-reads it; Ask puts a bar on the tab instead. A tab with ' +
          'unsaved edits always asks either way — and never writes over the new ' +
          'version behind your back.',
        select(
          [
            { value: 'auto', label: 'Automatic' },
            { value: 'ask', label: 'Ask' },
          ],
          s.refreshChangedFiles,
          (v) => patch({ refreshChangedFiles: v })
        )
      ),
      field(
        'Resume agent sessions',
        'A pane that was in a Claude Code conversation reopens into it, by ' +
          'running claude --resume at its first prompt. Needs the Claude Code ' +
          'integration below, which is what reports the session id.',
        toggle(s.resumeAgentSessions, (v) => patch({ resumeAgentSessions: v }))
      ),
      field(
        'Editor for “Open in editor”',
        'Program a file is handed to from the tree and the reader pane. Blank ' +
          'uses whatever Windows associates with the extension. The reader is ' +
          'read-only on purpose — editing is your editor’s job, not a ' +
          'terminal’s.',
        text(s.externalEditor, 'code', (v) => patch({ externalEditor: v }))
      ),
      field(
        'Browser pane home page',
        'Where a new browser pane opens. Blank uses the built-in default.',
        text(s.browserHome, DEFAULT_URL, (v) => patch({ browserHome: v }))
      ),
      field(
        'Add “Open in ia_workspaces” to Explorer',
        'Right-click a folder to open it as a workspace. Written to your own ' +
          'registry hive, so no admin rights are needed. Windows 11 files it ' +
          'under “Show more options”.',
        contextMenuToggle()
      )
    )
  )

  // ------------------------------------------------------------ notifications
  const n = s.notifications
  const soundRow = document.createElement('div')
  soundRow.style.display = 'flex'
  soundRow.style.gap = '8px'
  soundRow.appendChild(
    select(SOUND_OPTIONS, n.soundName, (v: SoundName) => {
      patchNotif({ soundName: v })
      playSound(v, store.settings.notifications.volume)
    })
  )
  soundRow.appendChild(
    button('Test', () => playSound(store.settings.notifications.soundName, store.settings.notifications.volume))
  )

  const volume = document.createElement('input')
  volume.type = 'range'
  volume.min = '0'
  volume.max = '1'
  volume.step = '0.05'
  volume.value = String(n.volume)
  volume.addEventListener('change', () => {
    patchNotif({ volume: Number(volume.value) })
    playSound(store.settings.notifications.soundName, Number(volume.value))
  })

  body.appendChild(
    section(
      'Notifications',
      field('Enable notifications', '', toggle(n.enabled, (v) => patchNotif({ enabled: v }))),
      field('Play a sound', '', toggle(n.sound, (v) => patchNotif({ sound: v }))),
      field('Sound', '', soundRow),
      field('Volume', '', volume),
      field(
        'Flash the taskbar',
        'Blinks the taskbar button when a background pane needs you.',
        toggle(n.flashTaskbar, (v) => patchNotif({ flashTaskbar: v }))
      ),
      field(
        'Only when unattended',
        'Stay quiet while you are already looking at that pane.',
        toggle(n.onlyWhenUnattended, (v) => patchNotif({ onlyWhenUnattended: v }))
      ),
      field(
        'On terminal bell',
        'How Claude Code signals that it finished or needs input.',
        toggle(n.onBell, (v) => patchNotif({ onBell: v }))
      ),
      field(
        'When a command finishes',
        'Needs shell integration.',
        toggle(n.onCommandFinished, (v) => patchNotif({ onCommandFinished: v }))
      ),
      field(
        'Minimum command length',
        'Seconds. Shorter commands never notify.',
        number(n.minCommandSeconds, 1, 3600, (v) => patchNotif({ minCommandSeconds: v }))
      ),
      field(
        'When a running command goes quiet',
        'Catches a program waiting for input without ringing the bell.',
        toggle(n.onIdle, (v) => patchNotif({ onIdle: v }))
      ),
      field(
        'Quiet for',
        'Seconds of silence before notifying.',
        number(n.idleSeconds, 5, 600, (v) => patchNotif({ idleSeconds: v }))
      ),
      field('When a shell exits', '', toggle(n.onExit, (v) => patchNotif({ onExit: v })))
    )
  )

  body.appendChild(section('Claude Code', await claudeSection()))
  body.appendChild(section('Other agents', await agentsSection()))
  body.appendChild(section('About', await aboutSection()))

  // Built with the rest of the panel and hidden until it is needed, so the
  // filter never has to create anything on a keystroke.
  const empty = document.createElement('div')
  empty.className = `settings-empty ${FILTERED}`
  body.appendChild(empty)

  // The panel has just been rebuilt, so whatever was being searched for has to
  // be re-applied to the new rows.
  applyFilter(query)
  panel.scrollTop = scroll
}

/**
 * Version, and the two controls around checking for a newer one.
 *
 * The check itself has no source wired up yet — see `renderer/updates.ts` — and
 * this reports that in the same place it would report a result, rather than
 * hiding the controls until there is something behind them. The toggle is real
 * either way: it is what the startup check reads, so setting it now is not a
 * promise, it is the setting.
 */
async function aboutSection(): Promise<HTMLElement> {
  const wrap = document.createElement('div')
  const s = store.settings

  const status = document.createElement('span')
  status.className = 'hint'

  const check = button('Check for updates', () => {
    check.disabled = true
    status.textContent = 'Checking…'
    void checkForUpdates().then((result) => {
      check.disabled = false
      status.textContent = describeUpdate(result)
      if (result.state === 'available' && result.url) {
        const open = button('Open release', () => void backend().openExternal(result.url!))
        row.appendChild(open)
      }
    })
  })

  const row = document.createElement('div')
  row.className = 'update-row'
  row.append(check, status)

  wrap.append(
    field('Version', `${backend().name} build`, value(await appVersion())),
    field('Updates', '', row),
    field(
      'Check when the app starts',
      'Stays quiet unless there is a newer release.',
      toggle(s.checkUpdatesAtStartup, (v) => patch({ checkUpdatesAtStartup: v }))
    )
  )
  return wrap
}

/**
 * Claude Code only rings the terminal bell when `preferredNotifChannel` is set;
 * on Windows terminals it is otherwise silent, so bell-based alerts would
 * never fire. Offer to set it, but show exactly what will change first.
 */
/**
 * Hook installers for the agents that are not Claude Code.
 *
 * Deliberately plainer than the Claude section above, and the difference is
 * honest rather than cosmetic: Claude Code is the one this app has actually
 * been tested against, and it is the only one that can resume a conversation in
 * a restored pane. Everything here installs the same tool-agnostic
 * notification protocol — `iaw notify`, which learns its pane from the
 * environment and has never known which agent called it.
 *
 * An agent whose settings file does not exist is listed anyway, with the path,
 * because "install it and see" is a worse answer than saying where it would go.
 */
async function agentsSection(): Promise<HTMLElement> {
  const wrap = document.createElement('div')
  let agents: AgentConfigInfo[] = []
  try {
    agents = await backend().agents.list()
  } catch {
    // A failure here costs a settings row, not a session.
  }

  if (!agents.length) {
    const none = document.createElement('div')
    none.className = 'field-hint'
    none.textContent = 'No other agents are known to this build.'
    wrap.appendChild(none)
    return wrap
  }

  for (const agent of agents) {
    const where = agent.exists
      ? `Writes ${agent.path}. Backed up first, and removable again from here.`
      : `Not installed yet — this would create ${agent.path}.`
    const hint = agent.note ? `${where} ${agent.note}` : where

    const button = document.createElement('button')
    button.className = 'btn'
    const paint = (installed: boolean) => {
      button.textContent = installed ? 'Remove' : 'Install'
      button.classList.toggle('danger', installed)
    }
    paint(agent.hooksInstalled)

    let installed = agent.hooksInstalled
    button.addEventListener('click', async () => {
      button.disabled = true
      const res = await backend().agents.set(agent.id, !installed)
      button.disabled = false
      if (!res.ok) {
        showToast(`Could not update ${agent.label}`, res.error ?? 'Unknown error')
        return
      }
      installed = !installed
      paint(installed)
      showToast(
        installed ? `${agent.label} notifications on` : `${agent.label} notifications removed`,
        res.path
      )
    })

    wrap.appendChild(field(`${agent.label} notifications`, hint, button))
  }
  return wrap
}

async function claudeSection(): Promise<HTMLElement> {
  const wrap = document.createElement('div')
  const info = await backend().claude.readConfig()

  const ready = info.bellEnabled && info.hooksInstalled

  const callout = document.createElement('div')
  callout.className = 'callout' + (ready ? ' ok' : '')
  const textEl = document.createElement('div')
  if (ready) {
    textEl.innerHTML =
      'Claude Code will tell this app when it is <strong>waiting for you</strong> and when it ' +
      '<strong>finishes responding</strong>, naming the pane it came from.'
  } else {
    textEl.innerHTML =
      'Out of the box Claude Code is <strong>silent in a Windows terminal</strong> \u2014 it only sends ' +
      'desktop notifications on Ghostty, Kitty and iTerm2, so there is nothing for this app to hear. ' +
      'Setting it up adds two things to your settings: <code>"preferredNotifChannel": "terminal_bell"</code>, ' +
      'and hooks on <code>Notification</code> and <code>Stop</code> that run ' +
      '<code>iaw notify</code> so the alert says what happened and lands on the right pane.'
  }
  callout.appendChild(textEl)
  wrap.appendChild(callout)

  const row = document.createElement('div')
  row.className = 'field'
  const label = document.createElement('div')
  label.className = 'field-label'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = ready ? 'Notifications configured' : 'Set up Claude Code notifications'
  const hint = document.createElement('span')
  hint.className = 'hint'
  const state = `bell ${info.bellEnabled ? 'on' : 'off'} \u00b7 hooks ${
    info.hooksInstalled ? 'installed' : 'missing'
  }`
  hint.textContent = info.exists ? `${info.path} \u2014 ${state}` : `${info.path} (will be created)`
  label.append(name, hint)

  /**
   * Both directions of the same switch.
   *
   * This is the only thing the app writes outside its own data folder, so
   * removing it has to be exactly as easy as adding it — and it removes only
   * what we put there: the bell setting if it still holds our value, and our
   * own hook handlers, leaving any the user added alongside them.
   */
  const apply = async (enabled: boolean) => {
    const res = await backend().claude.setIntegration(enabled)
    if (!res.ok) {
      showToast('Could not update settings', res.error ?? 'Unknown error', { kind: 'error' })
      return
    }
    store.updateSettings({ agentIntegration: enabled ? 'granted' : 'declined' })
    showToast(
      enabled ? 'Claude Code configured' : 'Claude Code integration removed',
      enabled
        ? 'Restart any running session to pick it up.'
        : 'Your settings.json is back to how it was.'
    )
    await render()
  }

  const control = document.createElement('div')
  control.className = 'field-control'
  if (!ready) {
    control.appendChild(button('Set up', () => void apply(true), true))
  } else {
    control.appendChild(button('Remove', () => void apply(false)))
  }
  row.append(label, control)
  wrap.appendChild(row)

  const cli = document.createElement('div')
  cli.className = 'callout'
  // A callout is a flex row, so its prose has to sit in one child element. Set
  // straight on the callout, every text run and <code> becomes its own flex
  // item and the paragraph lays out as a row of one-word columns.
  const cliText = document.createElement('div')
  cliText.innerHTML =
    'Every pane also exposes an <code>iaw</code> command. A hook can run ' +
    '<code>iaw notify --title "Claude" --body "needs input"</code> to light up that exact pane, or ' +
    '<code>iaw report-agent --blocked "permission: Bash" --choices \'[{"id":"y","label":"Yes","key":"1"}]\'</code> ' +
    'to say it is waiting on you and offer the answers it accepts. ' +
    'Run <code>iaw</code> with no arguments for the full list.'
  cli.appendChild(cliText)
  wrap.appendChild(cli)

  return wrap
}
