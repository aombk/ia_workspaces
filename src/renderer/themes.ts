import type { ITheme } from '@xterm/xterm'
import {
  BUILTIN_INTERFACE_THEMES,
  BUILTIN_TERMINAL_THEMES,
  CHROME_KEYS,
  RADIUS_SCALE,
  clampOpacity,
  findInterfaceTheme,
  findTerminalTheme,
  roundnessOf,
  type InterfaceTheme,
  type TerminalTheme,
} from '../shared/themes'
import type { Settings } from '../shared/types'

/**
 * Applies a theme to the document.
 *
 * The chrome palette becomes CSS custom properties on :root so every rule in
 * styles.css follows automatically; the terminal palette is handed to xterm
 * separately by TerminalManager.
 */

const CSS_VAR: Record<string, string> = {
  bg: '--bg',
  bgRaised: '--bg-raised',
  bgHover: '--bg-hover',
  bgActive: '--bg-active',
  border: '--border',
  borderStrong: '--border-strong',
  text: '--text',
  textDim: '--text-dim',
  textFaint: '--text-faint',
  accent: '--accent',
  danger: '--danger',
  warn: '--warn',
}

/**
 * Whether this window can actually show the desktop through itself.
 *
 * Set once at startup from the host. `transparent` is fixed when the window is
 * built, so a theme asking for real transparency on a window that was built
 * opaque cannot have it until the app restarts.
 */
let realTransparency = false

export function setRealTransparency(available: boolean): void {
  realTransparency = available
}

/**
 * Transparency is off, everywhere, whatever a theme stores.
 *
 * It never landed convincingly — the window came up washed out as often as
 * clear, and only after a restart — so the controls are gone from the settings
 * panel and this is the matching half: a theme saved with `opacity` below 1,
 * from before the controls went, paints solid rather than reviving a look
 * nobody can now turn off.
 *
 * Everything else is left standing on purpose. The field, its clamping, the
 * backdrop plumbing and the real-transparency handshake below all still work;
 * flipping this constant back to `true` is what it takes to have another go.
 */
const TRANSPARENCY_ENABLED: boolean = false

/**
 * The opacity actually worth applying.
 *
 * Full opacity whenever the theme wants *real* transparency and the window
 * cannot give it. Applying it anyway is what produced the pale grey window: the
 * terminal took its alpha, composited against a window background set to fully
 * transparent black, and an opaque window renders that as light grey. The
 * result looked broken rather than unapplied, which is worse than doing
 * nothing — so until the restart, nothing is what happens.
 *
 * A *material* backdrop is unaffected: Windows composites acrylic and mica
 * behind an ordinary window, so those work without the transparent flag.
 */
function effectiveOpacity(theme: InterfaceTheme): number {
  if (!TRANSPARENCY_ENABLED) return 1
  const opacity = clampOpacity(theme.opacity ?? 1)
  if (opacity >= 1) return 1
  const wantsReal = (theme.backdrop ?? 'none') === 'none'
  return wantsReal && !realTransparency ? 1 : opacity
}

export function interfaceThemesFor(settings: Settings): InterfaceTheme[] {
  return [...BUILTIN_INTERFACE_THEMES, ...(settings.customThemes ?? [])]
}

export function terminalThemesFor(settings: Settings): TerminalTheme[] {
  return [...BUILTIN_TERMINAL_THEMES, ...(settings.customTerminalThemes ?? [])]
}

/** The interface theme: chrome, and the window properties that travel with it. */
export function activeTheme(settings: Settings): InterfaceTheme {
  return findInterfaceTheme(settings.themeId, settings.customThemes ?? [])
}

/**
 * The theme the terminal takes its palette from.
 *
 * Only `terminal` is read off it — core and ANSI. Opacity, backdrop, roundness
 * and the chrome all come from the interface theme, so a terminal palette
 * imported from Ghostty cannot drag a sidebar colour or a window flag with it.
 *
 * Falls back to the interface theme, which is what every install had before
 * the two could differ.
 */
