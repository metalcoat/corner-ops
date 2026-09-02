"use client";

import { responseMessage } from "@/app/client-http";
import { FormEvent, useEffect, useState } from "react";
import "./forms.css";

type FormType = "W4" | "IT2104" | "I9" | "PAY_NOTICE" | "MEAL_POLICY";
type FormStatus = "Assigned" | "Employee Signed" | "Employer Review" | "Completed" | "Superseded";
type FormSummary = {
  id: string;
  formType: FormType;
  title: string;
  templateVersion: string;
  status: FormStatus;
  effectiveDate: string | null;
  assignedAt: string;
  employeeSignedAt: string | null;
  employerSignedAt: string | null;
  sourceUrl: string;
};
type FormDetail = FormSummary & { payload: Record<string, unknown> };
type EmployeePayload = { employee: { name: string; business: string; position: string }; forms: FormSummary[] };


function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function dollars(value: unknown): string {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(amount);
}

function dateLabel(value: string | null) {
  return value ? new Date(`${value}T12:00:00`).toLocaleDateString() : "Not specified";
}

export default function EmployeeFormsPage() {
  const [data, setData] = useState<EmployeePayload | null>(null);
  const [selected, setSelected] = useState<FormDetail | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);

  async function load() {
    const response = await fetch("/api/employee/forms", { cache: "no-store" });
    if (response.status === 401) {
      setUnauthorized(true);
      return;
    }
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as EmployeePayload;
    setData(payload);
    const pending = payload.forms.find((form) => form.status === "Assigned");
    if (pending) await openForm(pending.id);
  }

  async function openForm(id: string) {
    setNotice("");
    const response = await fetch(`/api/employee/forms?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as { form: FormDetail };
    setSelected(payload.form);
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
      for (const name of ["multipleJobs", "exempt2026", "attest"]) payload[name] = form.get(name) === "on";
      const signatureName = String(form.get("signatureName") || "");
      delete payload.signatureName;
      const response = await fetch("/api/employee/forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, signatureName, payload }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setSelected(null);
      await load();
      setNotice("Form signed, locked, and submitted.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Form submission failed.");
    } finally {
      setBusy(false);
    }
  }

  if (unauthorized) return <main className="employmentFormsShell"><section className="employmentFormsCard"><h1>Employee sign-in required</h1><p>Sign in through Employee Hub, then return to your employment forms.</p><a className="employmentPrimary" href="/employee">Open Employee Hub</a></section></main>;
  if (!data) return <main className="employmentFormsShell"><section className="employmentFormsCard"><h1>Loading employment forms</h1>{notice && <p>{notice}</p>}</section></main>;

  const initial = asRecord(selected?.payload);
  const employer = asRecord(initial.employer);
  const employee = asRecord(initial.employee);
  const assigned = data.forms.filter((form) => form.status === "Assigned");
  const finished = data.forms.filter((form) => form.status !== "Assigned");

  return <main className="employmentFormsShell">
    <header className="employmentFormsHero">
      <div><p className="employmentEyebrow">{data.employee.business} employee records</p><h1>Employment forms</h1><p>{data.employee.name} · {data.employee.position}</p></div>
      <div><a href="/employee">Employee Hub</a></div>
    </header>
    {notice && <div className="employmentNotice">{notice}</div>}

    <section className="employmentFormsGrid">
      <aside className="employmentFormsCard employmentFormList">
        <p className="employmentEyebrow">Action required</p>
        <h2>Forms to sign</h2>
        {assigned.map((form) => <button key={form.id} className={selected?.id === form.id ? "active" : ""} onClick={() => void openForm(form.id)}>
          <strong>{form.title}</strong><span>{form.templateVersion}</span><small>Effective {dateLabel(form.effectiveDate)}</small>
        </button>)}
        {!assigned.length && <p className="employmentEmpty">No forms are waiting for your signature.</p>}
        <p className="employmentEyebrow employmentHistoryHeading">History</p>
        {finished.map((form) => <button key={form.id} onClick={() => void openForm(form.id)}><strong>{form.title}</strong><span>{form.status}</span><small>{form.employeeSignedAt ? new Date(form.employeeSignedAt).toLocaleString() : "Awaiting signature"}</small></button>)}
      </aside>

      <section className="employmentFormsCard employmentFormWork">
        {!selected && <div className="employmentEmptyState"><h2>Select a form</h2><p>Completed forms remain locked. A replacement or pay-rate change creates a new record rather than rewriting the old one.</p></div>}
        {selected && selected.status !== "Assigned" && <div className="employmentEmptyState"><p className="employmentEyebrow">{selected.status}</p><h2>{selected.title}</h2><p>Signed {selected.employeeSignedAt ? new Date(selected.employeeSignedAt).toLocaleString() : "not yet"}. Sensitive tax and identity fields are not redisplayed in Employee Hub after submission.</p><a href={selected.sourceUrl} target="_blank" rel="noreferrer">Open official blank form and instructions</a></div>}
        {selected?.status === "Assigned" && <form className="employmentForm" onSubmit={submit}>
          <header><div><p className="employmentEyebrow">{selected.templateVersion}</p><h2>{selected.title}</h2><p>Effective {dateLabel(selected.effectiveDate)}</p></div><a href={selected.sourceUrl} target="_blank" rel="noreferrer">Official form</a></header>

          {selected.formType === "W4" && <>
            <div className="employmentSection"><h3>Step 1: Personal information</h3><div className="employmentFieldGrid">
              <label>First name<input name="firstName" defaultValue={text(employee.name).split(/\s+/)[0] || ""} required /></label>
              <label>Middle initial<input name="middleInitial" maxLength={1} /></label>
              <label>Last name<input name="lastName" defaultValue={text(employee.name).split(/\s+/).slice(1).join(" ")} required /></label>
              <label>Social Security number<input name="ssn" inputMode="numeric" autoComplete="off" placeholder="000-00-0000" required /></label>
              <label className="wide">Home address<input name="address" required /></label>
              <label>City<input name="city" required /></label><label>State<input name="state" defaultValue="NY" maxLength={2} required /></label><label>ZIP<input name="zip" required /></label>
              <label className="wide">Federal filing status<select name="filingStatus" required><option value="">Choose status</option><option>Single or Married filing separately</option><option>Married filing jointly or Qualifying surviving spouse</option><option>Head of household</option></select></label>
            </div></div>
            <div className="employmentSection"><h3>Steps 2 through 4</h3><div className="employmentFieldGrid">
              <label className="wide checkbox"><input name="multipleJobs" type="checkbox" /> Complete the multiple-jobs box as directed by the official W-4 instructions</label>
              <label>Dependents and other credits<input name="dependents" type="number" min="0" step="1" defaultValue="0" /></label>
              <label>Other income<input name="otherIncome" type="number" min="0" step="0.01" defaultValue="0" /></label>
              <label>Deductions<input name="deductions" type="number" min="0" step="0.01" defaultValue="0" /></label>
              <label>Extra withholding each pay period<input name="extraWithholding" type="number" min="0" step="0.01" defaultValue="0" /></label>
              <label className="wide checkbox"><input name="exempt2026" type="checkbox" /> I qualify to claim exemption from federal withholding for 2026 under the official instructions</label>
            </div></div>
          </>}

          {selected.formType === "IT2104" && <>
            <div className="employmentSection"><h3>Employee withholding certificate</h3><div className="employmentFieldGrid">
              <label className="wide">Home address<input name="address" required /></label>
              <label>City<input name="city" required /></label><label>State<input name="state" defaultValue="NY" maxLength={2} required /></label><label>ZIP<input name="zip" required /></label>
              <label>Social Security number<input name="ssn" inputMode="numeric" autoComplete="off" placeholder="000-00-0000" required /></label>
              <label>New York State allowances<input name="nysAllowances" type="number" step="1" defaultValue="0" required /></label>
              <label>New York City allowances<input name="nycAllowances" type="number" step="1" defaultValue="0" /></label>
              <label>Additional NYS withholding<input name="additionalNys" type="number" min="0" step="0.01" defaultValue="0" /></label>
              <label>Additional NYC withholding<input name="additionalNyc" type="number" min="0" step="0.01" defaultValue="0" /></label>
              <label>Additional Yonkers withholding<input name="additionalYonkers" type="number" min="0" step="0.01" defaultValue="0" /></label>
            </div></div>
            <div className="employmentCallout">The 2026 worksheet and instructions remain available through the official-form link. Corner Ops records what you submit; it does not give tax advice because apparently payroll was not complicated enough already.</div>
          </>}

          {selected.formType === "I9" && <>
            <div className="employmentSection"><h3>Section 1: Employee information</h3><div className="employmentFieldGrid">
              <label>Last name<input name="lastName" required /></label><label>First name<input name="firstName" required /></label><label>Middle initial<input name="middleInitial" maxLength={1} /></label>
              <label className="wide">Other last names used<input name="otherLastNames" /></label>
              <label className="wide">Address<input name="address" required /></label><label>Apt.<input name="apartment" /></label>
              <label>City<input name="city" required /></label><label>State<input name="state" defaultValue="NY" maxLength={2} required /></label><label>ZIP<input name="zip" required /></label>
              <label>Date of birth<input name="dateOfBirth" type="date" required /></label><label>Social Security number<input name="ssn" inputMode="numeric" autoComplete="off" /></label>
              <label>Email<input name="email" type="email" /></label><label>Telephone<input name="phone" type="tel" /></label>
              <label className="wide">Citizenship or immigration status<select name="citizenshipStatus" required><option value="">Choose status</option><option value="citizen">A citizen of the United States</option><option value="noncitizen-national">A noncitizen national of the United States</option><option value="permanent-resident">A lawful permanent resident</option><option value="authorized-alien">A noncitizen authorized to work</option></select></label>
              <label>Work authorization expiration<input name="workAuthorizationExpires" type="date" /></label><label>USCIS or A-Number<input name="uscisOrAlienNumber" /></label>
              <label>Form I-94 admission number<input name="i94Number" /></label><label>Foreign passport number<input name="foreignPassportNumber" /></label><label>Country of issuance<input name="foreignPassportCountry" /></label>
              <label className="wide">Preparer or translator<select name="preparerTranslator"><option value="none">I did not use a preparer or translator</option><option value="used">A preparer or translator assisted me</option></select></label>
            </div></div>
            <div className="employmentCallout">After you sign Section 1, management must physically or lawfully remotely examine documents you choose from the official acceptable-document lists and complete Section 2. Do not upload identity documents here unless management specifically enables a secure document process.</div>
          </>}

          {selected.formType === "PAY_NOTICE" && <div className="employmentSection"><h3>{text(initial.formVariant)} pay notice</h3><div className="employmentReviewGrid">
            <div><span>Employer</span><strong>{text(employer.legalName)}</strong><small>{text(employer.dba)}</small></div>
            <div><span>Employer address</span><strong>{text(employer.address)}</strong><small>{text(employer.phone)}</small></div>
            <div><span>Position</span><strong>{text(employee.position)}</strong></div>
            <div><span>Regular hourly rate</span><strong>{dollars(initial.regularRate)}</strong></div>
            {initial.secondaryRate !== null && initial.secondaryRate !== undefined && <div><span>Secondary or tipped rate</span><strong>{dollars(initial.secondaryRate)}</strong></div>}
            <div><span>Overtime rate shown</span><strong>{dollars(initial.overtimeRate)}</strong></div>
            <div><span>Tip credit or allowance shown</span><strong>{dollars(initial.tipCreditOrAllowance)}</strong></div>
            <div><span>Pay frequency</span><strong>{text(employer.payFrequency)}</strong><small>Regular payday: {text(employer.payday)}</small></div>
          </div><div className="employmentCallout">I acknowledge receiving this written notice before beginning work at the stated rate or before the stated rate change becomes effective.</div></div>}

          {selected.formType === "MEAL_POLICY" && <div className="employmentSection"><h3>Meal-period acknowledgment</h3><div className="employmentPolicyText">{text(initial.statement)}</div></div>}

          <section className="employmentSignature">
            <label className="checkbox"><input name="attest" type="checkbox" required /> I reviewed this form and certify that the information I entered is true, correct, and complete. I understand this electronic signature is the final entry in my submission.</label>
            <label>Electronic signature<input name="signatureName" autoComplete="off" placeholder={data.employee.name} required /></label>
            <small>Type your name exactly as shown: <strong>{data.employee.name}</strong>. Submission records the date, account, browser, and network address and then locks the form.</small>
            <button className="employmentPrimary" disabled={busy}>{busy ? "Signing…" : "Sign and submit"}</button>
          </section>
        </form>}
      </section>
    </section>
  </main>;
}
