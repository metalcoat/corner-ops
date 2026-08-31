"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import PosClient from "../pos-client";
import type { PosEmployeeSession, PosSessionView } from "../pos-pin-gate";
import "./deli-pos-shell.css";
import "./deli-pos-shell-overrides.css";
import "./deli-safe-area.css";

const centerWorkspaces = [
  { label: "Menu", href: "/pos/deli" },
  { label: "Dashboard", href: "/pos/deli/dashboard" },
  { label: "Customers", href: "/pos/deli/customers" },
  { label: "Kitchen", href: "/pos/deli/kitchen" },
  { label: "Drivers", href: "/pos/deli/drivers" },
  { label: "Payments", href: "/pos/deli/payments" },
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
  const statusControlRef=useRef<HTMLDivElement>(null);
  const [health, setHealth] = useState<{ application: "Online" | "Unavailable" | "Unknown"; database: "Online" | "Unavailable" | "Unknown" }>({ application: "Unknown", database: "Unknown" });
  const [printers,setPrinters]=useState<{kitchenPrinter:string;receiptPrinter:string}>({kitchenPrinter:"Unknown",receiptPrinter:"Unknown"});
  const [androidUpdateUrl, setAndroidUpdateUrl] = useState<string | null>(null);

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
    void (async () => {
      const { Capacitor } = await import("@capacitor/core");
      if (Capacitor.getPlatform() !== "android") return;
      const [{ App }, response] = await Promise.all([
        import("@capacitor/app"),
        fetch("/api/mobile/android/version", { cache: "no-store" }),
      ]);
      if (!response.ok) return;
      const [installed, available] = await Promise.all([
        App.getInfo(),
        response.json() as Promise<{ versionCode?: number; downloadUrl?: string }>,
      ]);
      if (Number(installed.build) < Number(available.versionCode || 0) && available.downloadUrl) setAndroidUpdateUrl(available.downloadUrl);
    })().catch(() => undefined);
  }, []);

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

  useEffect(()=>{
    if(!statusOpen)return;
    const closeOnPointer=(event:PointerEvent)=>{if(!statusControlRef.current?.contains(event.target as Node))setStatusOpen(false)};
    const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==="Escape")setStatusOpen(false)};
    document.addEventListener("pointerdown",closeOnPointer);document.addEventListener("keydown",closeOnEscape);
    return()=>{document.removeEventListener("pointerdown",closeOnPointer);document.removeEventListener("keydown",closeOnEscape)};
  },[statusOpen]);

  function lock() {
    window.dispatchEvent(new Event("corner-ops-pos-lock-request"));
    window.dispatchEvent(new Event("corner-ops-pos-locked"));
  }

  async function logout() {
    await fetch("/api/pos/session", { method: "DELETE" });
    window.dispatchEvent(new Event("corner-ops-pos-locked"));
    window.location.assign("/pos/deli");
  }

  async function showStatus() {
    const opening = !statusOpen;
    setStatusOpen(opening);
    if (!opening) return;
    try {
      const [response,printerResponse] = await Promise.all([fetch("/api/health", { cache: "no-store" }),fetch("/api/ordering/hardware/status",{cache:"no-store"})]);
      const body = await response.json() as { database?: { status?: string } };
      const printerBody=await printerResponse.json() as {kitchenPrinter?:string;receiptPrinter?:string};
      const label=(value?:string)=>value==="online"?"Online":value==="offline"?"Offline":value==="not_configured"?"Not configured":"Unknown";
      setHealth({ application: response.ok ? "Online" : "Unavailable", database: body.database?.status === "ok" ? "Online" : body.database?.status === "error" ? "Unavailable" : "Unknown" });
      setPrinters(printerResponse.ok?{kitchenPrinter:label(printerBody.kitchenPrinter),receiptPrinter:label(printerBody.receiptPrinter)}:{kitchenPrinter:"Unavailable",receiptPrinter:"Unavailable"});
    } catch { setHealth({ application: "Unavailable", database: "Unknown" });setPrinters({kitchenPrinter:"Unavailable",receiptPrinter:"Unavailable"}); }
  }

  function searchProducts() {
    router.push("/pos/deli");
    window.setTimeout(() => window.dispatchEvent(new Event("corner-ops-pos-product-search")), 80);
  }

  return <div className="deliPosShell">
    {androidUpdateUrl ? <a className="deliAndroidUpdate" href={androidUpdateUrl}>ANDROID POS UPDATE AVAILABLE — DOWNLOAD</a> : null}
    <header className="deliShellHeader">
      <div className="deliShellUtilities">
        <button type="button" onClick={() => void logout()}>LOGOUT</button>
        <Link className={activeWorkspace(pathname, "/pos/deli/reports") ? "active" : ""} aria-current={activeWorkspace(pathname, "/pos/deli/reports") ? "page" : undefined} href="/pos/deli/reports">REPORTS</Link>
        <Link className={activeWorkspace(pathname, "/pos/deli/settings") ? "active" : ""} aria-current={activeWorkspace(pathname, "/pos/deli/settings") ? "page" : undefined} href="/pos/deli/settings">SETTINGS</Link>
        <div className="deliStatusControl" ref={statusControlRef}><button type="button" aria-expanded={statusOpen} onClick={() => void showStatus()}>STATUS</button>{statusOpen && <div className="deliStatusPopover" role="status"><strong>System status</strong><dl><div><dt>Application</dt><dd>{health.application}</dd></div><div><dt>Database</dt><dd>{health.database}</dd></div><div><dt>Kitchen printer</dt><dd>{printers.kitchenPrinter}</dd></div><div><dt>Receipt printer</dt><dd>{printers.receiptPrinter}</dd></div><div><dt>Card reader</dt><dd>Not configured</dd></div></dl></div>}</div>
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
