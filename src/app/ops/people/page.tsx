"use client";

import { useSiteBrand } from "@/app/brand-context";
import { useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./people.css";
import OnboardingChecklist, { type OnboardingStatus } from "./onboarding-checklist";

const STORAGE_KEY = "corner-ops-business-theme";

export default function PeoplePage() {
  const brand = useSiteBrand();
  const siteBusiness: Business | null = brand.name === "At the Docks" ? "Tiki" : brand.name === "Corner Deli" ? "Corner Deli" : null;
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>(siteBusiness || "Corner Deli");
  const [inProgress, setInProgress] = useState<OnboardingStatus[] | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!siteBusiness) {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "Corner Deli" || saved === "Tiki") setBusiness(saved);
    }

    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView) => {
        setSession(payload);
        const allowed = payload.businesses || [];
        setBusiness((current) => allowed.length && !allowed.includes(current) ? allowed[0] : current);
      })
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, [siteBusiness]);

  function chooseBusiness(next: Business) {
    setBusiness(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.dataset.businessTheme = next;
  }

  const allowedBusinesses = session?.businesses?.length
    ? session.businesses
    : (["Corner Deli", "Tiki"] as Business[]);

  const groups = useMemo(() => [
    {
      eyebrow: "Who works here",
      title: "Team & paperwork",
      description: business === "Corner Deli"
        ? "Add a new hire with just a name and phone; they get one text to set up their account, forms, handbook, direct deposit and the schedule app. Open anyone on Team for their profile, PIN, paperwork and pay."
        : "Add a new hire with just a name and phone; they get one text to set up their account, forms, direct deposit and the schedule app. Open anyone on Team for their profile, PIN, paperwork and pay.",
      links: [
        { label: "Team", href: "/ops/people/team", primary: true },
        { label: "Add employee", href: "/ops/people/add" },
        { label: "Paperwork (forms, I-9 review, direct deposit)", href: "/ops/people/paperwork" },
        ...(business === "Corner Deli" ? [{ label: "Handbook & signatures", href: "/ops/people/handbook" }] : []),
      ],
    },
    {
      eyebrow: "Schedule, time and pay",
      title: "Time & pay",
      description: "Build and publish the schedule, handle requests and time off, review punches, then correct and approve payroll (Payroll Relief matching lives on Payroll).",
      links: [
        { label: "Schedule & requests", href: "/ops/workforce", primary: true },
        { label: "Attendance review", href: "/ops/attendance" },
        { label: "Payroll", href: "/ops/payroll-control" },
        ...(business === "Tiki" ? [{ label: "Tiki employee clock", href: "/clock" }] : []),
      ],
    },
  ], [business]);

  useEffect(() => {
    if (!session?.authenticated) return;
    setInProgress(null);
    fetch(`/api/employee-directory/onboarding?business=${encodeURIComponent(business)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : { inProgress: [] })
      .then((payload: { inProgress: OnboardingStatus[] }) => setInProgress(payload.inProgress || []))
      .catch(() => setInProgress([]));
  }, [business, session?.authenticated, refresh]);

  if (!session) return <main className="controlPage peoplePage">Loading people operations…</main>;
  if (!session.authenticated) return <main className="controlPage peoplePage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage peoplePage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">People</p>
        <h1>{business} team</h1>
        <p>Hire and document people on the left; schedule, time and payroll on the right. The bar above takes you to each page.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills" aria-label="Business">
          {allowedBusinesses.map((name) => <button type="button" key={name} className={business === name ? "active" : ""} onClick={() => chooseBusiness(name)}>{name}</button>)}
        </div>
      </div>
    </header>

    <section className="peopleFlow" aria-label="People workflow">
      <span>1. Add employee</span><i>→</i><span>2. They set up by text</span><i>→</i><span>3. Schedule</span><i>→</i><span>4. Review time</span><i>→</i><span>5. Approve payroll</span>
    </section>

    {inProgress && inProgress.length > 0 && <section className="controlCard peopleOnboarding">
      <p className="eyebrow">New hires in progress</p>
      <div className="onboardingGrid">
        {inProgress.map((status) => <OnboardingChecklist key={status.employeeId} business={business} status={status} onChanged={() => setRefresh((value) => value + 1)} />)}
      </div>
    </section>}

    <section className="peopleGrid">
      {groups.map((group) => <article className="controlCard peopleCard" key={group.title}>
        <div>
          <p className="eyebrow">{group.eyebrow}</p>
          <h2>{group.title}</h2>
          <p>{group.description}</p>
        </div>
        <div className="peopleLinks">
          {group.links.map((link) => <a key={link.href} className={link.primary ? "primary" : ""} href={link.href}>{link.label}</a>)}
        </div>
      </article>)}
    </section>
  </main>;
}
