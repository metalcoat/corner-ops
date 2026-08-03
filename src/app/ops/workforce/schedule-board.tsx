"use client";

import { CSSProperties, DragEvent, FormEvent, useMemo, useState } from "react";
import { positionsForBusiness } from "@/lib/business-positions";
import {
  analyzeShiftMealCompliance,
  mealRequirements,
  newYorkTimeValue,
  shiftTimeForSelectedDay,
} from "@/lib/schedule-meal-compliance";
import { analyzeSchedule } from "@/lib/schedule-validation";
import type { Business } from "@/lib/types";
import "./schedule-board.css";
import "./schedule-compliance.css";

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
  mealBreakStart?: string | null;
  mealBreakMinutes?: number;
  extraMealBreakStart?: string | null;
  extraMealBreakMinutes?: number;
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
  mealBreakTime: string;
  mealBreakMinutes: number;
  extraMealBreakTime: string;
  extraMealBreakMinutes: number;
  position: string;
  notes: string;
};

type GridRow = {
  key: string;
  employee: ScheduleEmployee | null;
  employeeId: string | null;
  name: string;
  position: string;
  color: string;
};

type DragTarget = {
  dayKey: string;
  employeeId: string | null;
} | null;

const DAY_MS = 86_400_000;
const UNASSIGNED_KEY = "__unassigned__";
const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const hour = Math.floor(index / 4);
  const minute = (index % 4) * 15;
  const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const label = new Date(`2000-01-01T${value}:00`).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return { value, label };
});
const BREAK_DURATION_OPTIONS = [0, 20, 30, 45, 60];

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

function localDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function inputTime(value: string | null | undefined): string {
  if (!value) return "";
  return newYorkTimeValue(value);
}

