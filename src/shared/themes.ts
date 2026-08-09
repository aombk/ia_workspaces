/**
 * Theme definitions shared by the renderer and the theme editor.
 *
 * A theme covers two surfaces: the app chrome (sidebar, tab strip, panels) and
 * the terminal grid. Splitting them lets a terminal palette stay faithful to
 * ANSI conventions while the surrounding UI follows its own, calmer palette.
 */

export interface ChromePalette {
  /** Window background and the terminal gutter. */
  bg: string
  /** Sidebar, tab strip, status bar, panels. */
  bgRaised: string
  bgHover: string
  bgActive: string
  border: string
  borderStrong: string
  text: string
  textDim: string
  textFaint: string
  /** Selection, focus rings, active markers. */
  accent: string
  danger: string
  warn: string
}

export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/**
 * What Windows composites behind a translucent window.
 *
 * Not a blur radius: no Windows API takes one. The desktop compositor offers a
 * fixed set of backdrop *materials*, each with its own baked-in blur, and that
 * set is the whole of what any app can ask for — `backdrop-filter` in CSS
 * cannot reach the desktop behind a transparent window, only content inside the
 * page. So this is a choice between materials, with `none` as the zero-blur end.
 *
 *   none     the desktop, crisp, straight through the alpha
 *   blur     the legacy blur-behind; lighter than acrylic
 *   acrylic  blur plus a noise and tint layer (Windows 10/11)
 *   mica     a heavily blurred wallpaper tint that ignores windows behind it
 */
export type BackdropMaterial = 'none' | 'blur' | 'acrylic' | 'mica'

export const BACKDROP_MATERIALS: BackdropMaterial[] = ['none', 'blur', 'acrylic', 'mica']

/**
 * How round the app's corners are.
 *
 *   full     the design's own radii — panels 6px, dialogs 10px
 *   subtle   2px everywhere: enough to stop a corner looking chipped
 *   square   0, and the window's own corners with it
 *
 * Three steps rather than a slider. The values are a designed set — a badge, a
 * panel and a dialog do not want the same radius, and one number for all three
 * either rounds the small things too much or leaves the big ones sharp.
 */
export type Roundness = 'full' | 'subtle' | 'square'

export const ROUNDNESS_LEVELS: Roundness[] = ['full', 'subtle', 'square']

/**
 * The radius scale each level resolves to, in pixels.
 *
 * `sm` is badges and inline chips, `md` is panels, rows and inputs, `lg` is the
 * things that float — dialogs, menus, toasts. Genuine circles (a status dot, an
 * avatar) are `50%` in the stylesheet and are deliberately not on this scale:
 * squaring a dot does not make it less round, it makes it a different shape.
 */
/**
 * `knob` and `dot` are the round things, and they are not the same thing.
 *
 * `knob` is the switch's slider — round by styling, inside a track that follows
 * the scale, so it tracks the scale too or it sits in a square trough looking
 * like a bug. `dot` is everything that is a circle by *meaning*: a workspace's
 * colour, an attention marker, the tick beside the selected mode. Those stay
 * circles at `subtle`, because softening large corners was never a reason to
 * reshape a status light — and go square at `square`, where the whole point is
 * that nothing in the window is round.
 */
export const RADIUS_SCALE: Record<
  Roundness,
  { sm: number; md: number; lg: number; knob: string; dot: string }
> = {
  full: { sm: 4, md: 6, lg: 10, knob: '50%', dot: '50%' },
  subtle: { sm: 2, md: 2, lg: 3, knob: '2px', dot: '50%' },
  square: { sm: 0, md: 0, lg: 0, knob: '0', dot: '0' },
}

/**
 * The app's own theme: everything outside the terminal grid.
 *
 * Shares nothing with `TerminalTheme` — not a field, not a list, not an editor.
 * They describe unrelated things. This one is the window: what the sidebar is,
 * how round a panel is, whether the desktop shows through. Nobody publishes one
 * of these, and no program can address a colour in it.
 */
export interface InterfaceTheme {
  id: string
  name: string
  /** Built-in themes can be duplicated but not edited or deleted. */
  builtin: boolean
  /**
   * Window opacity, 0.3–1. Below 1 the terminal grid becomes translucent; the
   * host runtime is asked for a translucent window so what shows through is the
   * desktop rather than black.
   */
  opacity: number
  /** Ignored at full opacity, where there is nothing to see behind. */
  backdrop?: BackdropMaterial
  /**
   * Corner rounding. Absent means `full`, so every theme saved before this
   * existed keeps the look it was designed with.
   */
  roundness?: Roundness
  /**
   * The shape of a workspace's colour marker, on its own switch.
   *
   * Every other round thing follows `roundness`. This one does not, because it
   * is the one round thing worth keeping round: it is a colour swatch, read as
   * a colour and not as a corner, and a square window full of square panels can
   * still want a dot there. Absent means `circle`.
   */
  workspaceDots?: 'circle' | 'square'
  chrome: ChromePalette
}

