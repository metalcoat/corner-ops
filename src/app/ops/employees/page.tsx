"use client";

import { CSSProperties, FormEvent, useEffect, useState } from "react";
import { CORNER_DELI_POSITIONS } from "@/lib/business-positions";
import { employeePinLabel, employeePinLength, employeePinPattern } from "@/lib/employee-pin";
import { maskedPhone } from "@/lib/phone";
import type { Business, SessionView } from "@/lib/types";
import "../workforce/workforce.css";
import "./employees.css";

type Employee = {
  id: string;
  email: string;
  phone: string;
  smsOptIn: boolean;
  name: string;
  position: string;
  roleGroup: "Driver" | "In-House" | "Ignore";
  countsForTips: boolean;
  hourlyRate: number;
  tippedRate: number;
  active: boolean;
  pinEnabled: boolean;
  scheduleColor: string;
  avatarSet: boolean;
};
type DirectoryData = { employees: Employee[] };
type BulkPinResult = { updated: string[]; missing: string[]; requested: number; pinLength: number };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function avatarUrl(business: Business, employeeId: string): string {
  return `/api/employee-directory/avatar?business=${encodeURIComponent(business)}&id=${encodeURIComponent(employeeId)}`;
}

export default function EmployeesPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pinLength = employeePinLength(business);
  const pinLabel = employeePinLabel(business);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false, configured: false, missing: ["Unable to reach server"] }));
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/employee-directory?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as DirectoryData;
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
      const response = await fetch("/api/employee-directory", {
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
    const position = String(form.get("position") || "");
    await action({
      action: "create",
      email: form.get("email"),
      phone: form.get("phone"),
      smsOptIn: form.get("smsOptIn") === "on",
      name: form.get("name"),
      pin: form.get("pin"),
      position,
      roleGroup: business === "Corner Deli" ? (position === "Delivery" ? "Driver" : "In-House") : form.get("roleGroup"),
      countsForTips: form.get("countsForTips") === "on",
      hourlyRate: Number(form.get("hourlyRate") || 0),
      tippedRate: Number(form.get("tippedRate") || 0),
    }, "Employee created and ready for schedules and Employee Hub login.");
    formElement.reset();
  }

  async function bulkPins(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business, action: "bulk-pin-update", lines: form.get("lines") }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as BulkPinResult;
      await load();
      const missing = result.missing.length ? ` Not found: ${result.missing.join(", ")}.` : "";
      setNotice(`PINs updated for ${result.updated.length} employee${result.updated.length === 1 ? "" : "s"}.${missing}`);
      if (!result.missing.length) formElement.reset();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Bulk PIN assignment failed.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhoto(event: FormEvent<HTMLFormElement>, employee: Employee) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("action", "profile-photo");
    form.set("business", business);
    form.set("employeeId", employee.id);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee-directory", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      await load();
      setNotice(`${employee.name}'s photo was updated.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Employee photo could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  function editName(employee: Employee) {
    const name = window.prompt("Correct employee name", employee.name)?.trim();
    if (name && name !== employee.name) void action({ action: "update-profile", id: employee.id, name }, `Employee renamed to ${name}.`);
  }

  function editPhone(employee: Employee) {
    const phone = window.prompt(`Mobile number for ${employee.name}`, employee.phone)?.trim();
    if (phone !== undefined && phone !== employee.phone) {
      void action({ action: "update-access", id: employee.id, phone, smsOptIn: phone ? employee.smsOptIn : false }, "Employee mobile number updated.");
    }
  }

  if (!session) return <main className="workforceShell"><section className="workforcePanel"><h1>Loading employees</h1></section></main>;
  if (!session.authenticated) return <main className="workforceShell"><section className="workforcePanel"><h1>Owner access required</h1><a className="wfPrimary" href="/">Return to sign-in</a></section></main>;

  return <main className="workforceShell">
    <header className="workforceHero">
      <div><p className="wfEyebrow">Staff access, identity, and notifications</p><h1>Employees</h1><p>Employee colors and photos appear on schedules. SMS schedule notifications require a mobile number and confirmed employee consent.</p></div>
      <div className="wfBusinessSwitch">{(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div>
    </header>
    {notice && <div className="wfNotice">{notice}</div>}
    <section className="wfTwoColumn">
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Add staff</p><h2>New {business} employee</h2></div></div>
        <form className="wfForm" onSubmit={createEmployee}>
          <label>Name<input name="name" required /></label>
          <label>Email<input name="email" type="email" /></label>
          <label>Mobile phone<input name="phone" type="tel" placeholder="315-555-0123" /></label>
          <label>{pinLabel}<input name="pin" inputMode="numeric" pattern={employeePinPattern(business)} minLength={pinLength} maxLength={pinLength} required /></label>
          <label>Position{business === "Corner Deli" ? <select name="position" defaultValue="Pizza" required>{CORNER_DELI_POSITIONS.map((position) => <option key={position}>{position}</option>)}</select> : <input name="position" defaultValue="Bartender" required />}</label>
          {business !== "Corner Deli" && <label>Role group<select name="roleGroup" defaultValue="In-House"><option>In-House</option><option>Driver</option><option>Ignore</option></select></label>}
          <label>Hourly rate<input name="hourlyRate" type="number" min="0" step="0.01" defaultValue="0" /></label>
          <label>Tipped rate<input name="tippedRate" type="number" min="0" step="0.01" defaultValue="0" /></label>
          <label className="wfWide"><input name="countsForTips" type="checkbox" defaultChecked /> Include in eligible tip pools</label>
          <label className="wfWide"><input name="smsOptIn" type="checkbox" /> Employee consented to SMS schedule notifications</label>
          <button className="wfPrimary" disabled={busy}>Create employee</button>
        </form>
      </article>

      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Bulk access</p><h2>Assign {pinLength}-digit PINs</h2></div></div>
        <p className="wfEmpty">Enter one employee per line with the PIN at the end. PINs are stored only as secure hashes.</p>
        <form className="wfForm" onSubmit={bulkPins}><label className="wfWide">Employee PIN list<textarea name="lines" rows={10} placeholder={`Aaron Smith ${"1".repeat(pinLength)}\nSecond Employee ${"2".repeat(pinLength)}`} required /></label><button className="wfPrimary" disabled={busy}>Apply PIN list</button></form>
      </article>

      <article className="workforcePanel employeeDirectoryPanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Current records</p><h2>{business} employees</h2></div><a className="wfTextLink" href="/ops/workforce">Open scheduler</a></div>
        <div className="employeeDirectoryGrid">
          {employees.map((employee) => <article className="employeeIdentityCard" key={employee.id} style={{ "--employee-color": employee.scheduleColor } as CSSProperties}>
            <header>
              <span className="employeeIdentityAvatar">{employee.avatarSet ? <img src={avatarUrl(business, employee.id)} alt={`${employee.name} profile`} loading="lazy" /> : initials(employee.name)}</span>
              <div><strong>{employee.name}</strong><span>{employee.position} · {employee.roleGroup}</span><small>{employee.email || "Email not set"}</small><small>{employee.phone ? maskedPhone(employee.phone) : "Mobile not set"}</small></div>
            </header>
            <div className="employeeIdentityControls">
              <label>Schedule color<input type="color" value={employee.scheduleColor} disabled={busy} onChange={(event) => void action({ action: "update-profile", id: employee.id, scheduleColor: event.target.value }, `${employee.name}'s schedule color was updated.`)} /></label>
              <label>Position{business === "Corner Deli" ? <select value={employee.position} disabled={busy} onChange={(event) => void action({ action: "update-profile", id: employee.id, position: event.target.value }, `${employee.name}'s position was updated.`)}>{CORNER_DELI_POSITIONS.map((position) => <option key={position}>{position}</option>)}</select> : <input value={employee.position} disabled={busy} onChange={() => undefined} onBlur={(event) => { const position = event.currentTarget.value.trim(); if (position && position !== employee.position) void action({ action: "update-profile", id: employee.id, position }, `${employee.name}'s position was updated.`); }} />}</label>
              <form className="employeePhotoForm" onSubmit={(event) => void uploadPhoto(event, employee)}><label>Icon photo<input name="photo" type="file" accept="image/*" required /></label><button disabled={busy}>Upload photo</button></form>
            </div>
            <footer>
              <span className={`wfBadge ${employee.active ? "approved" : "cancelled"}`}>{employee.active ? "Active" : "Inactive"}</span>
              <span className={`wfBadge ${employee.pinEnabled ? "approved" : "pending"}`}>{employee.pinEnabled ? "PIN set" : "PIN required"}</span>
              <span className={`wfBadge ${employee.smsOptIn ? "approved" : "pending"}`}>{employee.smsOptIn ? "SMS enabled" : "SMS off"}</span>
              <button disabled={busy} onClick={() => editName(employee)}>Edit name</button>
              <button disabled={busy} onClick={() => void action({ action: "update-access", id: employee.id, active: !employee.active }, employee.active ? "Employee deactivated." : "Employee reactivated.")}>{employee.active ? "Deactivate" : "Reactivate"}</button>
              <button disabled={busy} onClick={() => { const pin = window.prompt(`Enter a new ${pinLength}-digit PIN for ${employee.name}`); if (!pin) return; const confirmation = window.prompt("Confirm the new PIN"); if (pin !== confirmation) { setNotice("The PIN entries do not match."); return; } void action({ action: "update-access", id: employee.id, pin }, "PIN updated and Employee Hub access enabled."); }}>Change PIN</button>
              <button disabled={busy} onClick={() => { const email = window.prompt(`Enter an email for ${employee.name}`, employee.email); if (email !== null) void action({ action: "update-access", id: employee.id, email }, "Employee email updated."); }}>Edit email</button>
              <button disabled={busy} onClick={() => editPhone(employee)}>Edit phone</button>
              <button disabled={busy || !employee.phone} onClick={() => void action({ action: "update-access", id: employee.id, smsOptIn: !employee.smsOptIn }, employee.smsOptIn ? "SMS notifications disabled." : "SMS consent recorded and notifications enabled.")}>{employee.smsOptIn ? "Disable SMS" : "Enable SMS"}</button>
            </footer>
          </article>)}
          {employees.length === 0 && <p className="wfEmpty">No employee records for this location yet.</p>}
        </div>
      </article>
    </section>
  </main>;
}
