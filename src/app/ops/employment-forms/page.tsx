"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./employment-forms.css";

type Employee = { id: string; name: string; position: string; hourlyRate: number; tippedRate: number };
type FormAuditEvent = {
  action: string;
  actor: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};
type FormSummary = {
  id: string;
  employeeId: string;
  employeeName: string;
  formType: "W4" | "IT2104" | "I9" | "PAY_NOTICE" | "MEAL_POLICY";
  title: string;
  templateVersion: string;
  status: "Assigned" | "Employee Signed" | "Employer Review" | "Completed" | "Superseded";
  effectiveDate: string | null;
  assignedAt: string;
  assignedBy: string;
  employeeSignedAt: string | null;
  employerSignedAt: string | null;
  sourceUrl: string;
};
type Profile = {
  legalName: string;
  dba: string;
  ein: string;
  address: string;
  phone: string;
  payFrequency: string;
  payday: string;
  dependentHealthAvailable: boolean;
  dependentHealthEligibility: string;
};
type PageData = { business: Business; employees: Employee[]; forms: FormSummary[]; profile: Profile };
type FormDetail = FormSummary & { payload: Record<string, unknown>; events: FormAuditEvent[] };
type PreviewRow = { label: string; value: string };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function dateLabel(value: string | null) {
  return value ? new Date(`${value}T12:00:00`).toLocaleDateString() : "Not specified";
}

