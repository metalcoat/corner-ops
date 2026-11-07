"use client";
import { useEffect, useState } from "react";
import { BUSY_CHANNELS, type BusyChannel, type BusyTally } from "@/lib/busy-times";
import type { BusyTimesReport } from "@/lib/ordering-busy-times";
import type { ManagerReportView } from "@/lib/ordering-manager-report";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const clock = (minute: number, short = false) => {
  const hour = Math.floor(minute / 60) % 24, mins = minute % 60, suffix = hour < 12 ? "a" : "p";
  return `${hour % 12 || 12}${mins || !short ? `:${String(mins).padStart(2, "0")}` : ""}${short ? suffix : ` ${suffix.toUpperCase()}M`}`;
};
const dayLabel = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(`${date}T12:00:00Z`));
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LABELS: Record<BusyChannel, string> = { pickup: "Pickup", delivery: "Delivery", walk_in: "Walk-in" };
type Measure = "orders" | "sales";
const value = (tally: BusyTally, measure: Measure, channel?: BusyChannel) => {
  const source = channel ? tally.byChannel[channel] : tally;
  return measure === "orders" ? source.orders : source.salesCents;
};
const show = (amount: number, measure: Measure) => measure === "orders" ? (Number.isInteger(amount) ? String(amount) : amount.toFixed(1)) : money(amount);
const describe = (tally: BusyTally) => `${show(tally.orders, "orders")} orders · ${money(tally.salesCents)} — ${BUSY_CHANNELS.map((channel) => `${LABELS[channel]} ${show(tally.byChannel[channel].orders, "orders")}`).join(", ")}`;

/** Stacked columns, one per bar, split into pickup / delivery / walk-in. */
function Bars({ bars, measure, onPick }: { bars: Array<{ key: string; label: string; tick?: string; tally: BusyTally }>; measure: Measure; onPick?: (key: string) => void }) {
  const top = Math.max(1, ...bars.map((bar) => value(bar.tally, measure)));
  return <div className="busyChart" role="list">
    <div className="busyBars" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
      {bars.map((bar) => {
        const total = value(bar.tally, measure);
        const body = <>
          {total > 0 && bars.length <= 32 && <span className="busyBarTotal">{show(total, measure)}</span>}
          <span className="busyStack" style={{ height: `${(total / top) * 100}%` }}>
            {BUSY_CHANNELS.map((channel) => { const part = value(bar.tally, measure, channel); return part > 0 ? <i key={channel} className={`busy-${channel}`} style={{ flexGrow: part }} /> : null; })}
          </span>
        </>;
        const label = `${bar.label}: ${describe(bar.tally)}`;
        return onPick
          ? <button key={bar.key} type="button" role="listitem" className="busyBar" title={label} aria-label={`${label}. Open this day.`} onClick={() => onPick(bar.key)}>{body}</button>
          : <div key={bar.key} role="listitem" className="busyBar" title={label} aria-label={label}>{body}</div>;
      })}
    </div>
    <div className="busyTicks" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }} aria-hidden>
      {bars.map((bar) => <span key={bar.key}>{bar.tick ?? ""}</span>)}
    </div>
  </div>;
}

function Heatmap({ report, measure }: { report: BusyTimesReport; measure: Measure }) {
  const top = Math.max(1, ...report.heatmap.flatMap((row) => row.hours.map((cell) => value(cell, measure))));
  const columns = `3.2em repeat(${report.hours.length}, minmax(0, 1fr))`;
  return <div className="busyHeat" role="table" aria-label="Orders by weekday and hour">
    <div className="busyHeatRow" role="row" style={{ gridTemplateColumns: columns }}><span />{report.hours.map((hour, index) => <span key={hour.minute} className="busyHeatHead" role="columnheader">{index % 2 === 0 ? clock(hour.minute, true) : ""}</span>)}</div>
    {report.heatmap.map((row) => <div key={row.weekday} className="busyHeatRow" role="row" style={{ gridTemplateColumns: columns }}>
      <span role="rowheader">{WEEKDAYS[row.weekday]}</span>
      {row.hours.map((cell) => { const amount = value(cell, measure); return <span key={cell.minute} role="cell" className="busyHeatCell" style={{ opacity: row.days ? 1 : 0.25, background: amount ? `color-mix(in srgb, var(--busy-heat) ${Math.round(15 + (amount / top) * 85)}%, transparent)` : undefined }} title={`${WEEKDAYS[row.weekday]} ${clock(cell.minute)}: ${describe(cell)}`}>{amount ? show(amount, measure) : ""}</span>; })}
    </div>)}
  </div>;
}