function nearestQuarter(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const total = Math.round((hour * 60 + minute) / 15) * 15;
  return `${String(Math.floor((total % 1440) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function dateFromParts(day: string, time: string): Date {
  const result = new Date(`${day}T${time}:00`);
  if (Number.isNaN(result.getTime())) throw new Error("Shift date or time is invalid.");
  return result;
}

function editorDates(editor: EditorState) {
  const start = dateFromParts(editor.date, editor.startTime);
  let end = dateFromParts(editor.date, editor.endTime);
  if (end <= start) end = new Date(end.getTime() + DAY_MS);
  const mealBreakStart = editor.mealBreakTime && editor.mealBreakMinutes
    ? shiftTimeForSelectedDay(editor.date, editor.startTime, editor.mealBreakTime)
    : null;
  const extraMealBreakStart = editor.extraMealBreakTime && editor.extraMealBreakMinutes
    ? shiftTimeForSelectedDay(editor.date, editor.startTime, editor.extraMealBreakTime)
    : null;
  return { start, end, mealBreakStart, extraMealBreakStart };
}

function shiftHours(shift: ScheduleShift): number {
  return analyzeShiftMealCompliance(shift).paidHours;
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
    mealBreakTime: "",
    mealBreakMinutes: 0,
    extraMealBreakTime: "",
    extraMealBreakMinutes: 0,
    position: employee?.position || "",
    notes: "",
  };
}

function avatarUrl(business: Business, employeeId: string): string {
  return `/api/employee-directory/avatar?business=${encodeURIComponent(business)}&id=${encodeURIComponent(employeeId)}`;
}

function shiftIso(value: string | null | undefined, differenceMs: number): string | null {
  return value ? new Date(new Date(value).getTime() + differenceMs).toISOString() : null;
}

function moveShiftToCell(
  shift: ScheduleShift,
  targetDay: Date,
  employeeId: string | null,
  employeeName?: string,
): ScheduleShift {
  const originalStart = new Date(shift.startsAt);
  const originalEnd = new Date(shift.endsAt);
  const start = new Date(targetDay);
  start.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);
  const differenceMs = start.getTime() - originalStart.getTime();
  const end = new Date(originalEnd.getTime() + differenceMs);
  return {
    ...shift,
    employeeId,
    employeeName: employeeName ?? shift.employeeName,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    mealBreakStart: shiftIso(shift.mealBreakStart, differenceMs),
    extraMealBreakStart: shiftIso(shift.extraMealBreakStart, differenceMs),
  };
}

function cellKey(employeeId: string | null, dayKeyValue: string): string {
  return `${employeeId || UNASSIGNED_KEY}|${dayKeyValue}`;
}

function TimeSelect({ value, onChange, required = false, allowBlank = false }: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  allowBlank?: boolean;
}) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>
    {allowBlank && <option value="">Not scheduled</option>}
    {TIME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}

export default function ScheduleBoard({ business, employees, shifts, busy, runAction }: Props) {
  const [weekStart, setWeekStart] = useState(() => startOfMonday(new Date()));
  const [copiedShift, setCopiedShift] = useState<ScheduleShift | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart],
  );
  const weekEnd = addDays(weekStart, 7);
  const activeEmployees = employees.filter((employee) => employee.active);
  const employeeById = useMemo(
    () => new Map(activeEmployees.map((employee) => [employee.id, employee])),
    [activeEmployees],
  );
  const weekShifts = useMemo(() => shifts.filter((shift) => {
    const start = new Date(shift.startsAt);
    return start >= weekStart && start < weekEnd && shift.status !== "Cancelled";
  }), [shifts, weekStart, weekEnd]);

  const rows = useMemo<GridRow[]>(() => [
    ...activeEmployees.map((employee) => ({
      key: employee.id,
      employee,
      employeeId: employee.id,
      name: employee.name,
      position: employee.position,
      color: employee.scheduleColor,
    })),
    {
      key: UNASSIGNED_KEY,
      employee: null,
      employeeId: null,
      name: "Open / unassigned",
      position: "Needs assignment",
      color: "#64748B",
    },
  ], [activeEmployees]);

  const previewWeekShifts = useMemo(() => {
    if (!draggingId || !dragTarget) return weekShifts;
    const targetDay = dateFromKey(dragTarget.dayKey);
    return weekShifts.map((shift) => shift.id === draggingId
      ? moveShiftToCell(
          shift,
          targetDay,
          dragTarget.employeeId,
          dragTarget.employeeId ? employeeById.get(dragTarget.employeeId)?.name : "Unassigned",
        )
      : shift);
  }, [dragTarget, draggingId, employeeById, weekShifts]);

  const loneWorkerApplies = business === "Corner Deli";
  const scheduleAnalysis = useMemo(
    () => analyzeSchedule(previewWeekShifts, { enforceLoneWorker: loneWorkerApplies }),
    [loneWorkerApplies, previewWeekShifts],
  );
  const publishAnalysis = useMemo(
    () => analyzeSchedule(weekShifts, { enforceLoneWorker: loneWorkerApplies }),
    [loneWorkerApplies, weekShifts],
  );
  const overlapShiftIds = new Set(
    scheduleAnalysis.overlaps.flatMap((overlap) => [overlap.firstShiftId, overlap.secondShiftId]),
  );
  const loneShiftIds = new Set(
    scheduleAnalysis.loneWorkerViolations.flatMap((violation) => violation.shiftIds),
  );
  const mealViolationShiftIds = new Set(
    scheduleAnalysis.mealPeriodViolations.map((violation) => violation.shiftId),
  );
  const draftCount = weekShifts.filter((shift) => shift.status === "Draft").length;
  const publishedCount = weekShifts.filter(
    (shift) => shift.status === "Published" || shift.status === "Open",
  ).length;
  const missingEmailCount = activeEmployees.filter((employee) => !employee.email.trim()).length;

  const shiftsByCell = useMemo(() => {
    const map = new Map<string, ScheduleShift[]>();
    for (const shift of weekShifts) {
      const key = cellKey(shift.employeeId, dateKey(new Date(shift.startsAt)));
      const list = map.get(key) || [];
      list.push(shift);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    }
    return map;
  }, [weekShifts]);

  const editorPreview = useMemo(() => {
    if (!editor) return null;
    try {
      const { start, end, mealBreakStart, extraMealBreakStart } = editorDates(editor);
      const previewId = editor.shift?.id || "__schedule_editor_preview__";
      const employee = editor.employeeId ? employeeById.get(editor.employeeId) : undefined;
      const previewShift: ScheduleShift = {
        id: previewId,
        employeeId: editor.employeeId,
        employeeName: employee?.name || "Unassigned",
        position: editor.position,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        mealBreakStart: mealBreakStart?.toISOString() || null,
        mealBreakMinutes: editor.mealBreakMinutes,
        extraMealBreakStart: extraMealBreakStart?.toISOString() || null,
        extraMealBreakMinutes: editor.extraMealBreakMinutes,
        status: "Draft",
        notes: editor.notes,
      };
      const candidates = weekShifts.filter((shift) => shift.id !== editor.shift?.id);
      if (start >= weekStart && start < weekEnd) candidates.push(previewShift);
      const analysis = analyzeSchedule(candidates, { enforceLoneWorker: loneWorkerApplies });
      const meals = analyzeShiftMealCompliance(previewShift);
      return {
        hours: editor.employeeId ? analysis.employeeHours[editor.employeeId]?.hours || 0 : 0,
        risk: editor.employeeId ? analysis.employeeHours[editor.employeeId]?.risk || "normal" : "normal",
        overlap: analysis.overlaps.find(
          (item) => item.firstShiftId === previewId || item.secondShiftId === previewId,
        ) || null,
        meals,
      };
    } catch {
      return null;
    }
  }, [editor, employeeById, loneWorkerApplies, weekEnd, weekShifts, weekStart]);

  function openExisting(shift: ScheduleShift) {
    setEditor({
      shift,
      employeeId: shift.employeeId,
      date: dateKey(new Date(shift.startsAt)),
      startTime: nearestQuarter(inputTime(shift.startsAt)),
      endTime: nearestQuarter(inputTime(shift.endsAt)),
      mealBreakTime: nearestQuarter(inputTime(shift.mealBreakStart)),
      mealBreakMinutes: Number(shift.mealBreakMinutes || 0),
      extraMealBreakTime: nearestQuarter(inputTime(shift.extraMealBreakStart)),
      extraMealBreakMinutes: Number(shift.extraMealBreakMinutes || 0),
      position: shift.position,
      notes: shift.notes,
    });
  }

  function applyRequiredMeals() {
    setEditor((current) => {
      if (!current) return current;
      const { start, end } = editorDates(current);
      const requirements = mealRequirements({ startsAt: start.toISOString(), endsAt: end.toISOString() });
      const primary = requirements.find((requirement) => requirement.slot === "primary");
      const extra = requirements.find((requirement) => requirement.slot === "extra");
      return {
        ...current,
        mealBreakTime: primary ? newYorkTimeValue(primary.suggestedStart) : "",
        mealBreakMinutes: primary?.minimumMinutes || 0,
        extraMealBreakTime: extra ? newYorkTimeValue(extra.suggestedStart) : "",
        extraMealBreakMinutes: extra?.minimumMinutes || 0,
      };
    });
  }

  async function saveShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    if (editorPreview?.overlap) {
      window.alert("This employee already has an overlapping shift. Change the employee or the shift time before saving.");
      return;
    }
    const { start, end, mealBreakStart, extraMealBreakStart } = editorDates(editor);
    const action = editor.shift ? "shift-update" : "shift-create";
    await runAction({
      action,
      id: editor.shift?.id,
      employeeId: editor.employeeId,
      position: editor.position,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      mealBreakStart: mealBreakStart?.toISOString() || null,
      mealBreakMinutes: editor.mealBreakMinutes,
      extraMealBreakStart: extraMealBreakStart?.toISOString() || null,
      extraMealBreakMinutes: editor.extraMealBreakMinutes,
      status: "Draft",
      notes: editor.notes,
    }, editor.shift ? "Shift updated and marked for publishing." : "Draft shift added.");
    setEditor(null);
  }

  async function moveShift(shift: ScheduleShift, targetDay: Date, employeeId: string | null) {
    const moved = moveShiftToCell(shift, targetDay, employeeId);
    await runAction({
      action: "shift-update",
      id: shift.id,
      employeeId,
      startsAt: moved.startsAt,
      endsAt: moved.endsAt,
      mealBreakStart: moved.mealBreakStart || null,
      mealBreakMinutes: moved.mealBreakMinutes || 0,
      extraMealBreakStart: moved.extraMealBreakStart || null,
      extraMealBreakMinutes: moved.extraMealBreakMinutes || 0,
      status: "Draft",
    }, `Shift moved to ${targetDay.toLocaleDateString([], {
      weekday: "long",
      month: "short",
      day: "numeric",
    })}${employeeId ? "" : " as unassigned"} and marked for publishing.`);
  }

  async function pasteShift(targetDay: Date, employeeId: string | null) {
    if (!copiedShift) return;
    const copied = moveShiftToCell(copiedShift, targetDay, employeeId);
    await runAction({
      action: "shift-create",
      employeeId,
      position: copied.position,
      startsAt: copied.startsAt,
      endsAt: copied.endsAt,
      mealBreakStart: copied.mealBreakStart || null,
      mealBreakMinutes: copied.mealBreakMinutes || 0,
      extraMealBreakStart: copied.extraMealBreakStart || null,
      extraMealBreakMinutes: copied.extraMealBreakMinutes || 0,
      status: "Draft",
      notes: copied.notes,
    }, "Copied shift pasted as a draft.");
  }

  async function publishWeek() {
    if (!publishAnalysis.canPublish) {
      const details = [
        ...publishAnalysis.overForty.map(
          (employee) => `${employee.employeeName}: ${employee.hours.toFixed(1)} paid hours`,
        ),
        ...publishAnalysis.overlaps.map(
          (overlap) => `${overlap.employeeName}: overlapping shifts at ${localDateTime(overlap.startsAt)}`,
        ),
        ...publishAnalysis.loneWorkerViolations.map(
          (violation) => `${violation.employeeName}: alone ${violation.minutes} minutes starting ${localDateTime(violation.startsAt)}`,
        ),
        ...publishAnalysis.mealPeriodViolations.map(
          (violation) => `${violation.employeeName}: ${violation.message}`,
        ),
      ];
      window.alert(`The schedule cannot be published yet.\n\n${details.slice(0, 12).join("\n")}`);
      return;
    }
    const actionLabel = draftCount > 0 ? "Publish week" : "Resend schedule";
    if (!window.confirm(`${actionLabel} for ${business}? This will notify all active employees.`)) return;
    await runAction(
      { action: "week-publish", weekStart: dateKey(weekStart) },
      "Schedule published for everyone. Employee Hub was updated and email was sent wherever an address is configured.",
    );
  }

  function onDragStart(event: DragEvent<HTMLDivElement>, shift: ScheduleShift) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", shift.id);
    setDraggingId(shift.id);
  }

  async function onDrop(event: DragEvent<HTMLElement>, day: Date, employeeId: string | null) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain");
    const shift = shifts.find((candidate) => candidate.id === id);
    setDraggingId(null);
    setDragTarget(null);
    if (shift) await moveShift(shift, day, employeeId);
  }

  const positionOptions = positionsForBusiness(business);

  return <section className="scheduleBoardPanel">
    <header className="scheduleToolbar">
      <div>
        <p className="wfEyebrow">Weekly employee grid</p>
        <h2>
          {weekStart.toLocaleDateString([], { month: "long", day: "numeric" })} – {addDays(weekStart, 6).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}
        </h2>
        <span className="scheduleSubline">
          Times use 15-minute intervals. Paid totals deduct scheduled off-duty meals. {loneWorkerApplies ? "Corner Deli publication also blocks lone-worker periods over 30 minutes." : "The lone-worker rule is not applied to Tiki."}
        </span>
      </div>
      <div className="scheduleToolbarActions">
        <span className="scheduleClipboard">
          {draftCount > 0
            ? `${draftCount} unpublished change${draftCount === 1 ? "" : "s"}`
            : publishedCount > 0
              ? "Week published"
              : "No shifts yet"}
          {missingEmailCount > 0 ? ` · ${missingEmailCount} missing email` : ""}
        </span>
        {copiedShift && <span className="scheduleClipboard">
          Copied: {localTime(copiedShift.startsAt)} {copiedShift.position}
          <button type="button" onClick={() => setCopiedShift(null)}>Clear</button>
        </span>}
        <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))}>← Previous</button>
        <button type="button" onClick={() => setWeekStart(startOfMonday(new Date()))}>Today</button>
        <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next →</button>
        <button
          type="button"
          className="schedulePrimary"
          disabled={busy || weekShifts.length === 0 || !publishAnalysis.canPublish}
          title={!publishAnalysis.canPublish
            ? `${publishAnalysis.blockingIssueCount} blocking schedule issue${publishAnalysis.blockingIssueCount === 1 ? "" : "s"}`
            : ""}
          onClick={() => void publishWeek()}
        >
          {draftCount > 0 ? `Publish week (${draftCount})` : "Resend schedule"}
        </button>
        <button
          type="button"
          className="schedulePrimary"
          onClick={() => setEditor(defaultEditor(activeEmployees[0]?.id || null, weekStart, activeEmployees[0]))}
        >+ Add shift</button>
      </div>
    </header>

    <section className={`scheduleValidation ${publishAnalysis.canPublish ? "ready" : "blocked"}`}>
      <div className="scheduleValidationHeader">
        <div>
          <strong>{publishAnalysis.canPublish ? "Schedule checks passed" : "Schedule cannot be published yet"}</strong>
          <span>Yellow warns at more than 38 paid hours. Red, overlaps, required meals, and {loneWorkerApplies ? "lone-worker periods" : "other blocking checks"} prevent publication.</span>
        </div>
        <div className="scheduleCheckBadges">
          <span className={publishAnalysis.overThirtyEight.length ? "warning" : "clear"}>{publishAnalysis.overThirtyEight.length} over 38</span>
          <span className={publishAnalysis.overForty.length ? "danger" : "clear"}>{publishAnalysis.overForty.length} over 40</span>
          <span className={publishAnalysis.overlaps.length ? "danger" : "clear"}>{publishAnalysis.overlaps.length} overlap{publishAnalysis.overlaps.length === 1 ? "" : "s"}</span>
          <span className={publishAnalysis.mealPeriodViolations.length ? "warning" : "clear"}>{publishAnalysis.mealPeriodViolations.length} meal issue{publishAnalysis.mealPeriodViolations.length === 1 ? "" : "s"}</span>
          {loneWorkerApplies
            ? <span className={publishAnalysis.loneWorkerViolations.length ? "danger" : "clear"}>{publishAnalysis.loneWorkerViolations.length} alone &gt;30m</span>
            : <span className="clear">Tiki lone check off</span>}
        </div>
      </div>
      {(publishAnalysis.overThirtyEight.length > 0 || !publishAnalysis.canPublish) && <div className="scheduleIssueList">
        {publishAnalysis.overThirtyEight.map((employee) => <div className="scheduleIssue warning" key={`warning-${employee.employeeId}`}>
          <strong>{employee.employeeName}</strong><span>{employee.hours.toFixed(1)} paid hours scheduled.</span>
        </div>)}
        {publishAnalysis.overForty.map((employee) => <div className="scheduleIssue danger" key={`overtime-${employee.employeeId}`}>
          <strong>{employee.employeeName}</strong><span>{employee.hours.toFixed(1)} paid hours. Reduce to 40 or fewer.</span>
        </div>)}
        {publishAnalysis.overlaps.map((overlap) => <div className="scheduleIssue danger" key={`${overlap.firstShiftId}-${overlap.secondShiftId}`}>
          <strong>{overlap.employeeName}</strong><span>Scheduled twice from {localDateTime(overlap.startsAt)} to {localTime(overlap.endsAt)}.</span>
        </div>)}
        {publishAnalysis.mealPeriodViolations.map((violation) => <div className="scheduleIssue warning" key={`${violation.shiftId}-${violation.code}`}>
          <strong>{violation.employeeName} · {localDateTime(violation.startsAt)}</strong><span>{violation.message}</span>
        </div>)}
        {publishAnalysis.loneWorkerViolations.map((violation) => <div className="scheduleIssue danger" key={`${violation.employeeId}-${violation.startsAt}`}>
          <strong>{violation.employeeName}</strong><span>Alone from {localDateTime(violation.startsAt)} to {localTime(violation.endsAt)} ({violation.minutes} minutes), excluding off-duty meal periods.</span>
        </div>)}
      </div>}
    </section>

    <div className="scheduleGridScroll">
      <div className="scheduleWeekGrid" role="grid" aria-label={`${business} weekly schedule`}>
        <div className="scheduleGridCorner" role="columnheader"><strong>Employee</strong><span>Paid weekly total</span></div>
        {weekDays.map((day) => {
          const key = dateKey(day);
          const dayShifts = weekShifts.filter((shift) => dateKey(new Date(shift.startsAt)) === key);
          const dayHours = dayShifts.reduce((total, shift) => total + shiftHours(shift), 0);
          return <div className={`scheduleDayHeader ${dateKey(new Date()) === key ? "today" : ""}`} role="columnheader" key={key}>
            <strong>{day.toLocaleDateString([], { weekday: "short" })}</strong>
            <span>{day.toLocaleDateString([], { month: "short", day: "numeric" })}</span>
            <small>{dayShifts.length} shift{dayShifts.length === 1 ? "" : "s"} · {dayHours.toFixed(1)} paid hrs</small>
          </div>;
        })}

        {rows.map((row) => {
          const totals = row.employeeId ? scheduleAnalysis.employeeHours[row.employeeId] : null;
          const risk = totals?.risk || "normal";
          const totalHours = row.employeeId
            ? totals?.hours || 0
            : weekShifts.filter((shift) => !shift.employeeId).reduce(
                (total, shift) => total + shiftHours(shift),
                0,
              );
          return <div className="scheduleGridRow" role="row" key={row.key}>
            <div
              className={`scheduleEmployeeCell hours-${risk} ${!row.employee ? "unassigned" : ""}`}
              role="rowheader"
              style={{ "--employee-color": row.color } as CSSProperties}
            >
              <span className="scheduleAvatar small">
                {row.employee?.avatarSet
                  ? <img src={avatarUrl(business, row.employee.id)} alt="" loading="lazy" />
                  : initials(row.name)}
              </span>
              <div><strong>{row.name}</strong><span>{row.position}</span><b>{totalHours.toFixed(1)} paid hrs</b></div>
            </div>

            {weekDays.map((day) => {
              const dayKeyValue = dateKey(day);
              const shiftsInCell = shiftsByCell.get(cellKey(row.employeeId, dayKeyValue)) || [];
              const isTarget = dragTarget?.dayKey === dayKeyValue && dragTarget.employeeId === row.employeeId;
              return <div
                className={`scheduleGridCell ${isTarget ? "dragTarget" : ""} ${draggingId ? "dragReady" : ""}`}
                role="gridcell"
                key={`${row.key}-${dayKeyValue}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (!isTarget) setDragTarget({ dayKey: dayKeyValue, employeeId: row.employeeId });
                }}
                onDrop={(event) => void onDrop(event, day, row.employeeId)}
              >
                <div className="scheduleCellActions">
                  <button
                    type="button"
                    title={`Add ${row.name} shift`}
                    onClick={() => setEditor(defaultEditor(row.employeeId, day, row.employee || undefined))}
                  >+</button>
                  {copiedShift && <button type="button" onClick={() => void pasteShift(day, row.employeeId)}>Paste</button>}
                </div>
                <div className="scheduleCellShifts">
                  {shiftsInCell.map((shift) => {
                    const employee = shift.employeeId ? employeeById.get(shift.employeeId) : undefined;
                    const color = employee?.scheduleColor || shift.employeeColor || row.color;
                    const hourStatus = scheduleAnalysis.shiftRisks[shift.id];
                    const hasOverlap = overlapShiftIds.has(shift.id);
                    const hasLoneWorker = loneShiftIds.has(shift.id);
                    const hasMealIssue = mealViolationShiftIds.has(shift.id);
                    const meal = analyzeShiftMealCompliance(shift);
                    return <div
                      className={`scheduleShiftCard compact ${shift.status.toLowerCase()} ${draggingId === shift.id ? "dragging" : ""} hours-${hourStatus?.risk || "normal"} ${hasOverlap ? "hasOverlap" : ""} ${hasLoneWorker ? "hasLoneWorker" : ""} ${hasMealIssue ? "hasMealIssue" : ""}`}
                      style={{ "--employee-color": color } as CSSProperties}
                      key={shift.id}
                      draggable
                      onDragStart={(event) => onDragStart(event, shift)}
                      onDragEnd={() => { setDraggingId(null); setDragTarget(null); }}
                      onDoubleClick={() => openExisting(shift)}
                    >
                      <button type="button" className="shiftMain" onClick={() => openExisting(shift)}>
                        <span className="shiftDetails">
                          <b>{localTime(shift.startsAt)} – {localTime(shift.endsAt)}</b>
                          <em>{shift.position || "Shift"}</em>
                          <small>{meal.paidHours.toFixed(1)} paid hrs{shift.notes ? " · Notes" : ""}</small>
                          {(meal.primaryBreak || meal.extraBreak) && <span className="scheduleMealSummary">
                            {meal.primaryBreak && <b>Meal {localTime(meal.primaryBreak.start.toISOString())} · {meal.primaryBreak.minutes}m</b>}
                            {meal.extraBreak && <b>Extra {localTime(meal.extraBreak.start.toISOString())} · {meal.extraBreak.minutes}m</b>}
                          </span>}
                        </span>
                      </button>
                      <div className="shiftQuickActions">
                        <button type="button" onClick={() => setCopiedShift(shift)}>Copy</button>
                        <span className="shiftStatusLabels">
                          {hourStatus?.risk === "warning" && <b className="hoursWarning">38+</b>}
                          {hourStatus?.risk === "overtime" && <b className="hoursOvertime">40+</b>}
                          {hasOverlap && <b className="safetyDanger">Overlap</b>}
                          {hasLoneWorker && <b className="safetyDanger">Alone</b>}
                          {hasMealIssue && <b className="scheduleMealBadge">Meal</b>}
                          <i>{shift.status}</i>
                        </span>
                      </div>
                    </div>;
                  })}
                  {!shiftsInCell.length && <span className="scheduleEmptyCell">Drop shift here</span>}
                </div>
              </div>;
            })}
          </div>;
        })}
      </div>
    </div>

    {editor && <div
      className="scheduleModalBackdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }}
    >
      <section className="scheduleModal" role="dialog" aria-modal="true" aria-labelledby="shift-editor-heading">
        <header>
          <div><p className="wfEyebrow">{editor.shift ? "Edit shift" : "New shift"}</p><h2 id="shift-editor-heading">Shift details</h2></div>
          <button type="button" aria-label="Close" onClick={() => setEditor(null)}>×</button>
        </header>
        <form onSubmit={saveShift} className="scheduleEditForm">
          <label>Employee
            <select value={editor.employeeId || ""} onChange={(event) => {
              const employeeId = event.target.value || null;
              const employee = employeeId ? employeeById.get(employeeId) : undefined;
              setEditor((current) => current
                ? {
                    ...current,
                    employeeId,
                    position: current.shift ? current.position : employee?.position || current.position,
                  }
                : current);
            }}>
              <option value="">Unassigned / open when published</option>
              {activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
          </label>
          <label>Date<input type="date" value={editor.date} onChange={(event) => setEditor((current) => current ? { ...current, date: event.target.value } : current)} required /></label>
          <label>Start
            <TimeSelect value={editor.startTime} required onChange={(value) => setEditor((current) => current ? { ...current, startTime: value } : current)} />
          </label>
          <label>End
            <TimeSelect value={editor.endTime} required onChange={(value) => setEditor((current) => current ? { ...current, endTime: value } : current)} />
          </label>
          <label>Position
            {business === "Corner Deli"
              ? <select value={editor.position} onChange={(event) => setEditor((current) => current ? { ...current, position: event.target.value } : current)} required>
                  <option value="">Choose position</option>
                  {positionOptions.map((position) => <option key={position} value={position}>{position}</option>)}
                </select>
              : <input value={editor.position} onChange={(event) => setEditor((current) => current ? { ...current, position: event.target.value } : current)} required />}
          </label>

          {editorPreview && <section className="scheduleMealPlanner">
            <header>
              <div><h3>Meal-period compliance</h3><p>Required meals block publication until their start and duration comply.</p></div>
              {editorPreview.meals.requirements.length > 0 && <button type="button" onClick={applyRequiredMeals}>Apply required meals</button>}
            </header>
            {editorPreview.meals.requirements.length > 0 ? <div className="scheduleMealRequirements">
              {editorPreview.meals.requirements.map((requirement) => <div className="scheduleMealRequirement" key={requirement.code}>
                <strong>{requirement.label}</strong><span>{requirement.detail}</span>
              </div>)}
            </div> : <div className="scheduleMealClear">No statutory meal period is triggered by this shift length and timing.</div>}
            <div className="scheduleMealGrid">
              <div className="scheduleMealRow">
                <strong>Primary meal period</strong>
                <label>Start<TimeSelect allowBlank value={editor.mealBreakTime} onChange={(value) => setEditor((current) => current ? { ...current, mealBreakTime: value, mealBreakMinutes: value ? current.mealBreakMinutes || 30 : 0 } : current)} /></label>
                <label>Duration<select value={editor.mealBreakMinutes} onChange={(event) => setEditor((current) => current ? { ...current, mealBreakMinutes: Number(event.target.value), mealBreakTime: Number(event.target.value) ? current.mealBreakTime : "" } : current)}>{BREAK_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes ? `${minutes} minutes` : "None"}</option>)}</select></label>
              </div>
              <div className="scheduleMealRow">
                <strong>Additional evening meal</strong>
                <label>Start<TimeSelect allowBlank value={editor.extraMealBreakTime} onChange={(value) => setEditor((current) => current ? { ...current, extraMealBreakTime: value, extraMealBreakMinutes: value ? current.extraMealBreakMinutes || 20 : 0 } : current)} /></label>
                <label>Duration<select value={editor.extraMealBreakMinutes} onChange={(event) => setEditor((current) => current ? { ...current, extraMealBreakMinutes: Number(event.target.value), extraMealBreakTime: Number(event.target.value) ? current.extraMealBreakTime : "" } : current)}>{BREAK_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes ? `${minutes} minutes` : "None"}</option>)}</select></label>
              </div>
            </div>
            {editorPreview.meals.issues.length > 0 ? <div className="scheduleMealIssues">
              {editorPreview.meals.issues.map((issue) => <div className="scheduleMealIssue" key={issue.code}>{issue.message}</div>)}
            </div> : editorPreview.meals.requirements.length > 0 ? <div className="scheduleMealClear">Scheduled meal periods satisfy the configured New York rules.</div> : null}
            <p className="scheduleLawNote">Meal periods are treated as off-duty and unpaid. They reduce paid-hour totals and do not count as staffing coverage during the break.</p>
          </section>}

          {editor.employeeId && editorPreview && <div className={`scheduleEditorCheck ${editorPreview.overlap ? "danger" : editorPreview.risk}`}>
            <strong>Projected paid weekly total: {editorPreview.hours.toFixed(1)} hours</strong>
            <span>{editorPreview.overlap
              ? "This shift overlaps another assignment and cannot be saved."
              : editorPreview.risk === "overtime"
                ? "This draft takes the employee over 40 paid hours and will block publication."
                : editorPreview.risk === "warning"
                  ? "This draft takes the employee over 38 paid hours. Review before publishing."
                  : "No overlap or weekly-hour warning for this employee."}</span>
          </div>}
          <p className="scheduleNotes">Saving creates a draft. Missing required meals may remain while you build, but the week cannot be published until corrected.</p>
          <label className="scheduleNotes">Shift instructions shown to the employee
            <textarea
              rows={5}
              value={editor.notes}
              onChange={(event) => setEditor((current) => current ? { ...current, notes: event.target.value } : current)}
              placeholder="Example: Restock the outside cooler before opening. Private party arrives at 6:30."
            />
          </label>
          <div className="scheduleModalActions">
            {editor.shift && <>
              <button type="button" onClick={() => setCopiedShift(editor.shift)}>Copy shift</button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void runAction(
                  { action: "shift-update", id: editor.shift?.id, status: "Cancelled" },
                  "Shift cancelled.",
                ).then(() => setEditor(null))}
              >Cancel shift</button>
            </>}
            <button type="button" onClick={() => setEditor(null)}>Close</button>
            <button type="submit" className="schedulePrimary" disabled={busy || Boolean(editorPreview?.overlap)}>Save draft</button>
          </div>
        </form>
      </section>
    </div>}
  </section>;
}
