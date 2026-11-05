"use client";
import { useEffect, useRef, useState } from "react";
import type { ItemSalesMetrics, SalesMetrics as Report } from "@/lib/ordering-sales-metrics";
import { rankItems, type ItemMetric, type MetricsPreset, type SalesSeries, type SeriesCell, type TrendBucket } from "@/lib/sales-metrics";
import "./sales-metrics.css";

const PRESETS: Array<{ key: MetricsPreset; label: string }> = [
  { key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" }, { key: "this_week", label: "This week" }, { key: "last_week", label: "Last week" },
  { key: "this_month", label: "This month" }, { key: "last_month", label: "Last month" }, { key: "last_90", label: "Last 90 days" }, { key: "custom", label: "Custom" },
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CHANNEL_LABELS: Record<string, string> = { counter: "Counter", phone: "Phone", ai_phone: "AI phone", online: "Online", kiosk: "Kiosk", pickup: "Pickup", delivery: "Delivery", dine_in: "Dine-in" };
const TENDER_LABELS: Record<string, string> = { cash: "Cash", card: "Card", gift_card: "Gift card", store_credit: "Store credit", house_account: "House account", loyalty: "Loyalty", check: "Check", external: "Third party" };
// Categorical slots in fixed order; a series keeps its slot whatever its rank.
const SERIES = ["var(--sm-s1)", "var(--sm-s2)", "var(--sm-s3)", "var(--sm-s4)", "var(--sm-s5)", "var(--sm-s6)"];

type Measure = "sales" | "count";
const money = (cents: number, exact = false) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: exact || Math.abs(cents) < 10_000 ? 2 : 0, minimumFractionDigits: exact || Math.abs(cents) < 10_000 ? 2 : 0 }).format(cents / 100);
const compactMoney = (cents: number) => cents >= 100_000 ? `$${(cents / 100_000).toFixed(cents >= 1_000_000 ? 0 : 1)}k` : `$${Math.round(cents / 100)}`;
const count = (value: number) => Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(1);
const clock = (hour: number) => `${hour % 12 || 12}${hour < 12 ? "a" : "p"}`;
const clockLong = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
const pretty = (date: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));
const valueOf = (cell: SeriesCell, measure: Measure) => measure === "sales" ? cell.cents : cell.count;
const show = (value: number, measure: Measure) => measure === "sales" ? money(value) : count(value);
const axis = (value: number, measure: Measure) => measure === "sales" ? compactMoney(value) : count(Math.round(value));
const share = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "0%";
/** A round axis top a little above the largest value. */
function niceTop(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value)), unit = value / magnitude;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * magnitude;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function Change({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return <small className="smChange">no earlier data</small>;
  const good = invert ? value < 0 : value > 0;
  return <small className={`smChange ${value === 0 ? "" : good ? "up" : "down"}`}>{value > 0 ? "▲" : value < 0 ? "▼" : "■"} {Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0)}%</small>;
}
const changeOf = (now: number, before: number) => before ? Math.round(((now - before) / before) * 1000) / 10 : null;

/** The tapped or hovered mark's numbers, above the chart. */
function Readout({ text, hint }: { text: string | null; hint: string }) {
  return <p className={`smReadout ${text ? "" : "hint"}`} aria-live="polite">{text || hint}</p>;
}

const roundedTop = (x: number, y: number, width: number, height: number, radius = 4) => {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
};

