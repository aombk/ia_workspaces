import { backend } from '../../backend'
import { store } from '../state'
import {
  fromGhosttyTheme,
  fromWindowsTerminalScheme,
  interfaceThemesFor,
  terminalThemesFor,
} from '../themes'
import { confirmDialog } from './confirm'
import { showToast } from './toast'
import {
  ANSI_KEYS,
  CHROME_KEYS,
  COLOR_LABELS,
  TERMINAL_CORE_KEYS,
  roundnessOf,
  type Roundness,
  coerceInterfaceTheme,
  coerceTerminalTheme,
  duplicateInterfaceTheme,
  duplicateTerminalTheme,
  isValidHex,
  type InterfaceTheme,
  type TerminalTheme,
} from '../../shared/themes'

/**
 * Theme editor.
 *
 * Built-in themes are read-only; choosing to edit one duplicates it first so a
 * user can always get back to a known-good starting point. Every change writes
 * through immediately and re-applies live, because picking colours blind is
 * miserable.
 */

/** Rebuilds the settings panel — safe only between interactions. */
let onChanged: () => void = () => {}
/**
 * Repaints the app from the saved theme *without* touching the settings DOM.
 *
 * Sliders and colour pickers fire continuously while dragging, and rebuilding
 * the panel on each tick destroys the very control under the cursor — which is
 * what made the opacity slider impossible to drag.
 */
let onLivePreview: () => void = () => {}
/**
 * Which theme is open in the editor, by kind and id — never the object.
 *
 * The two kinds live in different lists and are edited by different code, so
 * "the theme being edited" is not a single type any more. Holding the id and
 * looking it up per render also means a live edit cannot leave a stale copy
 * behind, which a held object did.
 */
type ThemeKind = 'interface' | 'terminal'
let editing: { kind: ThemeKind; id: string } | null = null

export function initThemeEditor(cb: () => void, live: () => void): void {
  onChanged = cb
  onLivePreview = live
}

export function renderThemeSection(container: HTMLElement): void {
  container.replaceChildren()
  if (editing) renderEditor(container)
  else renderList(container)
}


// ------------------------------------------------------- the two theme kinds

/**
 * Everything that differs between the two systems, in one table.
 *
 * They share no data and no storage, so the only thing worth sharing is the
 * shape of the operations — list, save, delete, duplicate, select. Written out
 * once here, the list and editor below can be built for either kind without
 * either of them growing a branch per button.
 */
interface Kind {
  label: string
  subtitle: string
  list(): { id: string; name: string; builtin: boolean }[]
  selectedId(): string
  select(id: string): void
  save(theme: never): void
  remove(id: string): void
  duplicate(id: string, newId: string, name: string): { id: string } | null
}

const KINDS: Record<ThemeKind, Kind> = {
  interface: {
    label: 'Interface',
    subtitle: 'Sidebar, tabs, panels — and the window itself',
    list: () => interfaceThemesFor(store.settings),
    selectedId: () => store.settings.themeId,
    select: (id) => store.updateSettings({ themeId: id }),
    save: (theme) => store.upsertCustomTheme(theme as unknown as InterfaceTheme),
    remove: (id) => store.removeCustomTheme(id),
    duplicate: (id, newId, name) => {
      const source = interfaceThemesFor(store.settings).find((t) => t.id === id)
      if (!source) return null
      const copy = duplicateInterfaceTheme(source, newId, name)
      store.upsertCustomTheme(copy)
      return copy
    },
  },
  terminal: {
    label: 'Terminal & ANSI',
    subtitle: 'The grid, and the 16 colours programs ask for by number',
    list: () => terminalThemesFor(store.settings),
    selectedId: () => store.settings.terminalThemeId || store.settings.themeId,
    select: (id) => store.updateSettings({ terminalThemeId: id }),
    save: (theme) => store.upsertCustomTerminalTheme(theme as unknown as TerminalTheme),
    remove: (id) => store.removeCustomTerminalTheme(id),
    duplicate: (id, newId, name) => {
      const source = terminalThemesFor(store.settings).find((t) => t.id === id)
      if (!source) return null
      const copy = duplicateTerminalTheme(source, newId, name)
      store.upsertCustomTerminalTheme(copy)
      return copy
    },
  },
}

/** The theme being edited, read back from the store so live edits stick. */
function editingTheme(): (InterfaceTheme | TerminalTheme) | null {
  if (!editing) return null
  const found = KINDS[editing.kind].list().find((t) => t.id === editing!.id)
  return (found as InterfaceTheme | TerminalTheme | undefined) ?? null
}

