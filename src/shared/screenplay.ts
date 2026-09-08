/**
 * Fountain: screenplays as plain text.
 *
 * The one open format the film world actually has. Its premise is that a
 * correctly typed screenplay is *already* unambiguous — `INT. KITCHEN - DAY` is
 * a scene heading and a capitalised name above a paragraph is the person
 * speaking — so the markup is mostly the absence of markup, and a `.fountain`
 * file reads as a screenplay in any text editor that has never heard of one.
 *
 * Which is why it belongs here rather than a format of our own. It diffs, it
 * greps, it goes in a commit, and every other screenwriting tool imports it. A
 * script written in this app is not trapped in this app.
 *
 * This module is the parsing, kept apart from anything that draws, because two
 * things need it and they need it differently. The outline sees the whole file
 * and can look forward; the highlighter is handed one line at a time and cannot
 * — see `screenplay` in ui/highlight.ts for what that costs.
 */

/** A scene heading, and where it is. */
export interface Scene {
  /** 0-based line index. */
  line: number
  /** The heading exactly as written, forcing dot removed. */
  heading: string
}

/** Somebody who speaks, and how much. */
export interface Character {
  name: string
  /** How many times they are cued. Not how many lines they say. */
  cues: number
  /** Where they first speak. */
  line: number
}

export interface Outline {
  scenes: Scene[]
  characters: Character[]
}

/**
 * What a scene heading starts with.
 *
 * The spec's list, and no more of it: `INT`, `EXT`, `EST`, the combined forms,
 * and `I/E`. Case-insensitive because the format says so, even though every
 * script in the world writes them in capitals.
 *
 * Both orders of the combined form. This said `\/ext` at first, which quietly
 * accepted `INT/EXT` and refused `EXT/INT` — a slug people write when the
 * camera starts outside and follows somebody in, and one that vanished from the
 * Outline menu as well as losing its colour.
 */
const SCENE_PREFIX = /^(?:int|ext|est)(?:\.?\/(?:int|ext))?[.\s]|^i\/e[.\s]/i

/**
 * The title page keys.
 *
 * A closed set, matched anywhere rather than only at the top of the file, and
 * the reason is a limitation rather than a choice: the highlighter is given a
 * line and a carry value, the carry starts at zero, and zero also means
 * "nothing special is happening" — so there is no way for it to know it is on
 * the first line. Matching the keys themselves gets the same answer for every
 * real script, because nothing else in a screenplay begins `Credit:`.
 */
const TITLE_KEY =
  /^(title|credit|author|authors|source|draft date|date|contact|copyright|notes|revision|format):/i

/** Fountain's own way of saying "yes, this really is one" for each element. */
const FORCED_SCENE = /^\.(?!\.)/
const FORCED_CHARACTER = /^@/
const FORCED_TRANSITION = /^>(?!.*<$)/
const FORCED_ACTION = /^!/

/** `(V.O.)`, `(CONT'D)`, `(O.S.)` — part of the cue, not part of the name. */
const CUE_EXTENSION = /\s*\([^)]*\)\s*$/
/** Dual dialogue: `BOB ^` speaks alongside the block above. */
const DUAL = /\s*\^\s*$/

export function isTitleKey(line: string): boolean {
  return TITLE_KEY.test(line)
}

export function isForcedAction(line: string): boolean {
  return FORCED_ACTION.test(line)
}

/** `INT. KITCHEN - DAY`, or anything at all behind a forcing dot. */
export function isSceneHeading(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  if (FORCED_SCENE.test(text)) return true
  return SCENE_PREFIX.test(text)
}

/**
 * `CUT TO:` and its family.
 *
 * Ends in `TO:` and shouts, or is forced with `>`. Deliberately not matching
 * `FADE IN:` — it opens scripts, it is not a cut between two things, and every
 * tool disagrees about it. As action it reads correctly either way.
 */
export function isTransition(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  if (FORCED_TRANSITION.test(text)) return true
  return /TO:$/.test(text) && text === text.toUpperCase()
}

/**
 * Whether a line has the *shape* of a character cue.
 *
 * Shape only. Fountain also requires a blank line before and a non-blank line
 * after, and neither is visible from here — the callers add what they can see.
 *
 * Capitals with at least one letter in them, which is what rules out a line of
 * dashes or a number. A cue may carry an extension and a dual-dialogue caret,
 * so both are stripped before the case is judged rather than after, or
 * `BOB (cont'd)` fails on a lowercase `d` that was never part of the name.
 *
 * Every other shouting element has to be ruled out first, and the cost of
 * missing one is not a wrong colour on one line: a cue opens a dialogue block,
 * so `>THE END<` read as a character turned everything under it into something
 * it was saying.
 */
