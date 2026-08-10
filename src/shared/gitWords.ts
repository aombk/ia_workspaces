/**
 * Git's vocabulary, in plain words — the dictionary the git panes speak.
 *
 * Every concept git has is behind a word chosen badly enough to be a barrier on
 * its own. A *stage* is a thing you perform on; nothing performs here. *Commit*
 * is a commitment to what, and to whom — it means **save**. *Origin* sounds
 * cosmic and means **the copy on GitHub**. *HEAD* means **where you are**. The
 * panes could either avoid those words, and leave you unable to read anything
 * else git prints, or print them with their plain meaning attached, forever,
 * until it sinks in. This is the second.
 *
 * There is one rule, taken from `git_ia`, and it is the rule that makes the
 * difference: **never explain jargon with jargon.** Every git word appearing
 * inside another word's explanation is itself translated on the spot, because a
 * glossary that defines "commit" in terms of "the index" is a closed loop with
 * extra steps.
 *
 * Each word carries its meaning at two lengths, and the difference is what each
 * is *for*:
 *
 * - `short` — one line, for a tooltip. What you want mid-click, when you have a
 *   button under the cursor and a question that has to be answered in the time
 *   it takes to read a sentence. A tooltip holding a paragraph is a tooltip
 *   nobody finishes.
 * - `meaning` — the whole thing, for the Words page, where you have come
 *   deliberately to read and there is room to say why.
 *
 * Data rather than prose baked into components, so one edit changes the word
 * everywhere it appears — the tooltip, the button, the heading and the page
 * cannot drift apart if there is only one of them.
 */

/** Where a word sits on the Words page, so it can be grouped. */
export type WordGroup =
  | 'places'
  | 'names'
  | 'verbs'
  | 'disagreement'
  | 'undo'

export interface GitWord {
  /** The word as git itself prints it. */
  term: string
  /**
   * The plain replacement. One or two ordinary words, never a phrase — this is
   * what goes in brackets beside the git word on a button or a heading, and
   * anything longer stops being a label and starts being a sentence.
   */
  plain: string
  /** One line, for the tooltip. The answer you need without stopping. */
  short: string
  /** The whole meaning, for the Words page, with every git word inside it translated in turn. */
  meaning: string
  group: WordGroup
  /**
   * True for the handful that can destroy work. The Words page colours these
   * and puts them last, because "reset" and "reset --hard" look almost
   * identical and are not remotely the same promise.
   */
  destroys?: boolean
}

/**
 * The glossary.
 *
 * Ordered within each group from the one you meet first to the one you meet
 * last, not alphabetically: someone reading this top to bottom is learning, and
 * alphabetical order would open on "ahead" and explain it with four words they
 * have not met yet.
 */
