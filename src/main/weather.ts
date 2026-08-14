/**
 * The weather and the air, for the two blocks that are not about this machine.
 *
 * They are here because the Rainmeter skin this panel borrows its shape from
 * has them, and the reason it has them is a good one: a panel you leave open
 * beside your work is the right place for the handful of things you would
 * otherwise open a browser tab to check, and closing that tab is the point.
 *
 * **Two providers, and the default needs nothing.** Open-Meteo answers without
 * a key, without a signup and without a rate limit worth thinking about, which
 * means the blocks work the moment you give them a place. OpenWeatherMap is the
 * other, because the skin uses it and because somebody with a key already
 * should not have to abandon it. Adding a third is a function and a line in
 * `PROVIDERS`; it does not touch the blocks, the cache or the IPC.
 *
 * The split worth knowing about is modelled against measured. Both providers
 * here *model* air quality from atmospheric data, which is why they answer
 * anywhere on earth. Ground-station services — WAQI and the like — report what
 * a real instrument measured, which is better where there is a station and
 * nothing at all where there is not.
 *
 * Nothing is requested until a location is set. This is the only part of the
 * app that talks to a third party, and it should be impossible to do so by
 * accident.
 */
import type {
  AirQuality,
  Weather,
  WeatherProvider,
  WeatherReading,
  WeatherRequest,
} from '../shared/types'

/**
 * How long an answer is kept.
 *
 * Ten minutes, against numbers that move far more slowly: an air quality index
 * is computed hourly. Asking sixty times an hour for a figure that changes once
 * is rude to somebody else's server for no benefit at all.
 */
const TTL_MS = 10 * 60_000

/** Long enough for a slow connection, short enough that a dead one is not felt. */
const TIMEOUT_MS = 6000

let cache: { at: number; signature: string; value: WeatherReading } | null = null
let inFlight: Promise<WeatherReading> | null = null

/**
 * Both readings, cached together.
 *
 * Together because they are two calls about one place, and a panel that
 * refreshed them on separate clocks would show the air from ten minutes after
 * the weather. The signature is the request itself, so moving the location
 * invalidates at once rather than after the deadline.
 */
