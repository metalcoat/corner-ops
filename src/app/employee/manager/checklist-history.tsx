"use client";
// Checklists and the deli salad log, for an owner or manager reading remotely: who did each job and when,
// what was missed, un-checks with the reason, and every salad batch by person.
import { useEffect, useMemo, useState } from "react";
import type { ManagerReportView } from "@/lib/ordering-manager-report";
import StoreChecklistSetup from "@/components/store-checklist-setup";
import { agoLabel, whenLabel } from "@/lib/store-checklist-rules";

type Check = { employeeName: string; checkedAt: string; bulk: boolean; counts?: Record<string, number> | null; undoneAt: string | null; undoneByName: string | null; undoReason: string | null };
type ListDay = { checklistId: string; name: string; done: number; total: number; missed: string[]; items: Array<{ itemId: string; label: string; check: Check | null; undone: Check[] }> };
type Batch = { id: number; businessDate: string; saladName: string; employeeName: string; madeAt: string; batchSize: string; notes: string; voidedAt: string | null; voidedByName: string | null; voidReason: string | null };
type CountRow = { key: string; label: string; cells: Array<{ list: string; onHand: number | null; by: string | null }>; made: number };
type Day = { businessDate: string; finished: boolean; lists: ListDay[]; batches: Batch[]; counts: CountRow[] };
type Last = { name: string; at: string | null; by: string | null };
type OilChange = { id: number; businessDate: string; fryerName: string; employeeName: string; changedAt: string; voidedAt: string | null; voidedByName: string | null; voidReason: string | null };
type History = { today: string; days: Day[]; oilChanges: OilChange[]; lastDone: { salads: Last[]; fryers: Last[] }; people: Array<{ name: string; checks: number; undone: number; batches: number }> };

const time = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const countText = (counts?: Record<string, number> | null) => (counts ? Object.entries(counts).map(([field, value]) => `${field} ${value}`).join(" · ") : "");
const dayLabel = (date: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return <section className="mgrSection"><h2>{title}{count != null && <span>{count}</span>}</h2>{children}</section>;
}

