import { redirect } from "next/navigation";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { listDirectoryEmployees } from "@/lib/employee-directory-admin";
import { employeePortalDashboard } from "@/lib/employee-portal-dashboard";
import { newYorkDateKey } from "@/lib/schedule-meal-compliance";
import type { Business } from "@/lib/types";
import "../workforce.css";

const TIME_ZONE = "America/New_York";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

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
  const key = newYorkDateKey(value);
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
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(requestedWeek) ? mondayKey(requestedWeek) : mondayKey(new Date());
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

  if (employee) {
    console.info(`[employee-preview] ${owner.email} viewed ${business} Employee Hub as ${employee.id}`);
  }

  const myShifts = (dashboard?.teamShifts || []).filter((shift) => {
    const key = newYorkDateKey(shift.startsAt);
    return shift.employeeId === employee?.id && key >= weekStart && key < weekEnd;
  });
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
        <p>This preview uses the same Employee Hub dashboard data as the employee. Actions are intentionally unavailable here.</p>
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
          <div><p className="wfEyebrow">Employee schedule</p><h2>{dayLabel(weekStart)} – {dayLabel(addDays(weekStart, 6))}</h2></div>
          <div className="wfActions">
            <a href={`${base}&week=${addDays(weekStart, -7)}`}>← Previous</a>
            <a href={`${base}&week=${mondayKey(new Date())}`}>Current</a>
            <a href={`${base}&week=${addDays(weekStart, 7)}`}>Next →</a>
          </div>
        </div>
        <div className="wfList">
          {days.map((day) => {
            const shifts = myShifts.filter((shift) => newYorkDateKey(shift.startsAt) === day);
            return <div className="wfRequest" key={day}>
              <div>
                <strong>{dayLabel(day)}</strong>
                {shifts.map((shift) => <span key={shift.id}>{timeLabel(shift.startsAt)}–{timeLabel(shift.endsAt)} · {shift.position}{shift.notes ? ` · ${shift.notes}` : ""}</span>)}
                {!shifts.length && <span>Not scheduled</span>}
              </div>
            </div>;
          })}
        </div>
      </section>

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
