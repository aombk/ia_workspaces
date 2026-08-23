/**
 * Walking your own command history with the Up arrow, per pane.
 *
 * The Up arrow at a prompt has always belonged to the shell: it sends `\x1b[A`,
 * and bash or PSReadLine answers out of a history file this app never sees.
 * That history is per shell-process and per machine, it does not know which
 * pane or which project a line came from, and it is gone when the shell exits.
 * This app has been recording every submitted line — with its pane and its
 * folder — since shell integration existed, and had no way to reach it except a
 * search box.
 *
 * So the arrow is taken over, and the rules for doing that safely are the whole
 * of this file:
 *
 * - **Only at a real prompt.** A full-screen program — vim, less, htop, Claude
 *   Code — switches the terminal to its alternate screen buffer, and in there
 *   Up means whatever that program says it means. `xterm` knows which buffer is
 *   showing, so that is the test, and it needs no cooperation from the shell.
 * - **Only where there is something to show.** An empty history passes the key
 *   through untouched, so a pane with no shell integration behaves exactly as it
 *   did before and the shell's own recall still works.
 * - **Replace the line, never append to it.** End-of-line then kill-the-line
 *   then type: `Ctrl+E`, `Ctrl+U`. Those two are the same in readline and in
 *   PSReadLine, which is what makes one implementation work in bash, zsh and
 *   PowerShell.
 * - **Never submit.** The line lands on the prompt for you to read, edit or
 *   run. Same rule the history box follows, for the same reason: what you last
 *   ran might be a deploy.
 *
 * The scope — every pane, or only this one — is per pane and shown in the
 * pane's own corner, because it is a property of how you are working in *that*
 * terminal rather than a preference about the app.
 */
import { backend } from '../../backend'
import { commandsElsewhere, setCommandSource, watchRelay } from './relayMonitor'
import type { HistoryEntry, ShellKind } from '../../shared/types'

/** Which slice of the history one pane's Up arrow walks. */
export type HistoryScope = 'terminal' | 'machine' | 'everywhere'

/**
 * The three, widening. Clicking the control moves to the next and wraps.
 *
 * Each ring contains the one before it, which is the whole reason for these
 * names over "this/all/cross": nobody has to wonder whether the widest one also
 * includes what is local.
 */
export const SCOPES: readonly HistoryScope[] = ['terminal', 'machine', 'everywhere']

/**
 * How often the cached history is re-read while a terminal has focus.
 *
 * The Up arrow must answer in the key handler, which is synchronous, so the
 * list has to be in hand before it is pressed. Twenty seconds is short enough
 * that a command run a moment ago is there by the time anyone reaches for it,
 * and long enough to be nothing next to what the app already does per second.
 */
const REFRESH_MS = 20_000

/**
 * How long the clear gets to itself before the text follows.
 *
 * Long enough that a terminal reading a lone Escape cannot still be waiting to
 * see whether a sequence follows it, and short enough to be invisible: an arrow
 * key that took a tenth of a second to answer would feel broken. Terminals
 * settle this ambiguity in single-digit milliseconds.
 */
const ESCAPE_GAP_MS = 12

/** A recall's text write, held so the next recall can cancel it. */
const writes = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Panes whose shell walks the history itself, and therefore needs the file.
 *
 * Registered by the pane as it is built rather than derived here, because
 * whether a shell binds the arrows depends on its kind *and* on the integration
 * setting, and the pane already resolves both to draw its corner control.
 */
const filePanes = new Set<string>()

/** Anything drawing the history, redrawn when a fresh list lands. */
const readers = new Set<() => void>()

const scopes = new Map<string, HistoryScope>()
/** Where each pane is in its walk. -1 is "not walking", 0 is the newest. */
const cursors = new Map<string, number>()
let entries: HistoryEntry[] = []
let fetched = 0
let inFlight = false

/** The scope this pane's Up arrow uses. Every pane starts on this machine. */
export function paneScope(paneId: string): HistoryScope {
  return scopes.get(paneId) ?? 'machine'
}

/** The next ring out, wrapping. What the corner control does when clicked. */
export function nextScope(scope: HistoryScope): HistoryScope {
  return SCOPES[(SCOPES.indexOf(scope) + 1) % SCOPES.length]
}

export function setPaneScope(paneId: string, scope: HistoryScope): void {
  scopes.set(paneId, scope)
  // A walk in progress was through a different list, so its position means
  // nothing in the new one. Starting again is the only honest thing to do.
  cursors.delete(paneId)
  // The shell reads a file, not this map, so flipping the switch has to reach
  // the disk before the next arrow press. It is a few kilobytes and the shell
  // re-reads at the start of each walk, so this is the whole of the sync.
  syncFile(paneId)
}

