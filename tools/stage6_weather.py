from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
def read(p): return (ROOT/p).read_text()
def write(p,t): (ROOT/p).write_text(t)
def rep(p,o,n):
    t=read(p); c=t.count(o)
    if c!=1: raise RuntimeError(f'{p}: expected one exact match, got {c}')
    write(p,t.replace(o,n,1))
def sub(p,pat,n):
    t=read(p); out,c=re.subn(pat,lambda _m:n,t,count=1,flags=re.S)
    if c!=1: raise RuntimeError(f'{p}: expected one regex match, got {c}: {pat[:100]}')
    write(p,out)

# CO-062/063: cached/batched weather fetch + SQL-side sales/labor aggregation.
weather='src/lib/weather-intelligence.ts'
sub(weather, r'async function fetchWeatherWindow\(start: string, endInclusive: string, sourceKind: "Historical" \| "Forecast"\) \{.*?\n\}\n\nexport async function syncWeatherRange', '''type WeatherSyncOptions = { signal?: AbortSignal };

function contiguousDateWindows(dates: string[]): Array<{ start: string; end: string }> {
  if (!dates.length) return [];
  const sorted = [...dates].sort();
  const windows: Array<{ start: string; end: string }> = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const date of sorted.slice(1)) {
    if (date === addDays(previous, 1)) {
      previous = date;
      continue;
    }
    windows.push({ start, end: previous });
    start = previous = date;
  }
  windows.push({ start, end: previous });
  return windows;
}

async function weatherDatesNeedingFetch(start: string, endInclusive: string, sourceKind: "Historical" | "Forecast") {
  const rows = await getSql()`
    SELECT weather_date::text AS weather_date, source_kind, fetched_at
    FROM weather_daily
    WHERE weather_date >= ${start}::date AND weather_date <= ${endInclusive}::date
  ` as unknown as Array<{ weather_date: string; source_kind: "Historical" | "Forecast"; fetched_at: string }>;
  const existing = new Map(rows.map((row) => [String(row.weather_date).slice(0, 10), row]));
  const forecastFreshAfter = Date.now() - 60 * 60_000;
  return dateRange(start, addDays(endInclusive, 1)).filter((date) => {
    const row = existing.get(date);
    if (!row || row.source_kind !== sourceKind) return true;
    if (sourceKind === "Historical") return false;
    const fetched = new Date(row.fetched_at).getTime();
    return !Number.isFinite(fetched) || fetched < forecastFreshAfter;
  });
}

async function fetchWeatherWindow(start: string, endInclusive: string, sourceKind: "Historical" | "Forecast", signal?: AbortSignal) {
  const { latitude, longitude } = coordinates();
  const host = sourceKind === "Historical"
    ? "https://historical-forecast-api.open-meteo.com/v1/forecast"
    : "https://api.open-meteo.com/v1/forecast";
  const query = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude), start_date: start, end_date: endInclusive,
    timezone: TIME_ZONE, temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
    daily: ["weather_code","temperature_2m_max","temperature_2m_min","temperature_2m_mean","apparent_temperature_max","precipitation_sum","rain_sum","snowfall_sum","precipitation_probability_max","wind_speed_10m_max","wind_gusts_10m_max","sunshine_duration"].join(","),
  });
  const response = await fetch(`${host}?${query}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Weather service returned HTTP ${response.status}.`);
  const payload = await response.json() as WeatherApiResponse;
  if (payload.error) throw new Error(payload.reason || "Weather service rejected the request.");
  const daily = payload.daily;
  if (!daily?.time?.length) return 0;

  const values = daily.time.map((weatherDate, index) => ({
    weather_date: weatherDate,
    source_kind: sourceKind,
    weather_code: daily.weather_code?.[index] || 0,
    temperature_max_f: daily.temperature_2m_max?.[index] || 0,
    temperature_min_f: daily.temperature_2m_min?.[index] || 0,
    temperature_mean_f: daily.temperature_2m_mean?.[index] || 0,
    apparent_temperature_max_f: daily.apparent_temperature_max?.[index] || 0,
    precipitation_in: daily.precipitation_sum?.[index] || 0,
    rain_in: daily.rain_sum?.[index] || 0,
    snowfall_in: daily.snowfall_sum?.[index] || 0,
    precipitation_probability: daily.precipitation_probability_max?.[index] || 0,
    wind_max_mph: daily.wind_speed_10m_max?.[index] || 0,
    wind_gust_mph: daily.wind_gusts_10m_max?.[index] || 0,
    sunshine_hours: (daily.sunshine_duration?.[index] || 0) / 3600,
  }));
  await getSql()`
    INSERT INTO weather_daily (
      weather_date, source_kind, weather_code, temperature_max_f, temperature_min_f,
      temperature_mean_f, apparent_temperature_max_f, precipitation_in, rain_in,
      snowfall_in, precipitation_probability, wind_max_mph, wind_gust_mph, sunshine_hours
    )
    SELECT x.weather_date, x.source_kind, x.weather_code, x.temperature_max_f, x.temperature_min_f,
      x.temperature_mean_f, x.apparent_temperature_max_f, x.precipitation_in, x.rain_in,
      x.snowfall_in, x.precipitation_probability, x.wind_max_mph, x.wind_gust_mph, x.sunshine_hours
    FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS x(
      weather_date DATE, source_kind TEXT, weather_code INTEGER,
      temperature_max_f NUMERIC, temperature_min_f NUMERIC, temperature_mean_f NUMERIC,
      apparent_temperature_max_f NUMERIC, precipitation_in NUMERIC, rain_in NUMERIC,
      snowfall_in NUMERIC, precipitation_probability INTEGER, wind_max_mph NUMERIC,
      wind_gust_mph NUMERIC, sunshine_hours NUMERIC
    )
    ON CONFLICT (weather_date) DO UPDATE SET
      source_kind = EXCLUDED.source_kind, weather_code = EXCLUDED.weather_code,
      temperature_max_f = EXCLUDED.temperature_max_f, temperature_min_f = EXCLUDED.temperature_min_f,
      temperature_mean_f = EXCLUDED.temperature_mean_f, apparent_temperature_max_f = EXCLUDED.apparent_temperature_max_f,
      precipitation_in = EXCLUDED.precipitation_in, rain_in = EXCLUDED.rain_in,
      snowfall_in = EXCLUDED.snowfall_in, precipitation_probability = EXCLUDED.precipitation_probability,
      wind_max_mph = EXCLUDED.wind_max_mph, wind_gust_mph = EXCLUDED.wind_gust_mph,
      sunshine_hours = EXCLUDED.sunshine_hours, fetched_at = NOW()
  `;
  return daily.time.length;
}

export async function syncWeatherRange''')

