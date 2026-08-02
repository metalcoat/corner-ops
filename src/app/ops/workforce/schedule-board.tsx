"use client";

import { DragEvent, FormEvent, useMemo, useState } from "react";
import type { Business } from "@/lib/types";
import "./schedule-board.css";

export type ScheduleEmployee = {
  id: string;
  name: string;
  position: string;
  active: boolean;
};

export type ScheduleShift = {
  id: string;
  employeeId: string | null;
  employeeName: string;
  position: string;
  startsAt: string;
  endsAt: string;
  status: string;
  notes: string;
};

type Props = {
  business: Business;
  employees: ScheduleEmployee[];
  shifts: ScheduleShift[];
  busy: boolean;
  runAction: (body: Record<string, unknown>, success: string) => Promise<void>;
};

type EditorState = {
  shift: ScheduleShift | null;
  employeeId: string | null;
  date: string;
  startTime: string;
  endTime: string;
  position: string;
  status: "Draft" | "Published" | "Open";
  notes: string;
};

const DAY_MS = 86_400_000;

function startOfMonday(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function inputTime(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dateFromParts(day: string, time: string): Date {
  const result = new Date(`${day}T${time}:00`);
  if (Number.isNaN(result.getTime())) throw new Error("Shift date or time is invalid.");
  return result;
}

function shiftHours(shift: ScheduleShift): number {
  return Math.max(0, (new Date(shift.endsAt).getTime() - new Date(shift.startsAt).getTime()) / 3_600_000);
}

function defaultEditor(employeeId: string | null, day: Date, employee?: ScheduleEmployee): EditorState {
  return {
    shift: null,
    employeeId,
    date: dateKey(day),
    startTime: "16:00",
    endTime: "22:00",
    position: employee?.position || "",
    status: employeeId ? "Published" : "Open",
    notes: "",
  };
}

export default function ScheduleBoard({ business, employees, shifts, busy, runAction }: Props) {
  const [weekStart, setWeekStart] = useState(() => startOfMonday(new Date()));
  const [copiedShift, setCopiedShift] = useState<ScheduleShift | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const weekEnd = addDays(weekStart, 7);
  const activeEmployees = employees.filter((employee) => employee.active);
  const weekShifts = useMemo(() => shifts.filter((shift) => {
    const start = new Date(shift.startsAt);
    return start >= weekStart && start < weekEnd && shift.status !== "Cancelled";
  }), [shifts, weekStart, weekEnd]);

  const shiftsByCell = useMemo(() => {
    const map = new Map<string, ScheduleShift[]>();
    for (const shift of weekShifts) {
      const key = `${shift.employeeId || "open"}:${dateKey(new Date(shift.startsAt))}`;
      const list = map.get(key) || [];
      list.push(shift);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    return map;
  }, [weekShifts]);

  function openExisting(shift: ScheduleShift) {
    setEditor({
      shift,
      employeeId: shift.employeeId,
      date: dateKey(new Date(shift.startsAt)),
      startTime: inputTime(shift.startsAt),
      endTime: inputTime(shift.endsAt),
      position: shift.position,
      status: shift.employeeId ? (shift.status === "Draft" ? "Draft" : "Published") : "Open",
      notes: shift.notes,
    });
  }

  async function saveShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const start = dateFromParts(editor.date, editor.startTime);
    let end = dateFromParts(editor.date, editor.endTime);
    if (end <= start) end = new Date(end.getTime() + DAY_MS);
    const employeeId = editor.status === "Open" ? null : editor.employeeId;
    const action = editor.shift ? "shift-update" : "shift-create";
    await runAction({
      action,
      id: editor.shift?.id,
      employeeId,
      position: editor.position,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      status: employeeId ? editor.status : "Open",
      notes: editor.notes,
    }, editor.shift ? "Shift updated." : "Shift added.");
    setEditor(null);
  }

  async function moveShift(shift: ScheduleShift, employeeId: string | null, targetDay: Date) {
    const originalStart = new Date(shift.startsAt);
    const originalEnd = new Date(shift.endsAt);
    const duration = originalEnd.getTime() - originalStart.getTime();
    const start = new Date(targetDay);
    start.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);
    const end = new Date(start.getTime() + duration);
    await runAction({
      action: "shift-update",
      id: shift.id,
      employeeId,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      status: employeeId ? (shift.status === "Draft" ? "Draft" : "Published") : "Open",
    }, `Shift moved to ${employeeId ? activeEmployees.find((employee) => employee.id === employeeId)?.name || "employee" : "Open shifts"}.`);
  }

  async function pasteShift(employeeId: string | null, targetDay: Date) {
    if (!copiedShift) return;
    const sourceStart = new Date(copiedShift.startsAt);
    const sourceEnd = new Date(copiedShift.endsAt);
    const start = new Date(targetDay);
    start.setHours(sourceStart.getHours(), sourceStart.getMinutes(), 0, 0);
    const end = new Date(start.getTime() + (sourceEnd.getTime() - sourceStart.getTime()));
    await runAction({
      action: "shift-create",
      employeeId,
      position: copiedShift.position,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      status: employeeId ? (copiedShift.status === "Draft" ? "Draft" : "Published") : "Open",
      notes: copiedShift.notes,
    }, "Copied shift pasted.");
  }

  function onDragStart(event: DragEvent<HTMLDivElement>, shift: ScheduleShift) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", shift.id);
    setDraggingId(shift.id);
  }

  async function onDrop(event: DragEvent<HTMLDivElement>, employeeId: string | null, day: Date) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain");
    const shift = shifts.find((candidate) => candidate.id === id);
    setDraggingId(null);
    if (shift) await moveShift(shift, employeeId, day);
  }

  const rows: Array<{ id: string; name: string; position: string; employeeId: string | null }> = [
    ...activeEmployees.map((employee) => ({ id: employee.id, name: employee.name, position: employee.position, employeeId: employee.id })),
    { id: "open", name: "Open shifts", position: "Unassigned", employeeId: null },
  ];

  return <section className="scheduleBoardPanel">
    <header className="scheduleToolbar">
      <div>
        <p className="wfEyebrow">Monday through Sunday</p>
        <h2>{weekStart.toLocaleDateString([], { month: "long", day: "numeric" })} – {addDays(weekStart, 6).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</h2>
      </div>
      <div className="scheduleToolbarActions">
        {copiedShift && <span className="scheduleClipboard">Copied: {localTime(copiedShift.startsAt)} {copiedShift.position}<button type="button" onClick={() => setCopiedShift(null)}>Clear</button></span>}
        <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))}>← Previous</button>
        <button type="button" onClick={() => setWeekStart(startOfMonday(new Date()))}>Today</button>
        <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next →</button>
        <button type="button" className="schedulePrimary" onClick={() => setEditor(defaultEditor(activeEmployees[0]?.id || null, weekStart, activeEmployees[0]))}>+ Add shift</button>
      </div>
    </header>

    <div className="scheduleScroll">
      <div className="scheduleGrid" style={{ gridTemplateColumns: "190px repeat(7, minmax(155px, 1fr))" }}>
        <div className="scheduleCorner">{business}<small>Drag shifts between employees and days</small></div>
        {days.map((day) => <div className={`scheduleDayHeader ${dateKey(day) === dateKey(new Date()) ? "today" : ""}`} key={day.toISOString()}><strong>{day.toLocaleDateString([], { weekday: "short" })}</strong><span>{day.toLocaleDateString([], { month: "short", day: "numeric" })}</span></div>)}

        {rows.map((row) => <div className="scheduleRowContents" key={row.id}>
          <div className="scheduleEmployee"><strong>{row.name}</strong><span>{row.position}</span>{row.employeeId && <small>{weekShifts.filter((shift) => shift.employeeId === row.employeeId).reduce((total, shift) => total + shiftHours(shift), 0).toFixed(1)} hrs</small>}</div>
          {days.map((day) => {
            const key = `${row.employeeId || "open"}:${dateKey(day)}`;
            const cellShifts = shiftsByCell.get(key) || [];
            return <div
              className={`scheduleCell ${draggingId ? "dragReady" : ""}`}
              key={key}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
              onDrop={(event) => void onDrop(event, row.employeeId, day)}
            >
              <div className="scheduleCellActions">
                <button type="button" title="Add shift" onClick={() => setEditor(defaultEditor(row.employeeId, day, activeEmployees.find((employee) => employee.id === row.employeeId)))}>+</button>
                {copiedShift && <button type="button" className="pasteButton" onClick={() => void pasteShift(row.employeeId, day)}>Paste</button>}
              </div>
              {cellShifts.map((shift) => <div
                className={`scheduleShiftCard ${shift.status.toLowerCase()} ${draggingId === shift.id ? "dragging" : ""}`}
                key={shift.id}
                draggable
                onDragStart={(event) => onDragStart(event, shift)}
                onDragEnd={() => setDraggingId(null)}
                onDoubleClick={() => openExisting(shift)}
              >
                <button type="button" className="shiftMain" onClick={() => openExisting(shift)}>
                  <strong>{localTime(shift.startsAt)} – {localTime(shift.endsAt)}</strong>
                  <span>{shift.position || "Shift"}</span>
                  {shift.notes && <small>📝 {shift.notes}</small>}
                </button>
                <div className="shiftQuickActions"><button type="button" onClick={() => setCopiedShift(shift)}>Copy</button><span>{shift.status}</span></div>
              </div>)}
            </div>;
          })}
        </div>)}
      </div>
    </div>

    {editor && <div className="scheduleModalBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }}>
      <section className="scheduleModal" role="dialog" aria-modal="true" aria-labelledby="shift-editor-heading">
        <header><div><p className="wfEyebrow">{editor.shift ? "Edit shift" : "New shift"}</p><h2 id="shift-editor-heading">Shift details</h2></div><button type="button" aria-label="Close" onClick={() => setEditor(null)}>×</button></header>
        <form onSubmit={saveShift} className="scheduleEditForm">
          <label>Employee<select value={editor.employeeId || ""} onChange={(event) => setEditor((current) => current ? { ...current, employeeId: event.target.value || null, status: event.target.value ? (current.status === "Open" ? "Published" : current.status) : "Open" } : current)}><option value="">Open shift</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
          <label>Date<input type="date" value={editor.date} onChange={(event) => setEditor((current) => current ? { ...current, date: event.target.value } : current)} required /></label>
          <label>Start<input type="time" value={editor.startTime} onChange={(event) => setEditor((current) => current ? { ...current, startTime: event.target.value } : current)} required /></label>
          <label>End<input type="time" value={editor.endTime} onChange={(event) => setEditor((current) => current ? { ...current, endTime: event.target.value } : current)} required /></label>
          <label>Position<input value={editor.position} onChange={(event) => setEditor((current) => current ? { ...current, position: event.target.value } : current)} required /></label>
          <label>Status<select value={editor.status} onChange={(event) => setEditor((current) => current ? { ...current, status: event.target.value as EditorState["status"], employeeId: event.target.value === "Open" ? null : current.employeeId } : current)}><option>Draft</option><option>Published</option><option>Open</option></select></label>
          <label className="scheduleNotes">Shift instructions shown to the employee<textarea rows={5} value={editor.notes} onChange={(event) => setEditor((current) => current ? { ...current, notes: event.target.value } : current)} placeholder="Example: Restock the outside cooler before opening. Private party arrives at 6:30." /></label>
          <div className="scheduleModalActions">
            {editor.shift && <><button type="button" onClick={() => setCopiedShift(editor.shift)}>Copy shift</button><button type="button" className="danger" disabled={busy} onClick={() => void runAction({ action: "shift-update", id: editor.shift?.id, status: "Cancelled" }, "Shift cancelled.").then(() => setEditor(null))}>Cancel shift</button></>}
            <button type="button" onClick={() => setEditor(null)}>Close</button>
            <button type="submit" className="schedulePrimary" disabled={busy}>Save shift</button>
          </div>
        </form>
      </section>
    </div>}
  </section>;
}
