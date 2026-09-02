"use client";

import { CSSProperties, DragEvent, FormEvent, useMemo, useState } from "react";
import { positionsForBusiness } from "@/lib/business-positions";
import {
  analyzeShiftMealCompliance,
  mealRequirements,
  newYorkDateKey,
  newYorkDateTime,
  newYorkTimeValue,
  shiftTimeForSelectedDay,
} from "@/lib/schedule-meal-compliance";
import { analyzeSchedule } from "@/lib/schedule-validation";
import type { Business } from "@/lib/types";
import { useModalFocus } from "@/app/use-modal-focus";
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

export type ScheduleTimeOff = {
  id: string;
  employee_id: string;
  employee_name: string;
  starts_on: string;
  ends_on: string;
  status: string;
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
  updatedAt?: string | null;
};

type Props = {
  business: Business;
  employees: ScheduleEmployee[];
  shifts: ScheduleShift[];
  timeOff: ScheduleTimeOff[];
  busy: boolean;
  runAction: (body: Record<string, unknown>, success: string) => Promise<Record<string, unknown> | null>;
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

type DragTarget = { dayKey: string; employeeId: string | null } | null;
type TimeOption = { value: string; label: string };

const TIME_ZONE = "America/New_York";
const MINUTE_MS = 60_000;
const UNASSIGNED_KEY = "__unassigned__";
const BREAK_DURATION_OPTIONS = [0, 20, 30, 45, 60];
const TIME_OPTIONS: TimeOption[] = Array.from({ length: 96 }, (_, index) => {
  const hour = Math.floor(index / 4);
  const minute = (index % 4) * 15;
  const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(`2000-01-01T${value}:00Z`));
  return { value, label };
});