export function activeTerminalTheme(settings: Settings): TerminalTheme {
  return findTerminalTheme(
    settings.terminalThemeId || settings.themeId,
    settings.customTerminalThemes ?? []
  )
}

export function applyChrome(theme: InterfaceTheme): void {
  const root = document.documentElement
  const opacity = effectiveOpacity(theme)

  // Chrome stays fully opaque. Making the sidebar and tab strip translucent
  // too meant they composited over the desktop *as well as* over the
  // translucent page behind them, which read as doubled transparency and made
  // the UI hard to look at. Only the terminal grid goes see-through.
  for (const key of CHROME_KEYS) {
    root.style.setProperty(CSS_VAR[key], theme.chrome[key])
  }

  root.style.setProperty('--opacity', String(opacity))
  // The page itself must stop painting, or there is nothing for the terminal's
  // alpha to reveal.
  root.classList.toggle('translucent', opacity < 1)

  // All three tiers, every time. Setting only the ones that differ would leave
  // a stale value behind when moving from `full` back to `square`.
  const radius = RADIUS_SCALE[roundnessOf(theme)]
  root.style.setProperty('--radius-sm', `${radius.sm}px`)
  root.style.setProperty('--radius', `${radius.md}px`)
  root.style.setProperty('--radius-lg', `${radius.lg}px`)
  root.style.setProperty('--radius-knob', radius.knob)
  root.style.setProperty('--radius-dot', radius.dot)
  // Its own switch, not the scale: see `workspaceDots` in shared/themes.ts.
  root.style.setProperty(
    '--radius-workspace-dot',
    theme.workspaceDots === 'square' ? '0' : '50%'
  )
}

/**
 * The palette handed to xterm.
 *
 * On a translucent theme the grid contributes *no* background of its own: the
 * colour comes from the one translucent layer painted on the terminal host
 * underneath. Giving both a layer stacked them, so the grid ended up at
 * `1 - (1 - opacity)²` — 88% for a theme set to 66% — while the gutter around
 * it stayed at 66% and looked conspicuously more see-through.
 *
 * The rgb is kept and only the alpha zeroed, so any colour xterm derives from
 * the background (selection, dimming) still comes out the right hue.
 */
export function xtermTheme(settings: Settings): ITheme {
  // Palette from one theme, alpha from the other. The split is the whole point:
  // an imported scheme says what red is, the interface theme says how much of
  // the desktop shows through it.
  const palette = activeTerminalTheme(settings).terminal
  const opacity = effectiveOpacity(activeTheme(settings))
  return {
    ...palette,
    background: opacity < 1 ? withAlpha(palette.background, 0) : palette.background,
  }
}

export function isTranslucent(settings: Settings): boolean {
  return effectiveOpacity(activeTheme(settings)) < 1
}

/**
 * The colour behind the terminal grid. Must carry the same alpha as the grid
 * itself, or the gutter stays opaque and the window only *looks* transparent
 * at its edges.
 */
export function terminalBackdrop(settings: Settings): string {
  const background = activeTerminalTheme(settings).terminal.background
  const opacity = effectiveOpacity(activeTheme(settings))
  return opacity < 1 ? withAlpha(background, opacity) : background
}

/** `#rrggbb` -> `rgba(r, g, b, a)`. */
function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

/** Retained alias: `xtermTheme` now takes settings and resolves both themes. */
export function themeFor(settings: Settings): ITheme {
  return xtermTheme(settings)
}

// ------------------------------------------------- Windows Terminal import

interface WtScheme {
  name?: string
  background?: string
  foreground?: string
  cursorColor?: string
  selectionBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  purple?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightPurple?: string
  brightCyan?: string
  brightWhite?: string
}

/**
 * Converts a Windows Terminal colour scheme into one of our themes.
 *
 * WT names two slots differently (`purple` for magenta, `cursorColor` for
 * cursor) and has no notion of app chrome, so the chrome palette is derived
 * from the scheme's own background and foreground rather than invented.
 */
