/**
 * Which view a file gets when nobody has said.
 *
 * By extension, and only by extension: sniffing content means reading the file
 * before deciding how to read it, and being wrong about a `.txt` full of JSON
 * is worse than being predictable. The tab's menu overrides this per pane, and
 * that choice is what gets remembered.
 */
import type { EditorMode } from './types'

/**
 * Languages the code view knows, by extension.
 *
 * The grammar is deliberately shallow — comments, strings, numbers, keywords —
 * so one table covers the C-like majority. A language whose *lexing* differs
 * (its comment or string syntax) needs an entry here; one that merely has
 * different keywords does not need its own anything.
 */
export interface Grammar {
  /** Line-comment markers, longest first. */
  line: readonly string[]
  /**
   * Markers that only comment when they begin a line.
   *
   * Batch files are the reason: `REM` is a command, not a punctuation mark, so
   * `echo rem this` is output rather than a comment. Matched case-insensitively
   * and only after leading whitespace.
   */
  lineStart?: readonly string[]
  /** Block-comment delimiters, when the language has them. */
  block?: readonly [string, string]
  /** Quote characters that start a string. */
  quotes: readonly string[]
  keywords: ReadonlySet<string>
}

const C_LIKE = 'break case catch class const continue default do else enum export extends finally for function if import in instanceof interface let new return static super switch this throw try typeof var void while yield async await of as from type'
const RUST = 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while'
const PY = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda none nonlocal not or pass raise return true false try while with yield'
const GO = 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false'
const SHELL = 'if then else elif fi for while do done case esac function return exit local export set unset echo cd source alias trap shift read test'
const SQL = 'select from where insert update delete create table drop alter join left right inner outer on group by order having limit offset values set into as and or not null distinct union index primary key foreign references'
const BATCH = 'echo set setlocal endlocal if else for in do goto call exit rem pause cd pushd popd start title shift errorlevel not exist defined equ neq lss leq gtr geq'
const POWERSHELL = 'function param begin process end if elseif else switch foreach for while do until break continue return try catch finally throw filter class enum using module param write host output error warn'
const C_SHARP = `${C_LIKE} namespace using public private protected internal virtual override abstract sealed readonly params ref out struct record var when nameof`
const JAVA = `${C_LIKE} package public private protected abstract final synchronized volatile transient native implements throws boolean int long double float char byte short`
const LUA = 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while'
const RUBY = 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'
const PHP = `${C_LIKE} echo elseif endif endforeach endwhile foreach global namespace print public private protected require require_once include include_once use array isset unset null`
const SWIFT = 'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as any catch false is nil rethrows self super throw throws true try'
const ZIG = 'const var fn pub return if else while for switch break continue defer errdefer try catch struct enum union comptime inline export extern test orelse unreachable null undefined true false'
const NIX = 'let in rec with inherit if then else assert import builtins true false null or'
const MAKE = 'ifeq ifneq ifdef ifndef else endif include define endef export unexport override vpath'

const words = (list: string) => new Set(list.split(' '))

const C_GRAMMAR: Grammar = {
  line: ['//'],
  block: ['/*', '*/'],
  quotes: ['"', "'", '`'],
  keywords: words(C_LIKE),
}

const HASH = (keywords: string) => ({
  line: ['#'],
  quotes: ['"', "'"],
  keywords: words(keywords),
})
const MARKUP = { line: [], block: ['<!--', '-->'] as const, quotes: ['"', "'"], keywords: new Set<string>() }

