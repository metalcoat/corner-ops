"use client";

import { FormEvent, useEffect, useState } from "react";
import "./direct-deposit.css";

type Summary = {
  id: string;
  status: "Assigned" | "Completed" | "Superseded";
  assignedAt: string;
  signedAt: string | null;
};
type Detail = Summary & { payload: Record<string, unknown> };
type PageData = { employee: { name: string; business: string; position: string }; elections: Summary[] };

async function message(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export default function DirectDepositPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [choice, setChoice] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);

  async function open(id: string) {
    const response = await fetch(`/api/employee/direct-deposit?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await message(response));
    const payload = await response.json() as { election: Detail };
    setSelected(payload.election);
    const submission = record(payload.election.payload.employeeSubmission);
    setChoice(text(submission.paymentChoice));
  }

  async function load() {
    const response = await fetch("/api/employee/direct-deposit", { cache: "no-store" });
    if (response.status === 401) {
      setUnauthorized(true);
      return;
    }
    if (!response.ok) throw new Error(await message(response));
    const payload = await response.json() as PageData;
    setData(payload);
    const next = payload.elections.find((item) => item.status === "Assigned") || payload.elections[0];
    if (next) await open(next.id);
  }

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !data) return;
    setBusy(true);
    setNotice("");
    try {
      const form = new FormData(event.currentTarget);
      const payload = Object.fromEntries(form.entries()) as Record<string, unknown>;
      payload.directDepositConsent = form.get("directDepositConsent") === "on";
      payload.attest = form.get("attest") === "on";
      const signatureName = String(form.get("signatureName") || "");
      delete payload.signatureName;
      const response = await fetch("/api/employee/direct-deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, signatureName, payload }),
      });
      if (!response.ok) throw new Error(await message(response));
      await load();
      setNotice("Payment-method election signed and saved. A printable copy is available below.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Direct-deposit election failed.");
    } finally {
      setBusy(false);
    }
  }

  if (unauthorized) return <main className="ddShell"><section className="ddCard"><h1>Employee sign-in required</h1><a className="ddPrimary" href="/employee">Open Employee Hub</a></section></main>;
  if (!data) return <main className="ddShell"><section className="ddCard"><h1>Loading direct-deposit form</h1>{notice && <p>{notice}</p>}</section></main>;

  const initial = record(selected?.payload);
  const submission = record(initial.employeeSubmission);
  const employer = record(initial.employer);
  const completed = selected?.status === "Completed";

  return <main className="ddShell">
    <header className="ddHero"><div><p>{data.employee.business} onboarding</p><h1>Direct deposit and payment method</h1><span>{data.employee.name} · {data.employee.position}</span></div><a href="/employee/forms">Employment forms</a></header>
    {notice && <div className="ddNotice">{notice}</div>}

    <section className="ddGrid">
      <aside className="ddCard ddHistory"><h2>Records</h2>{data.elections.map((item) => <button key={item.id} className={selected?.id === item.id ? "active" : ""} onClick={() => void open(item.id)}><strong>{item.status}</strong><span>{new Date(item.assignedAt).toLocaleDateString()}</span></button>)}</aside>
      <section className="ddCard">
        {!selected && <p>No direct-deposit record is available.</p>}
        {selected && <>
          <div className="ddTitle"><div><p>NY LS 15 notice and consent</p><h2>{completed ? "Signed payment election" : "Choose a payment method"}</h2></div><a href="https://dol.ny.gov/LS15-doc" target="_blank" rel="noreferrer">Official NY form</a></div>
          <div className="ddPolicy"><strong>Available options</strong><p>{text(initial.paymentOptions)}</p><p>{text(initial.notice)}</p><p>{text(initial.terms)}</p></div>

          {!completed && <form className="ddForm" onSubmit={submit}>
            <label className="wide">Payment method<select name="paymentChoice" value={choice} onChange={(event) => setChoice(event.target.value)} required><option value="">Choose method</option><option value="direct-deposit">Voluntary direct deposit</option><option value="paper-check">Paper check</option></select></label>
            {choice === "direct-deposit" && <>
              <label className="wide">Account holder name<input name="accountHolderName" defaultValue={data.employee.name} required /></label>
              <label className="wide">Financial institution<input name="financialInstitution" required /></label>
              <label>Routing number<input name="routingNumber" inputMode="numeric" autoComplete="off" maxLength={9} placeholder="9 digits" required /></label>
              <label>Account number<input name="accountNumber" inputMode="numeric" autoComplete="off" maxLength={17} required /></label>
              <label>Account type<select name="accountType" required><option value="">Choose type</option><option value="checking">Checking</option><option value="savings">Savings</option></select></label>
              <label>Deposit allocation<select name="depositAllocation" required><option value="entire-net-pay">Entire net pay</option></select></label>
              <label className="wide check"><input name="directDepositConsent" type="checkbox" required /> I voluntarily authorize direct deposit under the notice and terms above.</label>
            </>}
            {choice === "paper-check" && <div className="wide ddChoice">You are declining direct deposit and electing payment by paper check. No bank information is required.</div>}
            <label className="wide check"><input name="attest" type="checkbox" required /> I received and reviewed the wage-payment notice, made this choice voluntarily, and certify my information is accurate.</label>
            <label className="wide">Electronic signature<input name="signatureName" placeholder={data.employee.name} autoComplete="off" required /></label>
            <small className="wide">Type your name exactly as shown: <strong>{data.employee.name}</strong>.</small>
            <button className="ddPrimary" disabled={busy}>{busy ? "Signing…" : "Sign and submit"}</button>
          </form>}

          {completed && <div className="ddReceipt">
            <div><span>Employer</span><strong>{text(employer.legalName) || data.employee.business}</strong></div>
            <div><span>Payment choice</span><strong>{text(submission.paymentChoice) === "direct-deposit" ? "Direct deposit" : "Paper check"}</strong></div>
            {text(submission.paymentChoice) === "direct-deposit" && <>
              <div><span>Account holder</span><strong>{text(submission.accountHolderName)}</strong></div>
              <div><span>Financial institution</span><strong>{text(submission.financialInstitution)}</strong></div>
              <div><span>Routing number</span><strong>{text(submission.routingNumber)}</strong></div>
              <div><span>Account number</span><strong>{text(submission.accountNumber)}</strong></div>
              <div><span>Account type</span><strong>{text(submission.accountType)}</strong></div>
              <div><span>Allocation</span><strong>{text(submission.depositAllocation)}</strong></div>
            </>}
            <div><span>Signed</span><strong>{selected.signedAt ? new Date(selected.signedAt).toLocaleString() : ""}</strong></div>
            <p className="wide">{text(initial.retention)}</p>
            <button className="ddPrimary wide" type="button" onClick={() => window.print()}>Print or save consent copy</button>
          </div>}
        </>}
      </section>
    </section>
  </main>;
}
