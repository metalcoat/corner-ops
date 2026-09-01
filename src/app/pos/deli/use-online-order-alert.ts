"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OnlineOrderAlertSound } from "@/lib/ordering-pos-settings";

type AlertOrder = {
  id: string;
  source: string;
  status: string;
  submitted_at: string;
};

const ONLINE_SOURCES = new Set(["web", "online", "customer_web", "kiosk", "ai_phone"]);

type AlertPreference = { sound: OnlineOrderAlertSound; volume: number };

function applicationServerKey(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, character => character.charCodeAt(0)).buffer;
}

function installedOnHomeScreen() {
  return Boolean((navigator as Navigator & { standalone?: boolean }).standalone) || window.matchMedia("(display-mode: standalone)").matches;
}

function posDeviceLabel() {
  const device = /ipad/i.test(navigator.userAgent) ? "iPad" : /iphone/i.test(navigator.userAgent) ? "iPhone" : /android/i.test(navigator.userAgent) ? "Android" : "Browser";
  return `POS/KDS:${device}`;
}

export function useOnlineOrderAlert(authenticated: boolean, initialSound: OnlineOrderAlertSound, initialVolume: number) {
  const initialized = useRef(false);
  const seen = useRef(new Set<string>());
  const audio = useRef<AudioContext | null>(null);
  const preference = useRef<AlertPreference>({ sound: initialSound, volume: initialVolume });
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertNotice, setAlertNotice] = useState("");

  const unlockAudio = useCallback(() => {
    const Context = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audio.current ||= new Context();
    if (audio.current.state === "suspended") void audio.current.resume();
  }, []);

  const ring = useCallback((override?: AlertPreference) => {
    unlockAudio();
    const context = audio.current;
    if (!context || context.state !== "running") return;
    const selected = override || preference.current;
    if (selected.sound === "off") return;
    const start = context.currentTime;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    compressor.connect(context.destination);
    const volume = Math.max(0.1, Math.min(1, selected.volume / 100));

    const tone = (begins: number, duration: number, frequency: number, endFrequency: number, type: OscillatorType, level: number) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const ends = begins + duration;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, begins);
      oscillator.frequency.linearRampToValueAtTime(endFrequency, ends);
      gain.gain.setValueAtTime(0.0001, begins);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level * volume), begins + 0.018);
      gain.gain.setValueAtTime(Math.max(0.0001, level * volume), ends - 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, ends);
      oscillator.connect(gain).connect(compressor);
      oscillator.start(begins);
      oscillator.stop(ends + 0.01);
    };

    if (selected.sound === "kitchen_ring") {
      [0, 0.72].forEach((delay) => {
        tone(start + delay, 0.52, 640, 675, "square", 0.48);
        tone(start + delay, 0.52, 880, 915, "triangle", 0.62);
      });
    } else if (selected.sound === "horn") {
      [0, 0.62].forEach((delay) => {
        tone(start + delay, 0.45, 310, 285, "sawtooth", 0.62);
        tone(start + delay, 0.45, 415, 390, "square", 0.4);
      });
    } else if (selected.sound === "telephone") {
      [0, 0.22, 0.7, 0.92].forEach((delay) => {
        tone(start + delay, 0.17, 440, 440, "square", 0.42);
        tone(start + delay, 0.17, 480, 480, "sine", 0.58);
      });
    } else {
      [0, 0.24, 0.48].forEach((delay, index) => tone(start + delay, 0.2, index === 1 ? 988 : 784, index === 1 ? 988 : 784, "sine", 0.34));
    }
  }, [unlockAudio]);

  useEffect(() => { preference.current = { sound: initialSound, volume: initialVolume }; }, [initialSound, initialVolume]);

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<AlertPreference & { test?: boolean }>).detail;
      if (!detail) return;
      preference.current = { sound: detail.sound, volume: detail.volume };
      if (detail.test) ring(preference.current);
    };
    window.addEventListener("corner-ops-online-order-alert-preference", update);
    return () => window.removeEventListener("corner-ops-online-order-alert-preference", update);
  }, [ring]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [unlockAudio]);

  useEffect(() => {
    if (!authenticated) {
      initialized.current = false;
      seen.current.clear();
      return;
    }
    let stopped = false;
    async function poll() {
      try {
        const response = await fetch("/api/ordering/kitchen?business=Corner%20Deli", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { orders?: AlertOrder[] };
        const online = (payload.orders || []).filter((order) =>
          order.status === "sent_to_kitchen" && ONLINE_SOURCES.has(String(order.source || "").toLowerCase()),
        );
        if (!initialized.current) {
          online.forEach((order) => seen.current.add(order.id));
          initialized.current = true;
          return;
        }
        const fresh = online.filter((order) => !seen.current.has(order.id));
        online.forEach((order) => seen.current.add(order.id));
        if (fresh.length && !stopped) ring();
      } catch {
        // The regular status indicator reports connectivity; alerts retry silently.
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [authenticated, ring]);

  useEffect(() => {
    if (!authenticated || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setAlertsEnabled(false);
      return;
    }
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready).then(registration => registration.pushManager.getSubscription()).then(subscription => setAlertsEnabled(Boolean(subscription && Notification.permission === "granted"))).catch(() => setAlertsEnabled(false));
  }, [authenticated]);

  const enableAlerts = useCallback(async () => {
    setAlertBusy(true);
    setAlertNotice("");
    try {
      unlockAudio();
      if (audio.current?.state === "suspended") await audio.current.resume();
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This device does not support PWA notifications.");
      if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !installedOnHomeScreen()) throw new Error("Add the POS to the Home Screen, open it from its icon, then enable alerts.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted. Allow Corner Deli POS notifications in Apple Settings.");
      const statusResponse = await fetch("/api/push?audience=pos", { cache: "no-store" });
      const status = await statusResponse.json() as { publicKey?: string; error?: string };
      if (!statusResponse.ok || !status.publicKey) throw new Error(status.error || "Notification setup could not be loaded.");
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(status.publicKey) });
      const response = await fetch("/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "subscribe", audience: "pos", subscription: subscription.toJSON(), userAgent: navigator.userAgent, deviceLabel: posDeviceLabel() }) });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || "This POS could not be registered for notifications.");
      setAlertsEnabled(true);
      setAlertNotice("Sound and background order notifications are enabled on this device.");
      ring();
    } catch (error) {
      setAlertsEnabled(false);
      setAlertNotice(error instanceof Error ? error.message : "Alerts could not be enabled.");
    } finally {
      setAlertBusy(false);
    }
  }, [ring, unlockAudio]);

  const testAlerts = useCallback(async () => {
    setAlertNotice("");
    unlockAudio();
    ring();
    try {
      const response = await fetch("/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "test", audience: "pos" }) });
      if (!response.ok) throw new Error("The background test notification could not be sent.");
      setAlertNotice("Foreground sound played and a background notification was sent.");
    } catch (error) {
      setAlertNotice(error instanceof Error ? error.message : "The alert test failed.");
    }
  }, [ring, unlockAudio]);

  return { alertsEnabled, alertBusy, alertNotice, enableAlerts, testAlerts };
}