/**
 * Says this pane's shell will read the file rather than being typed into.
 *
 * Writes it immediately: the pane may be about to be used, and an arrow pressed
 * before the first sync would find no file and fall back to the shell's own
 * history — correct, but not what the corner control claims.
 */
export function useHistoryFile(paneId: string): void {
  if (filePanes.has(paneId)) return
  filePanes.add(paneId)
  syncFile(paneId)
}

/** Whether this pane's shell owns its own arrows. */
export function usesHistoryFile(paneId: string): boolean {
  return filePanes.has(paneId)
}

function syncFile(paneId: string): void {
  if (!filePanes.has(paneId)) return
  void backend()
    .writePaneHistory(
      paneId,
      listFor(paneId).map((entry) => entry.command)
    )
    .catch(() => {
      // An unwritable data folder. The shell keeps whatever it last read, which
      // is a slightly stale list rather than a broken arrow key.
    })
}

export function forgetPane(paneId: string): void {
  scopes.delete(paneId)
  cursors.delete(paneId)
  filePanes.delete(paneId)
  paneCwd.delete(paneId)
  const pending = writes.get(paneId)
  if (pending) clearTimeout(pending)
  writes.delete(paneId)
}

/**
 * Re-reads the history if the copy in hand is old enough to matter.
 *
 * Called on focus and on a timer rather than after every command, because
 * nothing in the renderer is told when a line is submitted — and a list that is
 * twenty seconds stale costs one missing entry, while an IPC per keystroke
 * would cost something on every one.
 */
export function refreshPaneHistory(force = false): void {
  if (inFlight) return
  if (!force && Date.now() - fetched < REFRESH_MS) return
  inFlight = true
  void backend()
    .commandHistory()
    .then((list) => {
      entries = list
      fetched = Date.now()
      // Every pane reading a file gets the new list. Cheap, and the alternative
      // is a pane whose arrows recall everything except the command you just
      // ran, which is the one you most want back.
      for (const paneId of filePanes) syncFile(paneId)
      for (const fn of readers) fn()
    })
    .catch(() => {
      // Keep whatever is in hand. A failed read costs recall of the newest
      // command, not the whole feature.
    })
    .finally(() => {
      inFlight = false
    })
}

/** Everything recorded, newest first, whatever pane it was run in. */
export function allHistory(): readonly HistoryEntry[] {
  return entries
}

/** Called whenever a fresh list lands, for anything drawing from it. */
export function watchHistory(fn: () => void): () => void {
  readers.add(fn)
  return () => readers.delete(fn)
}

/**
 * What this pane's Up arrow walks, newest first.
 *
 * The widest ring appends rather than interleaves. Another machine's commands
 * have no timestamp this machine can trust — they were written at a time it
 * cannot compare against its own clock, and arrived whenever a sync client felt
 * like it — so sorting them together would produce an order that is confidently
 * wrong. Local first, in real order; then elsewhere, labelled.
 */
function listFor(paneId: string): HistoryEntry[] {
  const scope = paneScope(paneId)
  if (scope === 'terminal') return entries.filter((entry) => entry.paneId === paneId)
  if (scope === 'machine') return entries

  const cwd = paneCwd.get(paneId)
  const mine = entries
  if (!cwd) return mine

  const seen = new Set(mine.map((entry) => entry.command))
  const out = mine.slice()
  for (const machine of commandsElsewhere(cwd)) {
    for (const command of machine.commands) {
      // A command this machine already knows is not news, and a duplicated row
      // in a recall list is a row you press Up through twice.
      if (seen.has(command)) continue
      seen.add(command)
      out.push({ command, cwd, at: 0, elsewhere: machine.label })
    }
  }
  return out
}

/**
 * Which project folder each pane belongs to, for the widest ring.
 *
 * Held here rather than looked up, because this runs inside a synchronous key
 * handler and walking the workspace tree per keystroke to answer "which project
 * is this" is work that has an obvious cache.
 */
const paneCwd = new Map<string, string>()

export function setPaneCwd(paneId: string, cwd: string): void {
  if (cwd) paneCwd.set(paneId, cwd)
}

/**
 * The line to put on the prompt, or null to let the key through.
 *
 * Null is not failure and happens constantly: the end of the list, an empty
 * history, a pane whose scope has nothing in it. In every one of those cases
 * the shell should get the arrow it would have got, so its own recall carries
 * on working underneath this.
 */
