/**
 * The app's context menus, including the ones that open a second menu.
 *
 * A submenu rather than a longer list: an editor has a dozen line operations
 * and three case conversions, and a flat menu of twenty items is a menu nobody
 * reads. The rule for what earns a submenu is that its contents share a verb —
 * "line", "case" — so the parent label says what is inside without listing it.
 *
 * Menus close on a press outside, and a submenu closes as soon as the pointer
 * moves to a sibling. There is no timer and no hover delay: the parent stays
 * open while the pointer is anywhere inside either menu, which is what a
 * diagonal sweep to reach the child needs.
 */
export interface MenuItem {
  label: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /** Drawn with a state dot: filled when this is the one in effect, hollow otherwise. */
  checked?: boolean
  /** Opens to the right instead of doing something. */
  submenu?: MenuEntry[]
  onClick?(): void
}

export interface SwatchRow {
  kind: 'swatches'
  colors: readonly string[]
  selected: string
  onPick(color: string): void
}

export type MenuEntry = MenuItem | 'separator' | SwatchRow

const el = () => document.getElementById('context-menu') as HTMLDivElement

/**
 * The colour a checked item's dot is drawn in.
 *
 * Set from the active workspace on every render. It is pushed in rather than
 * read, because this file deliberately imports nothing — it is the one piece of
 * UI that every other piece calls, and a dependency on the store here would
 * make it a dependency of everything.
 */
let accent = ''

export function setMenuAccent(color: string): void {
  accent = color
}

/** Applies the accent to a freshly built menu, root or submenu. */
function paint(menu: HTMLDivElement): void {
  if (accent) menu.style.setProperty('--workspace-color', accent)
  else menu.style.removeProperty('--workspace-color')
}

let closeHandler: ((event?: Event) => void) | null = null
/** Submenus, innermost last. The root menu is not in here. */
let children: HTMLDivElement[] = []

export function showContextMenu(x: number, y: number, entries: MenuEntry[]): void {
  const menu = el()
  closeChildren(0)
  fill(menu, entries, 0)
  paint(menu)

  // Place it, then nudge back inside the viewport if it would overflow.
  menu.hidden = false
  menu.style.left = '0px'
  menu.style.top = '0px'
  const rect = menu.getBoundingClientRect()
  const left = Math.min(x, window.innerWidth - rect.width - 8)
  const top = Math.min(y, window.innerHeight - rect.height - 8)
  menu.style.left = `${Math.max(8, left)}px`
  menu.style.top = `${Math.max(8, top)}px`

  // Close on any press *outside* every open menu. Closing on a press inside
  // would hide the button before its click event could fire, which silently
  // killed every menu item.
  closeHandler = (event?: Event) => {
    if (event && event.type === 'mousedown') {
      const target = event.target
      if (target instanceof Node && [menu, ...children].some((m) => m.contains(target))) return
    }
    hideContextMenu()
  }

  setTimeout(() => {
    window.addEventListener('mousedown', closeHandler!, true)
    window.addEventListener('resize', closeHandler!, { once: true })
  }, 0)
}

export function hideContextMenu(): void {
  closeChildren(0)
  el().hidden = true
  if (closeHandler) {
    window.removeEventListener('mousedown', closeHandler, true)
    window.removeEventListener('resize', closeHandler)
    closeHandler = null
  }
}

/** Builds one menu's contents. `depth` is 0 for the root. */
function fill(menu: HTMLDivElement, entries: MenuEntry[], depth: number): void {
  menu.replaceChildren()

  for (const entry of entries) {
    if (entry === 'separator') {
      const sep = document.createElement('div')
      sep.className = 'sep'
      menu.appendChild(sep)
      continue
    }

    if ('kind' in entry) {
      const row = document.createElement('div')
      row.className = 'swatches'
      for (const color of entry.colors) {
        const swatch = document.createElement('button')
        swatch.className = 'swatch' + (color === entry.selected ? ' selected' : '')
        swatch.style.background = color
        swatch.title = color
        swatch.addEventListener('click', () => {
          entry.onPick(color)
          hideContextMenu()
        })
        row.appendChild(swatch)
      }
      menu.appendChild(row)
      continue
    }

    const button = document.createElement('button')
    if (entry.danger) button.classList.add('danger')
    button.disabled = Boolean(entry.disabled)

    // A dot rather than a tick, and present on every item in a group that has
    // any — an unchecked one draws a hollow ring, so the labels beside them all
    // start at the same x. A tick that appeared and vanished shifted every
    // label in the menu by its own width depending on what was selected.
    if (entry.checked !== undefined) {
      const dot = document.createElement('span')
      dot.className = 'check' + (entry.checked ? ' on' : '')
      button.appendChild(dot)
    }

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = entry.label
    button.appendChild(label)

    if (entry.submenu) {
      button.classList.add('has-submenu')
      const arrow = document.createElement('span')
      arrow.className = 'shortcut'
      arrow.textContent = '›'
      button.appendChild(arrow)

      const open = () => {
        if (entry.disabled) return
        closeChildren(depth)
        openSubmenu(button, entry.submenu!, depth + 1)
      }
      // Pointer in: open. Click: open too, for anyone who clicks a category
      // rather than resting on it.
      button.addEventListener('mouseenter', open)
      button.addEventListener('click', open)
    } else {
      // Moving onto a plain item closes whatever a sibling category opened,
      // so two submenus are never on screen at once.
      button.addEventListener('mouseenter', () => closeChildren(depth))
      button.addEventListener('click', () => {
        hideContextMenu()
        entry.onClick?.()
      })
    }

    if (entry.shortcut) {
      const shortcut = document.createElement('span')
      shortcut.className = 'shortcut'
      shortcut.textContent = entry.shortcut
      button.appendChild(shortcut)
    }

    menu.appendChild(button)
  }
}

/** Opens a submenu beside its parent item, flipping left when there is no room. */
function openSubmenu(parent: HTMLElement, entries: MenuEntry[], depth: number): void {
  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.style.position = 'fixed'
  document.body.appendChild(menu)
  children.push(menu)
  fill(menu, entries, depth)
  paint(menu)

  const anchor = parent.getBoundingClientRect()
  const rect = menu.getBoundingClientRect()
  // Overlap the parent's border by a couple of pixels: a gap between the two
  // menus is a gap the pointer can fall into, closing the thing it is aiming at.
  const right = anchor.right - 2
  const left = right + rect.width > window.innerWidth - 8 ? anchor.left - rect.width + 2 : right
  const top = Math.min(anchor.top - 4, window.innerHeight - rect.height - 8)
  menu.style.left = `${Math.max(8, left)}px`
  menu.style.top = `${Math.max(8, top)}px`
}

/** Closes every submenu deeper than `depth`. */
function closeChildren(depth: number): void {
  while (children.length > depth) children.pop()?.remove()
}
