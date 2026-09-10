/**
 * A first draft of a save's message, read off what is picked.
 *
 * The box asks "what did you change?" and a good deal of the answer is already
 * sitting in the patch. Writing it out by hand is transcription, and
 * transcription is the part of a save people skip by typing "fixes" and moving
 * on. So this transcribes, and leaves the writing.
 *
 * The first version of this listed the files and how many lines each one moved,
 * which turned out to be no help at all: "update 3 files in src" is a fact
 * about the patch and not about the work, and anybody who wanted it could have
 * read it off the pane behind the box. What a message has to say is what is now
 * there that was not there before, so that is what this looks for —
 *
 *   add draftMessage.ts: a first draft of a save's message (+2 more files)
 *
 *   - add src/shared/draftMessage.ts (+320 -0): readDiff, draftMessage
 *   - update src/renderer/git/changesView.ts (+100 -4): draft, clearMessage
 *   - update tests/git.test.mjs (+151 -0): 10 new checks, "a rename says both
 *     names and does not invent a change"
 *
 * — by reading the added lines for the things a person would have mentioned:
 * declarations and class members, the names of new tests, the sentence at the
 * top of a new file, a dependency that appeared in package.json. Every one of
 * them is a line somebody wrote on purpose, so quoting them back is not a
 * summary of the diff so much as a collection of the parts of it that were
 * already prose.
 *
 * What none of it is, is a `why`. A patch can say that a method called `draft`
 * appeared and cannot say it appeared because writing the message by hand was
 * the part of a save worth skipping. That sentence is the one worth reading in
 * six months, and it is the reader's to write — which is why this fills an
 * editable box and never saves anything itself.
 *
 * No network, no model, no key. It is git's own output, read closely.
 */
import type { ChangedFile } from './types'

/** How many files get their own line before the rest become a count. */
const MAX_LINES = 12

/** How many names one file's line will carry. */
const MAX_NAMES = 4

/** How many test names are worth quoting in full. */
const MAX_TESTS = 2

/** Where a subject line stops being read at a glance. */
const SUBJECT_ROOM = 72

/** What one file's patch turned out to contain. */
interface FileFacts {
  plus: number
  minus: number
  binary: boolean
  /** Names this patch introduced — declarations on added lines, not on removed ones. */
  adds: string[]
  /** Names it took away. */
  removes: string[]
  /** The names of tests the patch added, as their authors wrote them. */
  tests: string[]
  /** Dependencies that appeared in package.json. */
  deps: string[]
  /** The sentence at the top of a file this patch created. */
  purpose: string
}

/**
 * The names one file's patch declared, kept in tiers until it is over.
 *
 * Tiers rather than one list, because "which name is worth printing" can only
 * be answered once the whole file has been read. Taking the first match per
 * line and stopping reports a file by its private helpers whenever one of them
 * is written above the export — which, in a file that puts its helpers at the
 * top, is always. It is why the first version of this described its own new
 * file as `verbFor, commonDir, headerPath`, which are the three least
 * interesting names in it.
 */
interface Names {
  addedTop: string[]
  addedInner: string[]
  removedTop: string[]
  removedInner: string[]
}

/**
 * A declaration worth reporting, in three shapes.
 *
 * `TOP` is the file's outside — what other files can reach. `INNER` is a
 * top-level declaration in a language with no export keyword, and `MEMBER` is a
 * method on a class, which is the shape almost every change to this codebase
 * actually takes: nothing new is exported, and two methods appear on a class
 * that was already there. A reader that only knew about exports had nothing to
 * say about any of those patches.
 *
 * `MEMBER` insists the line ends in `{` so that an ordinary call, which is also
 * a name followed by brackets, is not mistaken for a definition.
 */
const TOP = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
const INNER = /^\s*(?:async\s+)?(?:function|class|def|fn|func|struct|impl)\s+([A-Za-z_$][\w$]*)/
const MEMBER = /^\s+(?:(?:private|public|protected|static|readonly|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{;]+)?\{\s*$/

/** Words that are followed by brackets and a brace and are not definitions. */
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'else'])