function dateTimeLabel(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formDataObject(form: FormData): Record<string, unknown> {
  return Object.fromEntries(form.entries()) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value ? value as Record<string, unknown> : {};
}

function display(value: unknown): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function friendlyField(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function auditAction(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function assignedPreview(payload: Record<string, unknown>): PreviewRow[] {
  const hidden = new Set(["employeeSubmission", "employeeAttestation", "employerReview", "employerAttestation"]);
  const rows: PreviewRow[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (hidden.has(key)) continue;
    if (Array.isArray(value)) {
      rows.push({ label: friendlyField(key), value: value.map(display).join(", ") || "—" });
      continue;
    }
    if (typeof value === "object" && value) {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof childValue === "object" && childValue !== null) continue;
        rows.push({ label: `${friendlyField(key)} · ${friendlyField(childKey)}`, value: display(childValue) });
      }
      continue;
    }
    rows.push({ label: friendlyField(key), value: display(value) });
  }
  return rows;
}

export default function EmploymentFormsPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<PageData | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<FormDetail | null>(null);
  const [rateEmployeeId, setRateEmployeeId] = useState("");
  const [rateHourly, setRateHourly] = useState("0");
  const [rateTipped, setRateTipped] = useState("0");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView) => {
        setSession(payload);
        const allowed = payload.businesses || [];
        if (allowed.length && !allowed.includes(business)) setBusiness(allowed[0]);
      })
      .catch(() => setSession({ authenticated: false } as SessionView));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/employment-forms?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as PageData;
    setData(payload);
    if (!rateEmployeeId && payload.employees[0]) chooseRateEmployee(payload.employees[0].id, payload.employees);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setReview(null);
    setNotice("");
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  function chooseRateEmployee(id: string, employees = data?.employees || []) {
    setRateEmployeeId(id);
    const employee = employees.find((item) => item.id === id);
    if (employee) {
      setRateHourly(employee.hourlyRate.toFixed(2));
      setRateTipped(employee.tippedRate.toFixed(2));
    }
  }

  async function action(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employment-forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, business }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setReview(null);
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Employment form update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action({ action: "save-profile", ...formDataObject(form), dependentHealthAvailable: form.get("dependentHealthAvailable") === "on" }, "Employer form profile saved.");
  }

  async function assignPacket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await action({ action: "assign-packet", ...formDataObject(form) }, "Five-form onboarding packet assigned in Employee Hub.");
    formElement.reset();
  }

  async function createRateChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await action({ action: "rate-change", ...formDataObject(form), hourlyRate: Number(form.get("hourlyRate")), tippedRate: Number(form.get("tippedRate") || 0) }, "Pay-rate change notice assigned for employee signature.");
    formElement.reset();
  }

  async function openReview(id: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/employment-forms?business=${encodeURIComponent(business)}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { form: FormDetail };
      setReview(payload.form);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The employment form could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  async function unassignForm(form: FormSummary) {
    const reason = window.prompt(
      `Unassign ${form.title} from ${form.employeeName}?\n\nThe record will remain in the audit history as Superseded. Enter a reason:`,
      "Assigned in error.",
    );
    if (reason === null) return;
    await action(
      { action: "unassign", id: form.id, reason },
      `${form.title} was unassigned from ${form.employeeName}. The audit history was preserved.`,
    );
  }

  async function completeI9(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review) return;
    const form = new FormData(event.currentTarget);
    const payload = formDataObject(form);
    const signatureName = String(form.get("signatureName") || "");
    delete payload.signatureName;
    payload.alternativeProcedureUsed = form.get("alternativeProcedureUsed") === "on";
    await action({ action: "complete-i9", id: review.id, signatureName, payload }, "I-9 Section 2 completed and locked.");
  }

  const allowedBusinesses = session?.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);
  const pending = useMemo(() => data?.forms.filter((form) => form.status !== "Completed" && form.status !== "Superseded") || [], [data?.forms]);
  const completed = useMemo(() => data?.forms.filter((form) => form.status === "Completed") || [], [data?.forms]);
  const employeeSubmission = asRecord(review?.payload.employeeSubmission);
  const assignedDetails = useMemo(() => review ? assignedPreview(review.payload) : [], [review]);

  if (!session) return <main className="controlPage">Loading employment forms…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage employmentAdminPage">
    <header className="controlHeader"><div><p className="eyebrow">Onboarding, tax, identity, and wage records</p><h1>{business} employment forms</h1><p>Assign official-form versions, collect employee signatures, issue pay-rate changes, and preserve an immutable audit history.</p></div><div className="controlActions"><div className="businessPills">{allowedBusinesses.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div><a href="/employee/forms">Employee view</a></div></header>
    {notice && <div className="noticeBar">{notice}</div>}
    {!data && <section className="controlCard">Loading records…</section>}
    {data && <>
      <section className="employmentAdminStats"><article><span>Active employees</span><strong>{data.employees.length}</strong></article><article><span>Action required</span><strong>{pending.length}</strong></article><article><span>Completed records</span><strong>{completed.length}</strong></article><article><span>I-9 employer reviews</span><strong>{data.forms.filter((form) => form.status === "Employer Review").length}</strong></article></section>

      <section className="employmentAdminGrid">
        <article className="controlCard"><p className="eyebrow">Business identity</p><h2>Employer form profile</h2><p className="employmentHelp">Used to prefill W-4/IT-2104 employer details and New York pay notices. This is business information, not the employee&apos;s private submission.</p><form className="employmentAdminForm" onSubmit={saveProfile} key={`${business}-${JSON.stringify(data.profile)}`}>
          <label>Legal employer name<input name="legalName" defaultValue={data.profile.legalName} required /></label>
          <label>DBA or operating name<input name="dba" defaultValue={data.profile.dba} required /></label>
          <label>Federal EIN<input name="ein" defaultValue={data.profile.ein} placeholder="00-0000000" required /></label>
          <label className="wide">Principal address<input name="address" defaultValue={data.profile.address} required /></label>
          <label>Employer phone<input name="phone" defaultValue={data.profile.phone} required /></label>
          <label>Pay frequency<select name="payFrequency" defaultValue={data.profile.payFrequency || "Weekly"}><option>Weekly</option><option>Biweekly</option><option>Semimonthly</option></select></label>
          <label>Regular payday<input name="payday" defaultValue={data.profile.payday} placeholder="Friday" required /></label>
          <label className="wide checkbox"><input name="dependentHealthAvailable" type="checkbox" defaultChecked={data.profile.dependentHealthAvailable} /> Dependent health insurance is available</label>
          <label className="wide">Eligibility date or rule<input name="dependentHealthEligibility" defaultValue={data.profile.dependentHealthEligibility} placeholder="Not available, or eligible after 90 days" /></label>
          <button disabled={busy}>Save employer profile</button>
        </form></article>

        <article className="controlCard"><p className="eyebrow">New employee</p><h2>Assign onboarding packet</h2><p className="employmentHelp">Creates separate W-4, IT-2104, I-9, New York pay notice, and meal-policy records.</p><form className="employmentAdminForm" onSubmit={assignPacket}>
          <label className="wide">Employee<select name="employeeId" required><option value="">Choose employee</option>{data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.position}</option>)}</select></label>
          <label>First day of employment<input name="hireDate" type="date" required /></label>
          <label>Employer electronic signature<input name="employerSignature" placeholder={session.displayName || "Employer representative"} required /></label>
          <button disabled={busy}>Assign five-form packet</button>
        </form></article>

        <article className="controlCard"><p className="eyebrow">Hospitality rate change</p><h2>Issue a new pay notice</h2><p className="employmentHelp">Creates a new LS 54 or LS 55 record. The prior signed notice remains intact.</p><form className="employmentAdminForm" onSubmit={createRateChange}>
          <label className="wide">Employee<select name="employeeId" value={rateEmployeeId} onChange={(event) => chooseRateEmployee(event.target.value)} required><option value="">Choose employee</option>{data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · current ${employee.hourlyRate.toFixed(2)} / ${employee.tippedRate.toFixed(2)}</option>)}</select></label>
          <label>Effective date<input name="effectiveDate" type="date" required /></label>
          <label>Regular hourly rate<input name="hourlyRate" type="number" min="0" step="0.01" value={rateHourly} onChange={(event) => setRateHourly(event.target.value)} required /></label>
          <label>Secondary or tipped rate<input name="tippedRate" type="number" min="0" step="0.01" value={rateTipped} onChange={(event) => setRateTipped(event.target.value)} /></label>
          <label>Employer electronic signature<input name="employerSignature" placeholder={session.displayName || "Employer representative"} required /></label>
          <button disabled={busy}>Assign rate-change notice</button>
        </form></article>
      </section>

      <section className="controlCard employmentRecords"><div className="employmentRecordsHeader"><div><p className="eyebrow">Signature and review queue</p><h2>Employment form records</h2></div><span>{data.forms.length} total</span></div><div className="tableWrap"><table><thead><tr><th>Employee</th><th>Form</th><th>Version</th><th>Effective</th><th>Status</th><th>Assigned</th><th>Action</th></tr></thead><tbody>{data.forms.map((form) => <tr key={form.id}><td>{form.employeeName}</td><td>{form.title}</td><td>{form.templateVersion}</td><td>{dateLabel(form.effectiveDate)}</td><td><span className={`employmentStatus ${form.status.replace(/\s+/g, "").toLowerCase()}`}>{form.status}</span></td><td><strong>{dateTimeLabel(form.assignedAt)}</strong><small>by {form.assignedBy || "Unknown account"}</small></td><td><div className="employmentRowActions"><button disabled={busy} onClick={() => void openReview(form.id)}>{form.status === "Employer Review" ? "Complete I-9" : "Review"}</button>{form.status === "Assigned" && <button className="employmentUnassign" disabled={busy} onClick={() => void unassignForm(form)}>Unassign</button>}</div></td></tr>)}{!data.forms.length && <tr><td colSpan={7}>No employment forms assigned yet.</td></tr>}</tbody></table></div></section>

      {review && <section className="controlCard employmentReview"><div className="employmentRecordsHeader"><div><p className="eyebrow">Secure record</p><h2>{review.employeeName} · {review.title}</h2><p>{review.status} · {review.templateVersion}</p></div><div className="employmentRowActions"><a href={review.sourceUrl} target="_blank" rel="noreferrer">Official form</a><button onClick={() => setReview(null)}>Close</button></div></div>
        <section className="employmentAuditSummary"><div><span>Assigned by</span><strong>{review.assignedBy || "Unknown account"}</strong></div><div><span>Assigned at</span><strong>{dateTimeLabel(review.assignedAt)}</strong></div><div><span>Current status</span><strong>{review.status}</strong></div>{review.status === "Assigned" && <button className="employmentUnassign" disabled={busy} onClick={() => void unassignForm(review)}>Unassign this form</button>}</section>

        <section>
          <p className="eyebrow">Assigned form details</p>
          <div className="employmentSubmissionGrid">{assignedDetails.map((entry) => <div key={entry.label}><span>{entry.label}</span><strong>{entry.value}</strong></div>)}{!assignedDetails.length && <p>No assignment details were stored for this form.</p>}</div>
        </section>

        <section>
          <p className="eyebrow">Employee submission</p>
          {review.status === "Assigned" && <p className="employmentHelp">The employee has not submitted this form yet. The assigned details above are available now; employee-entered answers will appear here after the employee signs and submits it.</p>}
          <div className="employmentSubmissionGrid">{Object.entries(employeeSubmission).map(([key, value]) => <div key={key}><span>{friendlyField(key)}</span><strong>{key.toLowerCase().includes("ssn") ? "Stored securely" : display(value)}</strong></div>)}{!Object.keys(employeeSubmission).length && review.status !== "Assigned" && <p>No employee submission is available yet.</p>}</div>
        </section>

        <section className="employmentAuditTrail"><p className="eyebrow">Audit trail</p>{review.events?.length ? review.events.map((entry, index) => <article key={`${entry.createdAt}-${entry.action}-${index}`}><div><strong>{auditAction(entry.action)}</strong><span>{dateTimeLabel(entry.createdAt)}</span></div><p>{entry.actor}</p>{entry.metadata.reason ? <small>{String(entry.metadata.reason)}</small> : null}</article>) : <p>No audit events were recorded.</p>}</section>
        {review.formType === "I9" && review.status === "Employer Review" && <form className="employmentAdminForm employmentI9Form" onSubmit={completeI9}>
          <div className="wide employmentWarning">Examine documents selected by the employee. Do not demand a particular List A, B, or C document. Record either one acceptable List A document or an acceptable List B plus List C combination.</div>
          <label>Document method<select name="documentMethod" required><option value="">Choose method</option><option value="List A">List A</option><option value="List B and C">List B and List C</option><option value="Acceptable receipt">Acceptable receipt</option></select></label>
          <label>First day of employment<input name="firstDayOfEmployment" type="date" defaultValue={review.effectiveDate || ""} required /></label>
          <label>List A document title<input name="listATitle" /></label><label>Issuing authority<input name="listAIssuer" /></label><label>Document number<input name="listANumber" /></label><label>Expiration date<input name="listAExpiration" type="date" /></label>
          <label>List B document title<input name="listBTitle" /></label><label>Issuing authority<input name="listBIssuer" /></label><label>Document number<input name="listBNumber" /></label><label>Expiration date<input name="listBExpiration" type="date" /></label>
          <label>List C document title<input name="listCTitle" /></label><label>Issuing authority<input name="listCIssuer" /></label><label>Document number<input name="listCNumber" /></label><label>Expiration date<input name="listCExpiration" type="date" /></label>
          <label className="wide">Additional information<textarea name="additionalInformation" rows={3} /></label>
          <label className="wide checkbox"><input name="alternativeProcedureUsed" type="checkbox" /> DHS-authorized alternative document examination procedure used</label>
          <label>Employer representative title<input name="employerTitle" required /></label><label>Employer electronic signature<input name="signatureName" required /></label>
          <button disabled={busy}>Complete and lock Section 2</button>
        </form>}
      </section>}
    </>}
  </main>;
}
