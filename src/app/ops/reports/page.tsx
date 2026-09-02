"use client";

import { responseMessage } from "@/app/client-http";
import { useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./reports.css";

type MetricName = "sales" | "taxes" | "tips" | "orders" | "laborHours" | "averageTicket";
type Metrics = Record<MetricName, number>;
type Delta = { value: number; percent: number | null };
type Daily = { date: string; sales: number; taxes: number; tips: number; orders: number; laborHours: number };
type ReportPayload = {
  business: Business;
  range: { start: string; end: string };
  comparisonRange: { start: string; end: string } | null;
  primary: { metrics: Metrics; daily: Daily[]; topItems: Array<{ item: string; quantity: number; sales: number }> };
  comparison: { metrics: Metrics } | null;
  deltas: Record<MetricName, Delta> | null;
  availability: Record<MetricName | "topItems", boolean>;
  source: string;
  sourceNote: string;
  coverage: { firstRecord: string | null; lastRecord: string | null; records: number; latestImport: string | null };
  refreshResult: Record<string, unknown> | null;
  refreshWarning: string;
};

type WeatherHistoryDay = {
  date: string;
  sales: number | null;
  orders: number;
  laborHours: number;
  condition: string;
  temperatureMax: number;
  temperatureMin: number;
  precipitation: number;
  windMax: number;
  sunshineHours: number;
};

type ForecastDay = WeatherHistoryDay & {
  predictedSales: number | null;
  predictedOrders: number;
  predictedLaborHours: number;
  precipitationProbability: number;
  windGust: number;
  confidence: string;
  comparableDays: string[];
  recommendation: string;
};

type WeatherPayload = {
  business: Business;
  location: { name: string; latitude: number; longitude: number };
  weatherSource: string;
  sync?: { historical: number; forecast: number };
  salesAvailable: boolean;
  measure: "sales" | "orders";
  history: WeatherHistoryDay[];
  correlations: { temperature: number | null; precipitation: number | null; wind: number | null; sunshine: number | null; sampleDays: number };
  forecast: ForecastDay[];
  limitations: string;
};

type ComparisonMode = "previous" | "week" | "month" | "year" | "none";
type Range = { start: string; end: string };
type Section = "overview" | "trends" | "weather" | "details";
type TrendMetric = "sales" | "orders" | "tips" | "laborHours";

const money = (value: number | null) => value === null ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value || 0);
const number = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value || 0);

function dateFromKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

function addMonths(value: string, months: number): string {
  const date = dateFromKey(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 12)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return dateKey(date);
}

function addYears(value: string, years: number): string {
  const date = dateFromKey(value);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + years);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return dateKey(date);
}

function daysBetween(start: string, end: string): number {
  return Math.round((dateFromKey(end).getTime() - dateFromKey(start).getTime()) / 86_400_000);
}