export default function ChecklistHistory({ view, date, onOpenDay }: { view: ManagerReportView; date: string; onOpenDay: (day: string) => void }) {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState("");
  const [salad, setSalad] = useState("");
  const [person, setPerson] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetch(`/api/employee/manager-report/checklists?${new URLSearchParams({ view, ...(date ? { date } : {}) })}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not load the checklists."); setHistory(body); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the checklists."); });
    return () => controller.abort();
  }, [date, view]);

  const batches = useMemo(() => history?.days.flatMap((day) => day.batches) || [], [history]);
  if (error) return <p className="mgrError" role="alert">{error}</p>;
  if (!history) return <p className="mgrEmpty">Loading checklists…</p>;

  const finishedDays = history.days.filter((day) => day.finished);
  const missed = finishedDays.reduce((sum, day) => sum + day.lists.reduce((total, list) => total + list.missed.length, 0), 0);
  const undone = history.days.reduce((sum, day) => sum + day.lists.reduce((total, list) => total + list.items.reduce((count, item) => count + item.undone.length, 0), 0), 0);
  const made = batches.filter((batch) => !batch.voidedAt);
  const saladNames = [...new Set(batches.map((batch) => batch.saladName))].sort();
  const people = [...new Set(batches.map((batch) => batch.employeeName))].sort();
  const shownBatches = batches.filter((batch) => (!salad || batch.saladName === salad) && (!person || batch.employeeName === person));
  const single = view === "day" ? history.days[0] : null;
  // Each counted thing (sub rolls, buns, dough) with the lists it is counted on, in list order.
  const countKeys = [...new Map(history.days.flatMap((day) => day.counts).map((row) => [row.key, row])).values()]
    .map((row) => ({ key: row.key, label: row.label, lists: [...new Set(history.days.flatMap((day) => day.counts.filter((entry) => entry.key === row.key).flatMap((entry) => entry.cells.map((cell) => cell.list))))] }));

  return <div className="ckHistory">
    <section className="mgrTiles" aria-label="Checklist summary">
      {view === "day"
        ? (single?.lists || []).slice(0, 3).map((list) => <article key={list.checklistId} className={single?.finished && list.done < list.total ? "warn" : ""}>
          <span>{list.name}</span><strong>{list.done}/{list.total}</strong><small>{list.done === list.total ? "All done" : single?.finished ? `${list.total - list.done} missed` : `${list.total - list.done} to go`}</small>
        </article>)
        : <article className={missed ? "warn" : ""}><span>Missed jobs</span><strong>{missed}</strong><small>Over {finishedDays.length} finished days</small></article>}
      <article><span>Salad batches</span><strong>{made.length}</strong><small>{[...new Set(made.map((batch) => batch.saladName))].length} kinds</small></article>
      {view !== "day" && <article><span>Jobs checked</span><strong>{history.people.reduce((sum, row) => sum + row.checks, 0)}</strong><small>{history.people.filter((row) => row.checks).length} people</small></article>}
      <article className={undone ? "warn" : ""}><span>Un-checked</span><strong>{undone}</strong><small>With a reason</small></article>
    </section>

    <Section title="Last made / last changed">
      <div className="ckLastGrid">
        {[...history.lastDone.salads.map((row) => ({ ...row, kind: "salad" })), ...history.lastDone.fryers.map((row) => ({ ...row, kind: "fryer" }))].map((row) => (
          <article key={`${row.kind}-${row.name}`} className={row.kind === "fryer" ? "fryer" : ""}>
            <strong>{row.kind === "fryer" ? `${row.name} oil` : row.name}</strong>
            {row.at ? <><span>{whenLabel(row.at)} · <b>{agoLabel(row.at)}</b></span><small>by {row.by}</small></> : <span>Never logged</span>}
          </article>
        ))}
      </div>
    </Section>

    {!history.days.length && <p className="mgrEmpty">Nothing for this period yet.</p>}

    {single && single.lists.map((list) => <Section key={list.checklistId} title={list.name} count={list.done}>
      {list.items.length === 0 && <p className="mgrEmpty">No jobs on this list.</p>}
      {list.items.map((item) => <div key={item.itemId} className={!item.check && single.finished ? "mgrRow flag" : "mgrRow"}>
        <div>
          <strong>{item.check ? "✓" : "✗"} {item.label}</strong>
          {item.check && <small>{item.check.employeeName} · {time(item.check.checkedAt)}{item.check.bulk ? " · marked with the rest" : ""}{item.check.counts ? ` · ${countText(item.check.counts)}` : ""}</small>}
          {item.undone.map((check, index) => <small key={index}>Un-checked by {check.undoneByName} at {time(check.undoneAt!)}: {check.undoReason} (was {check.employeeName} · {time(check.checkedAt)})</small>)}
        </div>
        {!item.check && <b className={single.finished ? "bad" : undefined}>{single.finished ? "Missed" : "Not yet"}</b>}
      </div>)}
    </Section>)}

    {!single && <Section title="Day by day">
      <div className="mgrDays">
        {history.days.map((day) => {
          const dayMissed = day.lists.flatMap((list) => list.missed.map((label) => `${list.name}: ${label}`));
          const batchCount = day.batches.filter((batch) => !batch.voidedAt).length;
          return <button type="button" key={day.businessDate} onClick={() => onOpenDay(day.businessDate)} className={day.finished && dayMissed.length ? "ckDayMissed" : ""}>
            <strong>{dayLabel(day.businessDate)}{!day.finished ? " · today" : ""}</strong>
            <span>{day.lists.map((list) => `${list.name} ${list.done}/${list.total}`).join(" · ") || "No lists"} · {batchCount} salad {batchCount === 1 ? "batch" : "batches"}</span>
            {day.finished && dayMissed.length > 0 && <small>Missed: {dayMissed.join(", ")}</small>}
          </button>;
        })}
      </div>
    </Section>}

    {countKeys.length > 0 && <Section title="Counts: start, shift change, close">
      <p className="mgrEmpty">On hand at each count, and everything entered as made that day.</p>
      {countKeys.map(({ key, label, lists: columns }) => <div key={key} className="ckCountTable">
        <h3>{label}</h3>
        <table>
          <thead><tr><th>Day</th>{columns.map((name) => <th key={name}>{name}</th>)}<th>Made</th></tr></thead>
          <tbody>
            {history.days.filter((day) => day.counts.some((row) => row.key === key)).map((day) => {
              const row = day.counts.find((entry) => entry.key === key)!;
              return <tr key={day.businessDate}>
                <td>{dayLabel(day.businessDate)}</td>
                {columns.map((name) => { const cell = row.cells.find((entry) => entry.list === name); return <td key={name} title={cell?.by ? `Counted by ${cell.by}` : undefined}>{cell?.onHand ?? "—"}</td>; })}
                <td>{row.made}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>)}
    </Section>}

    <Section title="Deli salad batches" count={made.length}>
      {batches.length > 0 && <div className="ckFilters">
        <select aria-label="Salad" value={salad} onChange={(event) => setSalad(event.target.value)}><option value="">All salads</option>{saladNames.map((name) => <option key={name}>{name}</option>)}</select>
        <select aria-label="Made by" value={person} onChange={(event) => setPerson(event.target.value)}><option value="">Everyone</option>{people.map((name) => <option key={name}>{name}</option>)}</select>
      </div>}
      {shownBatches.length === 0 && <p className="mgrEmpty">No salad batches logged.</p>}
      {shownBatches.map((batch) => <div key={batch.id} className="mgrRow">
        <div>
          <strong>{batch.voidedAt ? <s>{batch.saladName}</s> : batch.saladName}</strong>
          <small>{batch.employeeName} · {view === "day" ? "" : `${dayLabel(batch.businessDate)} `}{time(batch.madeAt)}{batch.batchSize ? ` · ${batch.batchSize}` : ""}{batch.notes ? ` · ${batch.notes}` : ""}</small>
          {batch.voidedAt && <small>Removed by {batch.voidedByName}: {batch.voidReason}</small>}
        </div>
      </div>)}
    </Section>

    <Section title="Fryer oil" count={history.oilChanges.filter((row) => !row.voidedAt).length}>
      {history.oilChanges.length === 0 && <p className="mgrEmpty">No oil changes logged.</p>}
      {history.oilChanges.map((row) => <div key={row.id} className="mgrRow">
        <div>
          <strong>{row.voidedAt ? <s>{row.fryerName}</s> : row.fryerName}</strong>
          <small>{row.employeeName} · {view === "day" ? "" : `${dayLabel(row.businessDate)} `}{time(row.changedAt)}</small>
          {row.voidedAt && <small>Removed by {row.voidedByName}: {row.voidReason}</small>}
        </div>
      </div>)}
    </Section>

    {history.people.length > 0 && <Section title="By person" count={history.people.length}>
      {history.people.map((row) => <div key={row.name} className="mgrRow">
        <div><strong>{row.name}</strong><small>{row.checks} {row.checks === 1 ? "job" : "jobs"} checked · {row.batches} salad {row.batches === 1 ? "batch" : "batches"}{row.undone ? ` · ${row.undone} of their checks un-checked` : ""}</small></div>
      </div>)}
    </Section>}

    <details className="ckEdit">
      <summary>Edit lists &amp; salads</summary>
      <StoreChecklistSetup />
    </details>
  </div>;
}
