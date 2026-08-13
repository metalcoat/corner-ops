"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import PosClient from "../pos-client";
import type { PosEmployeeSession, PosSessionView } from "../pos-pin-gate";
import "./deli-pos-shell.css";
import "./deli-pos-shell-overrides.css";

const workspaces = [
  { label: "Menu", href: "/pos/deli" },
  { label: "Orders", href: "/pos/deli/orders" },
  { label: "Customers", href: "/pos/deli/customers" },
  { label: "Kitchen", href: "/pos/deli/kitchen" },
  { label: "Settings", href: "/pos/deli/settings" },
] as const;

function activeWorkspace(pathname: string, href: string) {
  return href === "/pos/deli" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export default function DeliPosShell({ children, idleLockSeconds }: { children: ReactNode; idleLockSeconds: number }) {
  const pathname = usePathname();
  const menuActive = pathname === "/pos/deli";
  const [session, setSession] = useState<PosSessionView | null>(null);
  const [openCount, setOpenCount] = useState(0);

  const loadOpenCount = useCallback(async () => {
    const response = await fetch("/api/ordering/order-center?view=open", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { orders?: unknown[] };
    setOpenCount(payload.orders?.length || 0);
  }, []);

  useEffect(() => {
    fetch("/api/pos/session", { cache: "no-store" }).then((response) => response.json()).then((next: PosSessionView) => {
      setSession(next);
      if (next.authenticated) void loadOpenCount();
    }).catch(() => setSession({ authenticated: false }));
    const authenticated = (event: Event) => {
      const employee = (event as CustomEvent<PosEmployeeSession>).detail;
      setSession({ authenticated: true, session: employee });
      void loadOpenCount();
    };
    const locked = () => setSession({ authenticated: false });
    window.addEventListener("corner-ops-pos-authenticated", authenticated);
    window.addEventListener("corner-ops-pos-locked", locked);
    return () => {
      window.removeEventListener("corner-ops-pos-authenticated", authenticated);
      window.removeEventListener("corner-ops-pos-locked", locked);
    };
  }, [loadOpenCount]);

  function lock() {
    window.dispatchEvent(new Event("corner-ops-pos-lock-request"));
    window.dispatchEvent(new Event("corner-ops-pos-locked"));
  }

  return <div className="deliPosShell">
    <header className="deliShellHeader">
      <div className="deliShellIdentity"><span>DEVELOPMENT</span><strong>Corner Deli POS</strong><small>{session?.authenticated ? session.session?.name : "Employee locked"}</small></div>
      <nav aria-label="Corner Deli POS workspaces">
        {workspaces.map((workspace) => {
          const active = activeWorkspace(pathname, workspace.href);
          return <Link key={workspace.href} href={workspace.href} aria-current={active ? "page" : undefined} className={active ? "active" : ""}>
            {workspace.label}{workspace.label === "Orders" && openCount > 0 ? <b aria-label={`${openCount} open orders`}>{openCount}</b> : null}
          </Link>;
        })}
      </nav>
      <button type="button" className="deliShellLock" disabled={!session?.authenticated} onClick={lock}>LOCK / SWITCH EMPLOYEE</button>
    </header>
    <div className="deliShellWorkspace">
      <div className={`deliMenuWorkspace ${menuActive ? "active" : "inactive"}`} aria-hidden={!menuActive}>
        <PosClient business="Corner Deli" idleLockSeconds={idleLockSeconds} embedded />
      </div>
      {!menuActive && <div className="deliRoutedWorkspace">{children}</div>}
    </div>
  </div>;
}
