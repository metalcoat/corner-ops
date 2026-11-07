"use client";

import { responseMessage } from "@/app/client-http";
import { CSSProperties, FormEvent, useEffect, useState } from "react";
import { CORNER_DELI_POSITIONS } from "@/lib/business-positions";
import { employeePinLength } from "@/lib/employee-pin";
import { maskedPhone } from "@/lib/phone";
import type { Business, SessionView } from "@/lib/types";
import "../../workforce/workforce.css";
import "./employees.css";
import OnboardingChecklist, { type OnboardingStatus } from "../onboarding-checklist";

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
  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [inProgress, setInProgress] = useState<OnboardingStatus[]>([]);
  const pinLength = employeePinLength(business);
  const inactiveCount = employees.filter((employee) => !employee.active).length;
  const visibleEmployees = showInactive ? employees : employees.filter((employee) => employee.active);

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

  async function loadOnboarding(activeBusiness = business) {
    const response = await fetch(`/api/employee-directory/onboarding?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (response.ok) setInProgress(((await response.json()) as { inProgress: OnboardingStatus[] }).inProgress || []);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setNotice("");
    setInProgress([]);
    void loadOnboarding(business).catch(() => undefined);
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
  if (!session.authenticated) return <main className="workforceShell"><section className="workforcePanel"><h1>Owner access required</h1><a className="wfPrimary" href="/signin">Return to sign-in</a></section></main>;

  return <main className="workforceShell">
    <header className="workforceHero">
      <div><p className="wfEyebrow">People · Team</p><h1>Team</h1><p>Everyone on staff. Open a person for their profile, PIN, paperwork, pay and onboarding checklist; click a card to edit quickly. Colors and photos appear on schedules.</p></div>
      <div className="wfBusinessSwitch">{(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "selected" : ""} onClick={() => { setBusiness(name); setShowInactive(false); }}>{name}</button>)}</div>
    </header>
    {notice && <div className="wfNotice">{notice}</div>}
    <section className="wfTwoColumn">
      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Add staff</p><h2>New hires</h2></div><a className="wfPrimary" href="/ops/people/add">Add employee</a></div>
        <p className="wfEmpty">Name and mobile number are all it takes: they get one text to choose their PIN and finish their forms{business === "Corner Deli" ? ", handbook" : ""}, direct deposit and schedule app.</p>
        {inProgress.length > 0 && <div className="onboardingGrid">{inProgress.map((status) => <OnboardingChecklist key={status.employeeId} business={business} status={status} onChanged={() => void loadOnboarding()} />)}</div>}
        {inProgress.length === 0 && <p className="wfEmpty">No one is mid-setup right now.</p>}
      </article>

      <article className="workforcePanel">
        <div className="wfPanelHeader"><div><p className="wfEyebrow">Bulk access</p><h2>Assign {pinLength}-digit PINs</h2></div></div>
        <p className="wfEmpty">Enter one employee per line with the PIN at the end. PINs are stored only as secure hashes.</p>
        <form className="wfForm" onSubmit={bulkPins}><label className="wfWide">Employee PIN list<textarea name="lines" rows={10} placeholder={`Aaron Smith ${"1".repeat(pinLength)}\nSecond Employee ${"2".repeat(pinLength)}`} required /></label><button className="wfPrimary" disabled={busy}>Apply PIN list</button></form>
      </article>

      <article className="workforcePanel employeeDirectoryPanel">
        <div className="wfPanelHeader">
          <div><p className="wfEyebrow">Current records</p><h2>{business} employees</h2></div>
          <div>
            {inactiveCount > 0 && <button type="button" className="wfTextLink" onClick={() => setShowInactive((value) => !value)}>{showInactive ? "Hide inactive" : `Show inactive (${inactiveCount})`}</button>}
            <a className="wfTextLink" href="/ops/workforce">Open scheduler</a>
          </div>
        </div>
        <div className="employeeDirectoryGrid">
          {visibleEmployees.map((employee) => <article className="employeeIdentityCard" key={employee.id} style={{ "--employee-color": employee.scheduleColor } as CSSProperties}>
            <header>
              <span className="employeeIdentityAvatar">{employee.avatarSet ? <img src={avatarUrl(business, employee.id)} alt={`${employee.name} profile`} loading="lazy" /> : initials(employee.name)}</span>
              <div><strong><a className="employeeOpenLink" href={`/ops/people/team/${employee.id}?business=${encodeURIComponent(business)}`}>{employee.name}</a></strong><span>{employee.position} · {employee.roleGroup}</span><small>{employee.email || "Email not set"}</small><small>{employee.phone ? maskedPhone(employee.phone) : "Mobile not set"}</small></div>
            </header>
            <div className="employeeIdentityControls">
              <label>Schedule color<input type="color" value={employee.scheduleColor} disabled={busy} onChange={(event) => void action({ action: "update-profile", id: employee.id, scheduleColor: event.target.value }, `${employee.name}'s schedule color was updated.`)} /></label>
              <label>Position{business === "Corner Deli" ? <select value={employee.position} disabled={busy} onChange={(event) => void action({ action: "update-profile", id: employee.id, position: event.target.value }, `${employee.name}'s position was updated.`)}>{CORNER_DELI_POSITIONS.map((position) => <option key={position}>{position}</option>)}</select> : <input value={employee.position} disabled={busy} onChange={() => undefined} onBlur={(event) => { const position = event.currentTarget.value.trim(); if (position && position !== employee.position) void action({ action: "update-profile", id: employee.id, position }, `${employee.name}'s position was updated.`); }} />}</label>
              <form className="employeePhotoForm" onSubmit={(event) => void uploadPhoto(event, employee)}><label>Icon photo<input name="photo" type="file" accept="image/*" required /></label><button disabled={busy}>Upload photo</button></form>
            </div>
            <footer>
              <a className="wfTextLink" href={`/ops/people/team/${employee.id}?business=${encodeURIComponent(business)}`}>Open</a>
              <span className={`wfBadge ${employee.active ? "approved" : "cancelled"}`}>{employee.active ? "Active" : "Inactive"}</span>
              <span className={`wfBadge ${employee.pinEnabled ? "approved" : "pending"}`}>{employee.pinEnabled ? "PIN set" : "Setting up"}</span>
              <span className={`wfBadge ${employee.smsOptIn ? "approved" : "pending"}`}>{employee.smsOptIn ? "SMS enabled" : "SMS off"}</span>
              <button disabled={busy} onClick={() => editName(employee)}>Edit name</button>
              <button disabled={busy} onClick={() => void action({ action: "update-access", id: employee.id, active: !employee.active }, employee.active ? "Employee deactivated." : "Employee reactivated.")}>{employee.active ? "Deactivate" : "Reactivate"}</button>
              <button disabled={busy} onClick={() => { const pin = window.prompt(`Enter a new ${pinLength}-digit PIN for ${employee.name}`); if (!pin) return; const confirmation = window.prompt("Confirm the new PIN"); if (pin !== confirmation) { setNotice("The PIN entries do not match."); return; } void action({ action: "update-access", id: employee.id, pin }, "PIN updated and Employee Hub access enabled."); }}>Change PIN</button>
              <button disabled={busy} onClick={() => { const email = window.prompt(`Enter an email for ${employee.name}`, employee.email); if (email !== null) void action({ action: "update-access", id: employee.id, email }, "Employee email updated."); }}>Edit email</button>
              <button disabled={busy} onClick={() => editPhone(employee)}>Edit phone</button>
              <button disabled={busy || !employee.phone} onClick={() => void action({ action: "update-access", id: employee.id, smsOptIn: !employee.smsOptIn }, employee.smsOptIn ? "SMS notifications disabled." : "SMS consent recorded and notifications enabled.")}>{employee.smsOptIn ? "Disable SMS" : "Enable SMS"}</button>
            </footer>
          </article>)}
          {visibleEmployees.length === 0 && <p className="wfEmpty">{employees.length === 0 ? "No employee records for this location yet." : "No active employees for this location."}</p>}
        </div>
      </article>
    </section>
  </main>;
}
