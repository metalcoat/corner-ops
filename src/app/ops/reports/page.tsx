"use client";

import { useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./reports.css";

type MetricName = "sales" | "taxes" | "tips" | "orders" | "laborHours" | "averageTicket";
type Metrics = Record<MetricName, number>;
type Delta = { value: number; percent: number | null };
type ReportPayload = {
  business: Business;
  timeZone: string;
  businessDayStartsAt: string;
  range: { start: string; end: string };
  comparisonRange: { start: string; end: string } | null;
  primary: {
    metrics: Metrics;
    daily: Array<{
      date: string;
      sales: number;
      taxes: number;
      tips: number;
      orders: number;
      laborHours: number;
    }>;
    topItems: Array<{ item: string; quantity: number; sales: number }>;
  };
  comparison: { metrics: Metrics } | null;
  deltas: Record<MetricName, Delta> | null;
  availability: Record<MetricName | "topItems", boolean>;
  source: string;
  sourceNote: string;
  coverage: {
    firstRecord: string | null;
    lastRecord: string | null;
    records: number;
    latestImport: string | null;
    importCount?: number;
  };
  refreshResult: Record<string, unknown> | null;
  refreshWarning: string;
};

type ComparisonMode = "previous" | "week" | "month" | "year" | "none";
type Range = { start: string; end: string };

const money = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
}).format(value || 0);
const number = (value: number) => new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
}).format(value || 0);

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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function mondayOfWeek(value: string): string {
  const date = dateFromKey(value);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return addDays(value, -daysSinceMonday);
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

function errorMessage(response: Response): Promise<string> {
  return response.json()
    .catch(() => null)
    .then((payload: { error?: string } | null) => payload?.error || `Request failed (${response.status}).`);
}

function MetricCard(props: {
  label: string;
  metric: MetricName;
  value: number;
  delta: Delta | null;
  available: boolean;
  format: "money" | "number";
}) {
  if (!props.available) {
    return <div className="reportMetric unavailable"><span>{props.label}</span><strong>Not in emailed data</strong></div>;
  }
  const rendered = props.format === "money" ? money(props.value) : number(props.value);
  const change = props.delta;
  const direction = !change || Math.abs(change.value) < 0.005 ? "flat" : change.value > 0 ? "up" : "down";
  return <div className="reportMetric">
    <span>{props.label}</span>
    <strong>{rendered}</strong>
    {change ? <small className={direction}>
      {change.value > 0 ? "+" : ""}{props.format === "money" ? money(change.value) : number(change.value)}
      {change.percent === null ? "" : ` · ${change.percent > 0 ? "+" : ""}${change.percent.toFixed(1)}%`}
    </small> : <small className="flat">No comparison selected</small>}
  </div>;
}

export default function ReportsPage() {
  const today = useMemo(todayInNewYork, []);
  const currentMonday = useMemo(() => mondayOfWeek(today), [today]);
  const presets = useMemo(() => {
    const weekday = dateFromKey(today).getUTCDay();
    const completedWeekendEnd = weekday === 0 || weekday === 6 ? currentMonday : currentMonday;
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const firstOfYear = `${today.slice(0, 4)}-01-01`;
    return [
      { label: "Yesterday", range: { start: addDays(today, -1), end: today } },
      { label: "Last weekend", range: { start: addDays(completedWeekendEnd, -3), end: completedWeekendEnd } },
      { label: "Last week", range: { start: addDays(currentMonday, -7), end: currentMonday } },
      { label: "Last 30 days", range: { start: addDays(today, -29), end: addDays(today, 1) } },
      { label: "Last month", range: { start: addMonths(firstOfMonth, -1), end: firstOfMonth } },
      { label: "Year to date", range: { start: firstOfYear, end: addDays(today, 1) } },
    ];
  }, [currentMonday, today]);

  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Tiki");
  const [range, setRange] = useState<Range>(presets[2].range);
  const [comparison, setComparison] = useState<ComparisonMode>("previous");
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [notice, setNotice] = useState("");
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
    // The initial business is deliberately resolved from the returned session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session?.authenticated || !range.start || !range.end) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setNotice("");
      try {
        const query = new URLSearchParams({
          business,
          start: range.start,
          end: range.end,
          refresh: business === "Tiki" ? "1" : "0",
        });
        if (compared) {
          query.set("compareStart", compared.start);
          query.set("compareEnd", compared.end);
        }
        const response = await fetch(`/api/reports?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await errorMessage(response));
        setReport(await response.json());
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [business, compared, range, refreshNonce, session?.authenticated]);

  if (!session) return <main className="controlPage">Loading reports…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;

  const allowedBusinesses = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);
  const activePreset = presets.find((preset) => preset.range.start === range.start && preset.range.end === range.end)?.label;
  const metrics = report?.primary.metrics;
  const deltas = report?.deltas;

  return <main className={`controlPage ${loading ? "reportLoading" : ""}`}>
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Performance reports</p>
        <h1>{business} reporting</h1>
        <p>Clickable business periods, honest source coverage, and comparisons that do not require spreadsheet archaeology.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills">
          {allowedBusinesses.map((name) => <button
            key={name}
            className={business === name ? "active" : ""}
            onClick={() => setBusiness(name)}
          >{name}</button>)}
        </div>
        <button onClick={() => setRefreshNonce((value) => value + 1)} disabled={loading}>Refresh report</button>
        <a href="/ops">Operations</a>
      </div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <div className="controlGrid">
      <section className="controlCard reportToolbar">
        <div className="presetRow">
          {presets.map((preset) => <button
            key={preset.label}
            className={activePreset === preset.label ? "active" : ""}
            onClick={() => setRange(preset.range)}
          >{preset.label}</button>)}
        </div>
        <div className="reportFilters">
          <label>Start date<input type="date" value={range.start} onChange={(event) => setRange((current) => ({ ...current, start: event.target.value }))}/></label>
          <label>End date, exclusive<input type="date" value={range.end} onChange={(event) => setRange((current) => ({ ...current, end: event.target.value }))}/></label>
          <label>Compare with<select value={comparison} onChange={(event) => setComparison(event.target.value as ComparisonMode)}>
            <option value="previous">Previous period</option>
            <option value="week">Week before</option>
            <option value="month">Month before</option>
            <option value="year">Year before</option>
            <option value="none">No comparison</option>
          </select></label>
          <div className="reportNote"><strong>Business day</strong><br/>4:00 AM to 4:00 AM Eastern</div>
        </div>
      </section>

      <section className="controlCard">
        <div className="reportRange">
          <div><p className="eyebrow">Selected period</p><strong>{displayRange(range)}</strong><p>{activePreset || "Custom range"}</p></div>
          {compared && <div><p className="eyebrow">Comparison</p><strong>{displayRange(compared)}</strong><p>{comparison.replace("previous", "Previous period").replace("week", "Week before").replace("month", "Month before").replace("year", "Year before")}</p></div>}
          <span className="badge good">{report?.source || "Loading source"}</span>
        </div>
      </section>

      {report?.refreshWarning && <section className="controlCard"><div className="reportWarning">Square refresh warning: {report.refreshWarning}. Stored records are shown.</div></section>}
      {report && <section className="controlCard"><div className="reportNote">{report.sourceNote}</div></section>}

      <section className="controlCard">
        <div className="reportMetricGrid">
          <MetricCard label="Sales" metric="sales" value={metrics?.sales || 0} delta={deltas?.sales || null} available={report?.availability.sales ?? true} format="money"/>
          <MetricCard label="Orders" metric="orders" value={metrics?.orders || 0} delta={deltas?.orders || null} available={report?.availability.orders ?? true} format="number"/>
          <MetricCard label="Average ticket" metric="averageTicket" value={metrics?.averageTicket || 0} delta={deltas?.averageTicket || null} available={report?.availability.averageTicket ?? true} format="money"/>
          <MetricCard label="Tips" metric="tips" value={metrics?.tips || 0} delta={deltas?.tips || null} available={report?.availability.tips ?? true} format="money"/>
          <MetricCard label="Tax" metric="taxes" value={metrics?.taxes || 0} delta={deltas?.taxes || null} available={report?.availability.taxes ?? true} format="money"/>
          <MetricCard label="Labor hours" metric="laborHours" value={metrics?.laborHours || 0} delta={deltas?.laborHours || null} available={report?.availability.laborHours ?? true} format="number"/>
        </div>
      </section>

      <section className="controlCard">
        <p className="eyebrow">Data coverage</p>
        <div className="coverageStrip">
          <div><span>First stored record</span><strong>{report?.coverage.firstRecord ? new Date(report.coverage.firstRecord).toLocaleDateString() : "None"}</strong></div>
          <div><span>Latest stored record</span><strong>{report?.coverage.lastRecord ? new Date(report.coverage.lastRecord).toLocaleString() : "None"}</strong></div>
          <div><span>Stored source records</span><strong>{number(report?.coverage.records || 0)}</strong></div>
          <div><span>{business === "Tiki" ? "Square range refresh" : "Latest Rezku email import"}</span><strong>{business === "Tiki" ? (report?.refreshResult ? "Completed" : "Stored data") : (report?.coverage.latestImport ? new Date(report.coverage.latestImport).toLocaleString() : "None")}</strong></div>
        </div>
      </section>

      <section className="controlCard reportSplit">
        <div>
          <p className="eyebrow">Day by day</p>
          <h2>Selected period</h2>
          <div className="tableWrap"><table className="reportDaily"><thead><tr><th>Business date</th><th>Sales</th><th>Orders</th><th>Tips</th><th>Labor</th></tr></thead><tbody>
            {(report?.primary.daily || []).map((day) => <tr key={day.date}><td>{new Date(`${day.date}T12:00:00`).toLocaleDateString()}</td><td>{report?.availability.sales ? money(day.sales) : "—"}</td><td>{number(day.orders)}</td><td>{money(day.tips)}</td><td>{number(day.laborHours)}</td></tr>)}
            {report?.primary.daily.length === 0 && <tr><td colSpan={5}>No records were found in this period.</td></tr>}
          </tbody></table></div>
        </div>
        <div>
          <p className="eyebrow">{business === "Tiki" ? "Square item detail" : "Rezku limitation"}</p>
          <h2>{business === "Tiki" ? "Top items" : "Item sales unavailable"}</h2>
          {business === "Tiki" ? (report?.primary.topItems || []).slice(0, 15).map((item) => <div className="topItem" key={item.item}><strong>{item.item}</strong><span>{number(item.quantity)}</span><span>{money(item.sales)}</span></div>) : <div className="reportNote">The current Deli email exports do not provide item-level sales totals. Labor, order counts, and tips are shown for the dates actually imported.</div>}
        </div>
      </section>
    </div>
  </main>;
}
