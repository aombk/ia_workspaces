/**
 * The location and the weather service — the gear on the weather and air blocks.
 *
 * One panel rather than a run of prompts. A location is four fields that only
 * mean anything together, and asking them one at a time gives you no way to see
 * what you have already said or to fix the first after typing the third.
 *
 * It lives here rather than only in the settings panel because a block's own
 * location is that block's business, and Settings is three clicks and a scroll
 * away. Both write the same values; neither is the authority.
 */
import { store } from '../state'
import { WEATHER_PROVIDERS, type WeatherPlace, type WeatherProvider } from '../../shared/types'

/** Two places are the same place when they are called the same thing. */
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Adds a place to the saved list, or moves the one already called that.
 *
 * Exported because the gear menu on the blocks saves from there too, and a
 * second implementation of "is this one already on the list" is a second answer
 * waiting to disagree with this one.
 */
export function rememberPlace(place: WeatherPlace): void {
  const kept = store.settings.weatherPlaces.filter((p) => !sameName(p.place, place.place))
  store.updateSettings({ weatherPlaces: [...kept, place] })
}

export function showWeatherSettings(): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('overlay') as HTMLElement
    const wasOverlayHidden = overlay.hidden
    overlay.hidden = false

    const panel = document.createElement('div')
    panel.className = 'settings-panel publish-panel'
    panel.hidden = false

    const head = document.createElement('div')
    head.className = 'settings-head'
    const title = document.createElement('h2')
    title.textContent = 'Weather and air'
    head.appendChild(title)

    const body = document.createElement('div')
    body.className = 'settings-body publish-body'
    panel.append(head, body)
    document.body.appendChild(panel)

    const s = store.settings
    let provider: WeatherProvider = s.weatherProvider
    let place = s.weatherPlace
    let lat = s.weatherLat
    let lon = s.weatherLon
    let key = s.weatherKey

    const finish = (saved: boolean) => {
      window.removeEventListener('keydown', onKey, true)
      panel.remove()
      overlay.hidden = wasOverlayHidden
      resolve(saved)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('keydown', onKey, true)

    /**
     * The Keep button, and the question it answers on every keystroke.
     *
     * Held outside `draw` because the fields above it change it: a place that
     * is already on the list has nothing to keep, and renaming it means there
     * is a new one to keep — which is the whole of how a second place gets
     * added. Redrawing the panel on every keystroke would do the same job and
     * take the caret out of the field being typed in.
     */
    let keep: HTMLButtonElement | null = null
    function syncKeep(): void {
      if (!keep) return
      const named = place.trim()
      const already = store.settings.weatherPlaces.some(
        (p) => sameName(p.place, named) && p.lat === lat.trim() && p.lon === lon.trim()
      )
      keep.disabled = !named || !lat.trim() || !lon.trim() || already
      keep.title = already
        ? `${named} is saved already, at these coordinates.`
        : 'Saves this location and adds it to the list, so the gear on either block can switch straight back to it.'
    }

    function draw(): void {
      body.replaceChildren()

      body.appendChild(
        say(
          'Two blocks read from here: the weather and the air. Nothing is requested until there is a ' +
            'location — this is the only part of the app that talks to anything outside your machine.'
        )
      )

      // The places already kept, first, because on any visit after the first
      // this is the only part of the panel anybody wants: home, work, wherever
      // the person you are talking to is. Picking one fills the fields below
      // rather than saving on the spot — the panel still has one Save, and what
      // it saves is what is on screen.
      const saved = store.settings.weatherPlaces
      if (saved.length) {
        const kept = field('Places you have saved')
        const chips = document.createElement('div')
        chips.className = 'publish-hosts'
        for (const entry of saved) {
          const chip = document.createElement('button')
          const current = sameName(entry.place, place) && entry.lat === lat && entry.lon === lon
          chip.className = 'publish-host' + (current ? ' current' : '')
          chip.textContent = entry.place
          chip.title = `${entry.lat}, ${entry.lon}`
          chip.addEventListener('click', () => {
            place = entry.place
            lat = entry.lat
            lon = entry.lon
            draw()
          })
          // Forgetting one is on the chip rather than behind a mode: a list of
          // three bookmarks does not need an edit button, and the × cannot be
          // reached by accident on the way to picking one.
          const forget = document.createElement('span')
          forget.className = 'publish-host__drop'
          forget.textContent = '×'
          forget.title = `Forget ${entry.place}`
          forget.addEventListener('click', (e) => {
            e.stopPropagation()
            store.updateSettings({
              weatherPlaces: saved.filter((p) => !sameName(p.place, entry.place)),
            })
            draw()
          })
          chip.appendChild(forget)
          chips.appendChild(chip)
        }
        kept.appendChild(chips)
        body.appendChild(kept)
      }

      // Which service. Open-Meteo first and marked, because it is the one that
      // works with nothing but a coordinate.
      const who = field('Weather service')
      const chips = document.createElement('div')
      chips.className = 'publish-hosts'
      for (const option of WEATHER_PROVIDERS) {
        const chip = document.createElement('button')
        chip.className = 'publish-host' + (option.id === provider ? ' current' : '')
        chip.textContent = option.label
        chip.addEventListener('click', () => {
          provider = option.id
          draw()
        })
        chips.appendChild(chip)
      }
      who.appendChild(chips)
      body.appendChild(who)

      // Every field that makes up a place re-asks the Keep button whether there
      // is now something for it to do. Answered once at draw, it stayed greyed
      // out after you renamed the place you had just picked — which is exactly
      // the moment somebody is adding a second one.
      body.appendChild(
        input('Name for this place', place, 'Athens', (v) => {
          place = v
          syncKeep()
        })
      )
      body.appendChild(
        input(
          'Latitude',
          lat,
          '37.9957',
          (v) => {
            lat = v
            syncKeep()
          },
          'Degrees north, negative for south.'
        )
      )
      body.appendChild(
        input(
          'Longitude',
          lon,
          '23.7378',
          (v) => {
            lon = v
            syncKeep()
          },
          'Degrees east, negative for west.'
        )
      )
      body.appendChild(
        note(
          'Any map will give you the pair — in Google Maps, right-click a spot and the coordinates are the first thing in the menu.'
        )
      )

      // Only the provider that needs a key is asked for one, so the field is
      // never a question with no answer.
      if (WEATHER_PROVIDERS.find((p) => p.id === provider)?.needsKey) {
        body.appendChild(
          input('API key', key, 'your OpenWeatherMap key', (v) => (key = v), 'A new key can take a few minutes to start working.')
        )
      }

      const apply = () =>
        store.updateSettings({
          weatherProvider: provider,
          weatherPlace: place.trim(),
          weatherLat: lat.trim(),
          weatherLon: lon.trim(),
          weatherKey: key.trim(),
        })

      const save = document.createElement('button')
      save.className = 'btn primary'
      save.textContent = 'Save'
      save.addEventListener('click', () => {
        apply()
        finish(true)
      })

      // Keeping a place is a second action rather than a side effect of saving:
      // a coordinate typed to see what is there should not join the list you
      // switch between, and the two are told apart by which button was pressed.
      //
      // Always here, disabled when there is nothing it would do — a button that
      // comes and goes moves the one beside it, and the one beside it is Save.
      keep = document.createElement('button')
      keep.className = 'btn'
      keep.textContent = 'Save and keep'
      syncKeep()
      keep.addEventListener('click', () => {
        apply()
        rememberPlace({ place: place.trim(), lat: lat.trim(), lon: lon.trim() })
        finish(true)
      })

      const cancel = document.createElement('button')
      cancel.className = 'btn'
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', () => finish(false))

      const row = document.createElement('div')
      row.className = 'publish-actions'
      row.append(save, keep, cancel)
      body.appendChild(row)
    }

    function field(label: string): HTMLElement {
      const wrap = document.createElement('div')
      wrap.className = 'publish-field'
      const caption = document.createElement('div')
      caption.className = 'publish-field__label'
      caption.textContent = label
      wrap.appendChild(caption)
      return wrap
    }

    function input(
      label: string,
      value: string,
      placeholder: string,
      onChange: (v: string) => void,
      hint?: string
    ): HTMLElement {
      const wrap = field(label)
      const el = document.createElement('input')
      el.className = 'text-input'
      el.value = value
      el.placeholder = placeholder
      el.spellcheck = false
      // On input rather than on change: a value typed and then dismissed with
      // the keyboard would otherwise never reach the variable it is bound to.
      el.addEventListener('input', () => onChange(el.value))
      wrap.appendChild(el)
      if (hint) wrap.appendChild(note(hint))
      return wrap
    }

    function say(value: string): HTMLElement {
      const el = document.createElement('p')
      el.className = 'publish-say'
      el.textContent = value
      return el
    }

    function note(value: string): HTMLElement {
      const el = document.createElement('div')
      el.className = 'publish-note'
      el.textContent = value
      return el
    }

    draw()
  })
}
