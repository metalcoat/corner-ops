"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business } from "@/lib/types";
import "../workforce.css";

type Employee = {
  id: string;
  name: string;
  position: string;
  active: boolean;
};

type WorkforcePayload = {
  business: Business;
  employees: Employee[];
};

type CreatedEntry = {
  id: string;
  business: Business;
  employeeName: string;
  source: string;
  hours: number;
};

function newYorkToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function errorMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function MissingShiftPage() {
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [position, setPosition] = useState("");
  const [date, setDate] = useState(newYorkToday());
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [note, setNote] = useState("Missed both clock-in and clock-out.");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<CreatedEntry | null>(null);

  const selectedEmployee = useMemo(() => employees.find((employee) => employee.id === employeeId) || null, [employees, employeeId]);

  useEffect(() => {
    const controller = new AbortController();
    setEmployees([]);
    setEmployeeId("");
    setPosition("");
    setNotice("");
    setCreated(null);

    fetch(`/api/workforce?business=${encodeURIComponent(business)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response));
        return response.json() as Promise<WorkforcePayload>;
      })
      .then((payload) => setEmployees(payload.employees.filter((employee) => employee.active)))
      .catch((error) => {
        if ((error as Error)?.name !== "AbortError") setNotice(error instanceof Error ? error.message : "Unable to load employees.");
      });

    return () => controller.abort();
  }, [business]);

  useEffect(() => {
    if (selectedEmployee) setPosition(selectedEmployee.position || "");
  }, [selectedEmployee]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    setCreated(null);

    if (!employeeId || !date || !clockIn || !clockOut || !position.trim()) {
      setNotice("Employee, date, clock-in, clock-out, and position are required.");
      return;
    }

    const start = new Date(`${date}T${clockIn}`);
    const end = new Date(`${date}T${clockOut}`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setNotice("Enter valid clock-in and clock-out times.");
      return;
    }
    if (end <= start) end.setDate(end.getDate() + 1);

    setBusy(true);
    try {
      const response = await fetch("/api/workforce/manual-time-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business,
          employeeId,
          position,
          clockIn: start.toISOString(),
          clockOut: end.toISOString(),
          note,
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const result = await response.json() as CreatedEntry;
      setCreated(result);
      setNotice(`${result.employeeName}: ${result.hours.toFixed(2)} hours added to ${result.source}.`);
      setClockIn("");
      setClockOut("");
      setNote("Missed both clock-in and clock-out.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The missing shift could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="workforceShell">
    <header className="workforceHero">
      <div>
        <p className="wfEyebrow">Manager time entry</p>
        <h1>Add Missing Shift</h1>
        <p>Add both punches when an employee missed the entire clock-in/clock-out. Overnight shifts are handled automatically.</p>
      </div>
      <div className="wfBusinessSwitch">
        {(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>{name}</button>)}
      </div>
    </header>

    {notice && <div className="wfNotice">{notice}</div>}

    <section className="wfTwoColumn">
      <article className="workforcePanel">
        <div className="wfPanelHeader">
          <div><p className="wfEyebrow">Both punches missing</p><h2>Create payroll time</h2></div>
          <span className="wfSourceNote">{business === "Tiki" ? "Writes to Corner Ops" : "Writes to Rezku payroll stream"}</span>
        </div>

        <form className="wfForm oneColumn" onSubmit={submit}>
          <label>Employee
            <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required>
              <option value="">Choose employee</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.position}</option>)}
            </select>
          </label>

          <label>Date
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
          </label>

          <label>Clock in
            <input type="time" value={clockIn} onChange={(event) => setClockIn(event.target.value)} required />
          </label>

          <label>Clock out
            <input type="time" value={clockOut} onChange={(event) => setClockOut(event.target.value)} required />
          </label>

          <label>Position
            <input value={position} onChange={(event) => setPosition(event.target.value)} placeholder="Position" required />
          </label>

          <label>Reason / note
            <textarea rows={4} value={note} onChange={(event) => setNote(event.target.value)} maxLength={1500} />
          </label>

          <button className="wfPrimary" disabled={busy}>{busy ? "Creating…" : "Create Time Entry"}</button>
        </form>
      </article>

      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">What happens</p><h2>Payroll-safe entry</h2></div></div>
        <div className="wfList">
          <div className="wfMessage"><strong>{business === "Tiki" ? "Tiki" : "Corner Deli"}</strong><p>{business === "Tiki" ? "Creates a completed Corner Ops time entry marked Manager Added / Corrected." : "Creates a protected manual Rezku shift so it is included in the existing Deli payroll calculation."}</p></div>
          <div className="wfMessage"><strong>Duplicate protection</strong><p>The entry is rejected if that employee already has an overlapping shift.</p></div>
          <div className="wfMessage"><strong>Audit trail</strong><p>The system records the employee, exact punches, hours, note, manager, source record, and creation time.</p></div>
          <div className="wfMessage"><strong>Overnight</strong><p>If clock-out is earlier than clock-in, it is treated as the following day. Shifts longer than 18 hours are rejected.</p></div>
          {created && <div className="wfMessage"><strong>Last entry created</strong><p>{created.employeeName} · {created.hours.toFixed(2)} hours · {created.source}</p></div>}
        </div>
      </article>
    </section>
  </main>;
}
