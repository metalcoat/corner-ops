import { ensureSchema, getSql } from "@/lib/db";
import { ensureSquareControlSchema } from "@/lib/square-control";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
const DEFAULT_LATITUDE = 44.6942;
const DEFAULT_LONGITUDE = -75.4863;
const DAY_MS = 86_400_000;
let weatherSchemaPromise: Promise<void> | null = null;

type WeatherApiDaily = {
  time?: string[];
  weather_code?: Array<number | null>;
  temperature_2m_max?: Array<number | null>;
  temperature_2m_min?: Array<number | null>;
  temperature_2m_mean?: Array<number | null>;
  apparent_temperature_max?: Array<number | null>;
  precipitation_sum?: Array<number | null>;
  rain_sum?: Array<number | null>;
  snowfall_sum?: Array<number | null>;
  precipitation_probability_max?: Array<number | null>;
  wind_speed_10m_max?: Array<number | null>;
  wind_gusts_10m_max?: Array<number | null>;
  sunshine_duration?: Array<number | null>;
};

type WeatherApiResponse = {
  daily?: WeatherApiDaily;
  error?: boolean;
  reason?: string;
};

type WeatherDay = {
  date: string;
  sourceKind: "Historical" | "Forecast";
  weatherCode: number;
  condition: string;
  temperatureMax: number;
  temperatureMin: number;
  temperatureMean: number;
  apparentTemperatureMax: number;
  precipitation: number;
  rain: number;
  snowfall: number;
  precipitationProbability: number;
  windMax: number;
  windGust: number;
  sunshineHours: number;
};

type BusinessDay = {
  date: string;
  sales: number | null;
  orders: number;
  laborHours: number;
};

type JoinedDay = BusinessDay & WeatherDay;

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime());
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateRange(start: string, end: string): string[] {
  const result: string[] = [];
  for (let current = start; current < end; current = addDays(current, 1)) result.push(current);
  return result;
}

