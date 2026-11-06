"use client";

import { responseMessage } from "@/app/client-http";
import { useParams, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useCallback, useEffect, useState } from "react";
import { CORNER_DELI_POSITIONS } from "@/lib/business-positions";
import { employeePinLength } from "@/lib/employee-pin";
import { maskedPhone } from "@/lib/phone";
import type { Business, SessionView } from "@/lib/types";
import OnboardingChecklist, { type OnboardingStatus } from "../../onboarding-checklist";
import "../../../control-center.css";
import "../../people.css";

type Employee = {
  id: string; email: string; phone: string; smsOptIn: boolean; name: string; position: string;
  roleGroup: "Driver" | "In-House" | "Ignore"; countsForTips: boolean; hourlyRate: number; tippedRate: number;
  active: boolean; pinEnabled: boolean; scheduleColor: string;
};
type FormSummary = { id: string; employeeId: string; title: string; formType: string; status: string; assignedAt: string; employeeSignedAt: string | null };
type HandbookRow = { employeeId: string; acknowledged: boolean; acknowledgedAt: string | null; signatureName: string | null };
type Election = { id: string; employeeId: string; status: string; signedAt: string | null };
type Tab = "onboarding" | "profile" | "paperwork" | "pay" | "schedule";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "onboarding", label: "Onboarding" },
  { key: "profile", label: "Profile & access" },
  { key: "paperwork", label: "Paperwork" },
  { key: "pay", label: "Pay & payroll" },
  { key: "schedule", label: "Schedule" },
];

function dateLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
}

export default function TeamMemberPage() {
  return <Suspense fallback={<main className="controlPage peoplePage">Loading…</main>}><TeamMember /></Suspense>;
}

