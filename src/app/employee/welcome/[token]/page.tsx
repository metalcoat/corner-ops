"use client";

import { responseMessage } from "@/app/client-http";
import { useParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { employeePinLength } from "@/lib/employee-pin";
import { STORE_PHONE, TEAM_APP_APK_URL, type OnboardingStep } from "@/lib/employee-onboarding-shared";
import type { Business } from "@/lib/types";
import "../../forms/forms.css";
import "./welcome.css";

type Welcome =
  | { valid: false }
  | { valid: true; business: Business; businessName: string; firstName: string; accountSet: boolean; signedIn: boolean; steps: OnboardingStep[] };

const STEP_LINKS: Record<string, { href: string; label: string }> = {
  forms: { href: "/employee/forms", label: "Open my forms" },
  handbook: { href: "/employee/handbook", label: "Read & sign the handbook" },
  deposit: { href: "/employee/direct-deposit", label: "Set up direct deposit" },
};

export default function EmployeeWelcomePage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<Welcome | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [hubUrl, setHubUrl] = useState("/employee");

  const load = useCallback(async () => {
    const response = await fetch(`/api/employee/onboarding?token=${encodeURIComponent(token)}`, { cache: "no-store" });
    setData(await response.json() as Welcome);
  }, [token]);

  useEffect(() => {
    setHubUrl(`${window.location.origin}/employee`);
    void load().catch(() => setData({ valid: false }));
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>, action: "set-pin" | "sign-in") {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, token, pin: form.get("pin"), pinConfirm: form.get("pinConfirm") }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setData(await response.json() as Welcome);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That didn't work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <main className="employmentFormsShell welcomeShell"><section className="employmentFormsCard"><h1>Loading…</h1></section></main>;
  if (!data.valid) return <main className="employmentFormsShell welcomeShell"><section className="employmentFormsCard">
    <h1>This link has expired</h1>
    <p>Setup links work for one person and expire after a week, and a new text replaces the old link. Ask your manager to resend it, or call Corner Deli at <a href={`tel:${STORE_PHONE}`}>{STORE_PHONE}</a>.</p>
    <p>Already set up? <a href="/employee">Sign in to the Employee Hub</a>.</p>
  </section></main>;

  const pinLength = employeePinLength(data.business);
  const pinInput = (name: string, label: string) => <label>{label}<input name={name} type="password" inputMode="numeric" autoComplete="new-password" pattern={`\\d{${pinLength}}`} minLength={pinLength} maxLength={pinLength} required /></label>;

  return <main className="employmentFormsShell welcomeShell">
    <header className="employmentFormsHero">
      <div>
        <p className="employmentEyebrow">{data.businessName} new-hire setup</p>
        <h1>Welcome, {data.firstName}!</h1>
        <p>Work through the steps below. You can stop and come back to this link any time before it expires.</p>
      </div>
    </header>
    {notice && <div className="employmentNotice" role="alert">{notice}</div>}

    {!data.accountSet && <section className="employmentFormsCard">
      <p className="employmentEyebrow">Step 1</p>
      <h2>Create your employee account</h2>
      <p>Choose a {pinLength}-digit PIN. You&apos;ll use it to sign in to the schedule app, the Employee Hub and the time clock. Don&apos;t share it.</p>
      <form className="welcomeForm" onSubmit={(event) => void submit(event, "set-pin")}>
        {pinInput("pin", "Choose your PIN")}
        {pinInput("pinConfirm", "Type it again")}
        <button className="employmentPrimary" disabled={busy}>{busy ? "Saving…" : "Create my account"}</button>
      </form>
    </section>}

    {data.accountSet && !data.signedIn && <section className="employmentFormsCard">
      <h2>Sign in to continue</h2>
      <p>Your account is set up. Enter your PIN to see what&apos;s left.</p>
      <form className="welcomeForm" onSubmit={(event) => void submit(event, "sign-in")}>
        {pinInput("pin", "Your PIN")}
        <button className="employmentPrimary" disabled={busy}>{busy ? "Signing in…" : "Continue"}</button>
      </form>
      <p><a href="/employee/forgot-pin">Forgot your PIN?</a></p>
    </section>}

    {data.signedIn && <section className="employmentFormsCard">
      <h2>Your checklist</h2>
      <ol className="welcomeSteps">
        {data.steps.map((step) => <li key={step.key} className={`welcomeStep ${step.status}`}>
          <span className="welcomeMark" aria-hidden="true">{step.status === "done" ? "✓" : ""}</span>
          <div>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
            {step.key === "app" && <div className="welcomeApp">
              <a className="employmentPrimary" href={TEAM_APP_APK_URL}>Download the Android app</a>
              <small>iPhone or no Android? Open <a href={hubUrl}>{hubUrl.replace(/^https?:\/\//, "")}</a> in Safari and choose Share → Add to Home Screen. Sign in with your PIN to see your schedule.</small>
            </div>}
            {STEP_LINKS[step.key] && step.status !== "done" && step.status !== "manager" && <a className="employmentPrimary" href={STEP_LINKS[step.key].href}>{STEP_LINKS[step.key].label}</a>}
          </div>
        </li>)}
      </ol>
      <p>When you finish a step, come back to this page or open the <a href="/employee">Employee Hub</a>. Questions? Call <a href={`tel:${STORE_PHONE}`}>{STORE_PHONE}</a>.</p>
    </section>}
  </main>;
}