function businessDate(value: string): string {
  const adjusted = new Date(new Date(value).getTime() - 4 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(adjusted);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function conditionLabel(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorms";
  return "Mixed";
}

function normalizedRaw(raw: unknown): Map<string, unknown> {
  const object = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return new Map(Object.entries(object).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
}

function orderSales(raw: unknown): number | null {
  const values = normalizedRaw(raw);
  const candidates = [
    "netsales", "ordertotal", "totalamount", "grandtotal", "grosssales", "nettotal", "total", "amount", "subtotal",
  ];
  for (const candidate of candidates) {
    const value = values.get(candidate);
    if (value !== undefined && value !== null && String(value).trim() !== "") return numeric(value);
  }
  return null;
}

export function ensureWeatherSchema(): Promise<void> {
  if (!weatherSchemaPromise) {
    weatherSchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS weather_daily (
          weather_date DATE PRIMARY KEY,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('Historical', 'Forecast')),
          weather_code INTEGER NOT NULL DEFAULT 0,
          temperature_max_f NUMERIC(8,2) NOT NULL DEFAULT 0,
          temperature_min_f NUMERIC(8,2) NOT NULL DEFAULT 0,
          temperature_mean_f NUMERIC(8,2) NOT NULL DEFAULT 0,
          apparent_temperature_max_f NUMERIC(8,2) NOT NULL DEFAULT 0,
          precipitation_in NUMERIC(10,3) NOT NULL DEFAULT 0,
          rain_in NUMERIC(10,3) NOT NULL DEFAULT 0,
          snowfall_in NUMERIC(10,3) NOT NULL DEFAULT 0,
          precipitation_probability INTEGER NOT NULL DEFAULT 0,
          wind_max_mph NUMERIC(8,2) NOT NULL DEFAULT 0,
          wind_gust_mph NUMERIC(8,2) NOT NULL DEFAULT 0,
          sunshine_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS weather_daily_source_idx ON weather_daily (source_kind, weather_date)`;
    })().catch((error) => {
      weatherSchemaPromise = null;
      throw error;
    });
  }
  return weatherSchemaPromise;
}

function coordinates() {
  const latitude = Number(process.env.WEATHER_LATITUDE || DEFAULT_LATITUDE);
  const longitude = Number(process.env.WEATHER_LONGITUDE || DEFAULT_LONGITUDE);
  return {
    latitude: Number.isFinite(latitude) ? latitude : DEFAULT_LATITUDE,
    longitude: Number.isFinite(longitude) ? longitude : DEFAULT_LONGITUDE,
  };
}

async function fetchWeatherWindow(start: string, endInclusive: string, sourceKind: "Historical" | "Forecast") {
  const { latitude, longitude } = coordinates();
  const host = sourceKind === "Historical"
    ? "https://historical-forecast-api.open-meteo.com/v1/forecast"
    : "https://api.open-meteo.com/v1/forecast";
  const query = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    start_date: start,
    end_date: endInclusive,
    timezone: TIME_ZONE,
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
      "apparent_temperature_max",
      "precipitation_sum",
      "rain_sum",
      "snowfall_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "wind_gusts_10m_max",
      "sunshine_duration",
    ].join(","),
  });
  const response = await fetch(`${host}?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Weather service returned HTTP ${response.status}.`);
  const payload = await response.json() as WeatherApiResponse;
  if (payload.error) throw new Error(payload.reason || "Weather service rejected the request.");
  const daily = payload.daily;
  if (!daily?.time?.length) return 0;

  const sql = getSql();
  for (let index = 0; index < daily.time.length; index += 1) {
    const date = daily.time[index];
    await sql`
      INSERT INTO weather_daily (
        weather_date, source_kind, weather_code, temperature_max_f, temperature_min_f,
        temperature_mean_f, apparent_temperature_max_f, precipitation_in, rain_in,
        snowfall_in, precipitation_probability, wind_max_mph, wind_gust_mph, sunshine_hours
      ) VALUES (
        ${date}, ${sourceKind}, ${daily.weather_code?.[index] || 0},
        ${daily.temperature_2m_max?.[index] || 0}, ${daily.temperature_2m_min?.[index] || 0},
        ${daily.temperature_2m_mean?.[index] || 0}, ${daily.apparent_temperature_max?.[index] || 0},
        ${daily.precipitation_sum?.[index] || 0}, ${daily.rain_sum?.[index] || 0},
        ${daily.snowfall_sum?.[index] || 0}, ${daily.precipitation_probability_max?.[index] || 0},
        ${daily.wind_speed_10m_max?.[index] || 0}, ${daily.wind_gusts_10m_max?.[index] || 0},
        ${(daily.sunshine_duration?.[index] || 0) / 3600}
      )
      ON CONFLICT (weather_date) DO UPDATE SET
        source_kind = EXCLUDED.source_kind,
        weather_code = EXCLUDED.weather_code,
        temperature_max_f = EXCLUDED.temperature_max_f,
        temperature_min_f = EXCLUDED.temperature_min_f,
        temperature_mean_f = EXCLUDED.temperature_mean_f,
        apparent_temperature_max_f = EXCLUDED.apparent_temperature_max_f,
        precipitation_in = EXCLUDED.precipitation_in,
        rain_in = EXCLUDED.rain_in,
        snowfall_in = EXCLUDED.snowfall_in,
        precipitation_probability = EXCLUDED.precipitation_probability,
        wind_max_mph = EXCLUDED.wind_max_mph,
        wind_gust_mph = EXCLUDED.wind_gust_mph,
        sunshine_hours = EXCLUDED.sunshine_hours,
        fetched_at = NOW()
    `;
  }
  return daily.time.length;
}

export async function syncWeatherRange(start: string, end: string) {
  await ensureWeatherSchema();
  if (!validDate(start) || !validDate(end) || end <= start) throw new Error("Choose a valid weather date range.");
  if ((new Date(`${end}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime()) > 740 * DAY_MS) {
    throw new Error("Weather analysis is limited to two years at a time.");
  }

  const today = todayKey();
  const yesterday = addDays(today, -1);
  const lastRequested = addDays(end, -1);
  let historical = 0;
  let forecast = 0;

  if (start <= yesterday) {
    const historicalEnd = lastRequested < yesterday ? lastRequested : yesterday;
    historical = await fetchWeatherWindow(start, historicalEnd, "Historical");
  }
  if (lastRequested >= today) {
    const forecastStart = start > today ? start : today;
    const maximumForecast = addDays(today, 15);
    const forecastEnd = lastRequested < maximumForecast ? lastRequested : maximumForecast;
    if (forecastStart <= forecastEnd) forecast = await fetchWeatherWindow(forecastStart, forecastEnd, "Forecast");
  }
  return { historical, forecast };
}

export async function syncOperationalWeather() {
  const today = todayKey();
  return syncWeatherRange(addDays(today, -7), addDays(today, 11));
}

async function weatherRows(start: string, end: string): Promise<WeatherDay[]> {
  const rows = await getSql()`
    SELECT * FROM weather_daily
    WHERE weather_date >= ${start}::date AND weather_date < ${end}::date
    ORDER BY weather_date
  ` as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const code = numeric(row.weather_code);
    return {
      date: String(row.weather_date).slice(0, 10),
      sourceKind: row.source_kind as "Historical" | "Forecast",
      weatherCode: code,
      condition: conditionLabel(code),
      temperatureMax: numeric(row.temperature_max_f),
      temperatureMin: numeric(row.temperature_min_f),
      temperatureMean: numeric(row.temperature_mean_f),
      apparentTemperatureMax: numeric(row.apparent_temperature_max_f),
      precipitation: numeric(row.precipitation_in),
      rain: numeric(row.rain_in),
      snowfall: numeric(row.snowfall_in),
      precipitationProbability: numeric(row.precipitation_probability),
      windMax: numeric(row.wind_max_mph),
      windGust: numeric(row.wind_gust_mph),
      sunshineHours: numeric(row.sunshine_hours),
    };
  });
}

