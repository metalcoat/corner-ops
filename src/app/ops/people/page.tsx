"use client";

import { useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./people.css";

const STORAGE_KEY = "corner-ops-business-theme";

export default function PeoplePage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "Corner Deli" || saved === "Tiki") setBusiness(saved);

    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView) => {
        setSession(payload);
        const allowed = payload.businesses || [];
        setBusiness((current) => allowed.length && !allowed.includes(current) ? allowed[0] : current);
      })
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, []);

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
      eyebrow: "Plan and communicate",
      title: "Workforce",
      description: "Build and publish schedules, review time-off and shift requests, and manage day-to-day staffing.",
      links: [
        { label: "Schedule & workforce", href: "/ops/workforce", primary: true },
        { label: "Team messages", href: "/ops/messages" },
        { label: "Employees", href: "/ops/employees" },
      ],
    },
    {
      eyebrow: "Time and exceptions",
      title: "Attendance",
      description: "Review punches, late arrivals, missing clock-outs, source imports, and exceptions before payroll.",
      links: business === "Tiki"
        ? [
            { label: "Attendance review", href: "/ops/attendance", primary: true },
            { label: "Tiki employee clock", href: "/clock" },
          ]
        : [
            { label: "Attendance review", href: "/ops/attendance", primary: true },
            { label: "Rezku delivery monitor", href: "/ops/rezku-monitor" },
          ],
    },
    {
      eyebrow: "Correct, calculate, and approve",
      title: "Payroll control",
      description: "Correct payroll shifts, recalculate hours and tips, allocate exceptions, create versions, and lock the final weekly run in one place.",
      links: [
        { label: "Open payroll control", href: "/ops/payroll-control", primary: true },
        { label: "Employee Hub", href: "/employee" },
      ],
    },
  ], [business]);

  if (!session) return <main className="controlPage peoplePage">Loading people operations…</main>;
  if (!session.authenticated) return <main className="controlPage peoplePage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage peoplePage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">People operations</p>
        <h1>{business} schedule, attendance, and payroll</h1>
        <p>This is the single starting point for employee work. Business-specific tools stay with the business they actually belong to, a concept apparently requiring active enforcement.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills" aria-label="Business">
          {allowedBusinesses.map((name) => <button type="button" key={name} className={business === name ? "active" : ""} onClick={() => chooseBusiness(name)}>{name}</button>)}
        </div>
      </div>
    </header>

    <section className="peopleFlow" aria-label="People workflow">
      <span>1. Schedule</span><i>→</i><span>2. Review time</span><i>→</i><span>3. Correct & recalculate payroll</span>
    </section>

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