type Column = { key: string; tick: string; value: number; detail: string };
/** Vertical bars on a measured width, so text stays readable on a phone. */
function Columns({ columns, measure, label, height = 170, hint = "Tap a bar for its numbers." }: { columns: Column[]; measure: Measure; label: string; height?: number; hint?: string }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const left = 38, bottom = 20, top = 8, plotWidth = Math.max(0, width - left - 2), plotHeight = height - bottom - top;
  const max = niceTop(Math.max(0, ...columns.map((column) => column.value)));
  const step = columns.length ? plotWidth / columns.length : 0, gap = step > 8 ? 2 : 1, barWidth = Math.max(1, step - gap);
  const every = Math.max(1, Math.ceil(columns.length / Math.max(1, Math.floor(plotWidth / 34))));
  const y = (value: number) => top + plotHeight - (value / max) * plotHeight;
  return <div className="smChart" ref={ref}>
    <Readout text={active === null ? null : columns[active]?.detail || null} hint={hint} />
    {width > 0 && <svg width={width} height={height} role="img" aria-label={label} onPointerLeave={() => setActive(null)}>
      {[0, 0.5, 1].map((fraction) => <g key={fraction}>
        <line x1={left} x2={width} y1={y(max * fraction)} y2={y(max * fraction)} className={fraction ? "smGridLine" : "smBase"} />
        <text x={left - 5} y={y(max * fraction) + 4} className="smAxis" textAnchor="end">{axis(max * fraction, measure)}</text>
      </g>)}
      {columns.map((column, index) => {
        const x = left + index * step + gap / 2, barTop = y(column.value);
        return <g key={column.key}>
          {column.value > 0 && <path d={roundedTop(x, barTop, barWidth, top + plotHeight - barTop, Math.min(4, barWidth / 2))} className={`smBar ${active === index ? "active" : ""}`} />}
          {index % every === 0 && <text x={x + barWidth / 2} y={height - 5} className="smAxis" textAnchor="middle">{column.tick}</text>}
          <rect x={left + index * step} y={top} width={step} height={plotHeight} fill="transparent" onPointerEnter={() => setActive(index)} onPointerDown={() => setActive(index)}><title>{column.detail}</title></rect>
        </g>;
      })}
    </svg>}
  </div>;
}

/** Sales over the range as a line, with the period before as a dashed line. */
function Trend({ trend, measure, unit, label }: { trend: TrendBucket[]; measure: Measure; unit: string; label: string }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const height = 200, left = 38, right = 8, top = 10, bottom = 20, plotWidth = Math.max(0, width - left - right), plotHeight = height - top - bottom;
  const max = niceTop(Math.max(0, ...trend.flatMap((bucket) => [bucket.future ? 0 : valueOf(bucket, measure), bucket.previous ? valueOf(bucket.previous, measure) : 0])));
  const x = (index: number) => left + (trend.length > 1 ? (index / (trend.length - 1)) * plotWidth : plotWidth / 2);
  const y = (value: number) => top + plotHeight - (value / max) * plotHeight;
  const current = trend.map((bucket, index) => ({ bucket, index })).filter(({ bucket }) => !bucket.future);
  const path = (points: Array<[number, number]>) => points.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
  const line = path(current.map(({ bucket, index }) => [x(index), y(valueOf(bucket, measure))]));
  const area = current.length ? `${line}L${x(current[current.length - 1].index)},${y(0)}L${x(current[0].index)},${y(0)}Z` : "";
  const before = path(trend.flatMap((bucket, index) => bucket.previous ? [[x(index), y(valueOf(bucket.previous, measure))] as [number, number]] : []));
  const every = Math.max(1, Math.ceil(trend.length / Math.max(1, Math.floor(plotWidth / 46))));
  const pick = (clientX: number, element: SVGSVGElement) => {
    const offset = clientX - element.getBoundingClientRect().left;
    setActive(Math.min(trend.length - 1, Math.max(0, Math.round(((offset - left) / Math.max(1, plotWidth)) * (trend.length - 1)))));
  };
  const at = active === null ? null : trend[active];
  const detail = at ? `${at.label}: ${at.future ? "not yet" : `${show(valueOf(at, measure), measure)}${measure === "sales" ? ` · ${count(at.count)} ${unit}` : ""}`}${at.previous ? ` · before ${show(valueOf(at.previous, measure), measure)}` : ""}` : null;
  const tick = (bucket: TrendBucket) => bucket.label.replace(/^[A-Z][a-z]{2}, /, "").replace(/ – .*/, "");
  return <div className="smChart" ref={ref}>
    <Readout text={detail} hint="Drag or tap along the line." />
    {width > 0 && <svg width={width} height={height} role="img" aria-label={label} className="smTouch"
      onPointerMove={(event) => pick(event.clientX, event.currentTarget)} onPointerDown={(event) => pick(event.clientX, event.currentTarget)} onPointerLeave={() => setActive(null)}>
      {[0, 0.5, 1].map((fraction) => <g key={fraction}>
        <line x1={left} x2={width - right} y1={y(max * fraction)} y2={y(max * fraction)} className={fraction ? "smGridLine" : "smBase"} />
        <text x={left - 5} y={y(max * fraction) + 4} className="smAxis" textAnchor="end">{axis(max * fraction, measure)}</text>
      </g>)}
      {trend.map((bucket, index) => index % every === 0 && <text key={bucket.key} x={x(index)} y={height - 5} className="smAxis" textAnchor={index === 0 ? "start" : "middle"}>{tick(bucket)}</text>)}
      {area && <path d={area} className="smArea" />}
      {before && <path d={before} className="smLine previous" />}
      {line && <path d={line} className="smLine" />}
      {current.length === 1 && <circle cx={x(current[0].index)} cy={y(valueOf(current[0].bucket, measure))} r={4} className="smDot" />}
      {at && <g>
        <line x1={x(active!)} x2={x(active!)} y1={top} y2={top + plotHeight} className="smCross" />
        {at.previous && <circle cx={x(active!)} cy={y(valueOf(at.previous, measure))} r={4} className="smDot previous" />}
        {!at.future && <circle cx={x(active!)} cy={y(valueOf(at, measure))} r={5} className="smDot" />}
      </g>}
    </svg>}
    <div className="smLegend"><span><i className="smKey line" />This period</span><span><i className="smKey dashed" />Period before</span></div>
  </div>;
}

