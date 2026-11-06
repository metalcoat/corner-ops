"use client";

import { responseMessage } from "@/app/client-http";
import { useState } from "react";
import type { OnboardingStep } from "@/lib/employee-onboarding-shared";
import type { Business } from "@/lib/types";
import "./onboarding.css";

export type OnboardingStatus = {
  employeeId: string;
  name: string;
  hasInvite: boolean;
  linkExpiresAt: string | null;
  textStatus: string;
  textDetail: string;
  complete: boolean;
  canSchedule: boolean;
  stillToDo: string[];
  reminders: { sent: number; last: string | null; status: string };
  steps: OnboardingStep[];
};

export type ResendResult = { status: string; detail: string; expiresAt: string; devLink: string | null; text: string };

const MARK: Record<OnboardingStep["status"], string> = { done: "✓", waiting: "…", locked: "🔒", manager: "!", optional: "–" };

/** Result line after a setup text goes out (or is only logged on dev). */
export function TextResult({ result }: { result: ResendResult }) {
  return <div className="onboardingTextResult">
    <strong>{result.status === "sent" ? "Setup text sent." : result.status === "logged" ? "Dev mode: text logged, not sent." : `Text not sent: ${result.detail}`}</strong>
    <pre>{result.text}</pre>
    {result.devLink && <p>Test link (dev only): <a href={result.devLink} target="_blank" rel="noreferrer">{result.devLink}</a></p>}
  </div>;
}

export default function OnboardingChecklist({ business, status, onChanged, title }: {
  business: Business;
  status: OnboardingStatus;
  onChanged?: () => void;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResendResult | null>(null);
  const [error, setError] = useState("");

  async function resend() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/employee-directory/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business, action: "resend", employeeId: status.employeeId }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setResult(await response.json() as ResendResult);
      onChanged?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The text could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  const accountSet = status.steps.find((step) => step.key === "account")?.status === "done";
  return <article className="onboardingCard">
    <header>
      <div>
        <h3>{title || <a href={`/ops/people/team/${status.employeeId}`}>{status.name}</a>}</h3>
        <small>{status.complete ? "Onboarding complete" : status.linkExpiresAt ? `Link expires ${status.linkExpiresAt}` : "No setup link yet"}</small>
      </div>
      <button type="button" disabled={busy} onClick={() => void resend()}>{busy ? "Sending…" : status.hasInvite ? "Resend text" : "Send setup text"}</button>
    </header>
    <p className="onboardingHint">
      {status.canSchedule ? "Their own steps are done; they can be scheduled." : `Can't be scheduled yet. They still need: ${status.stillToDo.join(", ")}.`}
      {" "}{status.reminders.sent ? `Daily reminder texts: ${status.reminders.sent} of 7 sent, last ${status.reminders.last}${status.reminders.status === "logged" ? " (dev: logged)" : status.reminders.status === "failed" ? " (failed)" : ""}.` : "Daily reminder texts start the day after the setup text (10 AM–7 PM)."}
    </p>
    {accountSet && <p className="onboardingHint">They already chose a PIN. A new link lets them get back to their checklist; it doesn&apos;t change their PIN.</p>}
    <ol className="onboardingSteps">
      {status.steps.map((step) => <li key={step.key} className={step.status}>
        <span aria-label={step.status}>{MARK[step.status]}</span>
        <div><strong>{step.label}</strong><small>{step.detail}</small></div>
      </li>)}
    </ol>
    {error && <p className="onboardingError" role="alert">{error}</p>}
    {result && <TextResult result={result} />}
  </article>;
}
