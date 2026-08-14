/**
 * Makes a saved terminal stream safe to hand back to a *different* program.
 *
 * The restore path is byte-exact on purpose — a pane redraws its last screen by
 * replaying the bytes that drew it the first time, and stripping escapes would
 * leave the colours and the layout behind. But byte-exact has a sting in it that
 * only shows up on the second run: the bytes being replayed were written by a
 * program that is no longer there, and some of them are not drawing at all.
 * They are *conversation*.
 *
 * Two families of them, and both were reported as one bug — "junk appears in the
 * pane when I move the mouse after a restore":
 *
 * - **Mode sets.** A full-screen program turns mouse reporting on (`?1000h`,
 *   `?1002h`, `?1003h`), asks for SGR-encoded reports (`?1006h`) and for focus
 *   events (`?1004h`). Replaying those turns them on again in a terminal whose
 *   pty is now a bare shell. The shell never asked for mouse reports and has no
 *   idea what to do with one, so every twitch of the mouse arrives at the prompt
 *   as literal text: `35;24;9M35;25;10M…`. Button code 35 is motion with nothing
 *   held, which is mode 1003 exactly.
 *
 * - **Queries.** The same program asked the terminal what it was — device
 *   attributes (`ESC [ c`), cursor position (`ESC[6n`), the kitty keyboard flags
 *   (`ESC[?u`), the background colour (`OSC 11 ; ?`). A query in a replayed
 *   stream is still a query: xterm answers it, and the answer goes *to the pty*,
 *   which is the shell. That is where `zsh: command not found: 1` comes from —
 *   the terminal replied `ESC[?1;2c` at the prompt and zsh read `1;2c` as
 *   something to run. Worse, the reply lands interleaved with whatever the
 *   restore is typing, which is how `claude --resume …` became
 *   `1;2cclaude --resume …`.
 *
 * So the replayed stream keeps everything that paints and loses everything that
 * talks. What remains cannot solicit a reply and cannot change how the keyboard
 * or the mouse behaves, which leaves the restored screen looking the same and
 * the pane's input in the state a fresh shell expects.
 *
 * This runs on both sides of `renderReplay`, and that is not belt and braces —
 * it is required at each end for a different reason. *Before*, so the offscreen
 * terminal never enters the alternate screen or turns mouse reporting on while
 * it is reconstructing the screen. *After*, because `SerializeAddon` faithfully
 * re-emits the mode state it observed: given a stream containing `?1003h` it
 * puts `?1003h` back in its output, which was measured rather than assumed.
 */

/**
 * Private modes that change what the *keyboard and mouse* send.
 *
 * Deliberately not every private mode — line wrap (`?7`) and cursor visibility
 * (`?25`) are about what the screen looks like, which is the thing the replay
 * exists to reproduce. Only the ones that redirect input are dropped, plus the
 * alternate screen, which is neither: a replay that ends inside it leaves the
 * pane showing a buffer the new shell is not writing to.
 */
const INPUT_MODES = new Set([
  1, // DECCKM — arrows send SS3 instead of CSI
  9, // X10 mouse
  47, // alternate screen, the original spelling
  1000, // mouse: button press and release
  1001, // mouse: highlight tracking
  1002, // mouse: drag
  1003, // mouse: any motion — the one that fires on every pixel
  1004, // focus in/out reports
  1005, // UTF-8 mouse encoding
  1006, // SGR mouse encoding
  1007, // alternate scroll: the wheel sends arrow keys
  1015, // urxvt mouse encoding
  1016, // SGR pixel mouse encoding
  1047, // alternate screen
  1048, // save cursor for the alternate screen
  1049, // alternate screen plus cursor, the usual spelling
  2004, // bracketed paste
])

/** OSC numbers that never carry a user-supplied string, so a `?` in one is a query. */
const OSC_QUERYABLE = new Set([4, 5, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 52, 104, 105, 110, 111, 112])

/**
 * Everything that makes a terminal write back down the pty.
 *
 * Grouped by final byte rather than by name, because that is what distinguishes
 * them: `c` is device attributes in all three of its forms, `n` is a status
 * report, a `u` behind a private prefix is the kitty keyboard protocol (a query,
 * or a push of flags that outlives the program that pushed them), `>…q` is
 * XTVERSION, `$p` is DECRQM, and `ESC Z` is the ancient spelling of DA1 which is
 * still answered. Plain `CSI … u` with no prefix is a cursor restore and is left
 * alone; so is `CSI … n` with no parameters, which nothing sends.
 */
const QUERIES = /\x1b(?:\[[?>=]?[\d;]*[cn]|\[[?>=<][\d;]*u|\[>[\d;]*q|\[\?[\d;]*\$p|Z|=)/g

const PRIVATE_MODES = /\x1b\[\?([\d;]*)([hl])/g

const OSC = /\x1b\](\d+)((?:;[^\x07\x1b]*)?)(\x07|\x1b\\)/g

/**
 * Puts the pane back into the input state a newly started shell assumes.
 *
 * Every mode the filter drops, turned off explicitly, plus the keypad and the
 * cursor. The cursor is here rather than in the filter because hiding it is a
 * drawing instruction and belongs in the replay — but a program killed while it
 * was hidden (`?25l`) leaves a pane with no cursor at its prompt, and that is
 * the same class of bug wearing different clothes.
 *
 * Its real job is the case the filter cannot reach: a ring buffer that wrapped
 * mid-sequence, leaving half a mode set that no regex here recognises and
 * xterm's parser may yet complete against the bytes after it.
 */
export const REPLAY_RESET =
  '\x1b[?1l\x1b>' +
  '\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l' +
  '\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?1016l' +
  '\x1b[?1049l\x1b[?2004l\x1b[<u\x1b[?25h\x1b[?7h\x1b[0m'

/**
 * A saved stream with the conversation taken out of it.
 *
 * Exported without the reset attached so the tests can assert on the filtering
 * alone — with the epilogue on the end, every "is it gone" check would match the
 * epilogue instead and pass no matter what the filter did.
 */
export function stripInteractive(raw: string): string {
  return raw
    .replace(QUERIES, '')
    .replace(PRIVATE_MODES, (_whole, list: string, final: string) => {
      // `CSI ? h` with no parameters at all is not a mode set anybody means, and
      // passing it through as `CSI ? 0 h` would be inventing one.
      if (!list) return ''
      const kept = list.split(';').filter((part) => part !== '' && !INPUT_MODES.has(Number(part)))
      return kept.length ? `\x1b[?${kept.join(';')}${final}` : ''
    })
    .replace(OSC, (whole, code: string, payload: string) => {
      if (!OSC_QUERYABLE.has(Number(code))) return whole
      // A query is an OSC whose last field is a bare `?`. `OSC 11 ; ?` asks for
      // the background; `OSC 11 ; #1e1e2e` sets it and is a drawing instruction.
      return /;\?$/.test(payload) ? '' : whole
    })
}

/** The whole treatment for a stream that will not be re-rendered: filter, then reset. */
export function sanitizeReplay(raw: string): string {
  return stripInteractive(raw) + REPLAY_RESET
}
