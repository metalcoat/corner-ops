"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OnlineOrderAlertSound } from "@/lib/ordering-pos-settings";
import {
  createOnlineAlertState,
  reconcileOnlineAlerts,
  singleFlight,
} from "@/lib/pos-offline-sync-policy";

type AlertOrder = { id: string };

/** Unacknowledged new online orders re-chime on this interval. */
const REPEAT_ALERT_MS = 20_000;

type AlertPreference = { sound: OnlineOrderAlertSound; volume: number };

function applicationServerKey(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
    .buffer;
}

function installedOnHomeScreen() {
  return (
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone) ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

function posDeviceLabel() {
  const device = /ipad/i.test(navigator.userAgent)
    ? "iPad"
    : /iphone/i.test(navigator.userAgent)
      ? "iPhone"
      : /android/i.test(navigator.userAgent)
        ? "Android"
        : "Browser";
  return `POS/KDS:${device}`;
}

export function useOnlineOrderAlert(
  authenticated: boolean,
  initialSound: OnlineOrderAlertSound,
  initialVolume: number,
) {
  const alertState = useRef(createOnlineAlertState());
  // Whether the chime has actually been heard since the newest pending order arrived.
  const heard = useRef(false);
  const audio = useRef<AudioContext | null>(null);
  const preference = useRef<AlertPreference>({
    sound: initialSound,
    volume: initialVolume,
  });
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertNotice, setAlertNotice] = useState("");
  const [pendingOnlineOrders, setPendingOnlineOrders] = useState(0);
  const [soundBlocked, setSoundBlocked] = useState(false);

  const refreshSoundBlocked = useCallback(() => {
    setSoundBlocked(
      preference.current.sound !== "off" &&
        audio.current?.state !== "running",
    );
  }, []);

  const unlockAudio = useCallback(() => {
    const Context =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Context) return Promise.resolve();
    if (!audio.current) {
      audio.current = new Context();
      // iPads suspend audio again after backgrounding; keep the visible prompt in sync.
      audio.current.addEventListener("statechange", refreshSoundBlocked);
    }
    const resumed =
      audio.current.state === "running"
        ? Promise.resolve()
        : audio.current.resume().catch(() => undefined);
    refreshSoundBlocked();
    return resumed.then(refreshSoundBlocked);
  }, [refreshSoundBlocked]);

  /** Returns true when the chime actually played (or sound is intentionally off). */
  const ring = useCallback(
    (override?: AlertPreference): boolean => {
      void unlockAudio();
      const selected = override || preference.current;
      if (selected.sound === "off") return true;
      const context = audio.current;
      if (!context || context.state !== "running") return false;
      const start = context.currentTime;
      // Gentle sine partials and decaying envelopes avoid the sharp edges of
      // square waves and horns. The master gain caps the peak on every preset.
      const master = context.createGain();
      master.gain.value = Math.max(0.02, Math.min(0.24, selected.volume / 100 * 0.24));
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -18;
      limiter.knee.value = 18;
      limiter.ratio.value = 4;
      limiter.attack.value = 0.012;
      limiter.release.value = 0.18;
      master.connect(limiter).connect(context.destination);

      const strike = (
        begins: number,
        frequency: number,
        duration: number,
        partials: readonly (readonly [number, number])[],
      ) => {
        for (const [multiple, level] of partials) {
          const oscillator = context.createOscillator();
          const envelope = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency * multiple, begins);
          envelope.gain.setValueAtTime(0.0001, begins);
          envelope.gain.linearRampToValueAtTime(level, begins + Math.min(0.022, duration / 5));
          envelope.gain.exponentialRampToValueAtTime(0.0001, begins + duration);
          oscillator.connect(envelope).connect(master);
          oscillator.start(begins);
          oscillator.stop(begins + duration + 0.01);
        }
      };

      if (selected.sound === "gentle_bell") {
        strike(start, 587.33, 0.9, [[1, 0.45], [2.76, 0.1], [4.07, 0.035]]);
        strike(start + 0.55, 739.99, 0.9, [[1, 0.4], [2.76, 0.09], [4.07, 0.03]]);
      } else if (selected.sound === "wooden_tap") {
        strike(start, 349.23, 0.2, [[1, 0.55], [2.35, 0.11], [3.8, 0.035]]);
        strike(start + 0.34, 440, 0.24, [[1, 0.5], [2.35, 0.1], [3.8, 0.03]]);
      } else if (selected.sound === "phone_ring") {
        for (const delay of [0, 0.23, 0.74, 0.97]) {
          strike(start + delay, 440, 0.17, [[1, 0.22]]);
          strike(start + delay, 480, 0.17, [[1, 0.22]]);
        }
      } else if (selected.sound === "mellow_horn") {
        for (const delay of [0, 0.62]) {
          strike(start + delay, 220, 0.42, [[1, 0.3], [2, 0.11], [3, 0.035]]);
          strike(start + delay, 293.66, 0.42, [[1, 0.24], [2, 0.06]]);
        }
      } else if (selected.sound === "register_chime") {
        strike(start, 523.25, 0.28, [[1, 0.27], [2.02, 0.045]]);
        strike(start + 0.12, 783.99, 0.46, [[1, 0.26], [2.02, 0.04]]);
        strike(start + 0.42, 1046.5, 0.58, [[1, 0.22], [2.02, 0.025]]);
      } else {
        strike(start, 523.25, 0.64, [[1, 0.4], [2.01, 0.1], [3.88, 0.025]]);
        strike(start + 0.26, 659.25, 0.76, [[1, 0.4], [2.01, 0.1], [3.88, 0.025]]);
      }
      window.setTimeout(() => { master.disconnect(); limiter.disconnect(); }, 2_000);
      return true;
    },
    [unlockAudio],
  );

  const ringPending = useCallback(() => {
    if (!alertState.current.pending.size) return;
    if (ring()) heard.current = true;
  }, [ring]);

  /** Staff saw the new online order(s): stop repeating the chime. */
  const acknowledgeOnlineOrders = useCallback(() => {
    alertState.current.pending.clear();
    setPendingOnlineOrders(0);
    void unlockAudio();
  }, [unlockAudio]);

  useEffect(() => {
    preference.current = { sound: initialSound, volume: initialVolume };
    refreshSoundBlocked();
  }, [initialSound, initialVolume, refreshSoundBlocked]);

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (
        event as CustomEvent<AlertPreference & { test?: boolean }>
      ).detail;
      if (!detail) return;
      preference.current = { sound: detail.sound, volume: detail.volume };
      refreshSoundBlocked();
      if (detail.test) ring(preference.current);
    };
    window.addEventListener("corner-ops-online-order-alert-preference", update);
    return () =>
      window.removeEventListener(
        "corner-ops-online-order-alert-preference",
        update,
      );
  }, [ring, refreshSoundBlocked]);

  useEffect(() => {
    // Any tap unlocks audio; an order that arrived while sound was blocked then rings at once.
    const unlock = () =>
      void unlockAudio().then(() => {
        if (!heard.current) ringPending();
      });
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [unlockAudio, ringPending]);

  useEffect(() => {
    if (!authenticated) {
      alertState.current = createOnlineAlertState();
      setPendingOnlineOrders(0);
      setSoundBlocked(false);
      return;
    }
    void unlockAudio();
    let stopped = false;
    // Single-flight: a slow response is never overlapped by the next tick.
    const poll = singleFlight(async () => {
      try {
        const response = await fetch(
          "/api/ordering/orders/online-alerts?business=Corner%20Deli",
          { cache: "no-store" },
        );
        if (!response.ok || stopped) return;
        const payload = (await response.json()) as { orders?: AlertOrder[] };
        if (stopped) return;
        const fresh = reconcileOnlineAlerts(
          alertState.current,
          (payload.orders || []).map((order) => String(order.id)),
        );
        setPendingOnlineOrders(alertState.current.pending.size);
        if (fresh.length) {
          heard.current = false;
          ringPending();
        }
      } catch {
        // The regular status indicator reports connectivity; alerts retry silently.
      }
    });
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    // Keep chiming until staff acknowledge or the kitchen starts the order.
    const repeat = window.setInterval(ringPending, REPEAT_ALERT_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(repeat);
    };
  }, [authenticated, ringPending, unlockAudio]);

  useEffect(() => {
    if (
      !authenticated ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window)
    ) {
      setAlertsEnabled(false);
      return;
    }
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) =>
        setAlertsEnabled(
          Boolean(subscription && Notification.permission === "granted"),
        ),
      )
      .catch(() => setAlertsEnabled(false));
  }, [authenticated]);

  const enableAlerts = useCallback(async () => {
    setAlertBusy(true);
    setAlertNotice("");
    try {
      await unlockAudio();
      if (
        !("Notification" in window) ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window)
      )
        throw new Error("This device does not support PWA notifications.");
      if (
        /iphone|ipad|ipod/i.test(navigator.userAgent) &&
        !installedOnHomeScreen()
      )
        throw new Error(
          "Add the POS to the Home Screen, open it from its icon, then enable alerts.",
        );
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error(
          "Notification permission was not granted. Allow Corner Deli POS notifications in Apple Settings.",
        );
      const statusResponse = await fetch("/api/push?audience=pos", {
        cache: "no-store",
      });
      const status = (await statusResponse.json()) as {
        publicKey?: string;
        error?: string;
      };
      if (!statusResponse.ok || !status.publicKey)
        throw new Error(
          status.error || "Notification setup could not be loaded.",
        );
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(status.publicKey),
        }));
      const response = await fetch("/api/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "subscribe",
          audience: "pos",
          subscription: subscription.toJSON(),
          userAgent: navigator.userAgent,
          deviceLabel: posDeviceLabel(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          payload?.error ||
            "This POS could not be registered for notifications.",
        );
      setAlertsEnabled(true);
      setAlertNotice(
        "Sound and background order notifications are enabled on this device.",
      );
      ring();
    } catch (error) {
      setAlertsEnabled(false);
      setAlertNotice(
        error instanceof Error ? error.message : "Alerts could not be enabled.",
      );
    } finally {
      setAlertBusy(false);
    }
  }, [ring, unlockAudio]);

  const testAlerts = useCallback(async () => {
    setAlertNotice("");
    void unlockAudio();
    ring();
    try {
      const response = await fetch("/api/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test", audience: "pos" }),
      });
      if (!response.ok)
        throw new Error("The background test notification could not be sent.");
      setAlertNotice(
        "Foreground sound played and a background notification was sent.",
      );
    } catch (error) {
      setAlertNotice(
        error instanceof Error ? error.message : "The alert test failed.",
      );
    }
  }, [ring, unlockAudio]);

  return {
    alertsEnabled,
    alertBusy,
    alertNotice,
    enableAlerts,
    testAlerts,
    pendingOnlineOrders,
    soundBlocked,
    acknowledgeOnlineOrders,
  };
}