/** Hours that ever sell in the range, never narrower than 10 AM to 10 PM. Index 0 is 4 AM. */
function hourWindow(series: SalesSeries) {
  const sold = series.byHour.map((cell, index) => (cell.count ? index : -1)).filter((index) => index >= 0);
  return { first: Math.min(6, ...sold), last: Math.max(18, ...sold) };
}

function HourBars({ series, measure, unit }: { series: SalesSeries; measure: Measure; unit: string }) {
  const { first, last } = hourWindow(series);
  const columns = series.byHour.slice(first, last + 1).map((cell) => ({ key: String(cell.hour), tick: clock(cell.hour), value: valueOf(cell, measure), detail: `${clockLong(cell.hour)}–${clockLong((cell.hour + 1) % 24)}: ${money(cell.cents)} · ${count(cell.count)} ${unit}` }));
  return <Columns columns={columns} measure={measure} label="Sales by hour of day" />;
}

function WeekdayBars({ series, measure, unit, average }: { series: SalesSeries; measure: Measure; unit: string; average: boolean }) {
  const columns = series.byWeekday.map((cell) => {
    const by = average && cell.days ? cell.days : 1;
    return { key: String(cell.weekday), tick: WEEKDAYS[cell.weekday], value: valueOf(cell, measure) / by, detail: `${WEEKDAYS[cell.weekday]}: ${money(cell.cents / by)} · ${count(cell.count / by)} ${unit}${average ? ` per day (avg of ${cell.days})` : ""}` };
  });
  return <Columns columns={columns} measure={measure} label="Sales by weekday" />;
}