rep(weather, 'export async function syncWeatherRange(start: string, end: string) {', 'export async function syncWeatherRange(start: string, end: string, options: WeatherSyncOptions = {}) {')
rep(weather, '''  if (start <= yesterday) {
    const historicalEnd = lastRequested < yesterday ? lastRequested : yesterday;
    historical = await fetchWeatherWindow(start, historicalEnd, "Historical");
  }
  if (lastRequested >= today) {
    const forecastStart = start > today ? start : today;
    const maximumForecast = addDays(today, 15);
    const forecastEnd = lastRequested < maximumForecast ? lastRequested : maximumForecast;
    if (forecastStart <= forecastEnd) forecast = await fetchWeatherWindow(forecastStart, forecastEnd, "Forecast");
  }
''', '''  if (start <= yesterday) {
    const historicalEnd = lastRequested < yesterday ? lastRequested : yesterday;
    const needed = await weatherDatesNeedingFetch(start, historicalEnd, "Historical");
    for (const window of contiguousDateWindows(needed)) {
      historical += await fetchWeatherWindow(window.start, window.end, "Historical", options.signal);
    }
  }
  if (lastRequested >= today) {
    const forecastStart = start > today ? start : today;
    const maximumForecast = addDays(today, 15);
    const forecastEnd = lastRequested < maximumForecast ? lastRequested : maximumForecast;
    if (forecastStart <= forecastEnd) {
      const needed = await weatherDatesNeedingFetch(forecastStart, forecastEnd, "Forecast");
      for (const window of contiguousDateWindows(needed)) {
        forecast += await fetchWeatherWindow(window.start, window.end, "Forecast", options.signal);
      }
    }
  }
''')