function todayInNewYork(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function mondayOfWeek(value: string): string {
  const date = dateFromKey(value);
  return addDays(value, -((date.getUTCDay() + 6) % 7));
}

function comparisonRange(range: Range, mode: ComparisonMode): Range | null {
  if (mode === "none") return null;
  if (mode === "week") return { start: addDays(range.start, -7), end: addDays(range.end, -7) };
  if (mode === "month") return { start: addMonths(range.start, -1), end: addMonths(range.end, -1) };
  if (mode === "year") return { start: addYears(range.start, -1), end: addYears(range.end, -1) };
  const length = daysBetween(range.start, range.end);
  return { start: addDays(range.start, -length), end: range.start };
}

function displayRange(range: Range): string {
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${formatter.format(dateFromKey(range.start))} – ${formatter.format(dateFromKey(addDays(range.end, -1)))}`;
}

function dateLabel(value: string, weekday = false): string {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString([], weekday ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
}


function MetricCard(props: { label: string; value: number; delta: Delta | null; available: boolean; format: "money" | "number" }) {
  if (!props.available) return <div className="reportMetric unavailable"><span>{props.label}</span><strong>Unavailable</strong><small>Not supplied by this source</small></div>;
  const rendered = props.format === "money" ? money(props.value) : number(props.value);
  const direction = !props.delta || Math.abs(props.delta.value) < 0.005 ? "flat" : props.delta.value > 0 ? "up" : "down";
  return <div className="reportMetric"><span>{props.label}</span><strong>{rendered}</strong>{props.delta ? <small className={direction}>{props.delta.value > 0 ? "+" : ""}{props.format === "money" ? money(props.delta.value) : number(props.delta.value)}{props.delta.percent === null ? "" : ` · ${props.delta.percent > 0 ? "+" : ""}${props.delta.percent.toFixed(1)}%`}</small> : <small className="flat">No comparison selected</small>}</div>;
}

function TrendChart({ rows, metric }: { rows: Daily[]; metric: TrendMetric }) {
  const values = rows.map((row) => Number(row[metric] || 0));
  if (!rows.length) return <div className="chartEmpty">No daily records are available for this period.</div>;
  const width = 920;
  const height = 280;
  const paddingX = 42;
  const paddingTop = 20;
  const paddingBottom = 42;
  const maximum = Math.max(1, ...values);
  const minimum = Math.min(0, ...values);
  const span = Math.max(1, maximum - minimum);
  const points = rows.map((row, index) => {
    const x = paddingX + (index / Math.max(1, rows.length - 1)) * (width - paddingX * 2);
    const y = paddingTop + ((maximum - Number(row[metric] || 0)) / span) * (height - paddingTop - paddingBottom);
    return { x, y, row };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${paddingX},${height - paddingBottom} ${line} ${width - paddingX},${height - paddingBottom}`;
  const labels = points.filter((_, index) => index === 0 || index === points.length - 1 || index % Math.max(1, Math.floor(points.length / 5)) === 0);
  return <div className="trendChart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric} trend`}>
    {[0, .25, .5, .75, 1].map((ratio) => <line key={ratio} x1={paddingX} x2={width - paddingX} y1={paddingTop + ratio * (height - paddingTop - paddingBottom)} y2={paddingTop + ratio * (height - paddingTop - paddingBottom)} className="chartGridLine" />)}
    <polygon points={area} className="chartArea" />
    <polyline points={line} className="chartLine" />
    {points.map((point) => <circle key={point.row.date} cx={point.x} cy={point.y} r="4" className="chartPoint"><title>{dateLabel(point.row.date)}: {metric === "sales" || metric === "tips" ? money(Number(point.row[metric])) : number(Number(point.row[metric]))}</title></circle>)}
    {labels.map((point) => <text key={point.row.date} x={point.x} y={height - 13} textAnchor="middle" className="chartLabel">{dateLabel(point.row.date)}</text>)}
  </svg></div>;
}

function correlationLabel(value: number | null) {
  if (value === null) return "Not enough data";
  const strength = Math.abs(value) >= .65 ? "Strong" : Math.abs(value) >= .35 ? "Moderate" : "Weak";
  const direction = value > .05 ? "positive" : value < -.05 ? "negative" : "flat";
  return `${strength} ${direction}`;
}

export default function ReportsPage() {
  const today = useMemo(todayInNewYork, []);
  const currentMonday = useMemo(() => mondayOfWeek(today), [today]);
  const presets = useMemo(() => {
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const firstOfYear = `${today.slice(0, 4)}-01-01`;
    return [
      { label: "Yesterday", range: { start: addDays(today, -1), end: today } },
      { label: "Last week", range: { start: addDays(currentMonday, -7), end: currentMonday } },
      { label: "Last 30 days", range: { start: addDays(today, -29), end: addDays(today, 1) } },
      { label: "Last month", range: { start: addMonths(firstOfMonth, -1), end: firstOfMonth } },
      { label: "Year to date", range: { start: firstOfYear, end: addDays(today, 1) } },
    ];
  }, [currentMonday, today]);

  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [range, setRange] = useState<Range>(presets[2].range);
  const [comparison, setComparison] = useState<ComparisonMode>("previous");
  const [section, setSection] = useState<Section>("overview");
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("sales");
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [weather, setWeather] = useState<WeatherPayload | null>(null);
  const [notice, setNotice] = useState("");
  const [weatherNotice, setWeatherNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const compared = useMemo(() => comparisonRange(range, comparison), [comparison, range]);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView) => {
        setSession(payload);
        const allowed = payload.businesses || [];
        if (allowed.length && !allowed.includes(business)) setBusiness(allowed[0]);
      })
      .catch(() => setNotice("Unable to load the current account."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session?.authenticated || !range.start || !range.end || range.end <= range.start) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setNotice("");
      setWeatherNotice("");
      const reportQuery = new URLSearchParams({ business, start: range.start, end: range.end, refresh: business === "Tiki" ? "1" : "0" });
      if (compared) {
        reportQuery.set("compareStart", compared.start);
        reportQuery.set("compareEnd", compared.end);
      }
      const weatherQuery = new URLSearchParams({ business, start: range.start, end: range.end });
      const [reportResult, weatherResult] = await Promise.allSettled([
        fetch(`/api/reports?${reportQuery}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error(await responseMessage(response));
          return response.json() as Promise<ReportPayload>;
        }),
        fetch(`/api/weather?${weatherQuery}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error(await responseMessage(response));
          return response.json() as Promise<WeatherPayload>;
        }),
      ]);
      if (reportResult.status === "fulfilled") setReport(reportResult.value);
      else if ((reportResult.reason as Error)?.name !== "AbortError") setNotice(reportResult.reason instanceof Error ? reportResult.reason.message : String(reportResult.reason));
      if (weatherResult.status === "fulfilled") setWeather(weatherResult.value);
      else if ((weatherResult.reason as Error)?.name !== "AbortError") setWeatherNotice(weatherResult.reason instanceof Error ? weatherResult.reason.message : String(weatherResult.reason));
      if (!controller.signal.aborted) setLoading(false);
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [business, compared, range, refreshNonce, session?.authenticated]);

  const activePreset = presets.find((preset) => preset.range.start === range.start && preset.range.end === range.end)?.label;
  const daily = report?.primary.daily || [];
  const salesAvailable = report?.availability.sales ?? false;
  const demandMetric: "sales" | "orders" = salesAvailable ? "sales" : "orders";
  const bestDay = daily.reduce<Daily | null>((best, day) => !best || day[demandMetric] > best[demandMetric] ? day : best, null);
  const efficiency = daily.map((day) => ({ ...day, efficiency: day.laborHours > 0 ? (salesAvailable ? day.sales : day.orders) / day.laborHours : 0 }));
  const maxEfficiency = Math.max(1, ...efficiency.map((day) => day.efficiency));
  const correlationEntries = weather ? [
    { label: "Temperature", value: weather.correlations.temperature },
    { label: "Rain", value: weather.correlations.precipitation },
    { label: "Wind", value: weather.correlations.wind },
    { label: "Sunshine", value: weather.correlations.sunshine },
  ] : [];
  const strongestCorrelation = [...correlationEntries].filter((item) => item.value !== null).sort((left, right) => Math.abs(right.value || 0) - Math.abs(left.value || 0))[0];
  const nextForecast = weather?.forecast[0] || null;

  if (!session) return <main className="controlPage">Loading reports…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;
  const allowedBusinesses = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);

  return <main className={`controlPage reportsPage ${loading ? "reportLoading" : ""}`}>
    <header className="controlHeader">
      <div><p className="eyebrow">Performance and intelligence</p><h1>{business} reports</h1><p>Sales, labor, weather, trends, and operational recommendations in one place instead of scattered through a navigation scavenger hunt.</p></div>
      <div className="controlActions"><div className="businessPills">{allowedBusinesses.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div><button disabled={loading} onClick={() => setRefreshNonce((value) => value + 1)}>Refresh</button></div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}
    {weatherNotice && <div className="noticeBar weatherNotice">Weather intelligence could not refresh: {weatherNotice}</div>}

    <section className="controlCard reportToolbar">
      <div className="presetRow">{presets.map((preset) => <button key={preset.label} className={activePreset === preset.label ? "active" : ""} onClick={() => setRange(preset.range)}>{preset.label}</button>)}</div>
      <div className="reportFilters">
        <label>Start date<input type="date" value={range.start} onChange={(event) => setRange((current) => ({ ...current, start: event.target.value }))} /></label>
        <label>End date, exclusive<input type="date" value={range.end} onChange={(event) => setRange((current) => ({ ...current, end: event.target.value }))} /></label>
        <label>Compare with<select value={comparison} onChange={(event) => setComparison(event.target.value as ComparisonMode)}><option value="previous">Previous period</option><option value="week">Week before</option><option value="month">Month before</option><option value="year">Year before</option><option value="none">No comparison</option></select></label>
        <div className="reportRangeCompact"><span>{displayRange(range)}</span><small>Business day: 4 AM to 4 AM Eastern</small></div>
      </div>
    </section>

    <nav className="reportSections" aria-label="Report sections">{(["overview", "trends", "weather", "details"] as Section[]).map((name) => <button key={name} className={section === name ? "active" : ""} onClick={() => setSection(name)}>{name.charAt(0).toUpperCase() + name.slice(1)}</button>)}</nav>

    {section === "overview" && <div className="controlGrid">
      <section className="controlCard"><div className="reportMetricGrid">
        <MetricCard label="Sales" value={report?.primary.metrics.sales || 0} delta={report?.deltas?.sales || null} available={salesAvailable} format="money" />
        <MetricCard label="Orders" value={report?.primary.metrics.orders || 0} delta={report?.deltas?.orders || null} available={report?.availability.orders ?? true} format="number" />
        <MetricCard label="Average ticket" value={report?.primary.metrics.averageTicket || 0} delta={report?.deltas?.averageTicket || null} available={report?.availability.averageTicket ?? true} format="money" />
        <MetricCard label="Tips" value={report?.primary.metrics.tips || 0} delta={report?.deltas?.tips || null} available={report?.availability.tips ?? true} format="money" />
        <MetricCard label="Tax" value={report?.primary.metrics.taxes || 0} delta={report?.deltas?.taxes || null} available={report?.availability.taxes ?? true} format="money" />
        <MetricCard label="Labor hours" value={report?.primary.metrics.laborHours || 0} delta={report?.deltas?.laborHours || null} available={report?.availability.laborHours ?? true} format="number" />
      </div></section>

      <section className="intelligenceGrid">
        <article className="controlCard intelligenceCard"><p className="eyebrow">Demand peak</p><h2>{bestDay ? dateLabel(bestDay.date, true) : "No data"}</h2><strong>{bestDay ? (salesAvailable ? money(bestDay.sales) : `${number(bestDay.orders)} orders`) : "—"}</strong><p>Best day in the selected period by {salesAvailable ? "sales" : "order count"}.</p></article>
        <article className="controlCard intelligenceCard"><p className="eyebrow">Weather signal</p><h2>{strongestCorrelation?.label || "Learning"}</h2><strong>{strongestCorrelation ? correlationLabel(strongestCorrelation.value) : "Not enough history"}</strong><p>{weather ? `${weather.correlations.sampleDays} matched operating days analyzed.` : "Weather data is still loading."}</p></article>
        <article className="controlCard intelligenceCard"><p className="eyebrow">Next operating signal</p><h2>{nextForecast ? dateLabel(nextForecast.date, true) : "Forecast unavailable"}</h2><strong>{nextForecast ? `${Math.round(nextForecast.temperatureMax)}° · ${nextForecast.condition}` : "—"}</strong><p>{nextForecast?.recommendation || "Refresh weather intelligence to generate a recommendation."}</p></article>
      </section>

      <section className="controlCard reportPreview"><div><p className="eyebrow">Demand trend</p><h2>{trendMetric === "sales" ? "Daily sales" : trendMetric === "orders" ? "Daily orders" : trendMetric === "tips" ? "Daily tips" : "Daily labor"}</h2></div><TrendChart rows={daily} metric={salesAvailable ? "sales" : "orders"} /><button onClick={() => setSection("trends")}>Open trend analysis</button></section>
    </div>}

    {section === "trends" && <div className="controlGrid">
      <section className="controlCard"><div className="reportChartHeader"><div><p className="eyebrow">Daily graph</p><h2>Operating trend</h2></div><div className="chartMetricButtons">{(["sales", "orders", "tips", "laborHours"] as TrendMetric[]).map((metric) => <button key={metric} className={trendMetric === metric ? "active" : ""} disabled={metric === "sales" && !salesAvailable} onClick={() => setTrendMetric(metric)}>{metric === "laborHours" ? "Labor" : metric.charAt(0).toUpperCase() + metric.slice(1)}</button>)}</div></div><TrendChart rows={daily} metric={trendMetric === "sales" && !salesAvailable ? "orders" : trendMetric} /></section>
      <section className="controlCard"><div className="reportChartHeader"><div><p className="eyebrow">Efficiency</p><h2>{salesAvailable ? "Sales per labor hour" : "Orders per labor hour"}</h2></div><span>Higher bars indicate more demand handled per scheduled hour.</span></div><div className="efficiencyBars">{efficiency.map((day) => <div key={day.date} title={`${dateLabel(day.date)}: ${number(day.efficiency)}`}><i style={{ height: `${Math.max(3, (day.efficiency / maxEfficiency) * 100)}%` }} /><small>{dateLabel(day.date)}</small></div>)}</div></section>
    </div>}

    {section === "weather" && <div className="controlGrid" id="weather">
      <section className="controlCard weatherSource"><div><p className="eyebrow">Weather source</p><h2>{weather?.location.name || "Ogdensburg, NY"}</h2></div><span>{weather?.weatherSource || "Open-Meteo weather history and forecast"}</span><small>{weather?.limitations || "Weather data will appear after the first successful refresh."}</small></section>
      <section className="controlCard"><div className="reportChartHeader"><div><p className="eyebrow">Demand relationship</p><h2>Weather correlations</h2></div><span>{weather?.correlations.sampleDays || 0} matched days</span></div><div className="correlationGrid">{correlationEntries.map((item) => { const value = item.value || 0; return <article key={item.label}><span>{item.label}</span><strong>{correlationLabel(item.value)}</strong><div className="correlationTrack"><i className={value < 0 ? "negative" : "positive"} style={{ width: `${Math.abs(value) * 50}%`, left: value < 0 ? `${50 - Math.abs(value) * 50}%` : "50%" }} /></div><small>{item.value === null ? "—" : item.value.toFixed(2)}</small></article>; })}{!weather && <p>No weather analysis is available yet.</p>}</div></section>
      <section className="controlCard"><div className="reportChartHeader"><div><p className="eyebrow">Upcoming weather</p><h2>Forecast and operating recommendations</h2></div><span className="badge good">Next 10 days</span></div><div className="forecastGrid">{(weather?.forecast || []).map((day) => <article className="forecastCard" key={day.date}><header><div><strong>{dateLabel(day.date, true)}</strong><span>{day.condition}</span></div><span className={`confidence ${day.confidence.toLowerCase()}`}>{day.confidence}</span></header><div className="forecastMetrics"><span>{Math.round(day.temperatureMax)}° / {Math.round(day.temperatureMin)}°</span><span>{Math.round(day.precipitationProbability)}% rain</span><span>Gust {Math.round(day.windGust)} mph</span><span>{weather?.salesAvailable ? money(day.predictedSales) : `${number(day.predictedOrders)} orders`} predicted</span><span>{number(day.predictedLaborHours)} similar-day labor hrs</span></div><p>{day.recommendation}</p><small>Comparable dates: {day.comparableDays.length ? day.comparableDays.map((date) => dateLabel(date)).join(", ") : "Not enough history yet"}</small></article>)}{!weather?.forecast.length && <p>No forecast data is available.</p>}</div></section>
    </div>}

    {section === "details" && <div className="controlGrid">
      {report?.refreshWarning && <section className="controlCard"><div className="reportWarning">Square refresh warning: {report.refreshWarning}. Stored records are shown.</div></section>}
      <section className="controlCard"><div className="reportRange"><div><p className="eyebrow">Selected period</p><strong>{displayRange(range)}</strong><p>{activePreset || "Custom range"}</p></div>{compared && <div><p className="eyebrow">Comparison</p><strong>{displayRange(compared)}</strong></div>}<span className="badge good">{report?.source || "Loading source"}</span></div><div className="reportNote">{report?.sourceNote || "Source details are loading."}</div></section>
      <section className="controlCard"><p className="eyebrow">Data coverage</p><div className="coverageStrip"><div><span>First record</span><strong>{report?.coverage.firstRecord ? new Date(report.coverage.firstRecord).toLocaleDateString() : "None"}</strong></div><div><span>Latest record</span><strong>{report?.coverage.lastRecord ? new Date(report.coverage.lastRecord).toLocaleString() : "None"}</strong></div><div><span>Stored records</span><strong>{number(report?.coverage.records || 0)}</strong></div><div><span>Latest import</span><strong>{report?.coverage.latestImport ? new Date(report.coverage.latestImport).toLocaleString() : "None"}</strong></div></div></section>
      <section className="controlCard reportSplit"><div><p className="eyebrow">Day by day</p><h2>Selected period</h2><div className="tableWrap"><table className="reportDaily"><thead><tr><th>Business date</th><th>Sales</th><th>Orders</th><th>Tips</th><th>Labor</th></tr></thead><tbody>{daily.map((day) => <tr key={day.date}><td>{dateLabel(day.date, true)}</td><td>{salesAvailable ? money(day.sales) : "—"}</td><td>{number(day.orders)}</td><td>{money(day.tips)}</td><td>{number(day.laborHours)}</td></tr>)}{!daily.length && <tr><td colSpan={5}>No records were found in this period.</td></tr>}</tbody></table></div></div><div><p className="eyebrow">{business === "Tiki" ? "Square item detail" : "Rezku source"}</p><h2>{business === "Tiki" ? "Top items" : "Item sales unavailable"}</h2>{business === "Tiki" ? (report?.primary.topItems || []).slice(0, 15).map((item) => <div className="topItem" key={item.item}><strong>{item.item}</strong><span>{number(item.quantity)}</span><span>{money(item.sales)}</span></div>) : <div className="reportNote">Current Rezku email exports do not include reliable item-level sales totals. Orders, labor, tips, and any recognizable sales totals are shown instead.</div>}</div></section>
    </div>}
  </main>;
}