export async function readWeather(request: WeatherRequest): Promise<WeatherReading> {
  const now = Date.now()
  const signature = `${request.provider}|${request.lat}|${request.lon}|${request.key ?? ''}`

  if (!Number.isFinite(request.lat) || !Number.isFinite(request.lon)) {
    return { weather: null, air: null, at: now, error: 'no-location' }
  }
  if (request.provider === 'openweathermap' && !request.key) {
    return { weather: null, air: null, at: now, error: 'no-key' }
  }
  if (cache && cache.signature === signature && now - cache.at < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = PROVIDERS[request.provider](request)
    .then((value) => {
      const withPlace = { ...value, weather: value.weather ? { ...value.weather, place: request.place || value.weather.place } : null }
      cache = { at: Date.now(), signature, value: withPlace }
      return withPlace
    })
    .catch((err: unknown) => {
      // A failed lookup keeps the last good answer on screen rather than
      // blanking the block: the weather from ten minutes ago is still roughly
      // the weather, and a connection drops far more often than it changes.
      const message = err instanceof Error ? err.message : String(err)
      if (cache?.signature === signature) return { ...cache.value, error: message }
      return { weather: null, air: null, at: Date.now(), error: message }
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

async function get(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) {
    // 401 is the one worth naming: it is what a wrong *or brand-new* key
    // returns, and a new key genuinely takes some minutes to start working —
    // otherwise indistinguishable from having typed it wrong.
    if (response.status === 401) throw new Error('key rejected — a new key can take a few minutes to work')
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.json()
}

// ------------------------------------------------------------- Open-Meteo

/**
 * The default, and the one that needs nothing.
 *
 * Two endpoints on two hosts — forecast and air quality — asked in parallel
 * because neither needs the other's answer. Wind is requested in km/h outright
 * rather than converted here, since the API will do it and a unit converted in
 * two places is a unit that disagrees with itself.
 */
async function openMeteo(request: WeatherRequest): Promise<WeatherReading> {
  const where = `latitude=${request.lat}&longitude=${request.lon}`
  const [current, air] = await Promise.all([
    get(
      `https://api.open-meteo.com/v1/forecast?${where}&wind_speed_unit=kmh&current=` +
        'temperature_2m,relative_humidity_2m,apparent_temperature,surface_pressure,wind_speed_10m,wind_direction_10m,weather_code'
    ),
    get(
      `https://air-quality-api.open-meteo.com/v1/air-quality?${where}&current=` +
        'european_aqi,us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone'
    ).catch(() => null),
  ])
  return { weather: parseOpenMeteo(current), air: air ? parseOpenMeteoAir(air) : null, at: Date.now(), error: null }
}

/** Exported for the tests, which run it against a captured response. */
export function parseOpenMeteo(raw: unknown): Weather | null {
  const c = (raw as Record<string, any>)?.current
  if (!c) return null
  return {
    place: '',
    description: WMO[num(c.weather_code) ?? -1] ?? '',
    temperature: num(c.temperature_2m),
    feelsLike: num(c.apparent_temperature),
    humidity: num(c.relative_humidity_2m),
    pressure: num(c.surface_pressure),
    windSpeed: num(c.wind_speed_10m),
    windDegrees: num(c.wind_direction_10m),
  }
}

/** Exported for the tests. */
export function parseOpenMeteoAir(raw: unknown): AirQuality | null {
  const c = (raw as Record<string, any>)?.current
  if (!c) return null
  return {
    // Open-Meteo reports the European index, which runs 0–100+ rather than
    // OpenWeatherMap's 1–5. `scale` says which, so the block can label it
    // rather than printing a number whose range nobody can guess.
    index: num(c.european_aqi),
    scale: 'european',
    pm2_5: num(c.pm2_5),
    pm10: num(c.pm10),
    o3: num(c.ozone),
    no2: num(c.nitrogen_dioxide),
    so2: num(c.sulphur_dioxide),
    co: num(c.carbon_monoxide),
    nh3: null,
  }
}

/**
 * What a WMO weather code means, in the words a forecast uses.
 *
 * Open-Meteo reports the standard code rather than a phrase, which is the
 * better choice — a number does not need translating and does not change its
 * wording between releases.
 */
const WMO: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'freezing fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  56: 'freezing drizzle',
  57: 'heavy freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'heavy freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers',
  81: 'showers',
  82: 'violent showers',
  85: 'light snow showers',
  86: 'snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with hail',
  99: 'thunderstorm with heavy hail',
}

// -------------------------------------------------------- OpenWeatherMap

async function openWeatherMap(request: WeatherRequest): Promise<WeatherReading> {
  const where = `lat=${request.lat}&lon=${request.lon}&appid=${encodeURIComponent(request.key ?? '')}`
  const [current, pollution] = await Promise.all([
    get(`https://api.openweathermap.org/data/2.5/weather?${where}&units=metric`),
    // The air endpoint takes no units: its numbers are µg/m³ everywhere.
    get(`https://api.openweathermap.org/data/2.5/air_pollution?${where}`).catch(() => null),
  ])
  return {
    weather: parseOwm(current),
    air: pollution ? parseOwmAir(pollution) : null,
    at: Date.now(),
    error: null,
  }
}

/** Exported for the tests. */
export function parseOwm(raw: unknown): Weather | null {
  const d = raw as Record<string, any>
  if (!d?.main) return null
  return {
    place: typeof d.name === 'string' ? d.name : '',
    description: d.weather?.[0]?.description ?? '',
    temperature: num(d.main.temp),
    feelsLike: num(d.main.feels_like),
    humidity: num(d.main.humidity),
    pressure: num(d.main.pressure),
    // Metres per second under `units=metric`. Kilometres per hour is what a
    // forecast says, and it is what the other provider is asked for, so the
    // two cannot disagree about what the number means.
    windSpeed: scale(num(d.wind?.speed), 3.6),
    windDegrees: num(d.wind?.deg),
  }
}

/** Exported for the tests. */
export function parseOwmAir(raw: unknown): AirQuality | null {
  const entry = (raw as Record<string, any>)?.list?.[0]
  if (!entry) return null
  const c = entry.components ?? {}
  return {
    index: num(entry.main?.aqi),
    scale: 'owm',
    pm2_5: num(c.pm2_5),
    pm10: num(c.pm10),
    o3: num(c.o3),
    no2: num(c.no2),
    so2: num(c.so2),
    co: num(c.co),
    nh3: num(c.nh3),
  }
}

const PROVIDERS: Record<WeatherProvider, (r: WeatherRequest) => Promise<WeatherReading>> = {
  'open-meteo': openMeteo,
  openweathermap: openWeatherMap,
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function scale(value: number | null, factor: number): number | null {
  return value === null ? null : Math.round(value * factor * 10) / 10
}
