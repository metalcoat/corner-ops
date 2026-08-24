"use client";

import { BeforeInstallPromptEvent, isIos, isStandalone } from "@/app/pwa-platform";
import { responseMessage } from "@/app/client-http";
import { useCallback, useEffect, useRef, useState } from "react";

type PushStatus = {
  actorType: "owner" | "employee";
  publicKey: string;
  subscribedDevices: number;
};



function applicationServerKey(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}



function currentAudience(): "owner" | "employee" {
  return window.location.pathname.startsWith("/employee") ? "employee" : "owner";
}

function deviceLabel() {
  if (/iphone/i.test(navigator.userAgent)) return "iPhone";
  if (/ipad/i.test(navigator.userAgent)) return "iPad";
  if (/android/i.test(navigator.userAgent)) return "Android device";
  if (/windows/i.test(navigator.userAgent)) return "Windows device";
  if (/macintosh/i.test(navigator.userAgent)) return "Mac";
  return "Browser device";
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("This browser does not support installed web apps.");
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  return registration;
}

export default function PwaClient() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const syncedIdentity = useRef("");

  const refresh = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    const audience = currentAudience();
    const response = await fetch(`/api/push?audience=${audience}`, { cache: "no-store" }).catch(() => null);
    if (!response) return;
    if (!response.ok) {
      setStatus(null);
      return;
    }
    const value = await response.json() as PushStatus;
    setStatus(value);
    setInstalled(isStandalone());
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const registration = await registerServiceWorker();
    const subscription = await registration.pushManager.getSubscription();
    setSubscribed(Boolean(subscription));
    const identity = subscription ? `${audience}:${subscription.endpoint}` : "";
    if (subscription && syncedIdentity.current !== identity) {
      syncedIdentity.current = identity;
      const syncResponse = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "subscribe",
          audience,
          subscription: subscription.toJSON(),
          userAgent: navigator.userAgent,
          deviceLabel: deviceLabel(),
        }),
      });
      if (!syncResponse.ok) syncedIdentity.current = "";
    }
  }, []);

  useEffect(() => {
    setInstalled(isStandalone());
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
      setNotice("Corner Ops is installed on this device.");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15 * 60_000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  async function installApp() {
    setNotice("");
    if (installed) {
      setNotice("Corner Ops is already installed on this device.");
      return;
    }
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setNotice("Corner Ops is being installed.");
      else setNotice("Installation was dismissed. The browser remains emotionally resilient.");
      setInstallPrompt(null);
      return;
    }
    if (isIos()) {
      setNotice("On iPhone or iPad: tap Share, choose Add to Home Screen, then open Corner Ops from the new icon.");
      return;
    }
    setNotice("Open the browser menu and choose Install app or Add to Home Screen.");
  }

  async function enableNotifications() {
    if (!status) return;
    setBusy(true);
    setNotice("");
    try {
      if (!("Notification" in window) || !("PushManager" in window)) throw new Error("This browser does not support push notifications.");
      if (isIos() && !isStandalone()) {
        throw new Error("On iPhone or iPad, add Corner Ops to the Home Screen and open the installed app before enabling notifications.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted. It can be changed in the phone's site or app settings.");
      const registration = await registerServiceWorker();
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(status.publicKey),
      });
      const audience = currentAudience();
      const response = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "subscribe",
          audience,
          subscription: subscription.toJSON(),
          userAgent: navigator.userAgent,
          deviceLabel: deviceLabel(),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      syncedIdentity.current = `${audience}:${subscription.endpoint}`;
      setSubscribed(true);
      setNotice("Notifications are enabled for this phone. Messages can now arrive while Corner Ops is closed.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Notifications could not be enabled.");
    } finally {
      setBusy(false);
    }
  }

  async function disableNotifications() {
    setBusy(true);
    setNotice("");
    try {
      const registration = await registerServiceWorker();
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "unsubscribe", audience: currentAudience(), endpoint: subscription.endpoint }),
        });
        if (!response.ok) throw new Error(await responseMessage(response));
        await subscription.unsubscribe();
      }
      syncedIdentity.current = "";
      setSubscribed(false);
      setNotice("Notifications are disabled on this device.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Notifications could not be disabled.");
    } finally {
      setBusy(false);
    }
  }

  async function testNotifications() {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", audience: currentAudience() }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as { delivered?: number; attempted?: number };
      setNotice(result.delivered ? "Test notification sent." : `No notification was delivered to the ${result.attempted || 0} registered devices.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The test notification failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return <div className={`pwaControl ${panelOpen ? "open" : ""}`}>
    <button className="pwaControlButton" onClick={() => setPanelOpen((value) => !value)} aria-expanded={panelOpen}>
      <img src="/corner-ops-icon.svg" alt="" />
      <span>{subscribed ? "App notifications on" : "Install app"}</span>
    </button>
    {panelOpen && <section className="pwaPanel" aria-label="Corner Ops app and notifications">
      <header>
        <div><p className="eyebrow">{status.actorType === "owner" ? "Owner app" : "Employee app"}</p><h2>Corner Ops on this phone</h2></div>
        <button className="pwaClose" onClick={() => setPanelOpen(false)} aria-label="Close">×</button>
      </header>
      <div className="pwaStatusGrid">
        <div><span>Installed</span><strong>{installed ? "Yes" : "Not yet"}</strong></div>
        <div><span>This device</span><strong>{subscribed ? "Notifications on" : "Notifications off"}</strong></div>
        <div><span>Registered devices</span><strong>{status.subscribedDevices}</strong></div>
      </div>
      <p>{status.actorType === "owner"
        ? "Install Corner Ops for owner messaging and operational alerts. Tapping a notification opens the relevant management screen."
        : "Install Corner Ops for team messages and employee alerts. Tapping a notification opens your employee portal."}</p>
      <div className="pwaActions">
        {!installed && <button onClick={() => void installApp()} disabled={busy}>Install Corner Ops</button>}
        {!subscribed && <button className="primary" onClick={() => void enableNotifications()} disabled={busy}>Enable notifications</button>}
        {subscribed && <button className="primary" onClick={() => void testNotifications()} disabled={busy}>Send test notification</button>}
        {subscribed && <button onClick={() => void disableNotifications()} disabled={busy}>Disable on this device</button>}
      </div>
      {notice && <div className="pwaNotice">{notice}</div>}
    </section>}
  </div>;
}
