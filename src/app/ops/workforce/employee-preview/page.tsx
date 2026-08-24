import { redirect } from "next/navigation";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { listDirectoryEmployees } from "@/lib/employee-directory-admin";
import { employeePortalDashboard } from "@/lib/employee-portal-dashboard";
import { newYorkDateKey } from "@/lib/schedule-meal-compliance";
import type { Business } from "@/lib/types";
import "../workforce.css";

const TIME_ZONE = "America/New_York";
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type PreviewShift = {
  id: string;
  employeeId: string | null;
  position: string;
  startsAt: string;
  endsAt: string;
  status: string;
  notes: string;
};

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function businessFrom(value: string): Business {
  return value === "Tiki" ? "Tiki" : "Corner Deli";
}

function dateFromKey(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function addDays(value: string, days: number): string {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayKey(value: Date | string): string {
  // A YYYY-MM-DD value is already a calendar date, not an instant. Parsing it as
  // midnight UTC can move it to the prior New York day and therefore prior week.
  const key = typeof value === "string" && DATE_KEY_PATTERN.test(value) ? value : newYorkDateKey(value);
  const date = dateFromKey(key);
  const weekday = date.getUTCDay();
  return addDays(key, -((weekday + 6) % 7));
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function dayLabel(key: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(dateFromKey(key));
}

function ShiftWeek({ title, eyebrow, days, shifts }: { title: string; eyebrow: string; days: string[]; shifts: PreviewShift[] }) {
  return <section className="workforcePanel">
    <div className="wfPanelHeader"><div><p className="wfEyebrow">{eyebrow}</p><h2>{title}</h2></div></div>
    <div className="wfList">
      {days.map((day) => {
        const dayShifts = shifts.filter((shift) => newYorkDateKey(shift.startsAt) === day);
        return <div className="wfRequest" key={day}>
          <div>
            <strong>{dayLabel(day)}</strong>
            {dayShifts.map((shift) => <span key={shift.id}>{timeLabel(shift.startsAt)}–{timeLabel(shift.endsAt)} · {shift.position}{shift.status === "Draft" ? " · DRAFT" : ""}{shift.notes ? ` · ${shift.notes}` : ""}</span>)}
            {!dayShifts.length && <span>Not scheduled</span>}
          </div>
        </div>;
      })}
    </div>
  </section>;
}

export default async function EmployeePreviewPage({ searchParams }: { searchParams: SearchParams }) {
  const owner = await getSession();
  if (!owner) redirect("/");

  const params = await searchParams;
  const business = businessFrom(one(params.business));
  if (!canAccessBusiness(owner, business)) redirect("/ops/workforce");

  const directory = (await listDirectoryEmployees(business)).filter((employee) => employee.active);
  const requestedEmployeeId = one(params.employeeId);
  const employee = directory.find((candidate) => candidate.id === requestedEmployeeId) || directory[0] || null;
  const requestedWeek = one(params.week);
  const weekStart = DATE_KEY_PATTERN.test(requestedWeek) ? mondayKey(requestedWeek) : mondayKey(new Date());
  const weekEnd = addDays(weekStart, 7);

  const dashboard = employee
    ? await employeePortalDashboard({
        employeeId: employee.id,
        business,
        name: employee.name,
        position: employee.position,
        sessionVersion: 1,
        expiresAt: Date.now() + 60_000,
      })
    : null;

  const stagedRows = employee ? await getSql()`
    SELECT id, employee_id, position, starts_at, ends_at, status, notes
    FROM schedule_shifts
    WHERE business = ${business}
      AND employee_id = ${employee.id}
      AND status <> 'Cancelled'
      AND starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
    ORDER BY starts_at
  ` as unknown as Array<{
    id: string;
    employee_id: string | null;
    position: string;
    starts_at: string;
    ends_at: string;
    status: string;
    notes: string;
  }> : [];

  if (employee) {
    console.info(`[employee-preview] ${owner.email} viewed ${business} Employee Hub as ${employee.id}`);
  }

  const currentlyVisible: PreviewShift[] = (dashboard?.teamShifts || []).filter((shift) => {
    const key = newYorkDateKey(shift.startsAt);
    return shift.employeeId === employee?.id && key >= weekStart && key < weekEnd;
  }).map((shift) => ({
    id: shift.id,
    employeeId: shift.employeeId,
    position: shift.position,
    startsAt: shift.startsAt,
    endsAt: shift.endsAt,
    status: shift.status,
    notes: shift.notes,
  }));

  const afterPublish: PreviewShift[] = stagedRows.map((shift) => ({
    id: String(shift.id),
    employeeId: shift.employee_id ? String(shift.employee_id) : null,
    position: String(shift.position || ""),
    startsAt: String(shift.starts_at),
    endsAt: String(shift.ends_at),
    status: String(shift.status || ""),
    notes: String(shift.notes || ""),
  }));

  const openShifts = (dashboard?.teamShifts || []).filter((shift) => {
    const key = newYorkDateKey(shift.startsAt);
    return !shift.employeeId && shift.status === "Open" && key >= weekStart && key < weekEnd;
  });
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const base = `/ops/workforce/employee-preview?business=${encodeURIComponent(business)}${employee ? `&employeeId=${encodeURIComponent(employee.id)}` : ""}`;

  return <main className="workforceShell">
    <header className="workforceHero">
      <div>
        <p className="wfEyebrow">Read-only impersonation</p>
        <h1>Employee Hub Preview</h1>
        <p>Compare what the employee can see now with what they will see after the next schedule publish. No employee actions are available here.</p>
      </div>
      <a className="wfPrimary" href={`/ops/workforce?business=${encodeURIComponent(business)}`}>← Back to Workforce</a>
    </header>

    <section className="workforcePanel">
      <div className="wfPanelHeader">
        <div><p className="wfEyebrow">Viewing as</p><h2>{employee?.name || "No active employee"}</h2></div>
        <span className="wfBadge pending">READ ONLY</span>
      </div>
      <form className="wfForm" method="get">
        <label>Business<select name="business" defaultValue={business}><option>Corner Deli</option><option>Tiki</option></select></label>
        <label>Employee<select name="employeeId" defaultValue={employee?.id || ""}>{directory.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <input type="hidden" name="week" value={weekStart} />
        <button className="wfPrimary" type="submit">View employee</button>
      </form>
    </section>

    {employee && <>
      <section className="workforcePanel">
        <div className="wfPanelHeader">
          <div><p className="wfEyebrow">Schedule week</p><h2>{dayLabel(weekStart)} – {dayLabel(addDays(weekStart, 6))}</h2></div>
          <div className="wfActions">
            <a href={`${base}&week=${addDays(weekStart, -7)}`}>← Previous</a>
            <a href={`${base}&week=${mondayKey(new Date())}`}>Current</a>
            <a href={`${base}&week=${addDays(weekStart, 7)}`}>Next →</a>
          </div>
        </div>
      </section>

      <ShiftWeek title="After next Publish" eyebrow="Preview before notifying" days={days} shifts={afterPublish} />
      <ShiftWeek title="Currently visible in Employee Hub" eyebrow="What they see right now" days={days} shifts={currentlyVisible} />

      <section className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">What they can see</p><h2>Open shifts this week</h2></div></div>
        <div className="wfList">
          {openShifts.map((shift) => <div className="wfRequest" key={shift.id}><div><strong>{dayLabel(newYorkDateKey(shift.startsAt))}</strong><span>{timeLabel(shift.startsAt)}–{timeLabel(shift.endsAt)} · {shift.position}</span></div></div>)}
          {!openShifts.length && <p className="wfEmpty">No open shifts this week.</p>}
        </div>
      </section>
    </>}
  </main>;
}
