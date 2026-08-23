/**
 * Enough Markdown to read a README, and nothing more.
 *
 * Hand-rolled rather than pulled in, for the same reason the icon generator is:
 * this is a terminal, and a Markdown library is a dependency, a bundle-size
 * increase and a supply-chain surface for a feature that renders headings and
 * code fences.
 *
 * Deliberately *not* CommonMark. No raw HTML passthrough, no reference links,
 * no nested block quotes. Raw HTML is the important omission — a README is a
 * file from a repository you may have only just cloned, and passing its HTML
 * into the document would make reading one an execution.
 *
 * Returns a DOM fragment, not an HTML string: nothing here is ever parsed as
 * markup, so text can only ever become text.
 */
import { encodeImagePath } from '../shared/images'
import { renderFlowchart } from './flowchart'

/** The folder part of a file path, for resolving what it points at. */
export function folderOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut < 0 ? '' : file.slice(0, cut)
}

/**
 * Resolves a Markdown image path against the folder its file sits in.
 *
 * Returns null for anything that should not become an `<img>`: an absolute URL
 * (see `inline` for why remote images are not loaded), a `data:` payload, or a
 * path given with no folder to resolve it against.
 *
 * `..` is honoured because README images genuinely live above the file — a doc
 * in `docs/` reaching `../screenshots/x.png` is ordinary — and there is nothing
 * to defend here: the pane can already open any file on disk, so a path that
 * climbs out of the folder grants no reach the user did not already have.
 */
