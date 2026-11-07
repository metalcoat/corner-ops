"use client";

import { useEffect, useState } from "react";
import { STORE_PHONE, TEAM_APP_APK_URL, type OnboardingStep } from "@/lib/employee-onboarding-shared";
import "./setup.css";

const STEP_LINKS: Record<string, { href: string; label: string }> = {
  forms: { href: "/employee/forms", label: "Open my forms" },
  handbook: { href: "/employee/handbook", label: "Read & sign the handbook" },
  deposit: { href: "/employee/direct-deposit", label: "Set up direct deposit" },
};

/** The new hire's checklist, top to bottom; only the next step (and optional ones) can be opened. */
export default function SetupSteps({ steps }: { steps: OnboardingStep[] }) {
  const [hubUrl, setHubUrl] = useState("/employee");
  useEffect(() => setHubUrl(`${window.location.origin}/employee`), []);
  const remaining = steps.filter((step) => step.status !== "done" && step.status !== "optional");

  return <>
    {remaining.length > 0
      ? <p className="setupWarning"><strong>Not finished yet.</strong> Still to do: {remaining.map((step) => step.label).join(", ")}. We can&apos;t put you on the schedule until everything is complete.</p>
      : <p className="setupDone"><strong>You&apos;re all set.</strong> Your manager can now put you on the schedule.</p>}
    <ol className="welcomeSteps">
      {steps.map((step, index) => <li key={step.key} className={`welcomeStep ${step.status}`}>
        <span className="welcomeMark" aria-hidden="true">{step.status === "done" ? "✓" : step.status === "locked" ? "🔒" : index + 1}</span>
        <div>
          <strong>{step.label}</strong>
          <small>{step.detail}</small>
          {step.key === "app" && step.status !== "locked" && <div className="welcomeApp">
            <a className="employmentPrimary" href={TEAM_APP_APK_URL}>Download the Android app</a>
            <small>iPhone or no Android? Open <a href={hubUrl}>{hubUrl.replace(/^https?:\/\//, "")}</a> in Safari and choose Share → Add to Home Screen. Sign in with your PIN to see your schedule.</small>
          </div>}
          {STEP_LINKS[step.key] && (step.status === "waiting" || step.status === "optional") && <a className="employmentPrimary" href={STEP_LINKS[step.key].href}>{STEP_LINKS[step.key].label}</a>}
        </div>
      </li>)}
    </ol>
    <p>When you finish a step, come back here: <a href="/employee/setup">{hubUrl.replace(/^https?:\/\//, "").replace(/\/employee$/, "")}/employee/setup</a>. Questions? Call <a href={`tel:${STORE_PHONE}`}>{STORE_PHONE}</a>.</p>
  </>;
}