async function dailyBusinessRows(business: Business, start: string, end: string): Promise<BusinessDay[]> {
  const startDate = `${start}T04:00:00-04:00`;
  const endDate = `${end}T04:00:00-04:00`;
  const result = new Map<string, BusinessDay>();
  const day = (date: string) => {
    const existing = result.get(date);
    if (existing) return existing;
    const created: BusinessDay = { date, sales: business === "Tiki" ? 0 : null, orders: 0, laborHours: 0 };
    result.set(date, created);
    return created;
  };

  if (business === "Tiki") {
    await ensureSquareControlSchema();
    const orders = await getSql()`
      SELECT created_at_square, total_amount
      FROM square_orders
      WHERE state = 'COMPLETED'
        AND created_at_square >= ${startDate}
        AND created_at_square < ${endDate}
      ORDER BY created_at_square
    ` as unknown as Array<{ created_at_square: string; total_amount: string | number }>;
    for (const order of orders) {
      const item = day(businessDate(order.created_at_square));
      item.orders += 1;
      item.sales = (item.sales || 0) + numeric(order.total_amount);
    }
    const labor = await getSql()`
      SELECT clock_in, clock_out
      FROM time_entries
      WHERE business = 'Tiki'
        AND clock_in >= ${startDate}
        AND clock_in < ${endDate}
    ` as unknown as Array<{ clock_in: string; clock_out: string | null }>;
    for (const shift of labor) {
      const item = day(businessDate(shift.clock_in));
      if (shift.clock_out) item.laborHours += Math.max(0, (new Date(shift.clock_out).getTime() - new Date(shift.clock_in).getTime()) / 3_600_000);
    }
  } else {
    const orders = await getSql()`
      SELECT opened_at, raw
      FROM rezku_orders
      WHERE opened_at >= ${startDate}
        AND opened_at < ${endDate}
      ORDER BY opened_at
    ` as unknown as Array<{ opened_at: string; raw: unknown }>;
    let foundSales = false;
    for (const order of orders) {
      const item = day(businessDate(order.opened_at));
      item.orders += 1;
      const sales = orderSales(order.raw);
      if (sales !== null) {
        foundSales = true;
        item.sales = (item.sales || 0) + sales;
      }
    }
    if (!foundSales) for (const item of result.values()) item.sales = null;
    const labor = await getSql()`
      SELECT clock_in, clock_out, reported_hours
      FROM rezku_shifts
      WHERE clock_in >= ${startDate}
        AND clock_in < ${endDate}
    ` as unknown as Array<{ clock_in: string; clock_out: string | null; reported_hours: string | number }>;
    for (const shift of labor) {
      const item = day(businessDate(shift.clock_in));
      const hours = numeric(shift.reported_hours) || (shift.clock_out
        ? Math.max(0, (new Date(shift.clock_out).getTime() - new Date(shift.clock_in).getTime()) / 3_600_000)
        : 0);
      item.laborHours += hours;
    }
  }

  for (const date of dateRange(start, end)) day(date);
  return Array.from(result.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function pearson(rows: JoinedDay[], field: keyof Pick<WeatherDay, "temperatureMax" | "precipitation" | "windMax" | "sunshineHours">, measure: "sales" | "orders") {
  const points = rows
    .map((row) => [numeric(row[field]), measure === "sales" ? nullableNumber(row.sales) : row.orders] as const)
    .filter((point): point is readonly [number, number] => point[1] !== null && Number.isFinite(point[1]));
  if (points.length < 3) return null;
  const xMean = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  let numerator = 0;
  let xSquared = 0;
  let ySquared = 0;
  for (const [x, y] of points) {
    numerator += (x - xMean) * (y - yMean);
    xSquared += (x - xMean) ** 2;
    ySquared += (y - yMean) ** 2;
  }
  const denominator = Math.sqrt(xSquared * ySquared);
  return denominator ? numerator / denominator : null;
}

function weatherDistance(left: WeatherDay, right: WeatherDay): number {
  const conditionDifference = conditionLabel(left.weatherCode) === conditionLabel(right.weatherCode) ? 0 : 1;
  return Math.abs(left.temperatureMax - right.temperatureMax) / 15
    + Math.abs(left.temperatureMin - right.temperatureMin) / 15
    + Math.abs(left.precipitation - right.precipitation) / 0.4
    + Math.abs(left.windMax - right.windMax) / 20
    + conditionDifference;
}

function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function recommendation(business: Business, forecast: WeatherDay, predictedOrders: number, predictedSales: number | null): string {
  const wet = forecast.precipitationProbability >= 60 || forecast.precipitation >= 0.15;
  const windy = forecast.windGust >= 28 || forecast.windMax >= 20;
  const hot = forecast.temperatureMax >= 82;
  const cold = forecast.temperatureMax <= 55;
  const busySignal = predictedSales !== null ? predictedSales : predictedOrders;

  if (business === "Tiki") {
    if (wet && windy) return "Outdoor demand risk is high. Use lean opening coverage, protect inventory from weather, and make the final hours decision close to service time.";
    if (wet) return "Rain risk is meaningful. Keep staffing flexible and push weather-safe specials before committing to a full outdoor schedule.";
    if (hot && forecast.sunshineHours >= 7) return "Strong Tiki conditions. Staff the rush, stock ice and fast-moving drinks, and be ready earlier than the predicted peak.";
    if (windy) return "Wind may suppress dock traffic even without rain. Secure outdoor items and avoid overstaffing the earliest hours.";
    return busySignal > 0 ? "Conditions are serviceable. Use the similar-day estimate for staffing and confirm with reservations, events, and river traffic." : "Not enough comparable sales history yet. Operate conservatively while the weather and sales dataset grows.";
  }

  if (wet || cold) return "Expect more takeout and delivery pressure. Protect driver coverage, dough and pizza prep, and phone-order capacity.";
  if (hot && forecast.sunshineHours >= 7) return "Warm clear weather may shift demand later. Emphasize cold items, easy takeout, and avoid loading all labor into the early dinner window.";
  if (windy) return "Outdoor plans may move indoors. Keep delivery and comfort-food capacity available without assuming a full storm-day surge.";
  return busySignal > 0 ? "Use the similar-day estimate for prep and staffing, then adjust for local events and promotions." : "Order history is still thin for this weather pattern. Use normal staffing and collect another comparable day.";
}

export async function weatherSalesIntelligence(input: { business: Business; start: string; end: string }) {
  if (!validDate(input.start) || !validDate(input.end) || input.end <= input.start) throw new Error("Choose a valid report range.");
  const sync = await syncWeatherRange(input.start, input.end);
  const today = todayKey();
  await syncWeatherRange(today, addDays(today, 11));

  const [historyWeather, businessRows, forecastWeather] = await Promise.all([
    weatherRows(input.start, input.end),
    dailyBusinessRows(input.business, input.start, input.end),
    weatherRows(today, addDays(today, 11)),
  ]);
  const weatherByDate = new Map(historyWeather.map((row) => [row.date, row]));
  const history = businessRows
    .map((row) => {
      const weather = weatherByDate.get(row.date);
      return weather ? { ...row, ...weather } : null;
    })
    .filter((row): row is JoinedDay => Boolean(row));
  const salesAvailable = history.some((row) => row.sales !== null);
  const measure: "sales" | "orders" = salesAvailable ? "sales" : "orders";
  const comparableHistory = history.filter((row) => row.date < today && (measure === "sales" ? numeric(row.sales) > 0 : row.orders > 0));

  const forecast = forecastWeather.map((weather) => {
    const sameWeekday = comparableHistory.filter((row) => weekday(row.date) === weekday(weather.date));
    const pool = sameWeekday.length >= 3 ? sameWeekday : comparableHistory;
    const nearest = pool
      .map((row) => ({ row, distance: weatherDistance(weather, row) }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 8);
    const weights = nearest.map((item) => 1 / Math.max(0.25, item.distance));
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    const weighted = (selector: (row: JoinedDay) => number) => weightTotal
      ? nearest.reduce((sum, item, index) => sum + selector(item.row) * weights[index], 0) / weightTotal
      : 0;
    const predictedSales = salesAvailable && nearest.length ? weighted((row) => numeric(row.sales)) : null;
    const predictedOrders = nearest.length ? weighted((row) => row.orders) : 0;
    const predictedLaborHours = nearest.length ? weighted((row) => row.laborHours) : 0;
    return {
      ...weather,
      predictedSales,
      predictedOrders,
      predictedLaborHours,
      comparableDays: nearest.map((item) => item.row.date),
      confidence: nearest.length >= 6 ? "High" : nearest.length >= 3 ? "Moderate" : "Low",
      recommendation: recommendation(input.business, weather, predictedOrders, predictedSales),
    };
  });

  return {
    business: input.business,
    range: { start: input.start, end: input.end },
    location: { name: "Ogdensburg, NY", ...coordinates() },
    weatherSource: "Open-Meteo historical forecasts and current forecast",
    sync,
    salesAvailable,
    measure,
    history,
    correlations: {
      temperature: pearson(history, "temperatureMax", measure),
      precipitation: pearson(history, "precipitation", measure),
      wind: pearson(history, "windMax", measure),
      sunshine: pearson(history, "sunshineHours", measure),
      sampleDays: history.filter((row) => measure === "sales" ? row.sales !== null : true).length,
    },
    forecast,
    limitations: input.business === "Corner Deli" && !salesAvailable
      ? "The current Rezku order export does not expose a recognizable order-total field, so Deli predictions use order count as the demand measure until a sales-total field appears in the emailed data."
      : "Predictions use similar historical weather days and should be adjusted for local events, promotions, closures, and staffing constraints.",
  };
}
