"use client";

import { FormEvent, useMemo, useState } from "react";
import type { Business } from "@/lib/types";
import type { ScheduleShift } from "./schedule-board";
import "./week-copy-panel.css";

type Props = {
  business: Business;
  shifts: ScheduleShift[];
  busy: boolean;
  runAction: (body: Record<string, unknown>, success: string) => Promise<void>;
};

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

function mondayKey(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return dateKey(date);
}

function weekLabel(value: string): string {
  const monday = mondayKey(value);
  if (!monday) return "Choose a date";
  const start = new Date(`${monday}T12:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const formatter = new Intl.DateTimeFormat([], { month: "short", day: "numeric", year: "numeric" });
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

export default function WeekCopyPanel({ business, shifts, busy, runAction }: Props) {
  const today = useMemo(() => dateKey(new Date()), []);
  const [sourceDate, setSourceDate] = useState(() => addDays(today, -7));
  const [targetDate, setTargetDate] = useState(today);

  async function copyWeek(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sourceWeekStart = mondayKey(sourceDate);
    const targetWeekStart = mondayKey(targetDate);
    if (!sourceWeekStart || !targetWeekStart) {
      window.alert("Choose both a source week and a target week.");
      return;
    }
    if (sourceWeekStart === targetWeekStart) {
      window.alert("Choose a different target week.");
      return;
    }

    const targetStart = new Date(`${targetWeekStart}T00:00:00`);
    const targetEnd = new Date(targetStart);
    targetEnd.setDate(targetEnd.getDate() + 7);
    const targetShiftCount = shifts.filter((shift) => {
      if (shift.status === "Cancelled") return false;
      const start = new Date(shift.startsAt);
      return start >= targetStart && start < targetEnd;
    }).length;

    if (targetShiftCount > 0 && !window.confirm(
      `${business} already has ${targetShiftCount} shift${targetShiftCount === 1 ? "" : "s"} in the target week. Exact duplicates will be skipped, but other copied shifts will be added as drafts. Continue?`,
    )) return;

    await runAction({
      action: "week-copy",
      sourceWeekStart,
      targetWeekStart,
    }, `Copied ${weekLabel(sourceWeekStart)} into ${weekLabel(targetWeekStart)} as drafts. Shifts belonging to inactive employees were left unassigned.`).catch(() => undefined);
  }

  return <section className="weekCopyPanel">
    <div className="weekCopyIntro">
      <p className="wfEyebrow">Reuse any schedule</p>
      <h2>Copy a past week</h2>
      <p>Pick any date inside the source and target weeks. Corner Ops finds the Monday automatically, copies every non-cancelled shift as a draft, skips exact duplicates, and leaves former employees unassigned.</p>
    </div>
    <form className="weekCopyForm" onSubmit={copyWeek}>
      <label>
        Any date in source week
        <input type="date" value={sourceDate} onChange={(event) => setSourceDate(event.target.value)} required />
        <small>{weekLabel(sourceDate)}</small>
      </label>
      <span className="weekCopyArrow" aria-hidden="true">→</span>
      <label>
        Any date in target week
        <input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} required />
        <small>{weekLabel(targetDate)}</small>
      </label>
      <button className="wfPrimary" disabled={busy}>Copy week as drafts</button>
    </form>
  </section>;
}