function uniqueNameFor(kind: ThemeKind, base: string): string {
  const taken = new Set(KINDS[kind].list().map((t) => t.name))
  if (!taken.has(base)) return base
  for (let i = 2; i < 999; i++) {
    const candidate = `${base} ${i}`
    if (!taken.has(candidate)) return candidate
  }
  return base
}

/** Opens a theme for editing, duplicating first when it cannot be modified. */
function openThemeOf(kind: ThemeKind, id: string): void {
  const source = KINDS[kind].list().find((t) => t.id === id)
  if (!source) return
  if (source.builtin) {
    const copy = KINDS[kind].duplicate(
      id,
      crypto.randomUUID(),
      uniqueNameFor(kind, `${source.name} custom`)
    )
    if (!copy) return
    KINDS[kind].select(copy.id)
    editing = { kind, id: copy.id }
  } else {
    editing = { kind, id }
  }
  onChanged()
}

// --------------------------------------------------------------------- list

/** Copies a theme, selects the copy, and stays on the list. */
function duplicateThemeOf(kind: ThemeKind, id: string): void {
  const source = KINDS[kind].list().find((t) => t.id === id)
  if (!source) return
  const copy = KINDS[kind].duplicate(
    id,
    crypto.randomUUID(),
    uniqueNameFor(kind, `${source.name} copy`)
  )
  if (!copy) return
  KINDS[kind].select(copy.id)
  onChanged()
}

/**
 * One column: a list of themes for one kind, and the actions for that kind.
 *
 * Each column is self-contained — its own list, its own selection, its own
 * Edit/Duplicate/Delete. Nothing in the left column can reach the right one,
 * which is the point: they are two theme systems that happen to sit side by
 * side. Importing and exporting live in the editor, so both columns carry the
 * same three buttons and the two halves stay aligned.
 *
 * `column` is a `display: contents` wrapper: head, list and actions land in the
 * shared grid rows of `.theme-columns` so the two columns line up row for row
 * whatever length their contents are.
 */
function renderThemeColumn(kind: ThemeKind, index: number): HTMLElement {
  const spec = KINDS[kind]
  const column = document.createElement('div')
  column.className = `theme-column theme-column--${index}`

  const head = document.createElement('div')
  head.className = 'theme-column__head'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = spec.label
  const hint = document.createElement('span')
  hint.className = 'hint'
  hint.textContent = spec.subtitle
  head.append(name, hint)
  column.appendChild(head)

  const list = document.createElement('div')
  list.className = 'theme-list'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', spec.label)

  const selectedId = spec.selectedId()
  for (const theme of spec.list()) {
    const selected = theme.id === selectedId
    const row = document.createElement('button')
    row.className = 'theme-row' + (selected ? ' selected' : '')
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(selected))
    row.textContent = theme.name
    row.title = theme.builtin ? `${theme.name} (built-in)` : theme.name

    row.addEventListener('click', () => {
      spec.select(theme.id)
      onChanged()
    })
    row.addEventListener('dblclick', () => openThemeOf(kind, theme.id))
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openThemeOf(kind, theme.id)
    })

    list.appendChild(row)
  }
  column.appendChild(list)

  const current = spec.list().find((t) => t.id === selectedId)
  const actions = document.createElement('div')
  actions.className = 'theme-actions'
  if (current) {
    actions.appendChild(button('Edit', () => openThemeOf(kind, current.id), true))
    actions.appendChild(button('Duplicate', () => duplicateThemeOf(kind, current.id)))

    // Rendered even for a built-in, only disabled: three buttons in both
    // columns whatever is selected, so nothing below them jumps as the
    // selection moves.
    const del = button('Delete', async () => {
      const ok = await confirmDialog({
        title: `Delete “${current.name}”?`,
        body: 'This removes the theme. Built-in themes are unaffected.',
        confirmLabel: 'Delete',
        danger: true,
      })
      if (!ok) return
      spec.remove(current.id)
      onChanged()
    })
    del.disabled = current.builtin
    if (current.builtin) del.title = 'Built-in themes cannot be deleted. Duplicate it first.'
    actions.appendChild(del)
  }
  column.appendChild(actions)

  return column
}

function renderList(container: HTMLElement): void {
  const columns = document.createElement('div')
  columns.className = 'theme-columns'
  columns.appendChild(renderThemeColumn('interface', 0))
  columns.appendChild(renderThemeColumn('terminal', 1))
  container.appendChild(columns)

  const hint = document.createElement('p')
  hint.className = 'theme-hint'
  hint.textContent =
    'Double-click a theme to edit it. Built-in themes are duplicated first. Shape, import and export live in the editor.'
  container.appendChild(hint)
}

