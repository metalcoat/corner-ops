"use client";
// Checklists and the deli salad log, for an owner or manager reading remotely: who did each job and when,
// what was missed, un-checks with the reason, and every salad batch by person.
import { useEffect, useMemo, useState } from "react";
import type { ManagerReportView } from "@/lib/ordering-manager-report";
import StoreChecklistSetup from "@/components/store-checklist-setup";

type Check = { employeeName: string; checkedAt: string; bulk: boolean; undoneAt: string | null; undoneByName: string | null; undoReason: string | null };
type ListDay = { checklistId: string; name: string; done: number; total: number; missed: string[]; items: Array<{ itemId: string; label: string; check: Check | null; undone: Check[] }> };
type Batch = { id: number; businessDate: string; saladName: string; employeeName: string; madeAt: string; batchSize: string; notes: string; voidedAt: string | null; voidedByName: string | null; voidReason: string | null };
type Day = { businessDate: string; finished: boolean; lists: ListDay[]; batches: Batch[] };
type History = { today: string; days: Day[]; people: Array<{ name: string; checks: number; undone: number; batches: number }> };

const time = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
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

    {!history.days.length && <p className="mgrEmpty">Nothing for this period yet.</p>}

    {single && single.lists.map((list) => <Section key={list.checklistId} title={list.name} count={list.done}>
      {list.items.length === 0 && <p className="mgrEmpty">No jobs on this list.</p>}
      {list.items.map((item) => <div key={item.itemId} className={!item.check && single.finished ? "mgrRow flag" : "mgrRow"}>
        <div>
          <strong>{item.check ? "✓" : "✗"} {item.label}</strong>
          {item.check && <small>{item.check.employeeName} · {time(item.check.checkedAt)}{item.check.bulk ? " · marked with the rest" : ""}</small>}
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