/**
 * A test's name, as its author wrote it.
 *
 * The single most useful thing in a patch that adds tests, because a test name
 * is already a sentence about behaviour — "a rename says both names and does
 * not invent a change" is a better line of a commit message than anything a
 * machine could assemble about the file it lives in. The quote handling is
 * deliberate: half the names in this project contain an apostrophe.
 */
const TEST_NAME = /\b(?:check|checkAsync|it|test|describe)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/

/** A dependency line in package.json: a name against something version-shaped. */
const DEPENDENCY = /^\s*"([^"]+)":\s*"[\^~>=<]*\d/

/** A class in a stylesheet, at the start of its own rule. */
const CSS_CLASS = /^(\.[a-z][\w-]*)/i

/** The plain verb for a porcelain letter. */
function verbFor(file: ChangedFile): string {
  if (file.from) return 'rename'
  switch (file.picked) {
    case 'A':
      return 'add'
    case 'D':
      return 'remove'
    case 'C':
      return 'copy'
    default:
      return 'update'
  }
}

/**
 * The folder every path is inside, or '' when they have none in common.
 *
 * Compared segment by segment rather than character by character: `src/renderer`
 * and `src/relay` share the five characters `src/r`, which is not a folder.
 */
function commonDir(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  let parts = paths[0].split('/').slice(0, -1)
  for (const path of paths.slice(1)) {
    const other = path.split('/').slice(0, -1)
    let i = 0
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++
    parts = parts.slice(0, i)
    if (parts.length === 0) break
  }
  return parts.join('/')
}

/**
 * The path a `diff --git a/x b/x` line names.
 *
 * Only used for the one patch that has no `---`/`+++` headings to read
 * instead — a binary file, where git prints the header and then one sentence.
 * Split on the last ` b/` rather than the first, so a folder called `b` inside
 * the path does not cut it short; a path that genuinely contains ` b/` is
 * beyond what this line can be asked to say, and gets no counts rather than
 * wrong ones.
 */
function headerPath(line: string): string {
  const rest = line.slice('diff --git '.length)
  const cut = rest.lastIndexOf(' b/')
  return cut === -1 ? '' : rest.slice(cut + 3).replace(/^"|"$/g, '')
}

