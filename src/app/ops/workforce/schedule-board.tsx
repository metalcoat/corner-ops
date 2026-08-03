"use client";

import { CSSProperties, DragEvent, FormEvent, useMemo, useState } from "react";
import { positionsForBusiness } from "@/lib/business-positions";
import type { Business } from "@/lib/types";
import "./schedule-board.css";

export type ScheduleEmployee = {
  id: string;
  name: string;
  email: string;
  position: string;
  active: boolean;
  scheduleColor: string;
  avatarSet: boolean;
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
  employeeColor?: string;
  employeeAvatarSet?: boolean;
  publishedAt?: string | null;
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

function dateFromKey(value: string): Date {
  return new Date(`${value}T12:00:00`);
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

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function defaultEditor(employeeId: string | null, day: Date, employee?: ScheduleEmployee): EditorState {
  return {
    shift: null,
    employeeId,
    date: dateKey(day),
    startTime: "16:00",
    endTime: "22:00",
    position: employee?.position || "",
    notes: "",
  };
}

function avatarUrl(business: Business, employeeId: string): string {
  return `/api/employee-directory/avatar?business=${encodeURIComponent(business)}&id=${encodeURIComponent(employeeId)}`;
}

export default function ScheduleBoard({ business, employees, shifts, busy, runAction }: Props) {
  const [weekStart, setWeekStart] = useState(() => startOfMonday(new Date()));
  const [copiedShift, setCopiedShift] = useState<ScheduleShift | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const weekEnd = addDays(weekStart, 7);
  const activeEmployees = employees.filter((employee) => employee.active);
  const employeeById = useMemo(() => new Map(activeEmployees.map((employee) => [employee.id, employee])), [activeEmployees]);
  const weekShifts = useMemo(() => shifts.filter((shift) => {
    const start = new Date(shift.startsAt);
    return start >= weekStart && start < weekEnd && shift.status !== "Cancelled";
  }), [shifts, weekStart, weekEnd]);
  const draftCount = weekShifts.filter((shift) => shift.status === "Draft").length;
  const publishedCount = weekShifts.filter((shift) => shift.status === "Published" || shift.status === "Open").length;
  const missingEmailCount = activeEmployees.filter((employee) => !employee.email.trim()).length;
  const scheduledDayKeys = useMemo(() => [...new Set(weekShifts.map((shift) => dateKey(new Date(shift.startsAt))))].sort(), [weekShifts]);
  const shiftsByDay = useMemo(() => {
    const map = new Map<string, ScheduleShift[]>();
    for (const shift of weekShifts) {
      const key = dateKey(new Date(shift.startsAt));
      const list = map.get(key) || [];
      list.push(shift);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.employeeName.localeCompare(right.employeeName));
    }
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
      notes: shift.notes,
    });
  }

  async function saveShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const start = dateFromParts(editor.date, editor.startTime);
    let end = dateFromParts(editor.date, editor.endTime);
    if (end <= start) end = new Date(end.getTime() + DAY_MS);
    const action = editor.shift ? "shift-update" : "shift-create";
    await runAction({
      action,
      id: editor.shift?.id,
      employeeId: editor.employeeId,
      position: editor.position,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      status: "Draft",
      notes: editor.notes,
    }, editor.shift ? "Shift updated and marked for publishing." : "Draft shift added.");
    setEditor(null);
  }

  async function moveShiftToDay(shift: ScheduleShift, targetDay: Date) {
    const originalStart = new Date(shift.startsAt);
    const originalEnd = new Date(shift.endsAt);
    const duration = originalEnd.getTime() - originalStart.getTime();
    const start = new Date(targetDay);
    start.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);
    const end = new Date(start.getTime() + duration);
    await runAction({
      action: "shift-update",
      id: shift.id,
      employeeId: shift.employeeId,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      status: "Draft",
    }, `Shift moved to ${targetDay.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })} and marked for publishing.`);
  }

  async function pasteShift(targetDay: Date) {
    if (!copiedShift) return;
    const sourceStart = new Date(copiedShift.startsAt);
    const sourceEnd = new Date(copiedShift.endsAt);
    const start = new Date(targetDay);
    start.setHours(sourceStart.getHours(), sourceStart.getMinutes(), 0, 0);
    const end = new Date(start.getTime() + (sourceEnd.getTime() - sourceStart.getTime()));
    await runAction({
      action: "shift-create",
      employeeId: copiedShift.employeeId,
      position: copiedShift.position,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      status: "Draft",
      notes: copiedShift.notes,
    }, "Copied shift pasted as a draft.");
  }

  async function publishWeek() {
    const actionLabel = draftCount > 0 ? "Publish week" : "Resend schedule";
    if (!window.confirm(`${actionLabel} for ${business}? This will notify all active employees.`)) return;
    await runAction({
      action: "week-publish",
      weekStart: dateKey(weekStart),
    }, "Schedule published for everyone. Employee Hub was updated and email was sent wherever an address is configured.");
  }

  function onDragStart(event: DragEvent<HTMLDivElement>, shift: ScheduleShift) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", shift.id);
    setDraggingId(shift.id);
  }

  async function onDrop(event: DragEvent<HTMLElement>, day: Date) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain");
    const shift = shifts.find((candidate) => candidate.id === id);
    setDraggingId(null);
    if (shift) await moveShiftToDay(shift, day);
  }

  const firstScheduledDate = scheduledDayKeys[0] ? dateFromKey(scheduledDayKeys[0]) : weekStart;
  const positionOptions = positionsForBusiness(business);

  return <section className="scheduleBoardPanel">
    <header className="scheduleToolbar">
      <div>
        <p className="wfEyebrow">Scheduled-day planning board</p>
        <h2>{weekStart.toLocaleDateString([], { month: "long", day: "numeric" })} – {addDays(weekStart, 6).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</h2>
        <span className="scheduleSubline">Only days containing shifts are shown. Shifts are sorted by start time.</span>
      </div>
      <div className="scheduleToolbarActions">
        <span className="scheduleClipboard">
          {draftCount > 0 ? `${draftCount} unpublished change${draftCount === 1 ? "" : "s"}` : publishedCount > 0 ? "Week published" : "No shifts yet"}
          {missingEmailCount > 0 ? ` · ${missingEmailCount} employee${missingEmailCount === 1 ? "" : "s"} missing email` : ""}
        </span>
        {copiedShift && <span className="scheduleClipboard">Copied: {localTime(copiedShift.startsAt)} {copiedShift.position}<button type="button" onClick={() => setCopiedShift(null)}>Clear</button></span>}
        <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))}>← Previous</button>
        <button type="button" onClick={() => setWeekStart(startOfMonday(new Date()))}>Today</button>
        <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next →</button>
        <button type="button" className="schedulePrimary" disabled={busy || weekShifts.length === 0} onClick={() => void publishWeek()}>{draftCount > 0 ? `Publish week (${draftCount})` : "Resend schedule"}</button>
        <button type="button" className="schedulePrimary" onClick={() => setEditor(defaultEditor(activeEmployees[0]?.id || null, firstScheduledDate, activeEmployees[0]))}>+ Add shift</button>
      </div>
    </header>

    <div className="scheduleLegend" aria-label="Employee schedule colors">
      {activeEmployees.map((employee) => {
        const hours = weekShifts.filter((shift) => shift.employeeId === employee.id).reduce((total, shift) => total + shiftHours(shift), 0);
        return <div className="scheduleLegendPerson" key={employee.id} style={{ "--employee-color": employee.scheduleColor } as CSSProperties}>
          <span className="scheduleAvatar small">
            {employee.avatarSet ? <img src={avatarUrl(business, employee.id)} alt="" loading="lazy" /> : initials(employee.name)}
          </span>
          <div><strong>{employee.name}</strong><small>{employee.position} · {hours.toFixed(1)} hrs</small></div>
        </div>;
      })}
    </div>

    {scheduledDayKeys.length === 0 ? <div className="scheduleEmpty">
      <h3>No shifts scheduled this week</h3>
      <p>Blank days stay hidden. Add the first shift and its day will appear as a planning stage.</p>
      <button type="button" className="schedulePrimary" onClick={() => setEditor(defaultEditor(activeEmployees[0]?.id || null, weekStart, activeEmployees[0]))}>Add first shift</button>
    </div> : <div className="scheduleScroll">
      <div className="scheduleStageGrid" style={{ gridTemplateColumns: `repeat(${scheduledDayKeys.length}, minmax(285px, 1fr))` }}>
        {scheduledDayKeys.map((key) => {
          const day = dateFromKey(key);
          const dayShifts = shiftsByDay.get(key) || [];
          const totalHours = dayShifts.reduce((total, shift) => total + shiftHours(shift), 0);
          return <section
            className={`scheduleDayStage ${dateKey(new Date()) === key ? "today" : ""} ${draggingId ? "dragReady" : ""}`}
            key={key}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
            onDrop={(event) => void onDrop(event, day)}
          >
            <header className="scheduleDayStageHeader">
              <div><strong>{day.toLocaleDateString([], { weekday: "long" })}</strong><span>{day.toLocaleDateString([], { month: "long", day: "numeric" })}</span><small>{dayShifts.length} shift{dayShifts.length === 1 ? "" : "s"} · {totalHours.toFixed(1)} hrs</small></div>
              <div><button type="button" title="Add shift" onClick={() => setEditor(defaultEditor(activeEmployees[0]?.id || null, day, activeEmployees[0]))}>+</button>{copiedShift && <button type="button" onClick={() => void pasteShift(day)}>Paste</button>}</div>
            </header>
            <div className="scheduleDayCards">
              {dayShifts.map((shift) => {
                const employee = shift.employeeId ? employeeById.get(shift.employeeId) : undefined;
                const color = employee?.scheduleColor || shift.employeeColor || "#64748B";
                const avatarSet = employee?.avatarSet || shift.employeeAvatarSet || false;
                const name = employee?.name || shift.employeeName || "Unassigned";
                return <div
                  className={`scheduleShiftCard ${shift.status.toLowerCase()} ${draggingId === shift.id ? "dragging" : ""}`}
                  style={{ "--employee-color": color } as CSSProperties}
                  key={shift.id}
                  draggable
                  onDragStart={(event) => onDragStart(event, shift)}
                  onDragEnd={() => setDraggingId(null)}
                  onDoubleClick={() => openExisting(shift)}
                >
                  <button type="button" className="shiftMain" onClick={() => openExisting(shift)}>
                    <span className="scheduleAvatar">
                      {shift.employeeId && avatarSet ? <img src={avatarUrl(business, shift.employeeId)} alt="" loading="lazy" /> : initials(name)}
                    </span>
                    <span className="shiftDetails">
                      <strong>{name}</strong>
                      <b>{localTime(shift.startsAt)} – {localTime(shift.endsAt)}</b>
                      <em>{shift.position || "Shift"}</em>
                      {shift.notes && <small>📝 {shift.notes}</small>}
                    </span>
                  </button>
                  <div className="shiftQuickActions"><button type="button" onClick={() => setCopiedShift(shift)}>Copy</button><span>{shift.status}</span></div>
                </div>;
              })}
            </div>
          </section>;
        })}
      </div>
    </div>}

    {editor && <div className="scheduleModalBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }}>
      <section className="scheduleModal" role="dialog" aria-modal="true" aria-labelledby="shift-editor-heading">
        <header><div><p className="wfEyebrow">{editor.shift ? "Edit shift" : "New shift"}</p><h2 id="shift-editor-heading">Shift details</h2></div><button type="button" aria-label="Close" onClick={() => setEditor(null)}>×</button></header>
        <form onSubmit={saveShift} className="scheduleEditForm">
          <label>Employee<select value={editor.employeeId || ""} onChange={(event) => {
            const employeeId = event.target.value || null;
            const employee = employeeId ? employeeById.get(employeeId) : undefined;
            setEditor((current) => current ? { ...current, employeeId, position: current.shift ? current.position : employee?.position || current.position } : current);
          }}><option value="">Unassigned / open when published</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
          <label>Date<input type="date" value={editor.date} onChange={(event) => setEditor((current) => current ? { ...current, date: event.target.value } : current)} required /></label>
          <label>Start<input type="time" value={editor.startTime} onChange={(event) => setEditor((current) => current ? { ...current, startTime: event.target.value } : current)} required /></label>
          <label>End<input type="time" value={editor.endTime} onChange={(event) => setEditor((current) => current ? { ...current, endTime: event.target.value } : current)} required /></label>
          <label>Position{business === "Corner Deli"
            ? <select value={editor.position} onChange={(event) => setEditor((current) => current ? { ...current, position: event.target.value } : current)} required><option value="">Choose position</option>{positionOptions.map((position) => <option key={position} value={position}>{position}</option>)}</select>
            : <input value={editor.position} onChange={(event) => setEditor((current) => current ? { ...current, position: event.target.value } : current)} required />}</label>
          <p className="scheduleNotes">Saving creates a draft. Staff do not receive the change until the entire week is published.</p>
          <label className="scheduleNotes">Shift instructions shown to the employee<textarea rows={5} value={editor.notes} onChange={(event) => setEditor((current) => current ? { ...current, notes: event.target.value } : current)} placeholder="Example: Restock the outside cooler before opening. Private party arrives at 6:30." /></label>
          <div className="scheduleModalActions">
            {editor.shift && <><button type="button" onClick={() => setCopiedShift(editor.shift)}>Copy shift</button><button type="button" className="danger" disabled={busy} onClick={() => void runAction({ action: "shift-update", id: editor.shift?.id, status: "Cancelled" }, "Shift cancelled.").then(() => setEditor(null))}>Cancel shift</button></>}
            <button type="button" onClick={() => setEditor(null)}>Close</button>
            <button type="submit" className="schedulePrimary" disabled={busy}>Save draft</button>
          </div>
        </form>
      </section>
    </div>}
  </section>;
}