function dateFromKey(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateKey(value: Date | string): string {
  return newYorkDateKey(value);
}

function addDateKeyDays(value: string, days: number): string {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function startOfMonday(date: Date): Date {
  const localKey = newYorkDateKey(date);
  const localNoon = dateFromKey(localKey);
  const daysSinceMonday = (localNoon.getUTCDay() + 6) % 7;
  return addDays(localNoon, -daysSinceMonday);
}

function dayLabel(value: Date | string, options: Intl.DateTimeFormatOptions): string {
  const key = value instanceof Date ? newYorkDateKey(value) : /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : newYorkDateKey(value);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(dateFromKey(key));
}

function localTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function localDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function inputTime(value: string | null | undefined): string {
  return value ? newYorkTimeValue(value) : "";
}

function nearestQuarter(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "";
  const total = Math.round((Number(match[1]) * 60 + Number(match[2])) / 15) * 15;
  return `${String(Math.floor((total % 1440) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function editorDates(editor: EditorState) {
  const start = newYorkDateTime(editor.date, editor.startTime);
  let end = newYorkDateTime(editor.date, editor.endTime);
  if (end <= start) end = newYorkDateTime(addDateKeyDays(editor.date, 1), editor.endTime);
  const mealBreakStart = editor.mealBreakTime && editor.mealBreakMinutes
    ? shiftTimeForSelectedDay(editor.date, editor.startTime, editor.mealBreakTime)
    : null;
  const extraMealBreakStart = editor.extraMealBreakTime && editor.extraMealBreakMinutes
    ? shiftTimeForSelectedDay(editor.date, editor.startTime, editor.extraMealBreakTime)
    : null;
  return { start, end, mealBreakStart, extraMealBreakStart };
}

function mealStartOptions(editor: EditorState, business: Business, slot: "primary" | "extra"): TimeOption[] {
  try {
    const { start, end } = editorDates(editor);
    const requirements = mealRequirements({
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      business,
      position: editor.position,
    });
    const requirement = requirements.find((candidate) => candidate.slot === slot);
    const selectedMinutes = slot === "primary" ? editor.mealBreakMinutes : editor.extraMealBreakMinutes;
    const durationMinutes = selectedMinutes || requirement?.minimumMinutes || 0;
    if (!durationMinutes) return [];
    const allowedStart = requirement?.windowStart ? new Date(requirement.windowStart) : start;
    const allowedEnd = requirement?.windowEnd ? new Date(requirement.windowEnd) : end;
    const midpoint = requirement?.midpoint ? new Date(requirement.midpoint) : null;
    return TIME_OPTIONS.filter((option) => {
      const candidateStart = shiftTimeForSelectedDay(editor.date, editor.startTime, option.value);
      const candidateEnd = new Date(candidateStart.getTime() + durationMinutes * MINUTE_MS);
      if (candidateStart < start || candidateEnd > end) return false;
      if (candidateStart < allowedStart || candidateEnd > allowedEnd) return false;
      if (midpoint && !(candidateStart <= midpoint && candidateEnd >= midpoint)) return false;
      return true;
    });
  } catch {
    return [];
  }
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
  const targetDate = newYorkDateKey(targetDay);
  const originalLocalTime = newYorkTimeValue(originalStart);
  const start = newYorkDateTime(targetDate, originalLocalTime);
  const differenceMs = start.getTime() - originalStart.getTime();
  return {
    ...shift,
    employeeId,
    employeeName: employeeName ?? shift.employeeName,
    startsAt: start.toISOString(),
    endsAt: new Date(originalEnd.getTime() + differenceMs).toISOString(),
    mealBreakStart: shiftIso(shift.mealBreakStart, differenceMs),
    extraMealBreakStart: shiftIso(shift.extraMealBreakStart, differenceMs),
  };
}

function timeOffKey(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return match?.[1] || "";
}

function timeOffOverlapsShift(request: ScheduleTimeOff, employeeId: string | null, startsAt: string | Date, endsAt: string | Date): boolean {
  if (!employeeId || request.employee_id !== employeeId || !["Pending", "Approved"].includes(request.status)) return false;
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  const lastInstant = new Date(Math.max(start.getTime(), end.getTime() - 1));
  const shiftStart = newYorkDateKey(start);
  const shiftEnd = newYorkDateKey(lastInstant);
  return timeOffKey(request.starts_on) <= shiftEnd && timeOffKey(request.ends_on) >= shiftStart;
}

function timeOffLabel(request: ScheduleTimeOff): string {
  const start = timeOffKey(request.starts_on);
  const end = timeOffKey(request.ends_on);
  if (start === end) return dayLabel(start, { month: "short", day: "numeric" });
  return `${dayLabel(start, { month: "short", day: "numeric" })}–${dayLabel(end, { month: "short", day: "numeric" })}`;
}

function cellKey(employeeId: string | null, dayKeyValue: string): string {
  return `${employeeId || UNASSIGNED_KEY}|${dayKeyValue}`;
}

function TimeSelect({ value, onChange, required = false, allowBlank = false, options = TIME_OPTIONS }: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  allowBlank?: boolean;
  options?: TimeOption[];
}) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>
    {allowBlank && <option value="">Not scheduled</option>}
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}

export default function ScheduleBoard({ business, employees, shifts, timeOff, busy, runAction }: Props) {
  const [weekStart, setWeekStart] = useState(() => startOfMonday(new Date()));
  const [copiedShift, setCopiedShift] = useState<ScheduleShift | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const scheduleModalRef = useModalFocus<HTMLElement>(Boolean(editor), () => setEditor(null));

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const weekStartKey = dateKey(weekStart);
  const weekEndKey = addDateKeyDays(weekStartKey, 7);
  const activeEmployees = employees.filter((employee) => employee.active);
  const employeeById = useMemo(() => new Map(activeEmployees.map((employee) => [employee.id, employee])), [activeEmployees]);
  const weekShifts = useMemo(() => shifts.filter((shift) => {
    const key = newYorkDateKey(shift.startsAt);
    return key >= weekStartKey && key < weekEndKey && shift.status !== "Cancelled";
  }), [shifts, weekEndKey, weekStartKey]);

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

  const overlapShiftIds = new Set(scheduleAnalysis.overlaps.flatMap((item) => [item.firstShiftId, item.secondShiftId]));
  const loneShiftIds = new Set(scheduleAnalysis.loneWorkerViolations.flatMap((item) => item.shiftIds));
  const mealViolationShiftIds = new Set(scheduleAnalysis.mealPeriodViolations.map((item) => item.shiftId));
  const gapDayKeys = new Set(scheduleAnalysis.coverageGaps.map((gap) => gap.dateKey));
  const draftCount = weekShifts.filter((shift) => shift.status === "Draft").length;
  const publishedCount = weekShifts.filter((shift) => shift.status === "Published" || shift.status === "Open").length;
  const missingEmailCount = activeEmployees.filter((employee) => !employee.email.trim()).length;
  const hardBlockingIssueCount = Math.max(
    0,
    publishAnalysis.blockingIssueCount - publishAnalysis.overForty.length,
  );

  const assignmentTimeOff = (employeeId: string | null, startsAt: string | Date, endsAt: string | Date) =>
    timeOff.filter((request) => timeOffOverlapsShift(request, employeeId, startsAt, endsAt));

  const approvedTimeOffShiftConflicts = weekShifts.flatMap((shift) =>
    assignmentTimeOff(shift.employeeId, shift.startsAt, shift.endsAt)
      .filter((request) => request.status === "Approved")
      .map((request) => ({ shift, request })),
  );
  const pendingTimeOffShiftConflicts = weekShifts.flatMap((shift) =>
    assignmentTimeOff(shift.employeeId, shift.startsAt, shift.endsAt)
      .filter((request) => request.status === "Pending")
      .map((request) => ({ shift, request })),
  );
  const schedulePublishBlocked = hardBlockingIssueCount > 0 || approvedTimeOffShiftConflicts.length > 0;
  const overtimeApprovalRequired = !schedulePublishBlocked && publishAnalysis.overForty.length > 0;

  function confirmTimeOffAssignment(employeeId: string | null, startsAt: string | Date, endsAt: string | Date) {
    const conflicts = assignmentTimeOff(employeeId, startsAt, endsAt);
    const approved = conflicts.find((request) => request.status === "Approved");
    if (approved) {
      window.alert(`${approved.employee_name} has APPROVED time off ${timeOffLabel(approved)}. Reassign the shift or leave it open.`);
      return { allowed: false, acknowledgePendingTimeOff: false };
    }
    const pending = conflicts.find((request) => request.status === "Pending");
    if (pending) {
      const allowed = window.confirm(`${pending.employee_name} has a PENDING time-off request ${timeOffLabel(pending)}.\n\nAssign this shift anyway while the request is still pending?`);
      return { allowed, acknowledgePendingTimeOff: allowed };
    }
    return { allowed: true, acknowledgePendingTimeOff: false };
  }

  const shiftsByCell = useMemo(() => {
    const map = new Map<string, ScheduleShift[]>();
    for (const shift of weekShifts) {
      const key = cellKey(shift.employeeId, newYorkDateKey(shift.startsAt));
      const list = map.get(key) || [];
      list.push(shift);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
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
        mealBreakStart: business === "Tiki" ? null : mealBreakStart?.toISOString() || null,
        mealBreakMinutes: business === "Tiki" ? 0 : editor.mealBreakMinutes,
        extraMealBreakStart: business === "Tiki" ? null : extraMealBreakStart?.toISOString() || null,
        extraMealBreakMinutes: business === "Tiki" ? 0 : editor.extraMealBreakMinutes,
        status: "Draft",
        notes: editor.notes,
      };
      const candidates = weekShifts.filter((shift) => shift.id !== editor.shift?.id);
      const localStartKey = newYorkDateKey(start);
      if (localStartKey >= weekStartKey && localStartKey < weekEndKey) candidates.push(previewShift);
      const analysis = analyzeSchedule(candidates, { enforceLoneWorker: loneWorkerApplies });
      return {
        hours: editor.employeeId ? analysis.employeeHours[editor.employeeId]?.hours || 0 : 0,
        risk: editor.employeeId ? analysis.employeeHours[editor.employeeId]?.risk || "normal" : "normal",
        overlap: analysis.overlaps.find((item) => item.firstShiftId === previewId || item.secondShiftId === previewId) || null,
        meals: analyzeShiftMealCompliance(previewShift),
      };
    } catch {
      return null;
    }
  }, [business, editor, employeeById, loneWorkerApplies, weekEndKey, weekShifts, weekStartKey]);

  const editorTimeOff = useMemo(() => {
    if (!editor?.employeeId) return { approved: [] as ScheduleTimeOff[], pending: [] as ScheduleTimeOff[] };
    try {
      const { start, end } = editorDates(editor);
      const conflicts = timeOff.filter((request) => timeOffOverlapsShift(request, editor.employeeId, start, end));
      return {
        approved: conflicts.filter((request) => request.status === "Approved"),
        pending: conflicts.filter((request) => request.status === "Pending"),
      };
    } catch {
      return { approved: [] as ScheduleTimeOff[], pending: [] as ScheduleTimeOff[] };
    }
  }, [editor, timeOff]);

  const primaryMealTimeOptions = useMemo(
    () => editor ? mealStartOptions(editor, business, "primary") : [],
    [business, editor],
  );
  const extraMealTimeOptions = useMemo(
    () => editor ? mealStartOptions(editor, business, "extra") : [],
    [business, editor],
  );

  function openExisting(shift: ScheduleShift) {
    setEditor({
      shift,
      employeeId: shift.employeeId,
      date: newYorkDateKey(shift.startsAt),
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
      const requirements = mealRequirements({
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        business,
        position: current.position,
      });
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
      window.alert("This employee already has an overlapping shift. Change the employee or shift time before saving.");
      return;
    }
    const { start, end, mealBreakStart, extraMealBreakStart } = editorDates(editor);
    const timeOffCheck = confirmTimeOffAssignment(editor.employeeId, start, end);
    if (!timeOffCheck.allowed) return;
    await runAction({
      action: editor.shift ? "shift-update" : "shift-create",
      id: editor.shift?.id,
      employeeId: editor.employeeId,
      position: editor.position,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      mealBreakStart: business === "Tiki" ? null : mealBreakStart?.toISOString() || null,
      mealBreakMinutes: business === "Tiki" ? 0 : editor.mealBreakMinutes,
      extraMealBreakStart: business === "Tiki" ? null : extraMealBreakStart?.toISOString() || null,
      extraMealBreakMinutes: business === "Tiki" ? 0 : editor.extraMealBreakMinutes,
      status: editor.shift
        ? editor.shift.status === "Draft"
          ? "Draft"
          : editor.employeeId ? "Published" : "Open"
        : "Draft",
      notes: editor.notes,
      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,
      expectedUpdatedAt: editor.shift?.updatedAt || null,
    }, editor.shift ? "Shift changes saved." : "Draft shift added.");
    setEditor(null);
  }

  async function moveShift(shift: ScheduleShift, targetDay: Date, employeeId: string | null) {
    const moved = moveShiftToCell(shift, targetDay, employeeId);
    const timeOffCheck = confirmTimeOffAssignment(employeeId, moved.startsAt, moved.endsAt);
    if (!timeOffCheck.allowed) return;
    await runAction({
      action: "shift-update",
      id: shift.id,
      employeeId,
      startsAt: moved.startsAt,
      endsAt: moved.endsAt,
      mealBreakStart: business === "Tiki" ? null : moved.mealBreakStart || null,
      mealBreakMinutes: business === "Tiki" ? 0 : moved.mealBreakMinutes || 0,
      extraMealBreakStart: business === "Tiki" ? null : moved.extraMealBreakStart || null,
      extraMealBreakMinutes: business === "Tiki" ? 0 : moved.extraMealBreakMinutes || 0,
      status: "Draft",
      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,
      expectedUpdatedAt: shift.updatedAt || null,
    }, "Shift moved and marked for publishing.");
  }

  async function pasteShift(targetDay: Date, employeeId: string | null) {
    if (!copiedShift) return;
    const copied = moveShiftToCell(copiedShift, targetDay, employeeId);
    const timeOffCheck = confirmTimeOffAssignment(employeeId, copied.startsAt, copied.endsAt);
    if (!timeOffCheck.allowed) return;
    await runAction({
      action: "shift-create",
      employeeId,
      position: copied.position,
      startsAt: copied.startsAt,
      endsAt: copied.endsAt,
      mealBreakStart: business === "Tiki" ? null : copied.mealBreakStart || null,
      mealBreakMinutes: business === "Tiki" ? 0 : copied.mealBreakMinutes || 0,
      extraMealBreakStart: business === "Tiki" ? null : copied.extraMealBreakStart || null,
      extraMealBreakMinutes: business === "Tiki" ? 0 : copied.extraMealBreakMinutes || 0,
      notes: copied.notes,
      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,
    }, "Copied shift pasted as a draft.");
  }

  async function publishWeek() {
    if (approvedTimeOffShiftConflicts.length) {
      const details = approvedTimeOffShiftConflicts.slice(0, 10).map(({ shift, request }) =>
        `${request.employee_name}: ${localDateTime(shift.startsAt)}–${localTime(shift.endsAt)} (${timeOffLabel(request)} approved off)`,
      );
      window.alert(`The schedule cannot be published/resend yet. Approved time off conflicts with assigned shifts:\n\n${details.join("\n")}\n\nReassign those shifts or make them open.`);
      return;
    }
    if (hardBlockingIssueCount > 0) {
      const details = [
        ...publishAnalysis.overlaps.map((overlap) => `${overlap.employeeName}: overlap at ${localDateTime(overlap.startsAt)}`),
        ...publishAnalysis.coverageGaps.map((gap) => `No coverage: ${localDateTime(gap.startsAt)}–${localTime(gap.endsAt)} (${gap.minutes} min)`),
        ...publishAnalysis.loneWorkerViolations.map((item) => `${item.employeeName}: alone ${item.minutes} minutes at ${localDateTime(item.startsAt)}`),
        ...publishAnalysis.mealPeriodViolations.map((item) => `${item.employeeName}: ${item.message}`),
      ];
      window.alert(`The schedule cannot be published yet.\n\n${details.slice(0, 14).join("\n")}`);
      return;
    }
    if (pendingTimeOffShiftConflicts.length) {
      const names = Array.from(new Set(pendingTimeOffShiftConflicts.map(({ request }) => `${request.employee_name} (${timeOffLabel(request)})`)));
      if (!window.confirm(`There are pending time-off requests that overlap assigned shifts:\n\n${names.join("\n")}\n\nPublish anyway while those requests are pending?`)) return;
    }

    const actionLabel = draftCount > 0 ? "Publish week" : "Resend schedule";
    let allowOvertime = false;
    if (publishAnalysis.overForty.length) {
      const overtimeDetails = publishAnalysis.overForty.map((employee) =>
        `${employee.employeeName}: ${employee.hours.toFixed(1)} paid hours`,
      );
      if (!window.confirm(
        `OVERTIME WARNING\n\n${overtimeDetails.join("\n")}\n\n${actionLabel} for ${business} anyway? This records your manager approval. Confirm that the overtime is intentional and will be handled in payroll.`,
      )) return;
      allowOvertime = true;
    } else if (!window.confirm(
      `${actionLabel} for ${business}? Only employees whose schedule changed will be notified; an explicit resend notifies currently assigned employees again.`,
    )) return;

    await runAction(
      { action: "week-publish", weekStart: weekStartKey, allowOvertime },
      allowOvertime
        ? "Schedule published with manager overtime approval. Employee Hub and configured notifications were updated."
        : "Schedule published. Employee Hub and configured notifications were updated.",
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
  const issueCount = publishAnalysis.blockingIssueCount + publishAnalysis.overThirtyEight.length + approvedTimeOffShiftConflicts.length + pendingTimeOffShiftConflicts.length;

  return <section className="scheduleBoardPanel">
    <header className="scheduleToolbar">
      <div>
        <p className="wfEyebrow">Weekly employee grid</p>
        <h2>{dayLabel(weekStartKey, { month: "long", day: "numeric" })} – {dayLabel(addDateKeyDays(weekStartKey, 6), { month: "long", day: "numeric", year: "numeric" })}</h2>
        <span className="scheduleSubline">Calendar days and shift times use America/New_York, matching Employee Hub and notifications.</span>
      </div>
      <div className="scheduleToolbarActions">
        <span className="scheduleClipboard">
          {draftCount > 0 ? `${draftCount} unpublished` : publishedCount > 0 ? "Week published" : "No shifts"}
          {missingEmailCount > 0 ? ` · ${missingEmailCount} missing email` : ""}
        </span>
        {copiedShift && <span className="scheduleClipboard">Copied {localTime(copiedShift.startsAt)}<button type="button" onClick={() => setCopiedShift(null)}>Clear</button></span>}
        <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))}>← Previous</button>
        <button type="button" onClick={() => setWeekStart(startOfMonday(new Date()))}>Today</button>
        <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next →</button>
        <button type="button" className="schedulePrimary" disabled={busy || !weekShifts.length} title={schedulePublishBlocked ? "Click to see the schedule issues preventing publication." : overtimeApprovalRequired ? "Publishing requires manager overtime confirmation." : undefined} onClick={() => void publishWeek()}>
          {draftCount > 0 ? `Publish (${draftCount})` : "Resend"}
        </button>
        <button type="button" className="schedulePrimary" onClick={() => setEditor(defaultEditor(activeEmployees[0]?.id || null, weekStart, activeEmployees[0]))}>+ Shift</button>
      </div>
    </header>

    <section className={`scheduleValidation ${schedulePublishBlocked ? "blocked" : "ready"}`}>
      <div className="scheduleValidationHeader">
        <div><strong>{schedulePublishBlocked ? "Schedule cannot be published" : overtimeApprovalRequired ? "Overtime approval required" : "Schedule checks passed"}</strong><span>Paid hours, overlap, meals, continuous coverage, and business-specific staffing rules.</span></div>
        <div className="scheduleCheckBadges">
          <span className={publishAnalysis.overThirtyEight.length ? "warning" : "clear"}>{publishAnalysis.overThirtyEight.length} over 38</span>
          <span className={publishAnalysis.overForty.length ? "danger" : "clear"}>{publishAnalysis.overForty.length} over 40</span>
          <span className={publishAnalysis.overlaps.length ? "danger" : "clear"}>{publishAnalysis.overlaps.length} overlap</span>
          <span className={publishAnalysis.coverageGaps.length ? "danger" : "clear"}>{publishAnalysis.coverageGaps.length} gap</span>
          <span className={publishAnalysis.mealPeriodViolations.length ? "warning" : "clear"}>{publishAnalysis.mealPeriodViolations.length} meal</span>
          <span className={approvedTimeOffShiftConflicts.length ? "danger" : pendingTimeOffShiftConflicts.length ? "warning" : "clear"}>{approvedTimeOffShiftConflicts.length ? `${approvedTimeOffShiftConflicts.length} time-off conflict` : pendingTimeOffShiftConflicts.length ? `${pendingTimeOffShiftConflicts.length} pending off` : "time off clear"}</span>
          {loneWorkerApplies && <span className={publishAnalysis.loneWorkerViolations.length ? "danger" : "clear"}>{publishAnalysis.loneWorkerViolations.length} alone</span>}
        </div>
      </div>
      {issueCount > 0 && <details className="scheduleIssueDetails" open={schedulePublishBlocked || overtimeApprovalRequired}>
        <summary>View {issueCount} schedule warning{issueCount === 1 ? "" : "s"}</summary>
        <div className="scheduleIssueList">
          {publishAnalysis.overThirtyEight.map((employee) => <div className="scheduleIssue warning" key={`38-${employee.employeeId}`}><strong>{employee.employeeName}</strong><span>{employee.hours.toFixed(1)} paid hours.</span></div>)}
          {publishAnalysis.overForty.map((employee) => <div className="scheduleIssue danger" key={`40-${employee.employeeId}`}><strong>{employee.employeeName}</strong><span>{employee.hours.toFixed(1)} paid hours. Manager confirmation required to publish.</span></div>)}
          {publishAnalysis.overlaps.map((item) => <div className="scheduleIssue danger" key={`${item.firstShiftId}-${item.secondShiftId}`}><strong>{item.employeeName}</strong><span>Overlapping assignments at {localDateTime(item.startsAt)}.</span></div>)}
          {publishAnalysis.coverageGaps.map((gap) => <div className="scheduleIssue danger" key={`${gap.dateKey}-${gap.startsAt}`}><strong>No employee coverage</strong><span>{localDateTime(gap.startsAt)}–{localTime(gap.endsAt)} ({gap.minutes} minutes).</span></div>)}
          {publishAnalysis.mealPeriodViolations.map((item) => <div className="scheduleIssue warning" key={`${item.shiftId}-${item.code}`}><strong>{item.employeeName}</strong><span>{item.message}</span></div>)}
          {publishAnalysis.loneWorkerViolations.map((item) => <div className="scheduleIssue danger" key={`${item.employeeId}-${item.startsAt}`}><strong>{item.employeeName}</strong><span>Alone {item.minutes} minutes starting {localDateTime(item.startsAt)}.</span></div>)}
          {approvedTimeOffShiftConflicts.map(({ shift, request }) => <div className="scheduleIssue danger" key={`off-approved-${shift.id}-${request.id}`}><strong>{request.employee_name}</strong><span>Approved off {timeOffLabel(request)} but assigned {localDateTime(shift.startsAt)}–{localTime(shift.endsAt)}. Reassign or open this shift.</span></div>)}
          {pendingTimeOffShiftConflicts.map(({ shift, request }) => <div className="scheduleIssue warning" key={`off-pending-${shift.id}-${request.id}`}><strong>{request.employee_name}</strong><span>Pending time-off request {timeOffLabel(request)} overlaps {localDateTime(shift.startsAt)}–{localTime(shift.endsAt)}.</span></div>)}
        </div>
      </details>}
    </section>

    <div className="scheduleGridScroll">
      <div className="scheduleWeekGrid" role="grid" aria-label={`${business} weekly schedule`}>
        <div className="scheduleGridCorner" role="columnheader"><strong>Employee</strong><span>Paid total</span></div>
        {weekDays.map((day) => {
          const key = dateKey(day);
          const dayShifts = weekShifts.filter((shift) => newYorkDateKey(shift.startsAt) === key);
          const dayHours = dayShifts.reduce((total, shift) => total + shiftHours(shift), 0);
          return <div className={`scheduleDayHeader ${newYorkDateKey(new Date()) === key ? "today" : ""} ${gapDayKeys.has(key) ? "hasCoverageGap" : ""}`} role="columnheader" key={key}>
            <strong>{dayLabel(key, { weekday: "short" })}</strong>
            <span>{dayLabel(key, { month: "short", day: "numeric" })}</span>
            <small>{dayShifts.length} shifts · {dayHours.toFixed(1)} hrs{gapDayKeys.has(key) ? " · GAP" : ""}</small>
          </div>;
        })}

        {rows.map((row) => {
          const totals = row.employeeId ? scheduleAnalysis.employeeHours[row.employeeId] : null;
          const risk = totals?.risk || "normal";
          const totalHours = row.employeeId
            ? totals?.hours || 0
            : weekShifts.filter((shift) => !shift.employeeId).reduce((total, shift) => total + shiftHours(shift), 0);
          return <div className="scheduleGridRow" role="row" key={row.key}>
            <div className={`scheduleEmployeeCell hours-${risk} ${!row.employee ? "unassigned" : ""}`} role="rowheader" style={{ "--employee-color": row.color } as CSSProperties}>
              <span className="scheduleAvatar small">{row.employee?.avatarSet ? <img src={avatarUrl(business, row.employee.id)} alt="" loading="lazy" /> : initials(row.name)}</span>
              <div>
                <strong>{row.name}</strong>
                <span>{row.position}</span>
                <b>{totalHours.toFixed(1)} hrs</b>
                {row.employee && <a href={`/ops/workforce/employee-preview?business=${encodeURIComponent(business)}&employeeId=${encodeURIComponent(row.employee.id)}`}>View as employee</a>}
              </div>
            </div>

            {weekDays.map((day) => {
              const dayKeyValue = dateKey(day);
              const shiftsInCell = shiftsByCell.get(cellKey(row.employeeId, dayKeyValue)) || [];
              const dayTimeOff = row.employeeId ? timeOff.filter((request) => request.employee_id === row.employeeId && ["Pending", "Approved"].includes(request.status) && timeOffKey(request.starts_on) <= dayKeyValue && timeOffKey(request.ends_on) >= dayKeyValue) : [];
              const approvedDayOff = dayTimeOff.find((request) => request.status === "Approved");
              const pendingDayOff = dayTimeOff.find((request) => request.status === "Pending");
              const isTarget = dragTarget?.dayKey === dayKeyValue && dragTarget.employeeId === row.employeeId;
              return <div
                className={`scheduleGridCell ${isTarget ? "dragTarget" : ""} ${draggingId ? "dragReady" : ""} ${approvedDayOff ? "timeOffApproved" : pendingDayOff ? "timeOffPending" : ""}`}
                role="gridcell"
                key={`${row.key}-${dayKeyValue}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (!isTarget) setDragTarget({ dayKey: dayKeyValue, employeeId: row.employeeId });
                }}
                onDrop={(event) => void onDrop(event, day, row.employeeId)}
              >
                {approvedDayOff && <div className="scheduleTimeOffCellBadge approved">Approved off</div>}
                {!approvedDayOff && pendingDayOff && <div className="scheduleTimeOffCellBadge pending">Time off pending</div>}
                <div className="scheduleCellActions">
                  <button type="button" disabled={Boolean(approvedDayOff)} title={approvedDayOff ? `${row.name} has approved time off` : `Add ${row.name} shift`} onClick={() => setEditor(defaultEditor(row.employeeId, day, row.employee || undefined))}>+</button>
                  {copiedShift && <button type="button" disabled={Boolean(approvedDayOff)} onClick={() => void pasteShift(day, row.employeeId)}>Paste</button>}
                </div>
                <div className="scheduleCellShifts">
                  {shiftsInCell.map((shift) => {
                    const employee = shift.employeeId ? employeeById.get(shift.employeeId) : undefined;
                    const color = employee?.scheduleColor || shift.employeeColor || row.color;
                    const hourStatus = scheduleAnalysis.shiftRisks[shift.id];
                    const hasOverlap = overlapShiftIds.has(shift.id);
                    const hasLoneWorker = loneShiftIds.has(shift.id);
                    const hasMealIssue = mealViolationShiftIds.has(shift.id);
                    const shiftTimeOff = assignmentTimeOff(shift.employeeId, shift.startsAt, shift.endsAt);
                    const approvedShiftOff = shiftTimeOff.find((request) => request.status === "Approved");
                    const pendingShiftOff = shiftTimeOff.find((request) => request.status === "Pending");
                    const meal = analyzeShiftMealCompliance(shift);
                    return <div
                      className={`scheduleShiftCard compact ${shift.status.toLowerCase()} ${draggingId === shift.id ? "dragging" : ""} hours-${hourStatus?.risk || "normal"} ${hasOverlap ? "hasOverlap" : ""} ${hasLoneWorker ? "hasLoneWorker" : ""} ${hasMealIssue ? "hasMealIssue" : ""}`}
                      style={{ "--employee-color": color } as CSSProperties}
                      key={shift.id}
                      draggable
                      onDragStart={(event) => onDragStart(event, shift)}
                      onDragEnd={() => { setDraggingId(null); setDragTarget(null); }}
                    >
                      <button type="button" className="shiftMain" onClick={() => openExisting(shift)}>
                        <span className="shiftDetails">
                          <span className="shiftTimeLine"><b>{localTime(shift.startsAt)}–{localTime(shift.endsAt)}</b><i>{shift.status === "Draft" ? "D" : shift.status === "Open" ? "O" : "P"}</i></span>
                          <em>{shift.position || "Shift"} · {meal.paidHours.toFixed(1)}h</em>
                          {(meal.primaryBreak || meal.extraBreak) && <small>{meal.primaryBreak ? `Meal ${localTime(meal.primaryBreak.start.toISOString())}` : ""}{meal.extraBreak ? ` · Extra ${localTime(meal.extraBreak.start.toISOString())}` : ""}</small>}
                          <span className="shiftInlineBadges">
                            {hourStatus?.risk === "warning" && <b className="hoursWarning">38+</b>}
                            {hourStatus?.risk === "overtime" && <b className="hoursOvertime">40+</b>}
                            {hasOverlap && <b className="safetyDanger">Overlap</b>}
                            {hasLoneWorker && <b className="safetyDanger">Alone</b>}
                            {hasMealIssue && <b className="scheduleMealBadge">Meal</b>}
                            {approvedShiftOff && <b className="safetyDanger">TIME OFF</b>}
                            {!approvedShiftOff && pendingShiftOff && <b className="hoursWarning">Off?</b>}
                            {shift.notes && <b className="noteBadge">Notes</b>}
                          </span>
                        </span>
                      </button>
                    </div>;
                  })}
                  {!shiftsInCell.length && <span className="scheduleEmptyCell">Drop</span>}
                </div>
              </div>;
            })}
          </div>;
        })}
      </div>
    </div>

    {editor && <div className="scheduleModalBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }}>
      <section ref={scheduleModalRef} tabIndex={-1} className="scheduleModal" role="dialog" aria-modal="true" aria-labelledby="shift-editor-heading">
        <header><div><p className="wfEyebrow">{editor.shift ? "Edit shift" : "New shift"}</p><h2 id="shift-editor-heading">Shift details</h2></div><button type="button" aria-label="Close" onClick={() => setEditor(null)}>×</button></header>
        <form onSubmit={saveShift} className="scheduleEditForm">
          <label>Employee<select value={editor.employeeId || ""} onChange={(event) => {
            const employeeId = event.target.value || null;
            const employee = employeeId ? employeeById.get(employeeId) : undefined;
            setEditor((current) => current ? { ...current, employeeId, position: current.shift ? current.position : employee?.position || current.position } : current);
          }}><option value="">Unassigned / open</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
          <label>Date<input type="date" value={editor.date} onChange={(event) => setEditor((current) => current ? { ...current, date: event.target.value } : current)} required /></label>
          <label>Start<TimeSelect value={editor.startTime} required onChange={(value) => setEditor((current) => current ? { ...current, startTime: value } : current)} /></label>
          <label>End<TimeSelect value={editor.endTime} required onChange={(value) => setEditor((current) => current ? { ...current, endTime: value } : current)} /></label>
          <label>Position{business === "Corner Deli"
            ? <select value={editor.position} onChange={(event) => setEditor((current) => current ? { ...current, position: event.target.value } : current)} required><option value="">Choose position</option>{positionOptions.map((position) => <option key={position} value={position}>{position}</option>)}</select>
            : <input value={editor.position} onChange={(event) => setEditor((current) => current ? { ...current, position: event.target.value } : current)} required />}</label>

          {editorTimeOff.approved.length > 0 && <div className="scheduleTimeOffEditorWarning approved"><strong>Cannot assign this shift</strong><span>{editorTimeOff.approved[0].employee_name} has approved time off {timeOffLabel(editorTimeOff.approved[0])}. Choose another employee, date, or leave the shift open.</span></div>}
          {editorTimeOff.approved.length === 0 && editorTimeOff.pending.length > 0 && <div className="scheduleTimeOffEditorWarning pending"><strong>Pending time-off request</strong><span>{editorTimeOff.pending[0].employee_name} requested {timeOffLabel(editorTimeOff.pending[0])} off. You can still assign the shift, but you will be asked to confirm.</span></div>}

          {business === "Corner Deli" && editorPreview && <section className="scheduleMealPlanner">
            <header><div><h3>Meal-period compliance</h3><p>Off-duty meals reduce paid hours and staffing coverage.</p></div>{editorPreview.meals.requirements.length > 0 && <button type="button" onClick={applyRequiredMeals}>Apply required meals</button>}</header>
            {editorPreview.meals.requirements.length > 0 ? <div className="scheduleMealRequirements">{editorPreview.meals.requirements.map((requirement) => <div className="scheduleMealRequirement" key={requirement.code}><strong>{requirement.label}</strong><span>{requirement.detail}</span></div>)}</div> : <div className="scheduleMealClear">No required meal period for this shift.</div>}
            <div className="scheduleMealGrid">
              <div className="scheduleMealRow"><strong>Primary meal</strong><label>Start<TimeSelect allowBlank options={primaryMealTimeOptions} value={editor.mealBreakTime} onChange={(value) => setEditor((current) => current ? { ...current, mealBreakTime: value, mealBreakMinutes: value ? current.mealBreakMinutes || 30 : 0 } : current)} /></label><label>Duration<select value={editor.mealBreakMinutes} onChange={(event) => setEditor((current) => current ? { ...current, mealBreakMinutes: Number(event.target.value), mealBreakTime: Number(event.target.value) ? current.mealBreakTime : "" } : current)}>{BREAK_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes ? `${minutes} minutes` : "None"}</option>)}</select></label></div>
              <div className="scheduleMealRow"><strong>Additional meal</strong><label>Start<TimeSelect allowBlank options={extraMealTimeOptions} value={editor.extraMealBreakTime} onChange={(value) => setEditor((current) => current ? { ...current, extraMealBreakTime: value, extraMealBreakMinutes: value ? current.extraMealBreakMinutes || 20 : 0 } : current)} /></label><label>Duration<select value={editor.extraMealBreakMinutes} onChange={(event) => setEditor((current) => current ? { ...current, extraMealBreakMinutes: Number(event.target.value), extraMealBreakTime: Number(event.target.value) ? current.extraMealBreakTime : "" } : current)}>{BREAK_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes ? `${minutes} minutes` : "None"}</option>)}</select></label></div>
            </div>
            {editorPreview.meals.issues.length > 0 ? <div className="scheduleMealIssues">{editorPreview.meals.issues.map((issue) => <div className="scheduleMealIssue" key={issue.code}>{issue.message}</div>)}</div> : editorPreview.meals.requirements.length > 0 ? <div className="scheduleMealClear">Meal periods comply.</div> : null}
          </section>}

          {editor.employeeId && editorPreview && <div className={`scheduleEditorCheck ${editorPreview.overlap ? "danger" : editorPreview.risk}`}><strong>Projected paid week: {editorPreview.hours.toFixed(1)} hours</strong><span>{editorPreview.overlap ? "This shift overlaps another assignment and cannot be saved." : editorPreview.risk === "overtime" ? "Over 40 paid hours will block publication." : editorPreview.risk === "warning" ? "This employee will exceed 38 paid hours." : "No employee overlap or hour warning."}</span></div>}
          <label className="scheduleNotes">Shift instructions<textarea rows={4} value={editor.notes} onChange={(event) => setEditor((current) => current ? { ...current, notes: event.target.value } : current)} /></label>
          <div className="scheduleModalActions">
            {editor.shift && <><button type="button" onClick={() => setCopiedShift(editor.shift)}>Copy shift</button><button type="button" className="danger" disabled={busy} onClick={() => void runAction({ action: "shift-update", id: editor.shift?.id, status: "Cancelled", expectedUpdatedAt: editor.shift?.updatedAt || null }, "Shift cancelled.").then(() => setEditor(null))}>Cancel shift</button></>}
            <button type="button" onClick={() => setEditor(null)}>Close</button>
            <button type="submit" className="schedulePrimary" disabled={busy || Boolean(editorPreview?.overlap)}>{editor.shift ? "Save changes" : "Save draft"}</button>
          </div>
        </form>
      </section>
    </div>}
  </section>;
}