// ------------------------------------------------------------------- editor

function renderEditor(container: HTMLElement): void {
  const theme = editingTheme()
  if (!theme || theme.builtin || !editing) {
    editing = null
    renderList(container)
    return
  }
  const kind = editing.kind

  const head = document.createElement('div')
  head.className = 'theme-editor-head'
  head.appendChild(
    button('‹ All themes', () => {
      editing = null
      onChanged()
    })
  )

  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.value = theme.name
  nameInput.className = 'theme-name-input'
  nameInput.spellcheck = false
  nameInput.addEventListener('change', () => {
    patch({ name: nameInput.value.trim() || theme.name })
  })
  head.appendChild(nameInput)

  const which = document.createElement('span')
  which.className = 'hint'
  which.textContent = KINDS[kind].label
  head.appendChild(which)
  container.appendChild(head)

  // Each editor shows only what its own kind owns. The interface editor has no
  // ANSI section to scroll past, and the terminal editor has no window colours
  // it could never affect.
  if (kind === 'interface') {
    container.appendChild(colorGroup('Window colours', CHROME_KEYS as string[], 'chrome', theme))
    container.appendChild(shapeGroup(theme as InterfaceTheme))
  } else {
    container.appendChild(colorGroup('Terminal', TERMINAL_CORE_KEYS as string[], 'terminal', theme))
    container.appendChild(colorGroup('ANSI colours', ANSI_KEYS as string[], 'terminal', theme))
  }

  // The file operations belong here rather than on the list: they are all about
  // one theme's colours, and the list is only for choosing which theme that is.
  const files = document.createElement('div')
  files.className = 'theme-actions theme-actions--files'
  files.appendChild(button('Load from file…', () => void loadIntoEditing()))
  files.appendChild(button('Save to file…', () => exportTheme(theme)))
  if (kind === 'terminal') {
    // Terminal-only: a Ghostty or Windows Terminal file is a terminal palette
    // and says nothing about a sidebar. Both can carry several palettes, so
    // they arrive as new themes rather than overwriting this one.
    files.appendChild(button('Use my Ghostty palette', () => void importGhosttyConfig()))
    files.appendChild(button('Import Ghostty…', () => void importGhostty()))
    files.appendChild(button('Import Windows Terminal…', () => void importWindowsTerminal()))
  }
  container.appendChild(files)

  const actions = document.createElement('div')
  actions.className = 'theme-actions'
  actions.appendChild(
    button(
      'Done',
      () => {
        editing = null
        onChanged()
      },
      true
    )
  )
  container.appendChild(actions)
}

/**
 * The interface theme's non-colour properties: how corners and markers are cut.
 *
 * In the editor rather than beside the list because they are part of a theme
 * like any colour is — saved with it, exported with it, and back when it is
 * loaded again. Outside, they read as app settings that happen to move when the
 * theme does, and reaching them while a read-only built-in was selected meant
 * silently duplicating it under the user.
 */
function shapeGroup(theme: InterfaceTheme): HTMLElement {
  const section = document.createElement('div')
  section.className = 'theme-group'

  const heading = document.createElement('h4')
  heading.textContent = 'Shape'
  section.appendChild(heading)

  // A select rather than a slider: the three levels are designed sets of radii,
  // not points on a continuum, and a fourth of a pixel between them is not a
  // choice anybody wants to make.
  section.appendChild(
    selectField(
      'Corner rounding',
      'Panels, menus, dialogs and scrollbars. Square also squares the window itself, ' +
        'which takes effect next time the app starts.',
      [
        ['full', 'Full'],
        ['subtle', 'Subtle'],
        ['square', 'Square'],
      ],
      roundnessOf(theme),
      (value) => patch({ roundness: value as Roundness })
    )
  )

  // Its own control, not a consequence of the rounding above: see `workspaceDots`.
  section.appendChild(
    selectField(
      'Workspace markers',
      'The colour marker in front of each workspace. Independent of corner rounding.',
      [
        ['circle', 'Circles'],
        ['square', 'Squares'],
      ],
      theme.workspaceDots ?? 'circle',
      (value) => patch({ workspaceDots: value as 'circle' | 'square' })
    )
  )

  return section
}