export default function BusyTimes({ view, date, onOpenDay }: { view: ManagerReportView; date: string; onOpenDay: (day: string) => void }) {
  const [slot, setSlot] = useState<15 | 30>(30);
  const [measure, setMeasure] = useState<Measure>("orders");
  const [report, setReport] = useState<BusyTimesReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    const params = new URLSearchParams({ view, slot: String(slot), ...(date ? { date } : {}) });
    fetch(`/api/employee/manager-report/busy-times?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not load busy times."); setReport(body); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load busy times."); });
    return () => controller.abort();
  }, [date, slot, view]);

  if (error) return <p className="mgrError" role="alert">{error}</p>;
  if (!report) return <p className="mgrEmpty">Loading busy times…</p>;
  const { totals } = report;
  const days = report.byDay.length;
  const busiestDay = report.byDay.reduce<(typeof report.byDay)[number] | null>((best, day) => day.orders > (best?.orders || 0) ? day : best, null);
  return <div className="busyTimes">
    <div className="busyControls">
      <nav aria-label="Measure">{(["orders", "sales"] as const).map((option) => <button type="button" key={option} className={measure === option ? "active" : ""} aria-pressed={measure === option} onClick={() => setMeasure(option)}>{option === "orders" ? "Orders" : "Sales $"}</button>)}</nav>
      {view === "day" && <nav aria-label="Slot size">{([15, 30] as const).map((option) => <button type="button" key={option} className={slot === option ? "active" : ""} aria-pressed={slot === option} onClick={() => setSlot(option)}>{option} min</button>)}</nav>}
    </div>
    <p className="mgrEmpty">Counted by when each order was due to the customer (the time they picked, or the time quoted for ASAP), not when it was paid. Voided and cancelled orders are left out.</p>
    <section className="mgrTiles" aria-label="Busy summary">
      <article><span>Orders due</span><strong>{totals.orders}</strong><small>{money(totals.salesCents)} sales</small></article>
      {BUSY_CHANNELS.map((channel) => <article key={channel}><span><i className={`busyKey busy-${channel}`} />{LABELS[channel]}</span><strong>{totals.byChannel[channel].orders}</strong><small>{money(totals.byChannel[channel].salesCents)}</small></article>)}
      {view === "day"
        ? <article><span>Busiest {slot} min</span><strong>{report.busiestSlot ? clock(report.busiestSlot.minute) : "—"}</strong><small>{report.busiestSlot ? `${report.busiestSlot.orders} orders due` : "No orders"}</small></article>
        : <article><span>Busiest day</span><strong>{busiestDay ? dayLabel(busiestDay.businessDate, { weekday: "short", month: "short", day: "numeric" }) : "—"}</strong><small>{busiestDay ? `${busiestDay.orders} orders due` : "No orders"}</small></article>}
      <article><span>Busiest hour</span><strong>{report.busiestHour ? clock(report.busiestHour.minute) : "—"}</strong><small>{report.busiestHour ? view === "day" ? `${report.busiestHour.orders} orders due` : `${(report.busiestHour.orders / Math.max(1, days)).toFixed(1)} a day on average` : "No orders"}</small></article>
    </section>
    <p className="busyLegend">{BUSY_CHANNELS.map((channel) => <span key={channel}><i className={`busyKey busy-${channel}`} />{LABELS[channel]}</span>)}</p>
    {!report.storeHoursKnown && <p className="mgrEmpty">Store hours aren&apos;t set up, so the chart runs 10 AM – 10 PM plus any order due outside that.</p>}

    {view === "day" && <section className="mgrSection"><h2>{measure === "orders" ? "Orders" : "Sales"} due every {slot} minutes</h2>
      <Bars measure={measure} bars={report.slots.map((row) => ({ key: String(row.minute), label: `${clock(row.minute)}–${clock(row.minute + slot)}`, tick: row.minute % 60 === 0 && (row.minute / 60) % (slot === 15 ? 2 : 1) === 0 ? clock(row.minute, true) : "", tally: row }))} />
    </section>}

    {view !== "day" && <section className="mgrSection"><h2>{measure === "orders" ? "Orders" : "Sales"} due each day</h2>
      <Bars measure={measure} onPick={onOpenDay} bars={report.byDay.map((row) => ({ key: row.businessDate, label: dayLabel(row.businessDate, { weekday: "short", month: "short", day: "numeric" }), tick: view === "week" ? dayLabel(row.businessDate, { weekday: "short" }) : (Number(row.businessDate.slice(8)) === 1 || Number(row.businessDate.slice(8)) % 5 === 0 ? String(Number(row.businessDate.slice(8))) : ""), tally: row }))} />
      <p className="mgrEmpty">Tap a day to see it slot by slot.</p>
    </section>}

    {view === "week" && <section className="mgrSection"><h2>Hour by weekday</h2><Heatmap report={report} measure={measure} /></section>}

    {view === "month" && <section className="mgrSection"><h2>Average {measure === "orders" ? "orders" : "sales"} by hour</h2>
      <Bars measure={measure} bars={report.hours.map((row, index) => ({ key: String(row.minute), label: `${clock(row.minute)} (average of ${days} days)`, tick: index % 2 === 0 ? clock(row.minute, true) : "", tally: row.average }))} />
    </section>}
  </div>;
}