function resolveImage(src: string, baseDir: string): string | null {
  if (!baseDir) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null

  const sep = baseDir.includes('\\') ? '\\' : '/'
  // Already absolute — a POSIX root, a drive letter or a UNC share.
  const absolute = /^([/\\]|[a-z]:)/i.test(src)
  const parts = absolute ? [] : baseDir.split(/[/\\]/)

  for (const part of src.split(/[/\\]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return absolute ? src : parts.join(sep)
}

/**
 * Inline: `code`, **strong**, *em*, ![image](src), [link](url). In that order,
 * and the image rule sits ahead of the link rule because `![a](b)` contains a
 * complete `[a](b)` — matched the other way round, every image renders as a
 * link with a stray `!` in front of it.
 */
function inline(text: string, baseDir = ''): DocumentFragment {
  const frag = document.createDocumentFragment()
  // Code first and greedily consumed, so ** inside a span of code stays literal
  // — and an HTML comment second, for the same reason: `<!-- x -->` written
  // inside backticks is being shown on purpose. Everywhere else it is a note to
  // whoever edits the file and renders as nothing, which is what every other
  // Markdown reader does with one. The alternative has no capture group, so the
  // numbering below is unaffected.
  // `[[name]]` sits before the ordinary link rule, because `[` starts both and
  // the ordinary one would otherwise take the first bracket and leave a stray
  // one behind. See `wiki` below for what it becomes.
  const pattern =
    /`([^`]+)`|<!--[\s\S]*?-->|\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)/
  let rest = text

  while (rest) {
    const match = pattern.exec(rest)
    if (!match) break
    if (match.index > 0) frag.appendChild(document.createTextNode(rest.slice(0, match.index)))

    const [, code, wikiTarget, wikiText, strong1, strong2, em1, em2, alt, src, linkText, href] = match
    if (match[0].startsWith('<!--')) {
      // Nothing: the comment is dropped and the text either side closes up.
    } else if (wikiTarget !== undefined) {
      // `[[note]]`, or `[[note|what to call it]]`. The convention Obsidian and
      // every wiki before it use, and the reason people keep notes that way:
      // linking is one pair of brackets rather than a path anybody has to be
      // right about.
      //
      // Nothing is resolved here. Whether `note.md` exists is a question for a
      // filesystem, and this function is given a string — the pane that shows
      // the document decides what a click does, which is also what makes the
      // same markup work in the editor's preview and in the reader.
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'md-wikilink'
      el.dataset.wiki = wikiTarget.trim()
      el.textContent = (wikiText ?? wikiTarget).trim()
      el.title = `Open ${wikiTarget.trim()}`
      frag.appendChild(el)
    } else if (src !== undefined) {
      // Local files only, through the app's own image protocol. A remote image
      // is a network request made by opening a file, which tells whoever is
      // serving it that you read this README and from where — the same reason
      // raw HTML is not passed through. Those keep their alt text instead.
      const target = resolveImage(src, baseDir)
      if (target) {
        const el = document.createElement('img')
        el.className = 'md-image'
        el.src = encodeImagePath(target)
        el.alt = alt ?? ''
        el.loading = 'lazy'
        // A path that is simply wrong should read as a caption, not as a torn
        // icon: swap the broken image for the words the author wrote.
        el.addEventListener('error', () => {
          const note = document.createElement('span')
          note.className = 'md-image-missing'
          note.textContent = alt ? `[${alt}]` : `[${src}]`
          el.replaceWith(note)
        })
        frag.appendChild(el)
      } else {
        const note = document.createElement('span')
        note.className = 'md-image-missing'
        note.textContent = alt ? `[${alt}]` : `[${src}]`
        frag.appendChild(note)
      }
    } else if (code !== undefined) {
      const el = document.createElement('code')
      el.textContent = code
      frag.appendChild(el)
    } else if (strong1 !== undefined || strong2 !== undefined) {
      const el = document.createElement('strong')
      el.textContent = strong1 ?? strong2
      frag.appendChild(el)
    } else if (em1 !== undefined || em2 !== undefined) {
      const el = document.createElement('em')
      el.textContent = em1 ?? em2
      frag.appendChild(el)
    } else {
      const el = document.createElement('a')
      el.textContent = linkText
      // Only http(s) survives as a link. `javascript:` is the reason, and a
      // relative path is the other: it would resolve against the app's own
      // origin and mean nothing.
      if (/^https?:\/\//i.test(href)) el.dataset.href = href
      else el.className = 'md-link-inert'
      frag.appendChild(el)
    }
    rest = rest.slice(match.index + match[0].length)
  }

  if (rest) frag.appendChild(document.createTextNode(rest))
  return frag
}

/**
 * Renders Markdown source into a fragment ready to mount.
 *
 * `baseDir` is the folder the source came from, which is what makes a relative
 * image path mean anything. Omitted — for text with no file behind it — images
 * fall back to their alt text rather than pointing at nowhere.
 */
export function renderMarkdown(source: string, baseDir = ''): DocumentFragment {
  const out = document.createDocumentFragment()
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let i = 0

  /** Collects the run of list items starting here into one list element. */
  const takeList = (ordered: boolean): HTMLElement => {
    const list = document.createElement(ordered ? 'ol' : 'ul')
    const item = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/
    while (i < lines.length) {
      const m = item.exec(lines[i])
      if (!m) break
      const li = document.createElement('li')
      li.appendChild(inline(m[1], baseDir))
      list.appendChild(li)
      i++
    }
    return list
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code. The closing fence is optional so an unterminated block at
    // the end of a file still renders as code rather than swallowing nothing.
    const fence = /^\s*```(\S*)\s*$/.exec(line)
    if (fence) {
      i++
      const body: string[] = []
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      if (i < lines.length) i++
      // A mermaid block becomes a picture where we can draw it, and stays the
      // code it is where we cannot — a diagram that silently omits the box it
      // failed to parse is worse than the text it replaced. See
      // `shared/flowchart.ts` for exactly which syntax is understood.
      if (fence[1]?.toLowerCase() === 'mermaid') {
        const drawn = renderFlowchart(body.join('\n'))
        if (drawn) {
          const figure = document.createElement('div')
          figure.className = 'flowchart-figure'
          figure.appendChild(drawn)
          out.appendChild(figure)
          continue
        }
      }

      const pre = document.createElement('pre')
      const code = document.createElement('code')
      if (fence[1]) code.dataset.lang = fence[1]
      code.textContent = body.join('\n')
      pre.appendChild(code)
      out.appendChild(pre)
      continue
    }

    // A comment block, which a README uses for notes to whoever edits it: a
    // shot list, a "keep this in sync with", a paragraph parked rather than
    // deleted. GitHub shows none of it, and neither did this until now — the
    // lines fell through to the paragraph branch and were rendered as their own
    // literal text, so our preview was the one place the note was visible.
    //
    // After the fence check, so `<!--` inside a code block is already spoken
    // for: code showing a comment is showing it deliberately.
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !lines[i].includes('-->')) i++
      if (i < lines.length) {
        // Anything written after the close on that same line is content, and
        // goes back through the loop as if it were a line of its own.
        const tail = lines[i].slice(lines[i].indexOf('-->') + 3)
        if (tail.trim()) {
          lines[i] = tail
          continue
        }
        i++
      }
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const el = document.createElement(`h${heading[1].length}`)
      el.appendChild(inline(heading[2], baseDir))
      out.appendChild(el)
      i++
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.appendChild(document.createElement('hr'))
      i++
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      const el = document.createElement('blockquote')
      const parts: string[] = []
      while (i < lines.length) {
        const q = /^\s*>\s?(.*)$/.exec(lines[i])
        if (!q) break
        parts.push(q[1])
        i++
      }
      el.appendChild(inline(parts.join(' '), baseDir))
      out.appendChild(el)
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      out.appendChild(takeList(false))
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      out.appendChild(takeList(true))
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    // A paragraph runs until a blank line or anything that starts a block.
    const parts: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) parts.push(lines[i++])
    const p = document.createElement('p')
    p.appendChild(inline(parts.join(' '), baseDir))
    out.appendChild(p)
  }

  return out
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    // So a comment following a line of prose ends the paragraph rather than
    // being folded into it, where the inline rule would drop it but the two
    // paragraphs either side would already have been joined into one.
    /^\s*<!--/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line)
  )
}
