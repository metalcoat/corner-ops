"use client";

import { useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./weather.css";

type HistoryDay = {
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

type ForecastDay = HistoryDay & {
  predictedSales: number | null;
  predictedOrders: number;
  predictedLaborHours: number;
  precipitationProbability: number;
  windGust: number;
  confidence: string;
  comparableDays: string[];
  recommendation: string;
};

type Payload = {
  business: Business;
  range: { start: string; end: string };
  location: { name: string; latitude: number; longitude: number };
  weatherSource: string;
  salesAvailable: boolean;
  measure: "sales" | "orders";
  history: HistoryDay[];
  correlations: {
    temperature: number | null;
    precipitation: number | null;
    wind: number | null;
    sunshine: number | null;
    sampleDays: number;
  };
  forecast: ForecastDay[];
  limitations: string;
};

function todayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function money(value: number | null) {
  return value === null ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function number(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value || 0);
}

function dateLabel(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function correlationLabel(value: number | null) {
  if (value === null) return "Not enough data";
  const strength = Math.abs(value) >= 0.65 ? "Strong" : Math.abs(value) >= 0.35 ? "Moderate" : "Weak";
  const direction = value > 0.05 ? "positive" : value < -0.05 ? "negative" : "flat";
  return `${strength} ${direction} · ${value.toFixed(2)}`;
}

async function errorMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function WeatherPage() {
  const today = useMemo(todayKey, []);
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Tiki");
  const [start, setStart] = useState(() => addDays(today, -90));
  const [end, setEnd] = useState(today);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((value: SessionView) => {
        setSession(value);
        const allowed = value.businesses || [];
        if (allowed.length && !allowed.includes(business)) setBusiness(allowed[0]);
      })
      .catch(() => setNotice("Unable to load the current account."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session?.authenticated || !start || !end || end <= start) return;
    const controller = new AbortController();
    setLoading(true);
    setNotice("");
    const query = new URLSearchParams({ business, start, end });
    fetch(`/api/weather?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response));
        return response.json() as Promise<Payload>;
      })
      .then(setPayload)
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [business, end, nonce, session?.authenticated, start]);

  if (!session) return <main className="controlPage">Loading weather intelligence…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;
  const allowed = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);

  return <main className={`controlPage ${loading ? "weatherLoading" : ""}`}>
    <header className="controlHeader">
      <div><p className="eyebrow">Weather and demand</p><h1>{business} weather intelligence</h1><p>Daily weather matched to actual operating results, plus similar-day estimates for the upcoming forecast.</p></div>
      <div className="controlActions"><div className="businessPills">{allowed.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div><button disabled={loading} onClick={() => setNonce((value) => value + 1)}>Refresh weather</button><a href="/ops/reports">Reports</a></div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}
    <div className="controlGrid">
      <section className="controlCard weatherFilters"><label>History starts<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>History ends, exclusive<input type="date" value={end} max={today} onChange={(event) => setEnd(event.target.value)} /></label><button onClick={() => { setStart(addDays(today, -30)); setEnd(today); }}>30 days</button><button onClick={() => { setStart(addDays(today, -90)); setEnd(today); }}>90 days</button><button onClick={() => { setStart(addDays(today, -365)); setEnd(today); }}>1 year</button></section>

      {payload && <section className="controlCard weatherSource"><strong>{payload.location.name}</strong><span>{payload.weatherSource}</span><small>{payload.limitations}</small></section>}

      <section className="controlCard"><div className="weatherCorrelationGrid">
        <article><span>Temperature vs {payload?.measure || "demand"}</span><strong>{correlationLabel(payload?.correlations.temperature ?? null)}</strong></article>
        <article><span>Rain vs {payload?.measure || "demand"}</span><strong>{correlationLabel(payload?.correlations.precipitation ?? null)}</strong></article>
        <article><span>Wind vs {payload?.measure || "demand"}</span><strong>{correlationLabel(payload?.correlations.wind ?? null)}</strong></article>
        <article><span>Sunshine vs {payload?.measure || "demand"}</span><strong>{correlationLabel(payload?.correlations.sunshine ?? null)}</strong></article>
        <article><span>Comparable days</span><strong>{payload?.correlations.sampleDays || 0}</strong></article>
      </div></section>

      <section className="controlCard"><div className="weatherSectionHeader"><div><p className="eyebrow">Upcoming forecast</p><h2>Operational recommendations</h2></div><span className="badge good">Next 10 days</span></div><div className="forecastGrid">{(payload?.forecast || []).map((day) => <article className="forecastCard" key={day.date}><header><div><strong>{dateLabel(day.date)}</strong><span>{day.condition}</span></div><span className={`confidence ${day.confidence.toLowerCase()}`}>{day.confidence}</span></header><div className="forecastMetrics"><span>{Math.round(day.temperatureMax)}° / {Math.round(day.temperatureMin)}°</span><span>{Math.round(day.precipitationProbability)}% rain</span><span>Gust {Math.round(day.windGust)} mph</span><span>{payload?.salesAvailable ? money(day.predictedSales) : `${number(day.predictedOrders)} orders`} predicted</span><span>{number(day.predictedLaborHours)} labor hrs similar days</span></div><p>{day.recommendation}</p><small>Compared with: {day.comparableDays.length ? day.comparableDays.map(dateLabel).join(", ") : "No matching history yet"}</small></article>)}{!payload?.forecast.length && <p>No forecast data available.</p>}</div></section>

      <section className="controlCard"><div className="weatherSectionHeader"><div><p className="eyebrow">Daily history</p><h2>Weather against results</h2></div><span>{payload?.salesAvailable ? "Sales available" : "Orders used as demand proxy"}</span></div><div className="weatherTableWrap"><table className="weatherTable"><thead><tr><th>Date</th><th>Conditions</th><th>High / Low</th><th>Rain</th><th>Wind</th><th>Sales</th><th>Orders</th><th>Labor</th></tr></thead><tbody>{[...(payload?.history || [])].reverse().map((day) => <tr key={day.date}><td>{dateLabel(day.date)}</td><td>{day.condition}</td><td>{Math.round(day.temperatureMax)}° / {Math.round(day.temperatureMin)}°</td><td>{day.precipitation.toFixed(2)} in</td><td>{Math.round(day.windMax)} mph</td><td>{money(day.sales)}</td><td>{number(day.orders)}</td><td>{number(day.laborHours)}</td></tr>)}</tbody></table></div></section>
    </div>
  </main>;
}
