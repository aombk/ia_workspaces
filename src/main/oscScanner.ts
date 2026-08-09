/**
 * Incremental scanner for the escape sequences we care about.
 *
 * This has to be a real state machine rather than a regex over each chunk for
 * two reasons: a sequence can be split across PTY reads, and the BEL that
 * terminates an OSC string must not be mistaken for a bare bell (which is our
 * "Claude Code wants attention" signal).
 *
 * The scanner only *observes* — the byte stream is forwarded to xterm intact.
 */
import { isWindows, platformKind } from '../shared/platform'

const PLATFORM = platformKind(process.platform)

export interface OscEvents {
  /** Bare BEL outside any escape sequence. */
  onBell(): void
  /** OSC 0/1/2 — window/icon title. */
  onTitle(title: string): void
  /** OSC 9;9 or OSC 7 — reported working directory. */
  onCwd(cwd: string): void
  /** OSC 9 (ConEmu) or OSC 777 — an explicit desktop notification request. */
  onNotify(title: string, body: string): void
  /** OSC 133;A — a shell prompt is being drawn. */
  onPromptStart(): void
  /** OSC 133;C — a line was submitted, so a command is now running. */
  onCommandStart(): void
  /** OSC 133;D — the previous command finished with this exit code. */
  onCommandEnd(exitCode: number): void
  /** OSC 133;E — the text of the line that was submitted. */
  onCommandLine(command: string): void
}

/**
 * Longest command line worth keeping.
 *
 * It is persisted and put back on a prompt, and a here-string pasted into a
 * shell can run to megabytes — well past anything a person would want handed
 * back to them.
 */
const MAX_COMMAND_LINE = 512

const ESC = 0x1b
const BEL = 0x07
const MAX_OSC = 8 * 1024

type State = 'text' | 'esc' | 'osc' | 'osc-esc'

export class OscScanner {
  private state: State = 'text'
  private osc = ''

  constructor(private readonly events: OscEvents) {}

  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i)

      switch (this.state) {
        case 'text':
          if (code === ESC) this.state = 'esc'
          else if (code === BEL) this.events.onBell()
          break

        case 'esc':
          if (code === 0x5d /* ] */) {
            this.state = 'osc'
            this.osc = ''
          } else if (code === ESC) {
            // stay in 'esc'
          } else {
            // CSI and friends — we don't inspect them.
            this.state = 'text'
          }
          break

        case 'osc':
          if (code === BEL) {
            this.finishOsc()
          } else if (code === ESC) {
            this.state = 'osc-esc'
          } else {
            this.osc += chunk[i]
            // Runaway sequence (binary junk); bail out rather than grow forever.
            if (this.osc.length > MAX_OSC) {
              this.osc = ''
              this.state = 'text'
            }
          }
          break

        case 'osc-esc':
          // ESC \ is the ST terminator; anything else was a literal ESC.
          if (code === 0x5c /* \ */) {
            this.finishOsc()
          } else {
            this.osc += '\x1b' + chunk[i]
            this.state = 'osc'
          }
          break
      }
    }
  }

  private finishOsc(): void {
    const payload = this.osc
    this.osc = ''
    this.state = 'text'
    try {
      this.dispatch(payload)
    } catch {
      /* a malformed sequence must never take down the PTY pump */
    }
  }

  private dispatch(payload: string): void {
    const sep = payload.indexOf(';')
    const id = sep === -1 ? payload : payload.slice(0, sep)
    const rest = sep === -1 ? '' : payload.slice(sep + 1)

    switch (id) {
      case '0':
      case '1':
      case '2':
        if (rest) this.events.onTitle(rest)
        break

      case '7': {
        // OSC 7 ; file://host/C:/path on Windows, file://host/Users/you
        // elsewhere. The regex eats the slash between host and path, which is
        // part of the URL on Windows and part of the *path* on POSIX — hence
        // putting it back on one branch and not the other. Converting
        // separators unconditionally, as this used to, turned /Users/you into
        // \Users\you and every reported directory was wrong.
        const m = /^file:\/\/[^/]*\/?(.*)$/.exec(rest)
        if (m) {
          const decoded = isWindows(PLATFORM)
            ? safeDecode(m[1]).replace(/\//g, '\\')
            : '/' + safeDecode(m[1])
          if (decoded) this.events.onCwd(stripTrailingSlash(decoded))
        }
        break
      }

      case '9': {
        // ConEmu-style OSC 9 has numeric subcommands; 9 is "set cwd".
        // Anything else we treat as notification text.
        const sub = rest.indexOf(';')
        const subId = sub === -1 ? rest : rest.slice(0, sub)
        if (subId === '9') {
          const raw = sub === -1 ? '' : rest.slice(sub + 1)
          const cwd = stripQuotes(raw)
          if (cwd) this.events.onCwd(stripTrailingSlash(cwd))
        } else if (subId === '4') {
          // progress reports — ignored
        } else if (rest) {
          this.events.onNotify('Terminal', rest)
        }
        break
      }

      case '99': {
        // Kitty's protocol: OSC 99 ; <key=value:...> ; <payload>
        // Only the final chunk of a multi-part message carries d=0/omitted; we
        // take the payload of any chunk that has one, which is enough for the
        // single-chunk messages agents actually send.
        const sep = rest.indexOf(';')
        const body = sep === -1 ? rest : rest.slice(sep + 1)
        if (body) this.events.onNotify('Terminal', body)
        break
      }

      case '777': {
        // OSC 777 ; notify ; title ; body
        const parts = rest.split(';')
        if (parts[0] === 'notify') {
          this.events.onNotify(parts[1] || 'Terminal', parts.slice(2).join(';'))
        }
        break
      }

      case '133': {
        const parts = rest.split(';')
        if (parts[0] === 'A') this.events.onPromptStart()
        else if (parts[0] === 'C') this.events.onCommandStart()
        else if (parts[0] === 'D') {
          const code = Number.parseInt(parts[1] ?? '0', 10)
          this.events.onCommandEnd(Number.isFinite(code) ? code : 0)
        } else if (parts[0] === 'E') {
          // The command itself may contain semicolons, so everything after the
          // first separator is the payload rather than parts[1].
          const command = sanitizeCommandLine(rest.slice(2))
          if (command) this.events.onCommandLine(command)
        }
        break
      }
    }
  }
}

/**
 * Trims a reported command line to something safe to type back.
 *
 * Control characters are dropped rather than escaped: this string is written
 * into a live PTY, and a stray CR in it would submit the line on its own.
 */
function sanitizeCommandLine(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
  return clean.length > MAX_COMMAND_LINE ? '' : clean
}

/**
 * Unwraps the quotes around a reported path. Tolerates a stray backslash
 * before either quote, which is what a shell emits when its own escaping of
 * the quote character leaks through.
 */
function stripQuotes(s: string): string {
  return s.trim().replace(/^\\?"/, '').replace(/\\?"$/, '')
}

/**
 * Drops a trailing separator, without eating a root.
 *
 * The threshold is a root's length on the platform: `C:\` is three characters
 * and `/` is one, and stripping either would turn a real directory into a
 * relative path or an empty string.
 */
function stripTrailingSlash(s: string): string {
  const rootLength = isWindows(PLATFORM) ? 3 : 1
  return s.length > rootLength ? s.replace(/[\\/]+$/, '') : s
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
