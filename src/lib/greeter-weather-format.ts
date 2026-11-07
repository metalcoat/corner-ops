/**
 * Turns a National Weather Service forecast (api.weather.gov gridpoint periods) and the
 * latest station observation into what the TV weather slide shows. Pure, for testing.
 */

export type NwsPeriod = {
  name: string;
  startTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  shortForecast: string;
  probabilityOfPrecipitation?: { value: number | null } | null;
};

export type NwsObservation = {
  timestamp?: string | null;
  textDescription?: string | null;
  temperature?: { value: number | null; unitCode?: string } | null;
};

/** Which animation the TV draws for a forecast (tools/greeter-pi/greeter.py). */
export const WEATHER_KINDS = ["clear", "clear_night", "partly_cloudy", "cloudy", "rain", "snow", "storm", "fog"] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

/** Reads an NWS short forecast or observation text ("Chance Rain Showers", "Mostly Clear then Patchy Fog"). */
export function weatherKind(text: string, daytime = true): WeatherKind {
  const words = text.toLowerCase();
  if (/thunder|t-storm|tstorm/.test(words)) return "storm";
  if (/snow|flurr|sleet|ice pellets|freezing|wintry|blizzard/.test(words)) return "snow";
  if (/rain|shower|drizzle/.test(words)) return "rain";
  if (/fog|mist|haze|smoke/.test(words) && !/then/.test(words.split(/fog|mist|haze|smoke/)[0])) return "fog";
  if (/partly|mostly sunny|mostly clear|few clouds|scattered clouds/.test(words)) return "partly_cloudy";
  if (/cloud|overcast/.test(words)) return "cloudy";
  return daytime ? "clear" : "clear_night";
}

export type WeatherDay = { name: string; high: number | null; low: number | null; forecast: string; rainChance: number | null; kind: WeatherKind };
export type WeatherSlide = {
  now: { temperature: number | null; conditions: string; kind: WeatherKind };
  today: WeatherDay;
  next: WeatherDay[];
  updatedAt: string;
};

const fahrenheit = (period: NwsPeriod) => (period.temperatureUnit === "C" ? Math.round(period.temperature * 9 / 5 + 32) : Math.round(period.temperature));

function observedF(observation: NwsObservation | null): number | null {
  const value = observation?.temperature?.value;
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return String(observation?.temperature?.unitCode || "").endsWith("degF") ? Math.round(value) : Math.round(value * 9 / 5 + 32);
}

function day(period: NwsPeriod | undefined, night: NwsPeriod | undefined, name: string): WeatherDay {
  const pops = [period, night].map((item) => item?.probabilityOfPrecipitation?.value).filter((value): value is number => typeof value === "number");
  return {
    name,
    high: period ? fahrenheit(period) : null,
    low: night ? fahrenheit(night) : null,
    forecast: (period || night)?.shortForecast || "",
    rainChance: pops.length ? Math.max(...pops) : null,
    kind: weatherKind((period || night)?.shortForecast || "", Boolean(period)),
  };
}

/** Today (high from the day period, low from tonight) plus the next `days` days. */
export function summarizeForecast(periods: readonly NwsPeriod[], observation: NwsObservation | null, nowIso: string, days = 3): WeatherSlide {
  const list = [...periods].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  let index = 0;
  // After about 6 PM the forecast starts with "Tonight": today has no day period left.
  const todayDay = list[0]?.isDaytime ? list[index++] : undefined;
  const tonight = list[index] && !list[index].isDaytime ? list[index++] : undefined;
  const next: WeatherDay[] = [];
  while (next.length < days && index < list.length) {
    const daytime = list[index].isDaytime ? list[index++] : undefined;
    const night = list[index] && !list[index].isDaytime ? list[index++] : undefined;
    if (!daytime && !night) break;
    next.push(day(daytime, night, (daytime || night)!.name.replace(/ Night$/, "")));
  }
  const now = observedF(observation);
  const conditions = observation?.textDescription || todayDay?.shortForecast || tonight?.shortForecast || "";
  // Night if the forecast's current period is a night one (after ~6 PM until morning).
  const daytimeNow = Boolean(list[0]?.isDaytime);
  return {
    now: {
      temperature: now ?? (todayDay ? fahrenheit(todayDay) : tonight ? fahrenheit(tonight) : null),
      conditions,
      kind: weatherKind(conditions, daytimeNow),
    },
    today: day(todayDay, tonight, "Today"),
    next,
    updatedAt: nowIso,
  };
}