export function fromWindowsTerminalScheme(scheme: WtScheme, id: string): TerminalTheme | null {
  if (!scheme?.background || !scheme?.foreground) return null

  const bg = scheme.background
  const fg = scheme.foreground

  return {
    id,
    name: scheme.name ?? 'Imported scheme',
    builtin: false,
    terminal: {
      background: bg,
      foreground: fg,
      cursor: scheme.cursorColor ?? fg,
      cursorAccent: bg,
      selectionBackground: scheme.selectionBackground ?? mix(bg, fg, 0.25),
      black: scheme.black ?? '#000000',
      red: scheme.red ?? '#c50f1f',
      green: scheme.green ?? '#13a10e',
      yellow: scheme.yellow ?? '#c19c00',
      blue: scheme.blue ?? '#0037da',
      magenta: scheme.purple ?? '#881798',
      cyan: scheme.cyan ?? '#3a96dd',
      white: scheme.white ?? '#cccccc',
      brightBlack: scheme.brightBlack ?? '#767676',
      brightRed: scheme.brightRed ?? '#e74856',
      brightGreen: scheme.brightGreen ?? '#16c60c',
      brightYellow: scheme.brightYellow ?? '#f9f1a5',
      brightBlue: scheme.brightBlue ?? '#3b78ff',
      brightMagenta: scheme.brightPurple ?? '#b4009e',
      brightCyan: scheme.brightCyan ?? '#61d6d6',
      brightWhite: scheme.brightWhite ?? '#f2f2f2',
    },
  }
}

// -------------------------------------------------------------- Ghostty import

/**
 * A Ghostty theme file.
 *
 * The format is `key = value` lines, with the sixteen ANSI slots given as
 * repeated `palette = N=#rrggbb` entries. It is worth supporting for one
 * reason: there are hundreds of these files in the wild, they are all one
 * shape, and a terminal that can read them inherits the whole collection
 * instead of asking people to rebuild a palette by hand.
 *
 * Colours may or may not carry a leading `#`, so both are accepted.
 */
export function fromGhosttyTheme(text: string, id: string, name: string): TerminalTheme | null {
  const values = new Map<string, string>()
  const palette = new Map<number, string>()

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim().toLowerCase()
    const value = trimmed.slice(eq + 1).trim()

    if (key === 'palette') {
      const m = /^(\d+)\s*=\s*(.+)$/.exec(value)
      if (m) {
        const colour = hex(m[2])
        if (colour) palette.set(Number(m[1]), colour)
      }
      continue
    }
    const colour = hex(value)
    if (colour) values.set(key, colour)
  }

  const background = values.get('background')
  const foreground = values.get('foreground')
  if (!background || !foreground) return null

  // Routed through the Windows Terminal converter so both importers derive the
  // app chrome the same way, and there is only one place that decision lives.
  return fromWindowsTerminalScheme(
    {
      name,
      background,
      foreground,
      cursorColor: values.get('cursor-color'),
      selectionBackground: values.get('selection-background'),
      black: palette.get(0),
      red: palette.get(1),
      green: palette.get(2),
      yellow: palette.get(3),
      blue: palette.get(4),
      purple: palette.get(5),
      cyan: palette.get(6),
      white: palette.get(7),
      brightBlack: palette.get(8),
      brightRed: palette.get(9),
      brightGreen: palette.get(10),
      brightYellow: palette.get(11),
      brightBlue: palette.get(12),
      brightPurple: palette.get(13),
      brightCyan: palette.get(14),
      brightWhite: palette.get(15),
    },
    id
  )
}

/** Normalises `#rrggbb`, `rrggbb` and `#rgb` to `#rrggbb`. */
function hex(raw: string): string | undefined {
  const value = raw.trim().replace(/^#/, '')
  if (/^[0-9a-f]{6}$/i.test(value)) return `#${value.toLowerCase()}`
  if (/^[0-9a-f]{3}$/i.test(value)) {
    return `#${value
      .toLowerCase()
      .split('')
      .map((c) => c + c)
      .join('')}`
  }
  return undefined
}

/** Linear blend between two hex colours; `t` is how far toward `b`. */
function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  if (!pa || !pb) return a
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t))
  return '#' + c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
}

function parseHex(hex: string): number[] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
