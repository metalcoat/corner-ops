import { summarizeForecast, type NwsObservation, type NwsPeriod, type WeatherSlide } from "@/lib/greeter-weather-format";

// api.weather.gov asks every client to identify itself; no key is needed.
const USER_AGENT = "CornerDeli-TV/1.0 (ordercornerdeli.com)";
// Ogdensburg, NY (same defaults as weather-intelligence.ts).
const LATITUDE = Number(process.env.WEATHER_LATITUDE || 44.6942);
const LONGITUDE = Number(process.env.WEATHER_LONGITUDE || -75.4863);
/** Ogdensburg International Airport, then Massena if it has no recent reading. */
const STATIONS = ["KOGS", "KMSS"];
const REFRESH_MS = 20 * 60 * 1000;

let forecastUrl: string | null = null;
let cached: { slide: WeatherSlide; at: number } | null = null;
let inFlight: Promise<WeatherSlide | null> | null = null;

async function nws<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/geo+json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`weather.gov answered HTTP ${response.status} for ${url}`);
  return (await response.json()) as T;
}

async function latestObservation(): Promise<NwsObservation | null> {
  for (const station of STATIONS) {
    try {
      const { properties } = await nws<{ properties: NwsObservation }>(`https://api.weather.gov/stations/${station}/observations/latest`);
      const age = Date.now() - Date.parse(String(properties.timestamp || ""));
      if (properties.temperature?.value !== null && properties.temperature?.value !== undefined && age < 3 * 3600_000) return properties;
    } catch {
      // Try the next station; the slide can show the forecast temperature instead.
    }
  }
  return null;
}

async function load(): Promise<WeatherSlide> {
  forecastUrl ??= (await nws<{ properties: { forecast: string } }>(`https://api.weather.gov/points/${LATITUDE},${LONGITUDE}`)).properties.forecast;
  const [forecast, observation] = await Promise.all([
    nws<{ properties: { periods: NwsPeriod[] } }>(forecastUrl),
    latestObservation(),
  ]);
  return summarizeForecast(forecast.properties.periods, observation, new Date().toISOString());
}

/**
 * The TV weather slide's data, refreshed at most every 20 minutes. When weather.gov is
 * down it keeps showing the last good forecast; null only if there has never been one.
 */
export async function greeterWeather(): Promise<WeatherSlide | null> {
  if (cached && Date.now() - cached.at < REFRESH_MS) return cached.slide;
  inFlight ??= load()
    .then((slide) => {
      cached = { slide, at: Date.now() };
      return slide;
    })
    .catch((error) => {
      console.error("Greeter weather unavailable", error);
      return cached?.slide ?? null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
