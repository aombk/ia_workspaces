/**
 * Where to look, and who to ask — the gear on the weather and air blocks.
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
import { WEATHER_PROVIDERS, type WeatherProvider } from '../../shared/types'

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

    function draw(): void {
      body.replaceChildren()

      body.appendChild(
        say(
          'Two blocks read from here: the weather and the air. Nothing is requested until there is a ' +
            'location — this is the only part of the app that talks to anything outside your machine.'
        )
      )

      // Which service. Open-Meteo first and marked, because it is the one that
      // works with nothing but a coordinate.
      const who = field('Who to ask')
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

      body.appendChild(input('What to call it', place, 'Athens', (v) => (place = v)))
      body.appendChild(
        input('Latitude', lat, '37.9957', (v) => (lat = v), 'Degrees north, negative for south.')
      )
      body.appendChild(
        input('Longitude', lon, '23.7378', (v) => (lon = v), 'Degrees east, negative for west.')
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

      const save = document.createElement('button')
      save.className = 'btn primary'
      save.textContent = 'Save'
      save.addEventListener('click', () => {
        store.updateSettings({
          weatherProvider: provider,
          weatherPlace: place.trim(),
          weatherLat: lat.trim(),
          weatherLon: lon.trim(),
          weatherKey: key.trim(),
        })
        finish(true)
      })

      const cancel = document.createElement('button')
      cancel.className = 'btn'
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', () => finish(false))

      const row = document.createElement('div')
      row.className = 'publish-actions'
      row.append(save, cancel)
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
