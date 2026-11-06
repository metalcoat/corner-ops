"use client";

import { useEffect, useState } from "react";
import type { OnboardingStep } from "@/lib/employee-onboarding-shared";
import SetupSteps from "./setup-steps";
import "../forms/forms.css";

type Mine = { business: string; firstName: string; onboarding: { steps: OnboardingStep[]; stillToDo: string[] } | null };

/** Signed-in version of the setup link: reminder texts point here once the PIN is chosen. */
export default function EmployeeSetupPage() {
  const [data, setData] = useState<Mine | null | "signed-out">(null);

  useEffect(() => {
    fetch("/api/employee/onboarding?mine=1", { cache: "no-store" })
      .then((response) => response.status === 401 ? "signed-out" as const : response.json())
      .then(setData)
      .catch(() => setData("signed-out"));
  }, []);

  if (!data) return <main className="employmentFormsShell welcomeShell"><section className="employmentFormsCard"><h1>Loading…</h1></section></main>;
  if (data === "signed-out") return <main className="employmentFormsShell welcomeShell"><section className="employmentFormsCard">
    <h1>Sign in to finish your setup</h1>
    <p>Sign in with your PIN, then come back to this page.</p>
    <a className="employmentPrimary" href="/employee?business=Corner%20Deli">Sign in</a>
  </section></main>;

  return <main className="employmentFormsShell welcomeShell">
    <header className="employmentFormsHero"><div><p className="employmentEyebrow">New-hire setup</p><h1>Hi {data.firstName}</h1></div></header>
    <section className="employmentFormsCard">
      {data.onboarding ? <SetupSteps steps={data.onboarding.steps} /> : <p>You don&apos;t have any new-hire steps. <a href="/employee">Back to the Employee Hub</a>.</p>}
    </section>
  </main>;
}