const GRAMMARS: Record<string, Grammar> = {
  // C-family and friends
  ts: C_GRAMMAR,
  tsx: C_GRAMMAR,
  mts: C_GRAMMAR,
  cts: C_GRAMMAR,
  js: C_GRAMMAR,
  jsx: C_GRAMMAR,
  mjs: C_GRAMMAR,
  cjs: C_GRAMMAR,
  c: C_GRAMMAR,
  h: C_GRAMMAR,
  cc: C_GRAMMAR,
  cpp: C_GRAMMAR,
  cxx: C_GRAMMAR,
  hpp: C_GRAMMAR,
  hh: C_GRAMMAR,
  m: C_GRAMMAR,
  mm: C_GRAMMAR,
  cs: { ...C_GRAMMAR, keywords: words(C_SHARP) },
  java: { ...C_GRAMMAR, keywords: words(JAVA) },
  kt: C_GRAMMAR,
  kts: C_GRAMMAR,
  scala: C_GRAMMAR,
  dart: C_GRAMMAR,
  groovy: C_GRAMMAR,
  gradle: C_GRAMMAR,
  swift: { ...C_GRAMMAR, keywords: words(SWIFT) },
  go: { ...C_GRAMMAR, keywords: words(GO) },
  rs: { ...C_GRAMMAR, keywords: words(RUST) },
  zig: { ...C_GRAMMAR, keywords: words(ZIG) },
  v: C_GRAMMAR,
  php: { ...C_GRAMMAR, line: ['//', '#'], keywords: words(PHP) },
  glsl: C_GRAMMAR,
  frag: C_GRAMMAR,
  vert: C_GRAMMAR,
  hlsl: C_GRAMMAR,
  wgsl: C_GRAMMAR,
  proto: C_GRAMMAR,
  ino: C_GRAMMAR,

  // Data
  json: { line: [], quotes: ['"'], keywords: words('true false null') },
  jsonc: { line: ['//'], block: ['/*', '*/'], quotes: ['"'], keywords: words('true false null') },
  json5: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], keywords: words('true false null') },
  yml: HASH('true false null yes no on off'),
  yaml: HASH('true false null yes no on off'),
  toml: HASH('true false'),
  ini: { line: [';', '#'], quotes: ['"', "'"], keywords: new Set<string>() },
  cfg: { line: [';', '#'], quotes: ['"', "'"], keywords: new Set<string>() },
  conf: HASH(''),
  properties: { line: ['#', '!'], quotes: [], keywords: new Set<string>() },
  env: HASH(''),

  // Hash-comment languages
  py: { line: ['#'], quotes: ['"', "'"], keywords: words(PY) },
  pyw: { line: ['#'], quotes: ['"', "'"], keywords: words(PY) },
  rb: { line: ['#'], quotes: ['"', "'"], keywords: words(RUBY) },
  pl: HASH(PY),
  pm: HASH(PY),
  r: HASH('if else for while function return true false null na'),
  jl: HASH('function end if else elseif for while return true false nothing using import module struct'),
  tf: HASH('resource variable provider module output data locals true false null'),
  nix: HASH(NIX),
  gitignore: { line: ['#'], quotes: [], keywords: new Set<string>() },
  gitattributes: { line: ['#'], quotes: [], keywords: new Set<string>() },
  dockerfile: HASH('from run cmd label expose env add copy entrypoint volume user workdir arg onbuild healthcheck shell'),
  containerfile: HASH('from run cmd label expose env add copy entrypoint volume user workdir arg onbuild'),
  makefile: HASH(MAKE),
  mk: HASH(MAKE),

  // Shells
  sh: { line: ['#'], quotes: ['"', "'"], keywords: words(SHELL) },
  bash: { line: ['#'], quotes: ['"', "'"], keywords: words(SHELL) },
  zsh: { line: ['#'], quotes: ['"', "'"], keywords: words(SHELL) },
  fish: { line: ['#'], quotes: ['"', "'"], keywords: words(SHELL) },
  ps1: { line: ['#'], block: ['<#', '#>'], quotes: ['"', "'"], keywords: words(POWERSHELL) },
  psm1: { line: ['#'], block: ['<#', '#>'], quotes: ['"', "'"], keywords: words(POWERSHELL) },
  psd1: { line: ['#'], block: ['<#', '#>'], quotes: ['"', "'"], keywords: words(POWERSHELL) },
  // `rem` is a whole statement rather than a marker, but as a line comment it
  // reads correctly, which is all this lexer is for.
  bat: { line: ['::'], lineStart: ['rem'], quotes: ['"'], keywords: words(BATCH) },
  cmd: { line: ['::'], lineStart: ['rem'], quotes: ['"'], keywords: words(BATCH) },

  // Query and markup
  sql: { line: ['--'], block: ['/*', '*/'], quotes: ["'", '"'], keywords: words(SQL) },
  lua: { line: ['--'], block: ['--[[', ']]'], quotes: ['"', "'"], keywords: words(LUA) },
  hs: { line: ['--'], block: ['{-', '-}'], quotes: ['"'], keywords: words('module import where let in do case of if then else data type newtype class instance deriving') },
  css: { line: [], block: ['/*', '*/'], quotes: ['"', "'"], keywords: new Set<string>() },
  scss: C_GRAMMAR,
  less: C_GRAMMAR,
  html: MARKUP,
  htm: MARKUP,
  xml: MARKUP,
  svg: MARKUP,
  xaml: MARKUP,
  vue: MARKUP,
  svelte: MARKUP,
}

/** The bit after the last dot, lowercased. Empty for a file without one. */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  // A dotfile is all extension — `.gitignore` is matched by name, not suffix.
  if (dot <= 0) return name.replace(/^\./, '').toLowerCase()
  return name.slice(dot + 1).toLowerCase()
}

export function grammarFor(path: string): Grammar | null {
  return GRAMMARS[extensionOf(path)] ?? null
}

const MARKDOWN = new Set(['md', 'markdown', 'mdx', 'mdown'])
const TABLES = new Set(['csv', 'tsv'])
const BINARY = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'ico', 'png', 'jpg', 'jpeg', 'gif',
  'webp', 'pdf', 'zip', 'gz', 'xz', '7z', 'tar', 'wasm', 'class', 'o', 'obj',
  'pyc', 'ttf', 'otf', 'woff', 'woff2', 'mp3', 'mp4', 'wav', 'db', 'sqlite',
])

/** The view a file opens in when the pane has no remembered choice. */
export function modeForFile(path: string): EditorMode {
  const ext = extensionOf(path)
  if (!path) return 'markdown'
  if (MARKDOWN.has(ext)) return 'markdown'
  if (ext === 'json') return 'json'
  if (TABLES.has(ext)) return 'csv'
  if (BINARY.has(ext)) return 'hex'
  if (GRAMMARS[ext]) return 'code'
  return 'text'
}

/** The separator a table file uses. Tabs for `.tsv`, commas for everything else. */
export function delimiterFor(path: string): string {
  return extensionOf(path) === 'tsv' ? '\t' : ','
}
