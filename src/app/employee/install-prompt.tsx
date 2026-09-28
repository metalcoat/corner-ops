"use client";

import { BeforeInstallPromptEvent, isIos, isStandalone } from "@/app/pwa-platform";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useModalFocus } from "@/app/use-modal-focus";
import "./install-prompt.css";


const DISMISS_KEY = "corner-ops-employee-install-dismissed-at";
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;



export default function EmployeeInstallPrompt() {
  const pathname = usePathname();
  const [authenticated, setAuthenticated] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const shouldShow = visible && pathname !== "/employee/messages";
  const installModalRef = useModalFocus<HTMLDivElement>(shouldShow, () => dismiss());

  useEffect(() => {
    let cancelled = false;
    const checkSession = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch("/api/employee/session", { cache: "no-store" });
        const payload = await response.json() as { session?: unknown };
        if (!cancelled) setAuthenticated(Boolean(payload.session));
      } catch {
        if (!cancelled) setAuthenticated(false);
      }
    };
    const onFocus = () => void checkSession();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkSession();
    };

    void checkSession();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setVisible(false);
      setInstallPrompt(null);
      window.localStorage.removeItem(DISMISS_KEY);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!authenticated || isStandalone()) {
      setVisible(false);
      return;
    }
    const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) || 0);
    if (dismissedAt && Date.now() - dismissedAt < SEVEN_DAYS) return;
    if (installPrompt || isIos()) setVisible(true);
  }, [authenticated, installPrompt]);

  function dismiss() {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setVisible(false);
  }

  async function install() {
    setNotice("");
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setVisible(false);
      window.localStorage.removeItem(DISMISS_KEY);
    } else {
      setNotice("Installation was dismissed. You can install later from the app button.");
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    }
    setInstallPrompt(null);
  }

  if (!shouldShow) return null;

  const ios = isIos();
  return <div ref={installModalRef} tabIndex={-1} className="employeeInstallOverlay" role="dialog" aria-modal="true" aria-labelledby="employee-install-title">
    <section className="employeeInstallCard">
      <img src="/corner-ops-icon.svg" alt="" />
      <div className="employeeInstallCopy">
        <p>Corner Ops Employee App</p>
        <h2 id="employee-install-title">Install this app</h2>
        {ios
          ? <p>Tap the Share button in Safari, choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</p>
          : <p>Add Corner Ops to this device for faster access to schedules, attendance, messages, and notifications.</p>}
        {notice && <div className="employeeInstallNotice">{notice}</div>}
        <div className="employeeInstallActions">
          {!ios && <button className="primary" onClick={() => void install()}>Install now</button>}
          {ios && <button className="primary" onClick={dismiss}>Got it</button>}
          <button onClick={dismiss}>Not now</button>
        </div>
      </div>
    </section>
  </div>;
}
