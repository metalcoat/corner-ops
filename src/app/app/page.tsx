"use client";

import { useEffect, useState } from "react";
import "./app.css";

type SessionState = { authenticated?: boolean };

export default function AppLauncherPage() {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [ownerResponse, employeeResponse] = await Promise.all([
        fetch("/api/auth/session", { cache: "no-store" }).catch(() => null),
        fetch("/api/employee/session", { cache: "no-store" }).catch(() => null),
      ]);
      const owner = ownerResponse?.ok ? await ownerResponse.json().catch(() => null) as SessionState | null : null;
      const employee = employeeResponse?.ok ? await employeeResponse.json().catch(() => null) as SessionState | null : null;
      if (cancelled) return;
      if (owner?.authenticated) {
        window.location.replace("/ops/messages");
        return;
      }
      if (employee?.authenticated) {
        window.location.replace("/employee");
        return;
      }
      setChecking(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return <main className="appLauncher">
    <section className="appLauncherCard">
      <img src="/corner-ops-icon.svg" alt="" />
      <p className="eyebrow">Corner Ops app</p>
      <h1>{checking ? "Opening your workspace…" : "Choose your sign-in"}</h1>
      {checking ? <p>Checking whether this phone belongs to management or an employee. A surprisingly important distinction.</p> : <>
        <p>The same installed app serves the owner and employees. Sign in once and future launches will open the correct workspace automatically.</p>
        <div className="appLauncherActions">
          <a href="/">Owner sign-in</a>
          <a href="/employee">Employee sign-in</a>
        </div>
      </>}
    </section>
  </main>;
}