export const GIT_WORDS: readonly GitWord[] = [
  // ---------------------------------------------------------------- places
  {
    term: 'working tree',
    plain: 'your files',
    short: 'Your files on disk, right now.',
    meaning: 'Your files, right now, on disk — what you see in the editor.',
    group: 'places',
  },
  {
    term: 'staged',
    plain: 'picked',
    short: 'Files you have picked for the next save. Not saved yet.',
    meaning:
      'Files you have picked to go into the next save (commit). Picked, and not saved yet — picking changes nothing on disk and nothing in the project history.',
    group: 'places',
  },
  {
    term: 'commit',
    plain: 'save',
    short: 'A save, kept on this machine. Not on GitHub until you send it.',
    meaning:
      'A save: a snapshot of the picked (staged) files, kept forever in this project\'s list of saves — but only on this machine. A save is not on GitHub until you send (push) it.',
    group: 'places',
  },
  {
    term: 'pushed',
    plain: 'sent',
    short: 'Your saves have been sent to GitHub.',
    meaning: 'Your saves (commits) have been sent to GitHub. This is the only step that leaves your machine.',
    group: 'places',
  },
  {
    term: 'untracked',
    plain: 'new to git',
    short: 'A file git has never been told about.',
    meaning:
      'A file git has never been told about. It is not in any save (commit) and will not be in the next one unless you pick (stage) it.',
    group: 'places',
  },

  // ----------------------------------------------------------------- names
  {
    term: 'repo',
    plain: 'the project',
    short: 'A project folder git is watching, and all its saves.',
    meaning: 'A project folder git is watching, plus every save (commit) ever made in it.',
    group: 'names',
  },
  {
    term: 'remote',
    plain: 'the copy elsewhere',
    short: 'A copy of the project somewhere else. Usually GitHub.',
    meaning: 'A copy of the project (repo) that lives somewhere else. Usually GitHub.',
    group: 'names',
  },
  {
    term: 'origin',
    plain: 'your GitHub copy',
    short: 'The nickname for your GitHub copy. Not a magic word.',
    meaning:
      'The nickname git gives the copy elsewhere (the remote). It is not a magic word — "push to origin" means "send it to GitHub".',
    group: 'names',
  },
  {
    term: 'branch',
    plain: 'line of saves',
    short: 'A name marking the newest save in a line of them.',
    meaning:
      'A name marking the newest save (commit) in a line of them. Follow it back through the saves before it and you have the whole line.',
    group: 'names',
  },
  {
    term: 'main',
    plain: 'the usual line',
    short: 'The name of the default line of saves. Also not magic.',
    meaning:
      'Just the name of the default line of saves (branch). Also not magic; it used to be called "master".',
    group: 'names',
  },
  {
    term: 'HEAD',
    plain: 'where you are',
    short: 'Which line of saves you are on, and which save you sit on.',
    meaning: 'Which line of saves (branch) you are on right now, and which save you are sitting on.',
    group: 'names',
  },
  {
    term: 'detached HEAD',
    plain: 'off to one side',
    short: 'You are on one save rather than on a line of saves. Nothing is broken.',
    meaning:
      'You are sitting on one particular save (commit) rather than on a line of saves (branch). Nothing is broken and nothing is lost — but a save made here belongs to no line, so go to a branch before you save.',
    group: 'names',
  },
  {
    term: 'hash',
    plain: 'the save\'s number',
    short: 'The ugly number naming one save, like 1bd321c.',
    meaning:
      'The ugly number that names one save (commit), like 1bd321c. Every save has one, and no two are the same.',
    group: 'names',
  },
  {
    term: 'tag',
    plain: 'sticker',
    short: 'A sticker on one save, so you can find it by name.',
    meaning:
      'A sticker stuck on one save (commit) so you can find it by name — "v1.00" — instead of by its number (its hash). The save itself does not change; it only gets a label.',
    group: 'names',
  },
  {
    term: 'merge commit',
    plain: 'join-up save',
    short: 'The save left where two lines of saves were glued together.',
    meaning:
      'The save (commit) left behind when two lines of saves (branches) are glued together. It is the one save with two saves before it, which is why the picture forks and rejoins there.',
    group: 'names',
  },
  {
    term: '.gitignore',
    plain: 'the never-pick list',
    short: 'A list of files git should never pick: build junk, secrets.',
    meaning:
      'A list of files git should never pick (stage): build output, secrets, huge media. Keep it honest and "pick everything" is safe.',
    group: 'names',
  },

  // ----------------------------------------------------------------- verbs
  {
    term: 'add',
    plain: 'pick',
    short: 'Pick files for the next save. This is "staging".',
    meaning: 'Pick files for the next save (commit). This is what "staging" means.',
    group: 'verbs',
  },
  {
    term: 'commit (verb)',
    plain: 'save',
    short: 'Save the picked files. On this machine only.',
    meaning: 'Save the picked (staged) files. On this machine only — GitHub has not got it yet.',
    group: 'verbs',
  },
  {
    term: 'push',
    plain: 'send',
    short: 'Send your saves to GitHub.',
    meaning:
      'Send your saves (commits) to GitHub. This is the only step that leaves your machine — everything else you do happens here, which is also why this is the one that can be refused.',
    group: 'verbs',
  },
  {
    term: 'pull',
    plain: 'bring in',
    short: 'Get GitHub\'s saves and put them into your files.',
    meaning: 'Get saves (commits) from GitHub and put them into your files.',
    group: 'verbs',
  },
  {
    term: 'fetch',
    plain: 'peek',
    short: 'Look at what is new on GitHub. Touches nothing here.',
    meaning:
      'Peek at what is new on GitHub without touching your files. Nothing you have changes; you only find out where you stand.',
    group: 'verbs',
  },
  {
    term: 'checkout',
    plain: 'go to',
    short: 'Go to another line of saves, or back to an old save.',
    meaning:
      'Go to another line of saves (branch), or back to an old save (commit). Newer git calls this "switch", which is the clearer word.',
    group: 'verbs',
  },
  {
    term: 'merge',
    plain: 'glue together',
    short: 'Glue two lines of saves together. Leaves a join-up save.',
    meaning:
      'Glue two lines of saves (branches) together. It leaves a join-up save (merge commit) behind, so the line forks and rejoins — a knot in the picture.',
    group: 'verbs',
  },
  {
    term: 'rebase',
    plain: 'restart from later',
    short: 'Put their saves first and yours back on the end, so the line stays straight.',
    meaning:
      'Give your saves a new starting point. "Base" is where your saves start from; re-base is starting them somewhere else. Git lifts yours off, puts GitHub\'s in first, then puts yours back on the end — so the line is straight again instead of knotted.',
    group: 'verbs',
  },
  {
    term: 'diff',
    plain: 'what changed',
    short: 'The actual changed lines. + was added, - was taken away.',
    meaning: 'The actual changed lines. A + line was added, a - line was taken away.',
    group: 'verbs',
  },
  {
    term: 'log',
    plain: 'the list of saves',
    short: 'The list of past saves, newest first.',
    meaning: 'The list of past saves (commits), newest first.',
    group: 'verbs',
  },

  // -------------------------------------------------------- disagreement
  {
    term: 'ahead',
    plain: 'you have more',
    short: 'You have saves GitHub has not got.',
    meaning: 'You have saves (commits) GitHub does not have. Sending (pushing) is how it catches up.',
    group: 'disagreement',
  },
  {
    term: 'behind',
    plain: 'GitHub has more',
    short: 'GitHub has saves you have not got.',
    meaning: 'GitHub has saves (commits) you do not have. Bringing them in (pulling) is how you catch up.',
    group: 'disagreement',
  },
  {
    term: 'diverged',
    plain: 'both at once',
    short: 'You each have saves the other is missing. This is what gets a send refused.',
    meaning:
      'You each have saves (commits) the other is missing. This is what makes a send (push) get refused.',
    group: 'disagreement',
  },
  {
    term: 'fast-forward',
    plain: 'the happy case',
    short: 'One straight line, nothing to think about. Every normal send.',
    meaning:
      'Your line of saves is GitHub\'s line plus more on the end — one straight line — so GitHub just slides forward onto yours. This is every normal send (push), which is why you only ever meet the word as its opposite.',
    group: 'disagreement',
  },
  {
    term: 'non-fast-forward',
    plain: 'refused, on purpose',
    short: 'Sending was refused because you have diverged. Nothing is lost.',
    meaning:
      'Also printed as "rejected" or "fetch first". You have diverged: GitHub has saves (commits) you do not, so sending yours would mean GitHub throwing its own away. Git refuses. Git is protecting you — nothing is broken and nothing is lost. Bring GitHub\'s in first (pull), then send (push).',
    group: 'disagreement',
  },
  {
    term: 'conflict',
    plain: 'git is asking',
    short: 'You both changed the same lines. Git is asking which wins. Not damage.',
    meaning:
      'You and the other copy changed the same lines of the same file. Git cannot guess which wins, so it stops and asks, writing both versions into the file between <<<<<<< ======= >>>>>>> markers. Delete the marker lines, keep the code you want, save the file, then pick (add) it. A conflict is not damage.',
    group: 'disagreement',
  },
  {
    term: 'stash',
    plain: 'set aside',
    short: 'Set your unsaved changes aside, to pick up later. A pause, not a delete.',
    meaning:
      'Takes your unsaved changes off your files and holds them to one side, then puts them back when you ask. A pause, not a delete.',
    group: 'disagreement',
  },

  // ------------------------------------------------------------------ undo
  {
    term: 'git reset',
    plain: 'unpick',
    short: 'Unpick. Your files are not touched. Completely safe.',
    meaning: 'Takes files back out of picked (staged). Your files are not touched. Completely safe.',
    group: 'undo',
  },
  {
    term: 'git reset --soft HEAD~1',
    plain: 'undo the last save',
    short: 'Undo the last save, keeping every change picked. Safe.',
    meaning:
      'Undoes the last save (commit) and keeps every change, still picked (staged). For when you saved with a bad message. Safe — your work is still there.',
    group: 'undo',
  },
  {
    term: 'git reset --hard',
    plain: 'undo and bin the changes',
    short: 'Undoes the saves AND bins your changes. This deletes work.',
    meaning:
      'Undoes the saves (commits) and throws your file changes in the bin. This deletes work and there is no undo. The "--hard" is the entire difference between it and the safe ones.',
    group: 'undo',
    destroys: true,
  },
  {
    term: 'git checkout -- <file>',
    plain: 'throw away one file\'s edits',
    short: 'Throws away one file\'s edits. Also destroys work.',
    meaning: 'Throws away your edits to one file, back to the last save (commit). Also destroys work.',
    group: 'undo',
    destroys: true,
  },
]

