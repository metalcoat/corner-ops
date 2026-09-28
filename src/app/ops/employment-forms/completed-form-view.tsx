"use client";

import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "@/app/use-modal-focus";
import { completedEmploymentSections } from "@/lib/employment-form-display";
import type { EmploymentFormDetail } from "@/lib/employment-forms";
import type { Business } from "@/lib/types";
import "./completed-form-view.css";

export default function CompletedFormView({ id, business, onClose }: {
  id: string;
  business: Business;
  onClose: () => void;
}) {
  const [form, setForm] = useState<EmploymentFormDetail | null>(null);
  const [error, setError] = useState("");
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dialogRef = useModalFocus<HTMLDivElement>(true, onClose);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 15000);
    const hide = () => { setForm(null); closeRef.current(); };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    const privacyTimer = window.setTimeout(hide, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide);
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setForm(null);
    setError("");
    void (async () => {
      try {
        const response = await fetch("/api/employment-forms/completed", {
          method: "POST", cache: "no-store", credentials: "same-origin", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, business }),
        });
        if (!response.ok) throw new Error(response.status === 403
          ? "Your account cannot view full completed forms for this business."
          : response.status === 401 ? "Sign in again to view this completed form."
          : response.status === 409 ? "The employee has not submitted a signed form yet."
          : "The completed form could not be opened securely. Close this window and try again.");
        const result = await response.json() as { form?: EmploymentFormDetail; sensitive?: boolean };
        if (!result.sensitive || result.form?.id !== id || result.form.business !== business || !result.form.payload) {
          throw new Error("The server did not return the requested completed form.");
        }
        if (active) setForm(result.form);
      } catch (failure) {
        if (active) setError(controller.signal.aborted ? "The request timed out. Close this window and try again."
          : failure instanceof Error ? failure.message : "The completed form could not be opened.");
      } finally { window.clearTimeout(deadline); }
    })();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(deadline);
      window.clearTimeout(privacyTimer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", hide);
      document.body.style.overflow = priorOverflow;
    };
  }, [id, business]);

  return <div className="completedEmploymentOverlay">
    <div className="completedEmploymentDialog" ref={dialogRef} role="dialog" aria-modal="true"
      aria-labelledby="completed-form-title" aria-describedby="completed-form-privacy" tabIndex={-1}>
      <header className="completedEmploymentHeader">
        <div><p className="eyebrow">Saved employee submission · payroll entry</p>
          <h2 id="completed-form-title">{form ? `${form.employeeName} · ${form.title}` : "Completed employment form"}</h2>
          {form && <p>{form.business} · {form.templateVersion} · {form.status}</p>}
        </div>
        <button type="button" onClick={() => { setForm(null); onClose(); }}>Hide and close</button>
      </header>
      <p id="completed-form-privacy" className="completedEmploymentPrivacy">Full tax and identity fields are visible for payroll entry. This access is audited. The view closes after five minutes or when this tab is hidden.</p>
      {error && <p role="alert">{error}</p>}
      {!form && !error && <p role="status">Loading the saved signed answers…</p>}
      {form && <>
        <p>This is the employee&apos;s stored signed submission, not the blank official template. Values can be selected for payroll entry; the signed record remains read-only.</p>
        {completedEmploymentSections(form.payload).map((section) => <section key={section.key}>
          <h3>{section.title}</h3>
          <dl className="completedEmploymentFields">{section.fields.map((field) => <div key={field.key}>
            <dt>{field.label}</dt><dd>{field.value}</dd>
          </div>)}</dl>
        </section>)}
        <p className="completedEmploymentRecordId">Record ID: {form.id}</p>
      </>}
    </div>
  </div>;
}