/** The path a `--- a/x` or `+++ b/x` line names, or '' for /dev/null. */
function headingPath(line: string): string {
  const value = line.slice(4).trim()
  if (value === '/dev/null') return ''
  // git quotes paths containing spaces or non-ASCII, and prefixes both sides.
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  return unquoted.replace(/^[ab]\//, '')
}

/** The name a declaration line declares, and whether it is the file's outside. */
function nameIn(line: string): { name: string; top: boolean } | null {
  const exported = TOP.exec(line)?.[1]
  if (exported) return { name: exported, top: true }
  const declared = INNER.exec(line)?.[1] ?? MEMBER.exec(line)?.[1]
  if (declared && !NOT_NAMES.has(declared)) return { name: declared, top: false }
  return null
}

/**
 * The first sentence of a file this patch created.
 *
 * Only ever read from the very top of a new file — a hunk that starts at old
 * line 0, and only while the lines are still the opening comment — because that
 * is the one place a line of prose is reliably about the whole file rather than
 * about the six lines around it. In a codebase that opens every file with a
 * paragraph saying what it is for, this is the single best sentence available
 * to a machine, and it was written by a person.
 */
function purposeIn(line: string, state: { open: boolean }): string {
  const body = line.trim()
  if (body === '/**' || body === '/*') {
    state.open = true
    return ''
  }
  if (state.open) {
    const text = body.replace(/^\*+\s?/, '').trim()
    return text && text !== '/' ? text : ''
  }
  if (body.startsWith('# ')) return body.slice(2).trim()
  if (body.startsWith('// ')) return body.slice(3).trim()
  return ''
}

/**
 * The patch, split per file and read for what it says.
 *
 * Driven off the `---`/`+++` headings rather than off `diff --git`, because that
 * first line carries the path twice and, for a path with a space in it, in a way
 * nothing can reliably split. The headings state one path each.
 */
export function readDiff(diff: string): Map<string, FileFacts> {
  const byPath = new Map<string, FileFacts>()
  const seen = new Map<string, Names>()
  let current: FileFacts | null = null
  let currentNames: Names | null = null
  let currentPath = ''
  let pendingRemoved = ''
  /** The path the last `diff --git` named, for a patch that has no headings. */
  let pendingHeader = ''
  /** True while the added lines being read are the first lines of a new file. */
  let atStart = false
  const doc = { open: false }

  /**
   * The records for a path, made if this is the first sight of it.
   *
   * Returned rather than assigned to `current` in here, because an assignment
   * inside a closure is invisible to the compiler's narrowing and every read of
   * `current` further down would be typed as `null`.
   */
  const open = (path: string): { file: FileFacts; names: Names } | null => {
    if (!path) return null
    const names =
      seen.get(path) ?? { addedTop: [], addedInner: [], removedTop: [], removedInner: [] }
    seen.set(path, names)
    const existing = byPath.get(path)
    if (existing) return { file: existing, names }
    const file: FileFacts = {
      plus: 0,
      minus: 0,
      binary: false,
      adds: [],
      removes: [],
      tests: [],
      deps: [],
      purpose: '',
    }
    byPath.set(path, file)
    return { file, names }
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null
      currentNames = null
      currentPath = ''
      pendingRemoved = ''
      atStart = false
      doc.open = false
      pendingHeader = headerPath(line)
      continue
    }
    if (line.startsWith('--- ')) {
      pendingRemoved = headingPath(line)
      continue
    }
    if (line.startsWith('+++ ')) {
      const opened = open(headingPath(line) || pendingRemoved)
      // A delete has no `+++` path, so the `---` side is the only name it has.
      current = opened?.file ?? null
      currentNames = opened?.names ?? null
      currentPath = opened ? (headingPath(line) || pendingRemoved) : ''
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      // A binary patch is the one shape with no `---`/`+++` pair to have opened
      // the file already, so the header line is all there is to name it by.
      if (!current) {
        const opened = open(pendingHeader)
        current = opened?.file ?? null
        currentNames = opened?.names ?? null
        currentPath = opened ? pendingHeader : ''
      }
      if (current) current.binary = true
      continue
    }
    if (line.startsWith('@@')) {
      // `-0,0` is git's way of saying there was no file here before this.
      atStart = line.startsWith('@@ -0,0')
      doc.open = false
      continue
    }
    if (!current || !currentNames) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue

    const added = line.startsWith('+')
    if (!added && !line.startsWith('-')) {
      atStart = false
      continue
    }
    if (added) current.plus++
    else current.minus++

    const body = line.slice(1)

    if (added && atStart && !current.purpose) {
      const said = purposeIn(body, doc)
      if (said) current.purpose = said
      // A file whose first line is not the start of a comment has no sentence
      // at the top of it, and the search stops there rather than wandering down
      // to the first `// filler` it can find.
      else if (!doc.open) atStart = false
    }

    if (added) {
      const test = TEST_NAME.exec(body)
      const name = test?.[1] ?? test?.[2]
      if (name !== undefined) {
        const written = name.replace(/\\(.)/g, '$1')
        if (!current.tests.includes(written)) current.tests.push(written)
        continue
      }
      if (currentPath === 'package.json') {
        const dep = DEPENDENCY.exec(body)?.[1]
        // The version field is version-shaped too, and is not a dependency.
        if (dep && dep !== 'version') {
          if (!current.deps.includes(dep)) current.deps.push(dep)
          continue
        }
      }
      if (currentPath.endsWith('.css')) {
        const css = CSS_CLASS.exec(body)?.[1]
        if (css && !currentNames.addedInner.includes(css)) currentNames.addedInner.push(css)
      }
    }

    const found = nameIn(body)
    if (!found) continue
    const into = added
      ? found.top
        ? currentNames.addedTop
        : currentNames.addedInner
      : found.top
        ? currentNames.removedTop
        : currentNames.removedInner
    if (!into.includes(found.name)) into.push(found.name)
  }

  for (const [path, file] of byPath) {
    const names = seen.get(path)
    if (!names) continue
    // The file's outside if it has one, its inside only if it has not: a patch
    // that added an export is described by that export, and a patch entirely
    // within one file's private half is still better described by a name than
    // by nothing.
    const adds = names.addedTop.length ? names.addedTop : names.addedInner
    const removes = names.removedTop.length ? names.removedTop : names.removedInner
    // A name on both sides is a line that moved or was reindented, not a name
    // that arrived. Reported as neither, rather than as both.
    file.adds = adds.filter((name) => !removes.includes(name))
    file.removes = removes.filter((name) => !adds.includes(name))
  }
  return byPath
}