/**
 * The terminal's palette, and nothing else.
 *
 * This is the portable half — the shape every published colour scheme takes.
 * A Ghostty or Windows Terminal file *is* one of these, which is why importing
 * one no longer has to invent a sidebar colour to go with it.
 */
export interface TerminalTheme {
  id: string
  name: string
  builtin: boolean
  terminal: TerminalPalette
}

export const MIN_OPACITY = 0.3

/** A theme's roundness, defaulting for themes saved before it existed. */
export function roundnessOf(theme: InterfaceTheme | undefined): Roundness {
  const value = theme?.roundness
  return value && ROUNDNESS_LEVELS.includes(value) ? value : 'full'
}

/** The 16 ANSI slots, in the order the editor shows them. */
export const ANSI_KEYS: (keyof TerminalPalette)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]

export const CHROME_KEYS: (keyof ChromePalette)[] = [
  'bg',
  'bgRaised',
  'bgHover',
  'bgActive',
  'border',
  'borderStrong',
  'text',
  'textDim',
  'textFaint',
  'accent',
  'danger',
  'warn',
]

export const TERMINAL_CORE_KEYS: (keyof TerminalPalette)[] = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
]

/** Human labels for the editor. */
export const COLOR_LABELS: Record<string, string> = {
  bg: 'Window background',
  bgRaised: 'Panels and bars',
  bgHover: 'Hover',
  bgActive: 'Selected',
  border: 'Border',
  borderStrong: 'Strong border',
  text: 'Text',
  textDim: 'Dim text',
  textFaint: 'Faint text',
  accent: 'Accent',
  danger: 'Error',
  warn: 'Attention',
  background: 'Background',
  foreground: 'Foreground',
  cursor: 'Cursor',
  cursorAccent: 'Cursor text',
  selectionBackground: 'Selection',
  black: 'Black',
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
  magenta: 'Magenta',
  cyan: 'Cyan',
  white: 'White',
  brightBlack: 'Bright black',
  brightRed: 'Bright red',
  brightGreen: 'Bright green',
  brightYellow: 'Bright yellow',
  brightBlue: 'Bright blue',
  brightMagenta: 'Bright magenta',
  brightCyan: 'Bright cyan',
  brightWhite: 'Bright white',
}

// ----------------------------------------------------------------- built-ins

/** Neutral dark grey. No blue cast anywhere — the default. */
const graphite: ThemeSeed = {
  id: 'graphite',
  name: 'Graphite',
  builtin: true,
  opacity: 1,
  chrome: {
    bg: '#141414',
    bgRaised: '#1c1c1c',
    bgHover: '#262626',
    bgActive: '#303030',
    border: '#2a2a2a',
    borderStrong: '#3a3a3a',
    text: '#dcdcdc',
    textDim: '#9a9a9a',
    textFaint: '#6f6f6f',
    accent: '#9e9e9e',
    danger: '#d16a63',
    warn: '#d1a45f',
  },
  terminal: {
    background: '#141414',
    foreground: '#dcdcdc',
    cursor: '#dcdcdc',
    cursorAccent: '#141414',
    selectionBackground: '#3a3a3a',
    black: '#3a3a3a',
    red: '#cf6a5f',
    green: '#8bb26b',
    yellow: '#d1a45f',
    blue: '#7fa2c4',
    magenta: '#b08cb0',
    cyan: '#79aeae',
    white: '#c8c8c8',
    brightBlack: '#6f6f6f',
    brightRed: '#e08a7d',
    brightGreen: '#a6c98a',
    brightYellow: '#e3bd7e',
    brightBlue: '#9dbcd8',
    brightMagenta: '#c8a8c8',
    brightCyan: '#98c6c6',
    brightWhite: '#f0f0f0',
  },
}

/** Greyscale only — the single most legible option under bright light. */
const mono: ThemeSeed = {
  id: 'mono',
  name: 'Mono',
  builtin: true,
  opacity: 1,
  chrome: {
    bg: '#101010',
    bgRaised: '#191919',
    bgHover: '#242424',
    bgActive: '#2e2e2e',
    border: '#272727',
    borderStrong: '#383838',
    text: '#e4e4e4',
    textDim: '#a0a0a0',
    textFaint: '#707070',
    accent: '#e4e4e4',
    danger: '#bdbdbd',
    warn: '#d6d6d6',
  },
  terminal: {
    background: '#101010',
    foreground: '#e0e0e0',
    cursor: '#ffffff',
    cursorAccent: '#101010',
    selectionBackground: '#3d3d3d',
    black: '#2b2b2b',
    red: '#8a8a8a',
    green: '#a8a8a8',
    yellow: '#c2c2c2',
    blue: '#7c7c7c',
    magenta: '#969696',
    cyan: '#b4b4b4',
    white: '#d4d4d4',
    brightBlack: '#5c5c5c',
    brightRed: '#ababab',
    brightGreen: '#c6c6c6',
    brightYellow: '#dcdcdc',
    brightBlue: '#9a9a9a',
    brightMagenta: '#b6b6b6',
    brightCyan: '#d0d0d0',
    brightWhite: '#f6f6f6',
  },
}