sub(weather, r'async function dailyBusinessRows\(business: Business, start: string, end: string\): Promise<BusinessDay\[]> \{.*?\n\}\n\nfunction pearson', '''async function dailyBusinessRows(business: Business, start: string, end: string): Promise<BusinessDay[]> {
  const result = new Map<string, BusinessDay>();
  const day = (date: string) => {
    const existing = result.get(date);
    if (existing) return existing;
    const created: BusinessDay = { date, sales: business === "Tiki" ? 0 : null, orders: 0, laborHours: 0 };
    result.set(date, created);
    return created;
  };
  const startInstantSql = getSql()`(${start}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}`;
  const endInstantSql = getSql()`(${end}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}`;

  if (business === "Tiki") {
    await ensureSquareControlSchema();
    const rows = await getSql()`
      WITH order_days AS (
        SELECT (((created_at_square AT TIME ZONE ${TIME_ZONE}) - INTERVAL '4 hours')::date)::text AS day,
          COUNT(*)::int AS orders, COALESCE(SUM(total_amount), 0)::numeric AS sales
        FROM square_orders
        WHERE state = 'COMPLETED'
          AND created_at_square >= (${start}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}
          AND created_at_square < (${end}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}
        GROUP BY 1
      ), labor_days AS (
        SELECT (((clock_in AT TIME ZONE ${TIME_ZONE}) - INTERVAL '4 hours')::date)::text AS day,
          COALESCE(SUM(CASE WHEN clock_out IS NOT NULL THEN EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600 ELSE 0 END), 0)::numeric AS labor_hours
        FROM time_entries
        WHERE business = 'Tiki'
          AND clock_in >= (${start}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}
          AND clock_in < (${end}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}
        GROUP BY 1
      )
      SELECT COALESCE(o.day, l.day) AS day, COALESCE(o.orders, 0)::int AS orders,
        COALESCE(o.sales, 0)::numeric AS sales, COALESCE(l.labor_hours, 0)::numeric AS labor_hours
      FROM order_days o FULL OUTER JOIN labor_days l ON l.day = o.day
    ` as unknown as Array<{ day: string; orders: number; sales: string | number; labor_hours: string | number }>;
    for (const row of rows) result.set(row.day, { date: row.day, orders: Number(row.orders || 0), sales: numeric(row.sales), laborHours: numeric(row.labor_hours) });
  } else {
    const rows = await getSql()`
      WITH order_values AS (
        SELECT opened_at,
          NULLIF(REGEXP_REPLACE(COALESCE(
            raw->>'Net Sales', raw->>'Order Total', raw->>'Total Amount', raw->>'Grand Total',
            raw->>'Gross Sales', raw->>'Net Total', raw->>'Total', raw->>'Amount', raw->>'Subtotal', ''
          ), '[^0-9.-]+', '', 'g'), '')::numeric AS sale
        FROM rezku_orders
        WHERE opened_at >= (${start}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}
          AND opened_at < (${end}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}
      ), order_days AS (
        SELECT (((opened_at AT TIME ZONE ${TIME_ZONE}) - INTERVAL '4 hours')::date)::text AS day,
          COUNT(*)::int AS orders, SUM(sale)::numeric AS sales
        FROM order_values GROUP BY 1
      ), labor_days AS (
        SELECT (((clock_in AT TIME ZONE ${TIME_ZONE}) - INTERVAL '4 hours')::date)::text AS day,
          COALESCE(SUM(CASE
            WHEN COALESCE(reported_hours, 0) > 0 THEN reported_hours
            WHEN clock_out IS NOT NULL THEN EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600
            ELSE 0 END), 0)::numeric AS labor_hours
        FROM rezku_shifts
        WHERE clock_in >= (${start}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}
          AND clock_in < (${end}::date + TIME '04:00') AT TIME ZONE ${TIME_ZONE}
        GROUP BY 1
      )
      SELECT COALESCE(o.day, l.day) AS day, COALESCE(o.orders, 0)::int AS orders,
        o.sales, COALESCE(l.labor_hours, 0)::numeric AS labor_hours
      FROM order_days o FULL OUTER JOIN labor_days l ON l.day = o.day
    ` as unknown as Array<{ day: string; orders: number; sales: string | number | null; labor_hours: string | number }>;
    for (const row of rows) result.set(row.day, { date: row.day, orders: Number(row.orders || 0), sales: row.sales === null ? null : numeric(row.sales), laborHours: numeric(row.labor_hours) });
  }

  for (const date of dateRange(start, end)) day(date);
  return Array.from(result.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function pearson''')

rep(weather, 'export async function weatherSalesIntelligence(input: { business: Business; start: string; end: string }) {', 'export async function weatherSalesIntelligence(input: { business: Business; start: string; end: string }, options: WeatherSyncOptions = {}) {')
rep(weather, '  const sync = await syncWeatherRange(input.start, input.end);', '  const sync = await syncWeatherRange(input.start, input.end, options);')
rep(weather, '  await syncWeatherRange(today, addDays(today, 11));', '  await syncWeatherRange(today, addDays(today, 11), options);')

# Route timeout now actually aborts Open-Meteo rather than abandoning work in the function.
route='src/app/api/weather/route.ts'
sub(route, r'async function reportWeatherWithTimeout\(input: \{ business: Business; start: string; end: string \}\) \{.*?\n\}', '''async function reportWeatherWithTimeout(input: { business: Business; start: string; end: string }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_WEATHER_TIMEOUT_MS);
  try {
    return await weatherSalesIntelligence(input, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Weather intelligence is taking too long. Stored performance data is still available; refresh weather again later.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}''')

print('Stage 6 weather/report performance transformations applied')