export function isCharacterCue(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  if (FORCED_CHARACTER.test(text)) return text.length > 1
  if (isSceneHeading(text) || isTransition(text)) return false
  if (isCentred(text) || isLyric(text) || isPageBreak(text)) return false
  const bare = text.replace(DUAL, '').replace(CUE_EXTENSION, '')
  if (!bare || !/[A-Za-z]/.test(bare)) return false
  return bare === bare.toUpperCase()
}

/** A cue with the forcing character, the extension and the caret taken off. */
export function characterName(line: string): string {
  return line.trim().replace(FORCED_CHARACTER, '').replace(DUAL, '').replace(CUE_EXTENSION, '').trim()
}

/** A parenthetical: a line that is nothing but a bracketed aside. */
export function isParenthetical(line: string): boolean {
  const text = line.trim()
  return text.startsWith('(') && text.endsWith(')') && text.length > 1
}

/**
 * `> THE END <` — centred on the page.
 *
 * Opens with the transition's forcing character and is not one, which is why
 * `FORCED_TRANSITION` refuses anything ending in `<`. Titles, chapter cards and
 * the last two words of the film.
 */
export function isCentred(line: string): boolean {
  const text = line.trim()
  return text.length > 1 && text.startsWith('>') && text.endsWith('<')
}

/** `~` — sung rather than spoken. */
export function isLyric(line: string): boolean {
  return line.trimStart().startsWith('~')
}

/**
 * `===` — a page break the writer insisted on.
 *
 * Three or more, which is what keeps it apart from a synopsis: one `=` is a
 * note to yourself about the scene, three is an instruction to the page.
 */
export function isPageBreak(line: string): boolean {
  return /^={3,}$/.test(line.trim())
}

/**
 * The scenes and the cast, read out of the script itself.
 *
 * Derived on every call and stored nowhere, which is the whole point. A scene
 * list kept beside the file is a scene list that disagrees with the file the
 * first time somebody edits a slug line in a terminal, and this app is full of
 * terminals.
 *
 * More accurate than the highlighter, and allowed to be: here the next line is
 * available, so a cue is only a cue when somebody actually says something under
 * it — which is what stops a lone `THE END` becoming a member of the cast.
 */
export function outlineOf(text: string): Outline {
  const lines = text.split(/\r?\n/)
  const scenes: Scene[] = []
  const cast = new Map<string, Character>()
  let inBoneyard = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // The boneyard is Fountain's "not this draft" — cut material left in the
    // file on purpose. A character who only speaks in there is not in the film.
    if (inBoneyard) {
      if (line.includes('*/')) inBoneyard = false
      continue
    }
    if (line.trimStart().startsWith('/*') && !line.includes('*/')) {
      inBoneyard = true
      continue
    }

    const text = line.trim()
    if (!text || isForcedAction(text)) continue
    // Both elements need the blank line above them. Line 0 counts as having
    // one: a script may open on a slug.
    const opensBlock = i === 0 || !lines[i - 1].trim()
    if (!opensBlock) continue

    if (isSceneHeading(text)) {
      scenes.push({ line: i, heading: text.replace(FORCED_SCENE, '').trim() })
      continue
    }

    // The lookahead the highlighter does not get: a cue with nothing under it
    // is somebody shouting in the action, not somebody speaking.
    const speaks = Boolean(lines[i + 1]?.trim())
    if (!speaks || !isCharacterCue(text)) continue

    const name = characterName(text)
    if (!name) continue
    const seen = cast.get(name)
    if (seen) seen.cues += 1
    else cast.set(name, { name, cues: 1, line: i })
  }

  // By how much they speak, then by name: the lead is what you want at the top
  // of the list, and alphabetical is only useful when you already know who you
  // are looking for.
  const characters = [...cast.values()].sort(
    (a, b) => b.cues - a.cues || a.name.localeCompare(b.name)
  )
  return { scenes, characters }
}

