"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../workforce/workforce.css";

type Employee = {
  id: string;
  name: string;
  position: string;
  roleGroup: "Driver" | "In-House" | "Ignore";
  countsForTips: boolean;
  active: boolean;
};
type WorkforceData = { employees: Employee[] };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function EmployeesPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false, configured: false, missing: ["Unable to reach server"] }));
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/workforce?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as WorkforceData;
    setEmployees(payload.employees);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setNotice("");
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, business]);

  async function action(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/workforce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, business }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Employee update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await action({
      action: "employee-create",
      name: form.get("name"),
      pin: form.get("pin"),
      position: form.get("position"),
      roleGroup: form.get("roleGroup"),
      countsForTips: form.get("countsForTips") === "on",
      hourlyRate: Number(form.get("hourlyRate") || 0),
      tippedRate: Number(form.get("tippedRate") || 0),
    }, "Employee created and ready for schedules and Employee Hub login.");
    formElement.reset();
  }

  if (!session) return <main className="workforceShell"><section className="workforcePanel"><h1>Loading employees</h1></section></main>;
  if (!session.authenticated) return <main className="workforceShell"><section className="workforcePanel"><h1>Owner access required</h1><a className="wfPrimary" href="/">Return to sign-in</a></section></main>;

  return <main className="workforceShell">
    <header className="workforceHero"><div><p className="wfEyebrow">Staff access and payroll identity</p><h1>Employees</h1><p>Maintain separate employee records for Corner Deli and Tiki. Employees may use the same five-digit PIN at both businesses because each PIN is securely scoped to its location.</p></div><div className="wfBusinessSwitch">{(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div></header>
    {notice && <div className="wfNotice">{notice}</div>}
    <section className="wfTwoColumn">
      <article className="workforcePanel"><div className="wfPanelHeader"><div><p className="wfEyebrow">Add staff</p><h2>New {business} employee</h2></div></div><form className="wfForm" onSubmit={createEmployee}><label>Name<input name="name" required /></label><label>Five-digit PIN<input name="pin" inputMode="numeric" pattern="\d{5}" maxLength={5} required /></label><label>Position<input name="position" placeholder={business === "Tiki" ? "Bartender" : "Chef / Driver / Manager"} required /></label><label>Role group<select name="roleGroup" defaultValue="In-House"><option>In-House</option><option>Driver</option><option>Ignore</option></select></label><label>Hourly rate<input name="hourlyRate" type="number" min="0" step="0.01" defaultValue="0" /></label><label>Tipped rate<input name="tippedRate" type="number" min="0" step="0.01" defaultValue="0" /></label><label className="wfWide"><input name="countsForTips" type="checkbox" defaultChecked /> Include in eligible tip pools</label><button className="wfPrimary" disabled={busy}>Create employee</button></form></article>
      <article className="workforcePanel"><div className="wfPanelHeader"><div><p className="wfEyebrow">Current records</p><h2>{business} employees</h2></div><a className="wfTextLink" href="/ops/workforce">Open scheduler</a></div><div className="wfList">{employees.map((employee) => <div className="wfShift" key={employee.id}><div><strong>{employee.name}</strong><span>{employee.position} · {employee.roleGroup}</span><small>{employee.countsForTips ? "Tip eligible" : "Excluded from tips"}</small></div><div className="wfActions"><span className={`wfBadge ${employee.active ? "approved" : "cancelled"}`}>{employee.active ? "Active" : "Inactive"}</span><button disabled={busy} onClick={() => void action({ action: "employee-update", id: employee.id, active: !employee.active }, employee.active ? "Employee deactivated." : "Employee reactivated.")}>{employee.active ? "Deactivate" : "Reactivate"}</button><button disabled={busy} onClick={() => { const pin = window.prompt(`Enter a new five-digit PIN for ${employee.name}`); if (pin) void action({ action: "employee-update", id: employee.id, pin }, "PIN updated."); }}>Change PIN</button></div></div>)}{employees.length === 0 && <p className="wfEmpty">No employee records for this location yet.</p>}</div></article>
    </section>
  </main>;
}
