"use client";

import { responseMessage } from "@/app/client-http";
import { FormEvent, useEffect, useState } from "react";
import { CORNER_DELI_POSITIONS } from "@/lib/business-positions";
import type { Business, SessionView } from "@/lib/types";
import OnboardingChecklist, { TextResult, type OnboardingStatus, type ResendResult } from "../onboarding-checklist";
import "../../control-center.css";
import "../people.css";

type AddResult = {
  employee: { id: string; name: string; phone: string; position: string };
  paperwork: { formsAssigned: number; notes: string[] };
  invite: ResendResult;
};

export default function AddEmployeePage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [added, setAdded] = useState<AddResult | null>(null);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView) => {
        setSession(payload);
        const allowed = payload.businesses || [];
        setBusiness((current) => allowed.length && !allowed.includes(current) ? allowed[0] : current);
      })
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, []);

  async function loadStatus(employeeId: string) {
    const response = await fetch(`/api/employee-directory/onboarding?business=${encodeURIComponent(business)}&employeeId=${encodeURIComponent(employeeId)}`, { cache: "no-store" });
    if (response.ok) setStatus(await response.json() as OnboardingStatus);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setNotice("");
    setAdded(null);
    setStatus(null);
    try {
      const response = await fetch("/api/employee-directory/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business,
          action: "add",
          name: form.get("name"),
          phone: form.get("phone"),
          position: form.get("position") || undefined,
          hourlyRate: form.get("hourlyRate") || undefined,
          tippedRate: form.get("tippedRate") || undefined,
          smsConsent: form.get("smsConsent") === "on",
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as AddResult;
      setAdded(result);
      formElement.reset();
      await loadStatus(result.employee.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The employee could not be added.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="controlPage peoplePage">Loading…</main>;
  if (!session.authenticated) return <main className="controlPage peoplePage"><a href="/signin">Sign in to Corner Ops</a></main>;
  const allowed = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);

  return <main className="controlPage peoplePage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">People · Add employee</p>
        <h1>Add a new hire</h1>
        <p>Enter their name and mobile number. They get one text with a personal link (good for 7 days) to choose their PIN, fill out their new-hire forms{business === "Corner Deli" ? ", sign the handbook" : ""}, set up direct deposit and install the schedule app. You can watch their progress here and on Team.</p>
      </div>
      <div className="controlActions"><div className="businessPills">{allowed.map((name) => <button type="button" key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div></div>
    </header>
    {notice && <div className="noticeBar" role="alert">{notice}</div>}
    <section className="peopleGrid">
      <article className="controlCard">
        <form className="peopleAddForm" onSubmit={submit}>
          <label>Name<input name="name" autoComplete="off" required /></label>
          <label>Mobile phone<input name="phone" type="tel" placeholder="315-555-0123" required /></label>
          <label>Role <small>optional</small>{business === "Corner Deli"
            ? <select name="position" defaultValue=""><option value="">Decide later (Pizza)</option>{CORNER_DELI_POSITIONS.map((position) => <option key={position}>{position}</option>)}</select>
            : <input name="position" placeholder="Bartender" />}</label>
          <label>Regular hourly rate <small>needed for the NY pay notice; at least $16.00 here in 2026. If left blank, send the pay notice later from their Pay tab.</small><input name="hourlyRate" type="number" min="0" step="0.01" placeholder="16.00" /></label>
          {business === "Corner Deli" && <label>Driver (tipped) rate <small>everyone gets both rates, driving or not, so it&apos;s set if they ever drive. Leave blank for $10.70 (2026 NY food service cash wage; + $5.30 tip credit = $16.00). Their pay notice shows both rates, the tip credit, both overtime rates and the overtime-by-job agreement.</small><input name="tippedRate" type="number" min="10.70" step="0.01" placeholder="10.70" /></label>}
          <label className="peopleCheck"><input name="smsConsent" type="checkbox" required /> They agreed to get texts from {business === "Tiki" ? "At the Docks" : "Corner Deli"} at this number.</label>
          <button className="primary" disabled={busy}>{busy ? "Adding…" : "Add employee & text setup link"}</button>
        </form>
      </article>
      <article className="controlCard">
        {!added && <>
          <p className="eyebrow">What happens next</p>
          <ol className="peopleNextSteps">
            <li>They tap the link and choose their own {business === "Corner Deli" ? "4" : "5"}-digit PIN.</li>
            <li>W-4, IT-2104, I-9 and meal policy are already waiting for them{business === "Corner Deli" ? ", plus the handbook to read and sign" : ""}. The NY pay notice goes with them if you entered a rate (otherwise send it from their Pay tab).</li>
            <li>Optional direct deposit, then the schedule app download.</li>
            <li>You review their I-9, add them in Payroll Relief, and match them on Payroll. The checklist shows what's left.</li>
          </ol>
        </>}
        {added && <>
          <p className="eyebrow">Added {added.employee.name}</p>
          {added.paperwork.notes.map((note) => <p key={note} className="onboardingHint">{note}</p>)}
          <TextResult result={added.invite} />
          {status && <OnboardingChecklist business={business} status={status} onChanged={() => void loadStatus(added.employee.id)} />}
        </>}
      </article>
    </section>
  </main>;
}