function Heatmap({ series, measure, unit }: { series: SalesSeries; measure: Measure; unit: string }) {
  const [active, setActive] = useState<string | null>(null);
  const { first, last } = hourWindow(series);
  const rows = series.heatmap.map((row) => ({ ...row, hours: row.hours.slice(first, last + 1) }));
  const top = Math.max(1, ...rows.flatMap((row) => row.hours.map((cell) => valueOf(cell, measure))));
  const columns = `2.4em repeat(${last - first + 1}, minmax(0, 1fr))`;
  return <div className="smChart">
    <Readout text={active} hint="Tap a square for its numbers. Darker sells more." />
    <div className="smHeat" role="table" aria-label="Sales by weekday and hour">
      <div className="smHeatRow" role="row" style={{ gridTemplateColumns: columns }}><span />{rows[0].hours.map((cell, index) => <span key={cell.hour} role="columnheader" className="smHeatHead">{index % 3 === 0 ? clock(cell.hour) : ""}</span>)}</div>
      {rows.map((row) => <div key={row.weekday} className="smHeatRow" role="row" style={{ gridTemplateColumns: columns }}>
        <span role="rowheader">{WEEKDAYS[row.weekday]}</span>
        {row.hours.map((cell) => {
          const amount = valueOf(cell, measure), text = `${WEEKDAYS[row.weekday]} ${clockLong(cell.hour)}: ${money(cell.cents)} · ${count(cell.count)} ${unit}`;
          return <button key={cell.hour} type="button" role="cell" className="smHeatCell" title={text} aria-label={text} onClick={() => setActive(text)} onPointerEnter={() => setActive(text)}
            style={{ background: amount ? `color-mix(in srgb, var(--sm-s1) ${Math.round(18 + (amount / top) * 82)}%, var(--sm-panel-2))` : undefined }} />;
        })}
      </div>)}
    </div>
  </div>;
}

/** One bar split into shares, with a legend row per part. */
function ShareBar({ parts, title }: { parts: Array<{ key: string; label: string; cents: number; orders?: number; change?: number | null; color: string }>; title: string }) {
  const whole = parts.reduce((sum, part) => sum + Math.max(0, part.cents), 0);
  const shown = parts.filter((part) => part.cents > 0 || part.orders);
  return <div className="smShare">
    <h3>{title}</h3>
    <div className="smShareBar" role="img" aria-label={`${title}: ${shown.map((part) => `${part.label} ${share(part.cents, whole)}`).join(", ")}`}>
      {whole ? shown.filter((part) => part.cents > 0).map((part) => <i key={part.key} style={{ flexGrow: part.cents, background: part.color }} title={`${part.label}: ${money(part.cents)} (${share(part.cents, whole)})`} />) : <i className="empty" />}
    </div>
    <ul>{shown.length ? shown.map((part) => <li key={part.key}>
      <span><i className="smKey" style={{ background: part.color }} />{part.label}</span>
      <b>{money(part.cents)}</b>
      <small>{share(part.cents, whole)}{part.orders !== undefined ? ` · ${part.orders} order${part.orders === 1 ? "" : "s"}` : ""}</small>
      {part.change !== undefined && <Change value={part.change ?? null} />}
    </li>) : <li className="smMuted">Nothing in this range.</li>}</ul>
  </div>;
}

/** Ranked items as horizontal bars; tap one to see when it sells. */
function ItemBars({ items, by, onPick }: { items: ItemMetric[]; by: "quantity" | "revenue"; onPick: (item: ItemMetric) => void }) {
  const top = Math.max(1, ...items.map((item) => (by === "quantity" ? item.quantity : item.netCents)));
  if (!items.length) return <p className="smMuted">No items sold in this range.</p>;
  return <ol className="smItems">{items.map((item) => {
    const value = by === "quantity" ? item.quantity : item.netCents, before = by === "quantity" ? item.prevQuantity : item.prevNetCents;
    return <li key={item.id}><button type="button" onClick={() => onPick(item)} aria-label={`${item.name}: ${item.quantity} sold, ${money(item.netCents)}. Open details.`}>
      <span className="smItemName">{item.name}<small>{item.category}</small></span>
      <span className="smItemValue">{by === "quantity" ? count(item.quantity) : money(item.netCents)}<Change value={changeOf(value, before)} /></span>
      <span className="smItemTrack"><i style={{ width: `${Math.max(1.5, (value / top) * 100)}%` }} /></span>
    </button></li>;
  })}</ol>;
}

function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void; label: string }) {
  return <div className="smToggle" role="group" aria-label={label}>{options.map(([key, text]) => <button key={key} type="button" className={value === key ? "active" : ""} aria-pressed={value === key} onClick={() => onChange(key)}>{text}</button>)}</div>;
}