function TeamMember() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const business: Business = searchParams.get("business") === "Tiki" ? "Tiki" : "Corner Deli";
  const [session, setSession] = useState<SessionView | null>(null);
  const [employee, setEmployee] = useState<Employee | null | undefined>(undefined);
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [handbook, setHandbook] = useState<HandbookRow | null>(null);
  const [elections, setElections] = useState<Election[]>([]);
  const [tab, setTab] = useState<Tab>("onboarding");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" }).then((response) => response.json()).then(setSession)
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, []);

  const load = useCallback(async () => {
    const query = `business=${encodeURIComponent(business)}`;
    const [directory, status, formData, handbookData, depositData] = await Promise.all([
      fetch(`/api/employee-directory?${query}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : { employees: [] }),
      fetch(`/api/employee-directory/onboarding?${query}&employeeId=${encodeURIComponent(id)}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null),
      fetch(`/api/employment-forms?${query}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : { forms: [] }),
      business === "Corner Deli" ? fetch("/api/employment-handbook", { cache: "no-store" }).then((response) => response.ok ? response.json() : { employees: [] }) : Promise.resolve({ employees: [] }),
      fetch(`/api/direct-deposit?${query}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : { elections: [] }),
    ]);
    const found = (directory.employees as Employee[]).find((item) => item.id === id) || null;
    setEmployee(found);
    setOnboarding(status as OnboardingStatus | null);
    setForms(((formData.forms || []) as FormSummary[]).filter((form) => form.employeeId === id));
    setHandbook(((handbookData.employees || []) as HandbookRow[]).find((row) => row.employeeId === id) || null);
    setElections(((depositData.elections || []) as Election[]).filter((row) => row.employeeId === id));
  }, [business, id]);

  useEffect(() => {
    if (session?.authenticated) void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [session?.authenticated, load]);

  async function update(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, business, id }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await update({
      action: "update-profile",
      name: form.get("name"),
      email: form.get("email"),
      phone: form.get("phone"),
      position: form.get("position"),
      scheduleColor: form.get("scheduleColor"),
      active: form.get("active") === "on",
      smsOptIn: form.get("smsOptIn") === "on",
      countsForTips: form.get("countsForTips") === "on",
      ...(business === "Tiki" ? { roleGroup: form.get("roleGroup") } : {}),
    }, "Profile saved.");
  }

  async function changePin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (form.get("pin") !== form.get("pinConfirm")) { setNotice("The PIN entries do not match."); return; }
    await update({ action: "update-access", pin: form.get("pin") }, "PIN changed. Their devices were signed out.");
    formElement.reset();
  }

  async function savePay(formElement: HTMLFormElement, sendNotice: boolean) {
    const form = new FormData(formElement);
    const hourlyRate = Number(form.get("hourlyRate") || 0);
    const tippedRate = Number(form.get("tippedRate") || 0);
    if (!sendNotice) { await update({ action: "update-profile", hourlyRate, tippedRate }, "Pay rates saved."); return; }
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee-directory/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business, action: "pay-notice", employeeId: id, hourlyRate, tippedRate }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice("Rates saved and the NY pay notice was sent to their forms.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Pay notice failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!session || employee === undefined) return <main className="controlPage peoplePage">Loading…</main>;
  if (!session.authenticated) return <main className="controlPage peoplePage"><a href="/signin">Sign in to Corner Ops</a></main>;
  if (!employee) return <main className="controlPage peoplePage"><h1>Employee not found</h1><a href="/ops/people/team">Back to Team</a></main>;

  const payrollStep = onboarding?.steps.find((step) => step.key === "payroll");
  const pinLength = employeePinLength(business);
  return <main className="controlPage peoplePage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow"><a href="/ops/people/team">Team</a> · {business}</p>
        <h1>{employee.name}</h1>
        <p>{employee.position} · {employee.active ? "Active" : "Inactive"} · {employee.pinEnabled ? "PIN set" : "Still setting up"} · {employee.phone ? maskedPhone(employee.phone) : "No mobile"}</p>
      </div>
    </header>
    {notice && <div className="noticeBar" role="status">{notice}</div>}
    <nav className="peopleTabs" aria-label="Employee sections">
      {TABS.map((item) => <button type="button" key={item.key} className={tab === item.key ? "active" : ""} onClick={() => setTab(item.key)}>{item.label}</button>)}
    </nav>

    {tab === "onboarding" && <section className="controlCard">
      {onboarding ? <OnboardingChecklist business={business} status={onboarding} title="Onboarding checklist" onChanged={() => void load()} /> : <p>Loading checklist…</p>}
      {onboarding && !onboarding.hasInvite && <p className="onboardingHint">Added before self-setup texts existed. &quot;Send setup text&quot; texts them a link to their checklist; if they already have a PIN it stays the same.</p>}
    </section>}

    {tab === "profile" && <section className="peopleGrid">
      <article className="controlCard">
        <h2>Profile</h2>
        <form className="peopleAddForm" onSubmit={saveProfile} key={`${employee.id}-${employee.name}-${employee.phone}`}>
          <label>Name<input name="name" defaultValue={employee.name} required /></label>
          <label>Mobile phone<input name="phone" type="tel" defaultValue={employee.phone} /></label>
          <label>Email<input name="email" type="email" defaultValue={employee.email} /></label>
          <label>Role{business === "Corner Deli"
            ? <select name="position" defaultValue={employee.position}>{CORNER_DELI_POSITIONS.map((position) => <option key={position}>{position}</option>)}</select>
            : <input name="position" defaultValue={employee.position} required />}</label>
          {business === "Tiki" && <label>Payroll role group<select name="roleGroup" defaultValue={employee.roleGroup}><option>In-House</option><option>Driver</option><option>Ignore</option></select></label>}
          <label>Schedule color<input name="scheduleColor" type="color" defaultValue={employee.scheduleColor} /></label>
          <label className="peopleCheck"><input name="active" type="checkbox" defaultChecked={employee.active} /> Active employee</label>
          <label className="peopleCheck"><input name="smsOptIn" type="checkbox" defaultChecked={employee.smsOptIn} /> Agreed to get texts</label>
          <label className="peopleCheck"><input name="countsForTips" type="checkbox" defaultChecked={employee.countsForTips} /> Include in tip pools</label>
          <button className="primary" disabled={busy}>Save profile</button>
        </form>
      </article>
      <article className="controlCard">
        <h2>PIN & sign-in</h2>
        <p>{employee.pinEnabled ? "They can sign in with their PIN. Changing it signs out all their devices." : "They haven't chosen a PIN yet; their setup link does that. You can also set one here."}</p>
        <form className="peopleAddForm" onSubmit={changePin}>
          <label>New {pinLength}-digit PIN<input name="pin" type="password" inputMode="numeric" autoComplete="new-password" pattern={`\\d{${pinLength}}`} required /></label>
          <label>Confirm PIN<input name="pinConfirm" type="password" inputMode="numeric" autoComplete="new-password" pattern={`\\d{${pinLength}}`} required /></label>
          <button className="primary" disabled={busy}>Set PIN</button>
        </form>
        <p className="onboardingHint">Photo and bulk PIN lists are on <a href="/ops/people/team">Team</a>.</p>
      </article>
    </section>}

    {tab === "paperwork" && <section className="controlCard">
      <h2>Forms</h2>
      {forms.length === 0 ? <p>No forms assigned. <a href="/ops/people/paperwork">Assign the packet on Paperwork</a>.</p> : <table className="peopleTable">
        <thead><tr><th>Form</th><th>Status</th><th>Assigned</th><th>Signed</th></tr></thead>
        <tbody>{forms.map((form) => <tr key={form.id}><td>{form.title}</td><td>{form.status}</td><td>{dateLabel(form.assignedAt)}</td><td>{dateLabel(form.employeeSignedAt)}</td></tr>)}</tbody>
      </table>}
      <div className="peopleFacts">
        {business === "Corner Deli" && <div><span>Handbook</span><strong>{handbook?.acknowledged ? `Signed ${dateLabel(handbook.acknowledgedAt)}` : "Not signed (current version)"}</strong></div>}
        <div><span>Direct deposit</span><strong>{elections.find((row) => row.status === "Completed") ? `Submitted ${dateLabel(elections.find((row) => row.status === "Completed")?.signedAt)}` : elections.length ? "Assigned, not submitted" : "Not assigned"}</strong></div>
      </div>
      <p className="onboardingHint">Review I-9s, open completed forms and bank details on <a href="/ops/people/paperwork">Paperwork</a> and <a href="/ops/people/paperwork/direct-deposit">Direct deposit</a>.</p>
    </section>}

    {tab === "pay" && <section className="peopleGrid">
      <article className="controlCard">
        <h2>Pay rates</h2>
        <form className="peopleAddForm" onSubmit={(event) => { event.preventDefault(); void savePay(event.currentTarget, false); }} key={`${employee.hourlyRate}-${employee.tippedRate}`}>
          <label>Hourly rate<input name="hourlyRate" type="number" min="0" step="0.01" defaultValue={employee.hourlyRate} /></label>
          <label>{business === "Corner Deli" ? "Delivery tipped rate" : "Tipped hourly rate"}<input name="tippedRate" type="number" min="0" step="0.01" defaultValue={employee.tippedRate} /></label>
          <div className="controlActions">
            <button className="primary" disabled={busy}>Save rates</button>
            <button type="button" disabled={busy} onClick={(event) => { const form = event.currentTarget.form; if (form) void savePay(form, true); }}>Save & send NY pay notice</button>
          </div>
        </form>
        <p className="onboardingHint">New York requires a pay notice at hire and when a rate changes. It goes to their forms for signature.</p>
      </article>
      <article className="controlCard">
        <h2>Payroll Relief</h2>
        {business === "Corner Deli"
          ? <p>{payrollStep?.detail || "Loading…"}</p>
          : <p>At the Docks payroll isn't sent to Payroll Relief.</p>}
        <p><a href="/ops/payroll-control">Open Payroll</a> to refresh Payroll Relief&apos;s list and match people (&quot;Who is who in Payroll Relief&quot;). Bank details for direct deposit are on <a href="/ops/people/paperwork/direct-deposit">Direct deposit</a>.</p>
      </article>
    </section>}

    {tab === "schedule" && <section className="controlCard">
      <h2>Schedule & time</h2>
      <p>Shifts, availability and time off for {employee.name.split(" ")[0]} are on the scheduler; punches are on Attendance.</p>
      <div className="peopleLinks">
        <a className="primary" href="/ops/workforce">Open schedule</a>
        <a href="/ops/attendance">Attendance review</a>
      </div>
    </section>}
  </main>;
}
