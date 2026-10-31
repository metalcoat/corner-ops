"use client";
import { useCallback, useEffect, useState } from "react";
import type { ManagerReport as Report, ManagerReportView } from "@/lib/ordering-manager-report";
import "./manager-report.css";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${money(Math.abs(cents))}`;
const when = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const dayLabel = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(`${date}T12:00:00Z`));
const creditKinds: Record<string, string> = { refund: "Refund left as credit", issue: "Credit issued", redeem: "Credit used", reversal: "Credit returned" };

function move(view: ManagerReportView, date: string, step: number) {
  const value = new Date(`${date}T12:00:00Z`);
  if (view === "month") { value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() + step); }
  else value.setUTCDate(value.getUTCDate() + step * (view === "week" ? 7 : 1));
  return value.toISOString().slice(0, 10);
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return <section className="mgrSection"><h2>{title}{count != null && <span>{count}</span>}</h2>{children}</section>;
}
function Row({ title, detail, amount, tone }: { title: string; detail?: string; amount?: string; tone?: "bad" | "good" }) {
  return <div className="mgrRow"><div><strong>{title}</strong>{detail && <small>{detail}</small>}</div>{amount && <b className={tone}>{amount}</b>}</div>;
}

export default function ManagerReport() {
  const [view, setView] = useState<ManagerReportView>("day");
  const [date, setDate] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async (signal: AbortSignal) => {
    setError("");
    const params = new URLSearchParams({ view, ...(date ? { date } : {}) });
    const response = await fetch(`/api/employee/manager-report?${params}`, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load the report.");
    setReport(body);
  }, [date, view]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the report."); });
    return () => controller.abort();
  }, [load]);

  const shown = report?.date || date;
  const today = report?.today || "";
  const openDay = (day: string) => { setDate(day); setView("day"); window.scrollTo({ top: 0 }); };
  const title = !report ? "" : view === "day" ? dayLabel(report.date, { weekday: "long", month: "long", day: "numeric" }) : view === "week" ? `${dayLabel(report.start, { month: "short", day: "numeric" })} – ${dayLabel(report.end, { month: "short", day: "numeric" })}` : dayLabel(report.start, { month: "long", year: "numeric" });
  const totals = report?.totals;
  const stillOpen = report?.tills.filter((till) => till.inProgress) || [];
  return (
    <main className="mgrPage">
      <header className="mgrHeader">
        <h1>Daily report</h1>
        <nav aria-label="Report period">
          {(["day", "week", "month"] as const).map((option) => <button type="button" key={option} className={view === option ? "active" : ""} aria-pressed={view === option} onClick={() => setView(option)}>{option[0].toUpperCase() + option.slice(1)}</button>)}
        </nav>
      </header>
      <div className="mgrDate">
        <button type="button" aria-label="Previous" disabled={!shown} onClick={() => setDate(move(view, shown, -1))}>‹</button>
        <label><strong>{title || "Loading…"}</strong><input type="date" aria-label="Choose a date" value={shown} max={today} onChange={(event) => event.target.value && setDate(event.target.value)} /></label>
        <button type="button" aria-label="Next" disabled={!report || report.end >= today} onClick={() => setDate(move(view, shown, 1) > today ? today : move(view, shown, 1))}>›</button>
        <button type="button" disabled={!report || (report.start <= today && report.end >= today)} onClick={() => setDate(today)}>Today</button>
      </div>
      {error && <p className="mgrError" role="alert">{error}</p>}
      {report && totals && <>
        <section className="mgrTiles" aria-label="Summary">
          <article><span>Sales</span><strong>{money(totals.salesCents)}</strong><small>{totals.orders} orders</small></article>
          <article><span>Cash</span><strong>{money(totals.cashCents)}</strong><small>Card {money(totals.cardCents)}</small></article>
          <article className={totals.overShortCents ? "warn" : ""}><span>Tills over / short</span><strong>{signed(totals.overShortCents)}</strong><small>{totals.tillsMissing ? `${totals.tillsMissing} not closed out` : stillOpen.length ? `${stillOpen.length} still open` : "All counted"}</small></article>
          <article><span>Credit left</span><strong>{money(totals.creditIssuedCents)}</strong><small>Used {money(totals.creditUsedCents)}</small></article>
          <article><span>Refunded</span><strong>{money(totals.refundedCents)}</strong><small>Cash and card</small></article>
          <article className={totals.voidCount ? "warn" : ""}><span>Voids</span><strong>{totals.voidCount}</strong><small>Orders and items</small></article>
          <article className={report.calls.notCalledBack ? "warn" : ""}><span>Missed calls</span><strong>{report.calls.hasData ? report.calls.missed : "—"}</strong><small>{report.calls.hasData ? `${report.calls.notCalledBack} not called back` : "No call records"}</small></article>
          <article><span>Tips</span><strong>{money(totals.tipsCents)}</strong><small>Delivery fees {money(totals.deliveryFeesCents)}</small></article>
        </section>

        {report.stillOwed.length > 0 && <Section title="Still owed to customers" count={report.stillOwed.length}>
          {report.stillOwed.map((order) => <Row key={order.orderId} title={`#${order.displayNumber} · ${order.customerName}`} detail="Refund it or leave credit from the Order Center" amount={money(order.owedCents)} tone="bad" />)}
        </Section>}

        {view !== "day" && <Section title="Day by day">
          <div className="mgrDays">
            {[...report.byDay].reverse().map((day) => <button type="button" key={day.businessDate} onClick={() => openDay(day.businessDate)}>
              <strong>{dayLabel(day.businessDate, { weekday: "short", month: "short", day: "numeric" })}</strong>
              <span>{money(day.salesCents)} · {day.orders} orders</span>
              <small>Tills {signed(day.overShortCents)}{day.tillsMissing ? ` · ${day.tillsMissing} not closed` : ""} · Voids {day.voidCount} · Credit {money(day.creditIssuedCents)}{report.calls.hasData ? ` · Missed ${day.missedCalls}` : ""}</small>
            </button>)}
          </div>
        </Section>}

        <Section title="Tills" count={report.tills.length}>
          {report.tills.length === 0 && <p className="mgrEmpty">No tills for this period.</p>}
          {report.tills.map((till) => <Row key={`${till.businessDate}-${till.name}`}
            title={`${till.name}${view === "day" ? "" : ` · ${dayLabel(till.businessDate, { month: "short", day: "numeric" })}`}`}
            detail={till.closedAt ? `Closed by ${till.closedBy || "unknown"} · counted ${money(till.countedCents || 0)} of ${money(till.expectedCents || 0)}` : till.inProgress ? "Open now" : "Not closed out"}
            amount={till.closedAt ? signed(till.overShortCents || 0) : undefined} tone={till.overShortCents ? "bad" : undefined} />)}
        </Section>

        <Section title="Credits" count={report.credits.length}>
          {report.credits.length === 0 && <p className="mgrEmpty">No credit left or used.</p>}
          {report.credits.map((row) => <Row key={row.id} title={`${row.customer}${row.number ? ` · #${row.number}` : ""}`} detail={`${creditKinds[row.kind] || row.kind} · ${when(row.at)} · ${row.by}${row.reason ? ` · ${row.reason}` : ""}`} amount={signed(row.amountCents)} />)}
        </Section>

        <Section title="Refunds" count={report.refunds.length}>
          {report.refunds.length === 0 && <p className="mgrEmpty">No refunds.</p>}
          {report.refunds.map((row) => <Row key={row.id} title={`#${row.number} · ${row.tender.replaceAll("_", " ")} ${row.kind}`} detail={`${when(row.at)} · ${row.by}${row.reason ? ` · ${row.reason}` : ""}`} amount={money(row.amountCents)} />)}
        </Section>

        <Section title="Voids" count={report.voidedOrders.length + report.voidedItems.length}>
          {report.voidedOrders.length + report.voidedItems.length === 0 && <p className="mgrEmpty">No voids.</p>}
          {report.voidedOrders.map((row) => <Row key={row.id} title={`#${row.number} · whole order`} detail={`${when(row.at)} · ${row.by}${row.reason ? ` · ${row.reason}` : ""}`} amount={money(row.amountCents)} />)}
          {report.voidedItems.map((row) => <Row key={row.id} title={`#${row.number} · ${row.item}`} detail={`${when(row.at)} · ${row.by}${row.reason ? ` · ${row.reason}` : ""}`} amount={money(row.amountCents)} />)}
        </Section>

        <Section title="Missed calls" count={report.calls.missed}>
          {report.calls.list.length === 0 && <p className="mgrEmpty">{report.calls.hasData ? `All ${report.calls.total} calls answered.` : "No call records for this period."}</p>}
          {report.calls.list.map((call) => <Row key={call.id} title={`${when(call.at)}${call.callerLast4 ? ` · ending ${call.callerLast4}` : ""}`} detail={`Rang ${call.ringSeconds}s · on the clock: ${call.onClock.map((person) => person.name).join(", ") || "nobody"}`} amount={call.calledBackAt ? "Called back" : "Not called back"} tone={call.calledBackAt ? "good" : "bad"} />)}
        </Section>
        {stillOpen.length > 0 && <p className="mgrEmpty">Today isn&apos;t finished, so these numbers will still change.</p>}
      </>}
    </main>
  );
}