function Card({ title, children, wide = false, tools }: { title: string; children: React.ReactNode; wide?: boolean; tools?: React.ReactNode }) {
  return <section className={`smCard ${wide ? "wide" : ""}`}><header><h2>{title}</h2>{tools}</header>{children}</section>;
}

function ItemDetail({ item, query, onClose }: { item: ItemMetric; query: string; onClose: () => void }) {
  const [data, setData] = useState<ItemSalesMetrics | null>(null), [error, setError] = useState("");
  const [measure, setMeasure] = useState<Measure>("count");
  useEffect(() => {
    let live = true;
    fetch(`/api/employee/sales-metrics?${query}&item=${item.id}`, { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!live) return;
      if (!response.ok) setError(body.error || "Couldn't load this item."); else setData(body);
    }).catch(() => live && setError("Couldn't reach the store server."));
    return () => { live = false; };
  }, [item.id, query]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const days = data ? data.range.lengthDays : 1;
  return <div className="smSheetBack" onClick={onClose}>
    <div className="smSheet" role="dialog" aria-modal="true" aria-label={`${item.name} sales`} onClick={(event) => event.stopPropagation()}>
      <header><div><h2>{item.name}</h2><small>{item.category}</small></div><button type="button" onClick={onClose} aria-label="Close">✕</button></header>
      {error && <p className="smError">{error}</p>}
      {!data && !error && <p className="smMuted">Loading…</p>}
      {data && <>
        <div className="smMiniKpis">
          <article><span>Sold</span><strong>{count(data.quantity)}</strong><Change value={changeOf(data.quantity, data.prevQuantity)} /></article>
          <article><span>Net sales</span><strong>{money(data.netCents)}</strong><Change value={changeOf(data.netCents, data.prevNetCents)} /></article>
          <article><span>Per day</span><strong>{count(Math.round((data.quantity / Math.max(1, days)) * 10) / 10)}</strong><small className="smChange">{data.prevQuantity} before</small></article>
        </div>
        <Toggle value={measure} options={[["count", "Quantity"], ["sales", "Sales $"]]} onChange={setMeasure} label="Measure" />
        <h3>Trend</h3>
        <Trend trend={data.series.trend} measure={measure} unit="sold" label={`${item.name} over the range`} />
        <h3>By hour of day</h3>
        <HourBars series={data.series} measure={measure} unit="sold" />
        <h3>By weekday</h3>
        <WeekdayBars series={data.series} measure={measure} unit="sold" average={days > 7} />
      </>}
    </div>
  </div>;
}

const KPI_LABELS: Record<string, string> = { netCents: "Net sales", orders: "Orders", avgTicketCents: "Average ticket", itemsSold: "Items sold" };