/** `1.2.0` → `1.2.1`, when that is what the patch did to package.json. */
function versionBump(diff: Map<string, FileFacts>, raw: string): string {
  if (!diff.has('package.json')) return ''
  return /^\+\s*"version":\s*"([^"]+)"/m.exec(raw)?.[1] ?? ''
}

/**
 * A sentence lowered to the case the rest of the subject is written in.
 *
 * Only when the first word is an ordinary capitalised one: `A first draft` is a
 * sentence that has started, and `HEAD is where you are` and `GitHub calls it a
 * repo` are names, which stay as their authors typed them.
 */
function uncapitalise(text: string): string {
  const first = text.split(' ')[0] ?? ''
  const ordinary = /^[A-Z][a-z]+$/.test(first) || first.length === 1
  return ordinary ? text.charAt(0).toLowerCase() + text.slice(1) : text
}

/**
 * A body line, folded at the width git's own tools assume.
 *
 * `git log` indents a message by four spaces and terminals are eighty wide, so
 * a line longer than this is one somebody reads with a horizontal scrollbar or
 * not at all. Continuations are indented two spaces, under the text of the
 * bullet rather than under its dash, which is how every list of these is read.
 */
function wrap(line: string, room = SUBJECT_ROOM): string[] {
  const out: string[] = []
  let current = ''
  for (const word of line.split(' ')) {
    const candidate = current ? `${current} ${word}` : word
    if (current && candidate.length > room) {
      out.push(current)
      current = `  ${word}`
    } else {
      current = candidate
    }
  }
  if (current) out.push(current)
  return out
}

/** Cut to fit, at a comma or a word rather than mid-word, and never mid-`(`. */
function fit(text: string, room: number): string {
  if (text.length <= room) return text
  const head = text.slice(0, room)
  const comma = head.lastIndexOf(', ')
  const space = head.lastIndexOf(' ')
  const cut = comma > room / 2 ? comma : space > 0 ? space : room
  return head.slice(0, cut).replace(/[,;:]$/, '')
}

/** `readDiff, draftMessage` — the names, capped, with the rest as a count. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES).join(', ')
  const rest = names.length - MAX_NAMES
  return rest > 0 ? `${shown} and ${rest} more` : shown
}

/**
 * What this file's patch put there, in as many words as it deserves.
 *
 * The order is what a person would lead with. A new test file is its tests; a
 * package.json is its dependencies; anything else is the names it now holds.
 * Line counts are not in here at all — they go beside this, because "+320" is
 * the size of a change and never the substance of one.
 */
function contentOf(file: FileFacts | undefined): string {
  if (!file) return ''
  if (file.tests.length) {
    const count = `${file.tests.length} new check${file.tests.length === 1 ? '' : 's'}`
    const quoted = file.tests.slice(0, MAX_TESTS).map((name) => `"${fit(name, 60)}"`)
    return file.tests.length > MAX_TESTS ? `${count}, ${quoted.join(', ')}` : quoted.join(', ')
  }
  if (file.deps.length) return `adds ${nameList(file.deps)}`
  if (file.adds.length && file.removes.length)
    return `${nameList(file.adds)}; drops ${nameList(file.removes)}`
  if (file.adds.length) return nameList(file.adds)
  if (file.removes.length) return `drops ${nameList(file.removes)}`
  return ''
}

