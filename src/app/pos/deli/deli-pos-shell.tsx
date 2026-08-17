"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import PosClient from "../pos-client";
import type { PosEmployeeSession, PosSessionView } from "../pos-pin-gate";
import "./deli-pos-shell.css";
import "./deli-pos-shell-overrides.css";

const centerWorkspaces = [
  { label: "Menu", href: "/pos/deli" },
  { label: "Customers", href: "/pos/deli/customers" },
  { label: "Kitchen", href: "/pos/deli/kitchen" },
] as const;

function activeWorkspace(pathname: string, href: string) {
  return href === "/pos/deli" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export default function DeliPosShell({ children, idleLockSeconds }: { children: ReactNode; idleLockSeconds: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const menuActive = pathname === "/pos/deli";
  const [session, setSession] = useState<PosSessionView | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [statusOpen, setStatusOpen] = useState(false);
  const [health, setHealth] = useState<{ application: "Online" | "Unavailable" | "Unknown"; database: "Online" | "Unavailable" | "Unknown" }>({ application: "Unknown", database: "Unknown" });

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

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const target = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].pathname : args[0].url;
      const protectedConfiguration = target.startsWith("/api/ordering/settings/") || target.startsWith("/api/ordering/reports") || target.startsWith("/api/ordering/barcodes") || target.startsWith("/api/ordering/gift-cards/report");
      if (protectedConfiguration && (response.status === 401 || response.status === 403)) {
        if (response.status === 401) window.dispatchEvent(new Event("corner-ops-pos-locked"));
        window.setTimeout(() => router.refresh(), 0);
      }
      return response;
    };
    return () => { window.fetch = originalFetch; };
  }, [router]);

  function lock() {
    window.dispatchEvent(new Event("corner-ops-pos-lock-request"));
    window.dispatchEvent(new Event("corner-ops-pos-locked"));
  }

  async function logout() {
    await fetch("/api/pos/session", { method: "DELETE" });
    window.dispatchEvent(new Event("corner-ops-pos-locked"));
  }

  async function showStatus() {
    const opening = !statusOpen;
    setStatusOpen(opening);
    if (!opening) return;
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const body = await response.json() as { database?: { status?: string } };
      setHealth({ application: response.ok ? "Online" : "Unavailable", database: body.database?.status === "ok" ? "Online" : body.database?.status === "error" ? "Unavailable" : "Unknown" });
    } catch { setHealth({ application: "Unavailable", database: "Unknown" }); }
  }

  function searchProducts() {
    router.push("/pos/deli");
    window.setTimeout(() => window.dispatchEvent(new Event("corner-ops-pos-product-search")), 80);
  }

  return <div className="deliPosShell">
    <header className="deliShellHeader">
      <div className="deliShellUtilities">
        <button type="button" onClick={() => void logout()}>LOGOUT</button>
        <Link className={activeWorkspace(pathname, "/pos/deli/reports") ? "active" : ""} aria-current={activeWorkspace(pathname, "/pos/deli/reports") ? "page" : undefined} href="/pos/deli/reports">REPORTS</Link>
        <Link className={activeWorkspace(pathname, "/pos/deli/settings") ? "active" : ""} aria-current={activeWorkspace(pathname, "/pos/deli/settings") ? "page" : undefined} href="/pos/deli/settings">SETTINGS</Link>
        <div className="deliStatusControl"><button type="button" aria-expanded={statusOpen} onClick={() => void showStatus()}>STATUS</button>{statusOpen && <div className="deliStatusPopover" role="status"><strong>System status</strong><dl><div><dt>Application</dt><dd>{health.application}</dd></div><div><dt>Database</dt><dd>{health.database}</dd></div><div><dt>Kitchen printer</dt><dd>Not configured</dd></div><div><dt>Receipt printer</dt><dd>Not configured</dd></div><div><dt>Card reader</dt><dd>Not configured</dd></div></dl></div>}</div>
      </div>
      <div className="deliShellIdentity"><span>DEV</span><strong>Corner Deli POS</strong><small>{session?.authenticated ? session.session?.name : "Employee locked"}</small><button type="button" disabled={!session?.authenticated} onClick={lock}>LOCK / SWITCH EMPLOYEE</button></div>
      <nav className="deliWorkspaceNav" aria-label="Corner Deli POS workspaces">
        {centerWorkspaces.map((workspace) => { const active = activeWorkspace(pathname, workspace.href); return <Link key={workspace.href} href={workspace.href} aria-current={active ? "page" : undefined} className={active ? "active" : ""}>{workspace.label}</Link>; })}
      </nav>
      <div className="deliShellActions">
        <button type="button" onClick={searchProducts}>SEARCH</button>
        <Link href="/pos/deli/orders" aria-current={activeWorkspace(pathname, "/pos/deli/orders") ? "page" : undefined} className={`orders ${activeWorkspace(pathname, "/pos/deli/orders") ? "active" : ""}`}>ORDERS{openCount > 0 && <b aria-label={`${openCount} open orders`}>{openCount}</b>}</Link>
      </div>
    </header>
    <div className="deliShellWorkspace">
      <div className={`deliMenuWorkspace ${menuActive ? "active" : "inactive"}`} aria-hidden={!menuActive}><PosClient business="Corner Deli" idleLockSeconds={idleLockSeconds} embedded /></div>
      {!menuActive && <div className="deliRoutedWorkspace">{children}</div>}
    </div>
  </div>;
}