export default function SalesMetrics() {
  const [preset, setPreset] = useState<MetricsPreset>("this_week");
  const [custom, setCustom] = useState({ start: "", end: "" });
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [measure, setMeasure] = useState<Measure>("sales");
  const [itemsBy, setItemsBy] = useState<"quantity" | "revenue">("quantity");
  const [itemsEnd, setItemsEnd] = useState<"top" | "bottom">("top");
  const [picked, setPicked] = useState<ItemMetric | null>(null);
  const [showZero, setShowZero] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search), saved = params.get("range") as MetricsPreset | null;
    if (saved && PRESETS.some((entry) => entry.key === saved)) setPreset(saved);
    if (params.get("start") && params.get("end")) setCustom({ start: params.get("start") || "", end: params.get("end") || "" });
  }, []);
  const ready = preset !== "custom" || (custom.start && custom.end);
  const query = new URLSearchParams(preset === "custom" ? { range: preset, start: custom.start, end: custom.end } : { range: preset }).toString();
  useEffect(() => {
    if (!ready) return;
    let live = true;
    setLoading(true); setError("");
    window.history.replaceState(null, "", `?${query}`);
    fetch(`/api/employee/sales-metrics?${query}`, { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!live) return;
      if (!response.ok) setError(body.error || "Couldn't load sales metrics."); else setReport(body);
    }).catch(() => live && setError("Couldn't reach the store server.")).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [query, ready]);

  const range = report?.range;
  const unit = "orders";
  const ranked = report ? rankItems(report.items, itemsBy, itemsEnd) : [];
  const grainWord = range?.grain === "hour" ? "by hour" : range?.grain === "day" ? "by day" : "by week";
  const zeroByCategory = report ? Object.entries(report.zeroSellers.reduce<Record<string, typeof report.zeroSellers>>((groups, item) => { (groups[item.category] ||= []).push(item); return groups; }, {})) : [];
  const categoryTop = report ? Math.max(1, ...report.categories.map((category) => category.netCents)) : 1;

  return <main className="smPage">
    <header className="smHeader">
      <div><h1>Sales metrics</h1>{range && <p>{range.start === range.end ? pretty(range.start) : `${pretty(range.start)} – ${pretty(range.end)}`}{range.partial ? " (so far)" : ""} · vs {range.previous.start === range.previous.end ? pretty(range.previous.start) : `${pretty(range.previous.start)} – ${pretty(range.previous.end)}`}</p>}</div>
      <a href="/employee/manager">Daily report · Busy times</a>
    </header>
    <nav className="smPresets" aria-label="Date range">{PRESETS.map((entry) => <button key={entry.key} type="button" className={preset === entry.key ? "active" : ""} aria-pressed={preset === entry.key} onClick={() => setPreset(entry.key)}>{entry.label}</button>)}</nav>
    {preset === "custom" && <div className="smCustom">
      <label>From<input type="date" value={custom.start} max={custom.end || undefined} onChange={(event) => setCustom({ ...custom, start: event.target.value })} /></label>
      <label>To<input type="date" value={custom.end} min={custom.start || undefined} onChange={(event) => setCustom({ ...custom, end: event.target.value })} /></label>
    </div>}
    {error && <p className="smError">{error}</p>}
    {!report && !error && <p className="smMuted">{ready ? "Loading…" : "Pick a start and end date."}</p>}
    {report && range && <div className={`smGridWrap ${loading ? "loading" : ""}`}>
      <section className="smKpis" aria-label="Totals">
        {report.kpis.map((kpi) => <article key={kpi.key}>
          <span>{KPI_LABELS[kpi.key]}</span>
          <strong>{kpi.key === "netCents" || kpi.key === "avgTicketCents" ? money(kpi.value, kpi.key === "avgTicketCents") : count(kpi.value)}</strong>
          <Change value={kpi.change} />
          <small>before: {kpi.key === "netCents" || kpi.key === "avgTicketCents" ? money(kpi.previous, kpi.key === "avgTicketCents") : count(kpi.previous)}</small>
        </article>)}
      </section>
      <p className="smNote">Net sales are order totals (tax included) after voids, item cancellations and discounts, without tips ({money(report.totals.tipsCents)}) or delivery fees ({money(report.totals.deliveryFeesCents)}). With them: {money(report.totals.grossCents)}, the Daily report&apos;s Sales.</p>

      <div className="smGrid">
        <Card title={`Sales ${grainWord}`} wide tools={<Toggle value={measure} options={[["sales", "Sales $"], ["count", "Orders"]]} onChange={setMeasure} label="Chart measure" />}>
          <Trend trend={report.series.trend} measure={measure} unit={unit} label={`Sales ${grainWord}`} />
        </Card>
        <Card title="Where sales come from">
          <ShareBar title="Channel" parts={report.channels.map((part, index) => ({ key: part.key, label: CHANNEL_LABELS[part.key], cents: part.netCents, orders: part.orders, change: changeOf(part.netCents, part.prevNetCents), color: SERIES[index] }))} />
          <ShareBar title="Pickup or delivery" parts={report.fulfillment.map((part, index) => ({ key: part.key, label: CHANNEL_LABELS[part.key], cents: part.netCents, orders: part.orders, change: changeOf(part.netCents, part.prevNetCents), color: SERIES[index] }))} />
        </Card>
        <Card title="Payment mix">
          <ShareBar title="Money taken (with tips and fees)" parts={[...report.payments.tenders.map((part) => ({ key: part.tender, label: TENDER_LABELS[part.tender] || part.tender.replace(/_/g, " "), cents: part.cents, orders: part.orders })), ...(report.payments.unpaidCents ? [{ key: "unpaid", label: "Not paid yet", cents: report.payments.unpaidCents }] : [])].map((part, index) => ({ ...part, color: part.key === "unpaid" ? "var(--sm-muted-mark)" : SERIES[index] }))} />
        </Card>
        <Card title="By hour of day"><HourBars series={report.series} measure={measure} unit={unit} /><p className="smNote">By when the order was rung in. For orders by when they&apos;re due, open <a href="/employee/manager">Busy times</a> on the Daily report.</p></Card>
        <Card title={range.lengthDays > 7 ? "By weekday (average day)" : "By weekday"}><WeekdayBars series={report.series} measure={measure} unit={unit} average={range.lengthDays > 7} /></Card>
        <Card title="Hour × weekday" wide><Heatmap series={report.series} measure={measure} unit={unit} /></Card>
        <Card title={`${itemsEnd === "top" ? "Top" : "Bottom"} 10 items`} wide tools={<div className="smTools">
          <Toggle value={itemsEnd} options={[["top", "Best"], ["bottom", "Worst"]]} onChange={setItemsEnd} label="Best or worst sellers" />
          <Toggle value={itemsBy} options={[["quantity", "Qty"], ["revenue", "Sales $"]]} onChange={setItemsBy} label="Rank by" />
        </div>}>
          <p className="smMuted small">{itemsEnd === "bottom" ? "Slowest of the items that sold at least once. Items that sold none are below." : `${report.items.length} items sold.`} Tap an item to see when it sells.</p>
          <ItemBars items={ranked} by={itemsBy} onPick={setPicked} />
        </Card>
        <Card title="Categories">
          {report.categories.length ? <ol className="smItems">{report.categories.map((category) => <li key={category.name}><div className="smRowStatic">
            <span className="smItemName">{category.name}<small>{category.quantity} sold · {category.items} item{category.items === 1 ? "" : "s"}</small></span>
            <span className="smItemValue">{money(category.netCents)}<small className="smChange">{share(category.netCents, report.totals.netCents)}</small></span>
            <span className="smItemTrack"><i style={{ width: `${Math.max(1.5, (category.netCents / categoryTop) * 100)}%`, background: "var(--sm-s2)" }} /></span>
          </div></li>)}</ol> : <p className="smMuted">No items sold in this range.</p>}
        </Card>
        <Card title={`Sold none (${report.zeroSellers.length})`} tools={report.zeroSellers.length ? <button type="button" className="smLinkButton" onClick={() => setShowZero(!showZero)}>{showZero ? "Hide" : "Show"}</button> : undefined}>
          <p className="smMuted small">Active menu items with no sales in this range.</p>
          {showZero && zeroByCategory.map(([category, items]) => <div key={category} className="smZero"><h3>{category} <span>{items.length}</span></h3>
            <p>{items.map((item) => <span key={item.id} className={item.available ? "" : "off"} title={item.available ? undefined : "Marked unavailable"}>{item.name}{item.available ? "" : " (86)"}</span>)}</p></div>)}
          {!showZero && zeroByCategory.length > 0 && <p className="smZeroSummary">{zeroByCategory.slice(0, 6).map(([category, items]) => `${category} ${items.length}`).join(" · ")}{zeroByCategory.length > 6 ? " …" : ""}</p>}
        </Card>
      </div>
      <p className="smNote">Times are store time (Eastern). A day runs 4 AM to 4 AM. Updated {new Date(report.generatedAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })}.</p>
    </div>}
    {picked && <ItemDetail item={picked} query={query} onClose={() => setPicked(null)} />}
  </main>;
}
