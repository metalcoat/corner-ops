"use client";

import { useEffect, useState } from "react";
import { applicationServerKey, deviceLabel, isIos, isStandalone, registerServiceWorker } from "@/app/pwa-platform";
import { useSiteBrand } from "@/app/brand-context";

// Asked again after "Not now" a few days later. The key is new so that staff who
// dismissed the older prompt (or set notifications up on the old address) are asked again.
const ASKED_KEY = "corner-ops-employee-notifications-asked-at-v2";
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

type State = "hidden" | "ask" | "blocked";

/** Asks signed-in staff to turn on notifications whenever this phone isn't receiving them. */
export default function EmployeeNotificationPrompt() {
  const brand = useSiteBrand();
  const [state, setState] = useState<State>("hidden");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) return;
      // iPhones can only receive notifications in the installed app; the install prompt covers that first.
      if (isIos() && !isStandalone()) return;
      const session = await fetch("/api/employee/session", { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { session?: unknown } | null;
      if (!session?.session) return;
      if (Notification.permission === "granted") {
        const registration = await navigator.serviceWorker.getRegistration("/");
        if (await registration?.pushManager.getSubscription()) return;
      }
      const askedAt = Number(window.localStorage.getItem(ASKED_KEY) || 0);
      if (askedAt && Date.now() - askedAt < THREE_DAYS) return;
      if (!cancelled) setState(Notification.permission === "denied" ? "blocked" : "ask");
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  function later() {
    window.localStorage.setItem(ASKED_KEY, String(Date.now()));
    setState("hidden");
  }

  async function turnOn() {
    setBusy(true);
    setNotice("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("blocked");
        return;
      }
      const status = await fetch("/api/push?audience=employee", { cache: "no-store" }).then((r) => r.json()) as { publicKey?: string };
      if (!status.publicKey) throw new Error("Notifications aren't set up on the server yet.");
      const registration = await registerServiceWorker();
      const subscription = await registration.pushManager.getSubscription()
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(status.publicKey) });
      const response = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "subscribe", audience: "employee", subscription: subscription.toJSON(), userAgent: navigator.userAgent, deviceLabel: deviceLabel() }),
      });
      if (!response.ok) throw new Error("Notifications couldn't be turned on. Try again in a minute.");
      window.localStorage.removeItem(ASKED_KEY);
      setState("hidden");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Notifications couldn't be turned on.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "hidden") return null;
  return <section style={{ border: "1px solid currentColor", borderRadius: 12, padding: 16, margin: "12px 0" }} aria-labelledby="employee-notifications-title">
    <h2 id="employee-notifications-title" style={{ margin: "0 0 8px" }}>Turn on notifications</h2>
    {state === "ask" ? (
      <p style={{ margin: "0 0 12px" }}>Get schedule changes, shift offers and messages on this phone, even when {brand.name} is closed.</p>
    ) : (
      <p style={{ margin: "0 0 12px" }}>Notifications are blocked for {brand.name} on this phone. Turn them on in your phone&apos;s settings for this app (or this website in your browser&apos;s site settings), then come back.</p>
    )}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {state === "ask" && <button type="button" onClick={() => void turnOn()} disabled={busy}>{busy ? "Turning on…" : "Turn on notifications"}</button>}
      <button type="button" onClick={later} disabled={busy}>Not now</button>
    </div>
    {notice && <p role="alert" style={{ marginBottom: 0 }}>{notice}</p>}
  </section>;
}