function selectField(
  name: string,
  hint: string,
  options: [string, string][],
  value: string,
  onPick: (value: string) => void
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'field'

  const label = document.createElement('div')
  label.className = 'field-label'
  const title = document.createElement('span')
  title.className = 'name'
  title.textContent = name
  const note = document.createElement('span')
  note.className = 'hint'
  note.textContent = hint
  label.append(title, note)

  const select = document.createElement('select')
  for (const [optionValue, text] of options) {
    const option = document.createElement('option')
    option.value = optionValue
    option.textContent = text
    select.appendChild(option)
  }
  select.value = value
  select.addEventListener('change', () => onPick(select.value))

  const control = document.createElement('div')
  control.className = 'field-control'
  control.appendChild(select)
  row.append(label, control)
  return row
}

function colorGroup(
  title: string,
  keys: string[],
  surface: 'chrome' | 'terminal',
  theme: InterfaceTheme | TerminalTheme
): HTMLElement {
  const section = document.createElement('div')
  section.className = 'theme-group'

  const heading = document.createElement('h4')
  heading.textContent = title
  section.appendChild(heading)

  const grid = document.createElement('div')
  grid.className = 'color-grid'

  for (const key of keys) {
    const palette = (theme as unknown as Record<string, Record<string, string>>)[surface]
    const value = palette[key]

    const row = document.createElement('label')
    row.className = 'color-row'

    const picker = document.createElement('input')
    picker.type = 'color'
    picker.value = value
    picker.addEventListener('input', () => {
      applyColor(surface, key, picker.value)
      hexInput.value = picker.value
    })

    const label = document.createElement('span')
    label.className = 'color-label'
    label.textContent = COLOR_LABELS[key] ?? key

    const hexInput = document.createElement('input')
    hexInput.type = 'text'
    hexInput.className = 'color-hex'
    hexInput.value = value
    hexInput.spellcheck = false
    hexInput.addEventListener('change', () => {
      const next = hexInput.value.trim()
      if (!isValidHex(next)) {
        // Put back whatever is actually stored rather than leaving junk.
        const saved = editingTheme() as unknown as Record<string, Record<string, string>> | null
        hexInput.value = saved?.[surface]?.[key] ?? value
        return
      }
      picker.value = next
      applyColor(surface, key, next)
    })

    row.append(picker, label, hexInput)
    grid.appendChild(row)
  }

  section.appendChild(grid)
  return section
}

/** Writes one colour through without rebuilding the whole editor DOM. */
function applyColor(surface: 'chrome' | 'terminal', key: string, value: string): void {
  const theme = editingTheme()
  if (!theme) return
  const current = (theme as unknown as Record<string, Record<string, string>>)[surface]
  patch({ [surface]: { ...current, [key]: value } }, false)
}

/**
 * `rerender` is false for the high-frequency controls (colour pickers): the
 * change is saved and repainted, but the panel's DOM is left alone so the
 * control keeps focus and the drag continues.
 */
function patch(changes: Record<string, unknown>, rerender = true): void {
  const theme = editingTheme()
  if (!theme || !editing) return
  KINDS[editing.kind].save({ ...theme, ...changes } as never)
  if (rerender) onChanged()
  else onLivePreview()
}

// ------------------------------------------------------------ import/export

function exportTheme(theme: { name: string }): void {
  const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${theme.name.replace(/[^\w.-]+/g, '-').toLowerCase()}.iaw-theme.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Ghostty ships one theme per file, so this takes several at once — importing a
 * collection is the normal case, and doing it one file at a time would be a
 * chore rather than a feature.
 */
/**
 * The palette out of the user's own Ghostty configuration, wherever it lives.
 *
 * Ghostty's config is the same `key = value` / `palette = N=#rrggbb` shape as a
 * theme file, so the parser is already written — the only thing missing was
 * knowing where to look, which is a file picker's worth of friction for the one
 * palette somebody is most likely to want.
 *
 * Both documented locations are tried and the first readable one wins. Nothing
 * is written and nothing is watched: this is an import, so the palette becomes
 * a theme of yours that Ghostty cannot subsequently change under you.
 */
async function importGhosttyConfig(): Promise<void> {
  const home = await backend().homeDir()
  const candidates = [
    // XDG on Linux, and Ghostty honours it on macOS too when it is set.
    `${home}/.config/ghostty/config`,
    // The macOS application-support location.
    `${home}/Library/Application Support/com.mitchellh.ghostty/config`,
  ]

  for (const candidate of candidates) {
    let text: string
    try {
      text = await backend().readText(candidate)
    } catch {
      continue
    }
    const theme = fromGhosttyTheme(text, crypto.randomUUID(), 'Ghostty')
    if (!theme) {
      showToast('Nothing to import', `${candidate} sets no background and foreground.`, {
        kind: 'warn',
      })
      return
    }
    theme.name = uniqueNameFor('terminal', theme.name)
    store.upsertCustomTerminalTheme(theme)
    selectImported(theme.id)
    onChanged()
    showToast('Imported your Ghostty palette', candidate)
    return
  }

  showToast('No Ghostty config found', `Looked in ${candidates.join(' and ')}.`, { kind: 'warn' })
}

async function importGhostty(): Promise<void> {
  const files = await pickFiles('.theme,.conf,.txt,*/*')
  if (!files.length) return

  let imported = 0
  let lastId: string | null = null
  for (const file of files) {
    const theme = fromGhosttyTheme(await file.text(), crypto.randomUUID(), stripExtension(file.name))
    if (!theme) continue
    theme.name = uniqueNameFor('terminal', theme.name)
    store.upsertCustomTerminalTheme(theme)
    lastId = theme.id
    imported++
  }

  if (!imported) {
    showToast('Nothing imported', 'No file had both a background and a foreground.', { kind: 'warn' })
    return
  }
  if (lastId) selectImported(lastId)
  onChanged()
  showToast(
    `Imported ${imported} theme${imported === 1 ? '' : 's'}`,
    imported === 1 ? 'Switched to it.' : 'Switched to the last one.'
  )
}

/**
 * Selects a freshly imported palette and, if the editor is open, follows it.
 *
 * These importers are reached from inside the editor, so leaving the editor on
 * the theme you were editing while the app repaints in the imported one is the
 * one thing that would not make sense.
 */
function selectImported(id: string): void {
  store.updateSettings({ terminalThemeId: id })
  if (editing?.kind === 'terminal') editing = { kind: 'terminal', id }
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name
}

function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = accept
    input.addEventListener('change', () => resolve([...(input.files ?? [])]))
    input.click()
  })
}

function pickJsonFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      resolve(file ? await file.text() : null)
    })
    input.click()
  })
}

/**
 * Loads a theme file *into the theme being edited* — colours only.
 *
 * The id and the name stay, so a file replaces what a theme looks like without
 * replacing the theme itself: nothing that points at it — the selection, the
 * other column — has to be updated, and loading the wrong file is undone by
 * loading the right one. To keep an imported theme separate, duplicate first
 * and load into the copy.
 *
 * Also the way a pre-split export gets back in: those files carry both halves,
 * and each `coerce` reads only the half its own kind owns.
 */
async function loadIntoEditing(): Promise<void> {
  const theme = editingTheme()
  if (!theme || !editing) return
  const kind = editing.kind

  const text = await pickJsonFile()
  if (!text) return
  try {
    const raw = JSON.parse(text) as unknown
    if (kind === 'interface') {
      const next = coerceInterfaceTheme(raw, theme as InterfaceTheme, theme.id, theme.name)
      store.upsertCustomTheme(next)
    } else {
      const next = coerceTerminalTheme(raw, theme as TerminalTheme, theme.id, theme.name)
      store.upsertCustomTerminalTheme(next)
    }
    onChanged()
    showToast('Theme loaded', `Colours replaced in “${theme.name}”.`)
  } catch {
    showToast('Could not load theme', 'That file is not valid theme JSON.', { kind: 'error' })
  }
}

/**
 * Windows Terminal keeps its colour schemes in settings.json. Importing them
 * means an existing setup carries over instead of being rebuilt by hand.
 */
async function importWindowsTerminal(): Promise<void> {
  const text = await pickJsonFile()
  if (!text) return
  try {
    // WT's settings.json allows // and /* */ comments, which JSON.parse rejects.
    const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const parsed = JSON.parse(cleaned) as { schemes?: Record<string, unknown>[] }
    const schemes = parsed.schemes ?? []
    if (!schemes.length) {
      showToast('No schemes found', 'That file has no "schemes" array.', { kind: 'warn' })
      return
    }

    let imported = 0
    let lastId: string | null = null
    for (const scheme of schemes) {
      const theme = fromWindowsTerminalScheme(scheme, crypto.randomUUID())
      if (!theme) continue
      theme.name = uniqueNameFor('terminal', theme.name)
      store.upsertCustomTerminalTheme(theme)
      lastId = theme.id
      imported++
    }

    if (!imported) {
      showToast('Nothing imported', 'No scheme had both a background and foreground.', {
        kind: 'warn',
      })
      return
    }
    if (lastId) selectImported(lastId)
    onChanged()
    showToast(`Imported ${imported} scheme${imported === 1 ? '' : 's'}`, 'Switched to the last one.')
  } catch {
    showToast('Could not read that file', 'Expected a Windows Terminal settings.json.', {
      kind: 'error',
    })
  }
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'btn' + (primary ? ' primary' : '')
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}