export function walkHistory(paneId: string, direction: 1 | -1): string | null {
  const list = listFor(paneId)
  if (!list.length) return null

  const at = cursors.get(paneId) ?? -1
  const next = at + direction

  if (next < 0) {
    // Back past the newest entry: the walk is over and the prompt goes empty,
    // which is where it was before the first Up.
    cursors.delete(paneId)
    return ''
  }
  if (next >= list.length) {
    // The oldest entry, and Up again. Stay on it rather than returning null:
    // null hands the key to the shell, so walking off the end of our list would
    // silently start walking the *shell's* history from the bottom of ours —
    // which is exactly what "the switch is not being respected" looks like.
    return list[at].command
  }

  cursors.set(paneId, next)
  return list[next].command
}

/**
 * Ends a walk, so the next Up starts from the newest entry again.
 *
 * Called on any key that is not the two arrows. Without it, typing a command,
 * running it and pressing Up would resume halfway down the list from wherever
 * the last walk stopped — which is not where anybody expects to be.
 */
export function endWalk(paneId: string): void {
  cursors.delete(paneId)
}

/** True while this pane is part-way through a walk. */
export function walking(paneId: string): boolean {
  return cursors.has(paneId)
}

/**
 * Puts `line` on the prompt, whatever is there now.
 *
 * Two writes, deliberately, with a gap between them — and the gap is the whole
 * point rather than a workaround. Both earlier attempts failed here:
 *
 * 1. `Ctrl+E` then `Ctrl+U` — right for readline and ZLE, but PSReadLine
 *    defaults to its `Windows` edit mode where neither is bound, so PowerShell
 *    printed them as literal `^E^U` and every recall appended.
 * 2. `Escape` — correct for PSReadLine (`RevertLine`) and for cmd, but sent in
 *    the same write as the text it is followed *by* the text, and a terminal
 *    cannot tell a lone Escape from the start of an escape sequence except by
 *    timing. So the shell swallowed it along with the first characters of the
 *    command. `ESC c` is worse than swallowed: it is RIS, a full terminal
 *    reset, and every recalled `claude …` was sending one.
 *
 * So: the clear goes on its own, and the text follows a few milliseconds later,
 * by which point the escape can only have meant a key. The wait is cancelled if
 * another recall arrives first, so holding the arrow down cannot interleave one
 * recall's text with the next one's clear.
 */
export function putOnPrompt(paneId: string, line: string, shell: ShellKind): void {
  const pending = writes.get(paneId)
  if (pending) clearTimeout(pending)

  // PowerShell and cmd clear the line on Escape, whatever the edit mode.
  // Everything POSIX takes end-of-line then kill-line; Escape is emphatically
  // wrong there, where it opens a meta sequence. `wsl` and `ssh` are POSIX —
  // the shell on the far side reads this, not the program that launched it.
  const windowsish = shell === 'powershell' || shell === 'pwsh' || shell === 'cmd'
  const clear = windowsish ? '\x1b' : '\x05\x15'
  void backend().pty.write(paneId, clear)

  writes.set(
    paneId,
    setTimeout(() => {
      writes.delete(paneId)
      if (line) void backend().pty.write(paneId, line)
    }, ESCAPE_GAP_MS)
  )
}

/**
 * The commands run in one project, most used first, ready to be published.
 *
 * Capped, because this is the only thing Relay writes that grows with use, and
 * a list of two hundred is a list nobody walks to the end of. Ranked by how
 * often each has been run rather than by recency: what another machine can
 * usefully tell you is "this is how the project is built here", not "here is
 * what I typed at four o'clock".
 *
 * Registered with `relayMonitor` rather than imported by it, because that file
 * is imported here for the other direction and a cycle between the two would be
 * a cycle nobody could see the shape of.
 */
function commandsIn(cwd: string): string[] {
  const root = norm(cwd)
  if (!root) return []
  return entries
    .filter((entry) => {
      const at = norm(entry.cwd)
      return at === root || at.startsWith(root + '/')
    })
    .slice()
    .sort((a, b) => (b.runs ?? 1) - (a.runs ?? 1) || b.at - a.at)
    .slice(0, MAX_SHARED_COMMANDS)
    .map((entry) => entry.command)
}

/** How many of a project's commands are published to the other machines. */
const MAX_SHARED_COMMANDS = 80

/** Path comparison as the filesystem means it, not as JavaScript does. */
function norm(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

setCommandSource(commandsIn)

// A relay sweep can bring commands from another machine, which changes what the
// widest ring holds — and the shells that read a file would otherwise not see
// them until the next local refresh happened to fire.
watchRelay(() => {
  for (const paneId of filePanes) if (paneScope(paneId) === 'everywhere') syncFile(paneId)
  for (const fn of readers) fn()
})