/** Dark grey and light grey with orange and blue accents. */
const ember: ThemeSeed = {
  id: 'ember',
  name: 'Ember',
  builtin: true,
  opacity: 1,
  chrome: {
    bg: '#1b1d1e',
    bgRaised: '#242728',
    bgHover: '#2e3233',
    bgActive: '#383d3f',
    border: '#313537',
    borderStrong: '#434849',
    text: '#d9dddd',
    textDim: '#9aa0a1',
    textFaint: '#6d7374',
    accent: '#e8873a',
    danger: '#e0614f',
    warn: '#e8a33a',
  },
  terminal: {
    background: '#1b1d1e',
    foreground: '#d9dddd',
    cursor: '#e8873a',
    cursorAccent: '#1b1d1e',
    selectionBackground: '#3f4749',
    black: '#313537',
    red: '#e0614f',
    green: '#8fbf6f',
    yellow: '#e8a33a',
    blue: '#4f9fd6',
    magenta: '#b98cc9',
    cyan: '#54b0ac',
    white: '#c6cbcb',
    brightBlack: '#6d7374',
    brightRed: '#f0806e',
    brightGreen: '#a8d189',
    brightYellow: '#f2bd63',
    brightBlue: '#74b8e5',
    brightMagenta: '#cfa6dc',
    brightCyan: '#77c8c4',
    brightWhite: '#eef1f1',
  },
}

/** Warm neutral tuned to sit under Claude Code's own colours. */
const claude: ThemeSeed = {
  id: 'claude',
  name: 'Claude',
  builtin: true,
  opacity: 1,
  chrome: {
    bg: '#1f1e1d',
    bgRaised: '#272524',
    bgHover: '#332f2d',
    bgActive: '#3d3835',
    border: '#332f2d',
    borderStrong: '#474240',
    text: '#e5e2dd',
    textDim: '#a29c95',
    textFaint: '#756f6a',
    accent: '#d97757',
    danger: '#e06a5c',
    warn: '#d9a84e',
  },
  terminal: {
    background: '#1f1e1d',
    foreground: '#e5e2dd',
    cursor: '#d97757',
    cursorAccent: '#1f1e1d',
    selectionBackground: '#4a4642',
    black: '#3a3734',
    red: '#e06a5c',
    green: '#7fb069',
    yellow: '#d9a84e',
    blue: '#6f9ec9',
    magenta: '#b48ead',
    cyan: '#69a8a0',
    white: '#d6d1ca',
    brightBlack: '#6b6560',
    brightRed: '#f08878',
    brightGreen: '#9bcc84',
    brightYellow: '#f0c46a',
    brightBlue: '#8fb9e0',
    brightMagenta: '#cba6c8',
    brightCyan: '#87c4bb',
    brightWhite: '#f5f2ed',
  },
}

/** The Windows Terminal default palette. */
const campbell: ThemeSeed = {
  id: 'campbell',
  name: 'Campbell',
  builtin: true,
  opacity: 1,
  chrome: {
    bg: '#0c0c0c',
    bgRaised: '#161616',
    bgHover: '#222222',
    bgActive: '#2c2c2c',
    border: '#242424',
    borderStrong: '#363636',
    text: '#cccccc',
    textDim: '#999999',
    textFaint: '#6d6d6d',
    accent: '#3b78ff',
    danger: '#e74856',
    warn: '#c19c00',
  },
  terminal: {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#ffffff',
    cursorAccent: '#0c0c0c',
    selectionBackground: '#3a3d41',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2',
  },
}

/** The blue console from right-click "Open in Terminal". */
const powershell: ThemeSeed = {
  id: 'powershell',
  name: 'PowerShell Blue',
  builtin: true,
  opacity: 1,
  chrome: {
    bg: '#012456',
    bgRaised: '#062e63',
    bgHover: '#0d3a76',
    bgActive: '#14468a',
    border: '#0b3670',
    borderStrong: '#1a4e93',
    text: '#e8eefc',
    textDim: '#a8bbdd',
    textFaint: '#7c92b8',
    accent: '#61d6d6',
    danger: '#e74856',
    warn: '#f9f1a5',
  },
  terminal: {
    background: '#012456',
    foreground: '#cccccc',
    cursor: '#cccccc',
    cursorAccent: '#012456',
    selectionBackground: '#264f78',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2',
  },
}