/** Headings for the Words page, in the order the groups are meant to be read. */
export const WORD_GROUPS: readonly { id: WordGroup; title: string; note: string }[] = [
  {
    id: 'places',
    title: 'The three places your code can be',
    note: 'Everything else is built on this, and it is the only part you have to hold in your head.',
  },
  { id: 'names', title: 'The names that are just names', note: 'None of these are magic. They are labels.' },
  { id: 'verbs', title: 'The verbs', note: 'What each command actually does to your files.' },
  {
    id: 'disagreement',
    title: 'When your copy and GitHub disagree',
    note: 'Every one of these is git refusing to lose something. None of them is damage.',
  },
  {
    id: 'undo',
    title: 'The undo buttons, gentlest first',
    note: 'The last two destroy work. They look almost identical to the first two and are not.',
  },
]

const BY_TERM = new Map(GIT_WORDS.map((w) => [w.term.toLowerCase(), w]))

/** One word's entry, or undefined for a term this glossary does not carry. */
export function gitWord(term: string): GitWord | undefined {
  return BY_TERM.get(term.toLowerCase())
}

/**
 * The plain word for a git term, falling back to the term itself.
 *
 * A fallback rather than a throw, because callers pass words that came out of
 * git — and a pane that crashes on an unfamiliar one would be worse than a pane
 * that prints it untranslated.
 */
export function plainOf(term: string): string {
  return gitWord(term)?.plain ?? term
}

/**
 * The tooltip for a git word: the pair, and one line of meaning.
 *
 * `short`, not `meaning`. A tooltip is read with a cursor already moving and a
 * button already half-pressed, and the paragraph that belongs on the Words page
 * is one nobody finishes standing up. The long version is a click away and
 * always was.
 */
export function tooltipFor(term: string): string {
  const word = gitWord(term)
  if (!word) return term
  return `${word.term} — ${word.plain}\n${word.short}`
}