/** `(+18 -4)`, or nothing at all when counting lines would say nothing. */
function counts(file: FileFacts | undefined): string {
  if (!file) return ''
  if (file.binary) return ' (binary)'
  return file.plus || file.minus ? ` (+${file.plus} -${file.minus})` : ''
}

/**
 * A draft message for what is picked, or '' when nothing is.
 *
 * `files` is the whole status and `diff` is `git diff --cached`; only the picked
 * half of the first is used, because that is what the save will contain. A file
 * that is changed and not picked has no business being described in the message
 * for a save that does not include it.
 */
export function draftMessage(files: readonly ChangedFile[], diff: string): string {
  const picked = files.filter((f) => f.picked && !f.conflicted)
  if (picked.length === 0) return ''

  const parsed = readDiff(diff)
  const dir = commonDir(picked.map((f) => f.repoPath))

  // Biggest first: the point of the list is which change is the change, and
  // alphabetical order answers a question nobody asked. Ties fall back to the
  // path so the same patch always drafts the same message.
  const ordered = [...picked].sort((a, b) => {
    const size = (f: ChangedFile) => {
      const d = parsed.get(f.repoPath)
      return d ? d.plus + d.minus : 0
    }
    return size(b) - size(a) || a.repoPath.localeCompare(b.repoPath)
  })

  const head = ordered[0]
  const headFacts = parsed.get(head.repoPath)
  const version = versionBump(parsed, diff)
  const rest = picked.length - 1
  // Named rather than counted: the subject is the line that shows up in every
  // log, every blame and every list of saves, and "3 files" is not something
  // anybody has ever gone looking for. The file that moved most is the headline
  // and the others are a count after it, because they are all listed below.
  const also = rest > 0 ? ` (+${rest} more file${rest === 1 ? '' : 's'})` : ''
  const room = SUBJECT_ROOM - also.length

  let subject: string
  if (version && head.repoPath === 'package.json' && picked.length === 1) {
    subject = `version ${version}`
  } else if (head.from) {
    subject = fit(`rename ${head.from} to ${head.repoPath}`, room)
  } else {
    // The sentence at the top of a new file beats any description assembled
    // here, and a new file usually is the change. Short name for the headline:
    // the body underneath carries the full path.
    const name = head.repoPath.split('/').pop() ?? head.repoPath
    const said = uncapitalise(headFacts?.purpose || contentOf(headFacts))
    const opening = `${verbFor(head)} ${name}`
    subject = said ? fit(`${opening}: ${said.replace(/\.$/, '')}`, room) : fit(opening, room)
  }

  const lines: string[] = []
  if (picked.length > 1) {
    for (const file of ordered.slice(0, MAX_LINES)) {
      // Shortened against the folder the subject already named, so a list of
      // eight files in one folder does not print that folder eight more times.
      const path =
        dir && file.repoPath.startsWith(`${dir}/`) ? file.repoPath.slice(dir.length + 1) : file.repoPath
      const facts = parsed.get(file.repoPath)
      const what = file.from ? `rename ${file.from} to ${path}` : `${verbFor(file)} ${path}`
      const content = contentOf(facts)
      lines.push(...wrap(`- ${what}${counts(facts)}${content ? `: ${content}` : ''}`))
    }
    // Counted against the files listed rather than the lines printed: a wrapped
    // bullet is two lines and still one file.
    const over = picked.length - Math.min(picked.length, MAX_LINES)
    if (over > 0) lines.push(`- ...and ${over} more file${over === 1 ? '' : 's'}`)
  } else {
    // One file, so there is no list to make — but the subject is one line wide
    // and what the file now holds is not always one line long. It goes
    // underneath whenever the subject did not manage to say all of it: because
    // the file's own opening sentence took the line instead, or because the
    // list of names was cut to fit. When the subject already ends in it, this
    // would only be the same words twice.
    const content = contentOf(headFacts)
    if (content && !subject.endsWith(content)) lines.push(...wrap(`- ${content}`))
  }

  return lines.length ? `${subject}${also}\n\n${lines.join('\n')}` : `${subject}${also}`
}