/**
 * The elements of a screenplay, with what they are for.
 *
 * Here rather than in the editor because it is knowledge about the format, not
 * about a menu — the same reason the parsing is here. The editor turns each of
 * these into a row; the syntax column doubles as the reference, so somebody who
 * has never written a script reads what it types every time they use it and
 * stops needing the menu on their own.
 *
 * `hint` answers the question a label cannot: not what it is called, and not
 * what it types, but when you would want it. Written for somebody who has never
 * seen a screenplay, because that is who the menu is for.
 */
export interface FountainElement {
  label: string
  /** Shown in the menu's right-hand column. The literal shape of the thing. */
  syntax: string
  /** One sentence on hover: when to reach for this. */
  hint: string
  /** Put in at the caret, replacing the selection. */
  snippet?: string
  /**
   * A substring of `snippet` to leave selected, so the first thing you type
   * replaces it. Absent leaves the caret after the insertion.
   */
  place?: string
  /** Put around the selection instead — emphasis, and notes. */
  around?: readonly [string, string]
  /** Starts a new group: the menu draws a separator above it. */
  group?: boolean
}

export const FOUNTAIN_ELEMENTS: readonly FountainElement[] = [
  {
    label: 'Whole scene',
    syntax: 'example',
    hint:
      'A complete scene laid out — where it is, what happens, who speaks. ' +
      'The quickest way to see the shape of a screenplay, and safe to type over.',
    snippet:
      'INT. PLACE - DAY\n\nSomething happens here. Only what a camera could see.\n\nNAME\nWhat they say.\n',
    place: 'PLACE',
  },
  {
    label: 'Scene heading',
    syntax: 'INT. / EXT.',
    hint:
      'Where and when. INT. for indoors, EXT. for outdoors, then the place, then ' +
      'DAY or NIGHT. Every scene opens with one, and it is what the schedule is built from.',
    snippet: 'INT. PLACE - DAY',
    place: 'PLACE',
    group: true,
  },
  {
    label: 'Character',
    syntax: 'NAME',
    hint:
      'Who speaks next. Their name in capitals on its own line, with what they say ' +
      'on the line directly under it — the capitals are the whole of the syntax.',
    snippet: 'NAME',
    place: 'NAME',
  },
  {
    label: 'Parenthetical',
    syntax: '(…)',
    hint:
      'How a line is delivered — (quietly), (to Bob). Goes between the name and the ' +
      'words. Use rarely: if the line only works with it, the line is the problem.',
    snippet: '(quietly)',
    place: 'quietly',
  },
  {
    label: 'Transition',
    syntax: 'CUT TO:',
    hint:
      'How one scene becomes the next. Most scripts leave these out entirely — a cut ' +
      'is assumed between scenes — so save them for when the join itself matters.',
    snippet: 'CUT TO:',
    place: 'CUT',
  },
  {
    label: 'Section',
    syntax: '#',
    hint:
      'Your own structure: acts, sequences, parts. Never printed in the script and ' +
      'never seen by anyone else — it exists to let you find your way around.',
    snippet: '# Act One',
    place: 'Act One',
    group: true,
  },
  {
    label: 'Synopsis',
    syntax: '=',
    hint:
      'One line saying what the scene under it is for. Also never printed. Useful ' +
      'when the scene is not written yet and you only know its job.',
    snippet: '= What this scene is for.',
    place: 'What this scene is for.',
  },
  {
    label: 'Note',
    syntax: '[[…]]',
    hint:
      'A message to yourself or whoever reads this next — a question, a doubt, a ' +
      'thing to check. Never printed. Wraps whatever you have selected.',
    around: ['[[', ']]'],
  },
  {
    label: 'Italic',
    syntax: '*…*',
    hint: 'Emphasis inside action or dialogue. Wraps whatever you have selected.',
    around: ['*', '*'],
    group: true,
  },
  {
    label: 'Bold',
    syntax: '**…**',
    hint: 'Stronger emphasis. Rare in a screenplay outside of shot descriptions.',
    around: ['**', '**'],
  },
  {
    label: 'Underline',
    syntax: '_…_',
    hint: 'Emphasis again. Traditionally used for the first appearance of a character.',
    around: ['_', '_'],
  },
  {
    label: 'Force action',
    syntax: '!',
    hint:
      'Makes a line ordinary action when it would otherwise be read as something ' +
      'else — a shouted THE END that is not a character about to speak.',
    snippet: '!',
    group: true,
  },
  {
    label: 'Force character',
    syntax: '@',
    hint:
      'Makes a line a character cue when the name is not in capitals — @McAvoy, or a ' +
      'name with a lowercase word in it.',
    snippet: '@',
  },
]