/**
 * The built-ins are still authored as one object each.
 *
 * Six pairs of palettes designed together, and writing them twice would be six
 * chances for "Ember" the interface to drift from "Ember" the terminal. They are
 * split on the way out instead, so everything downstream sees two independent
 * lists and nothing downstream can put them back together.
 */
type ThemeSeed = InterfaceTheme & TerminalTheme

const SEEDS: ThemeSeed[] = [graphite, mono, ember, claude, campbell, powershell]

export const BUILTIN_INTERFACE_THEMES: InterfaceTheme[] = SEEDS.map(
  ({ id, name, builtin, opacity, backdrop, roundness, workspaceDots, chrome }) => ({
    id,
    name,
    builtin,
    opacity,
    backdrop,
    roundness,
    workspaceDots,
    chrome,
  })
)

export const BUILTIN_TERMINAL_THEMES: TerminalTheme[] = SEEDS.map(
  ({ id, name, builtin, terminal }) => ({ id, name, builtin, terminal })
)

export const DEFAULT_THEME_ID = 'graphite'

export function findInterfaceTheme(id: string, custom: InterfaceTheme[]): InterfaceTheme {
  return (
    custom.find((t) => t.id === id) ??
    BUILTIN_INTERFACE_THEMES.find((t) => t.id === id) ??
    BUILTIN_INTERFACE_THEMES[0]
  )
}

export function findTerminalTheme(id: string, custom: TerminalTheme[]): TerminalTheme {
  return (
    custom.find((t) => t.id === id) ??
    BUILTIN_TERMINAL_THEMES.find((t) => t.id === id) ??
    BUILTIN_TERMINAL_THEMES[0]
  )
}

/** Deep copy with a fresh id, used by "Duplicate & edit". */
export function duplicateInterfaceTheme(
  source: InterfaceTheme,
  id: string,
  name: string
): InterfaceTheme {
  return {
    id,
    name,
    builtin: false,
    opacity: source.opacity ?? 1,
    backdrop: source.backdrop,
    roundness: source.roundness,
    workspaceDots: source.workspaceDots,
    chrome: { ...source.chrome },
  }
}

export function duplicateTerminalTheme(
  source: TerminalTheme,
  id: string,
  name: string
): TerminalTheme {
  return { id, name, builtin: false, terminal: { ...source.terminal } }
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(MIN_OPACITY, Math.min(1, value))
}

const HEX = /^#[0-9a-fA-F]{6}$/

export function isValidHex(value: string): boolean {
  return HEX.test(value)
}

/**
 * Accepts a theme parsed from user input (import, Windows Terminal scheme),
 * filling any missing slot from a fallback so a partial file can't produce an
 * unusable theme.
 */
export function coerceBackdrop(raw: unknown, fallback: BackdropMaterial = 'none'): BackdropMaterial {
  return BACKDROP_MATERIALS.includes(raw as BackdropMaterial) ? (raw as BackdropMaterial) : fallback
}

export function coerceInterfaceTheme(
  raw: unknown,
  fallback: InterfaceTheme,
  id: string,
  name: string
): InterfaceTheme {
  const source = (raw ?? {}) as Partial<InterfaceTheme>
  const chrome = { ...fallback.chrome }

  for (const key of CHROME_KEYS) {
    const value = (source.chrome as Record<string, unknown> | undefined)?.[key]
    if (typeof value === 'string' && isValidHex(value)) chrome[key] = value
  }

  const opacity = clampOpacity(
    Number((source as { opacity?: number }).opacity ?? fallback.opacity ?? 1)
  )
  return {
    id,
    name,
    builtin: false,
    opacity,
    backdrop: coerceBackdrop(source.backdrop, fallback.backdrop),
    roundness: source.roundness ?? fallback.roundness,
    workspaceDots: source.workspaceDots ?? fallback.workspaceDots,
    chrome,
  }
}

/**
 * Accepts a terminal palette from user input.
 *
 * Also the migration path: a theme file written before the split carries both
 * halves, and its `terminal` object is exactly what this reads — so an old
 * export imports as a terminal theme without knowing anything has changed.
 */
export function coerceTerminalTheme(
  raw: unknown,
  fallback: TerminalTheme,
  id: string,
  name: string
): TerminalTheme {
  const source = (raw ?? {}) as Partial<TerminalTheme>
  const terminal = { ...fallback.terminal }

  for (const key of [...TERMINAL_CORE_KEYS, ...ANSI_KEYS]) {
    const value = (source.terminal as Record<string, unknown> | undefined)?.[key]
    if (typeof value === 'string' && isValidHex(value)) terminal[key] = value
  }

  return { id, name, builtin: false, terminal }
}
