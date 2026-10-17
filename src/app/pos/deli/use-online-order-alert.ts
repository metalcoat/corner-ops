"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OnlineOrderAlertSound } from "@/lib/ordering-pos-settings";
import { renderAlertSound, roomImpulse } from "@/lib/alert-sounds";
import {
  createOnlineAlertState,
  reconcileOnlineAlerts,
  singleFlight,
} from "@/lib/pos-offline-sync-policy";
import {
  createDoorChimeState,
  DOOR_CHIME_NOTICE_MS,
  DOOR_GREET_REMINDER_SECONDS,
  dueGreetReminders,
  reconcileDoorEvents,
  type DoorGreetOutcome,
} from "@/lib/door-chime-policy";

type AlertOrder = { id: string };
type DoorEvent = {
  id: number;
  camera: string;
  kind: string;
  detectedAt: string;
  waiting: boolean;
  ageSeconds: number;
};

const rendered = new Map<string, AudioBuffer>();
/** Sounds are rendered once per device (a few milliseconds each) and reused. */
function soundBuffer(context: AudioContext, sound: string) {
  const key = `${sound}@${context.sampleRate}`;
  let buffer = rendered.get(key);
  if (!buffer) {
    const { left, right } = renderAlertSound(sound, context.sampleRate);
    buffer = context.createBuffer(2, left.length, context.sampleRate);
    buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
    rendered.set(key, buffer);
  }
  return buffer;
}
function roomBuffer(context: AudioContext) {
  const key = `room@${context.sampleRate}`;
  let buffer = rendered.get(key);
  if (!buffer) {
    const { left, right } = roomImpulse(context.sampleRate);
    buffer = context.createBuffer(2, left.length, context.sampleRate);
    buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
    rendered.set(key, buffer);
  }
  return buffer;
}

/** Unacknowledged new online orders re-chime on this interval. */
const REPEAT_ALERT_MS = 20_000;

type AlertPreference = { sound: OnlineOrderAlertSound; volume: number };

/**
 * The entrance chime is the ding-dong, unless online orders already use it; then
 * the hand bell, so staff can tell a walk-in from an order by ear.
 */
function doorSound(selected: AlertPreference): AlertPreference {
  if (selected.sound === "off") return selected;
  return { sound: selected.sound === "warm_chime" ? "gentle_bell" : "warm_chime", volume: selected.volume };
}

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
  const doorState = useRef(createDoorChimeState());
  const doorReminders = useRef(new Map<number, number>());
  const doorTestTimer = useRef<number | null>(null);
  // Walk-ins nobody has greeted yet (from the server, so every screen agrees).
  const [doorWaiting, setDoorWaiting] = useState<DoorEvent[]>([]);
  // A detector test only flashes the bar; it is never greeted or counted.
  const [doorTest, setDoorTest] = useState(false);

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
      // Render the chosen sound now so the first alert plays instantly.
      const context = audio.current;
      window.setTimeout(() => {
        if (preference.current.sound !== "off") soundBuffer(context, preference.current.sound);
        roomBuffer(context);
      }, 0);
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
      // Modelled instrument samples (see alert-sounds.ts) through a small-room
      // reverb and a limiter, so the peak stays capped on every preset.
      const buffer = soundBuffer(context, selected.sound);
      const source = context.createBufferSource();
      source.buffer = buffer;
      const master = context.createGain();
      master.gain.value = Math.max(0.03, Math.min(0.55, (selected.volume / 100) * 0.55));
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 8;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      const wet = context.createGain();
      wet.gain.value = 0.22;
      const room = context.createConvolver();
      room.buffer = roomBuffer(context);
      source.connect(master);
      master.connect(limiter);
      master.connect(room).connect(wet).connect(limiter);
      limiter.connect(context.destination);
      source.start();
      window.setTimeout(() => {
        for (const node of [source, master, room, wet, limiter]) node.disconnect();
      }, (buffer.duration + 1.2) * 1000);
      return true;
    },
    [unlockAudio],
  );

  const ringPending = useCallback(() => {
    if (!alertState.current.pending.size) return;
    if (ring()) heard.current = true;
  }, [ring]);

  /**
   * Door events from one poll: chime once for new walk-ins, again for anyone
   * still not greeted at each reminder age, and keep the bar up until a tap.
   */
  const updateDoor = useCallback(
    (events: DoorEvent[]) => {
      const firstPoll = !doorState.current.initialized;
      const fresh = new Set(
        reconcileDoorEvents(
          doorState.current,
          events.map((event) => Number(event.id)),
        ),
      );
      const waiting = events.filter((event) => event.waiting);
      const reminders = dueGreetReminders(doorReminders.current, waiting);
      setDoorWaiting(waiting);
      if (events.some((event) => fresh.has(event.id) && event.kind === "test")) {
        setDoorTest(true);
        if (doorTestTimer.current) window.clearTimeout(doorTestTimer.current);
        doorTestTimer.current = window.setTimeout(() => setDoorTest(false), DOOR_CHIME_NOTICE_MS);
      }
      // A screen that just opened shows waiting walk-ins but doesn't ring for them.
      if (!firstPoll && (fresh.size || reminders.length)) ring(doorSound(preference.current));
    },
    [ring],
  );

  const greetWalkIns = useCallback(
    async (outcome: DoorGreetOutcome) => {
      void unlockAudio();
      const ids = doorWaiting.map((event) => event.id);
      setDoorTest(false);
      if (!ids.length) return;
      setDoorWaiting([]);
      try {
        const response = await fetch("/api/ordering/orders/door-events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids, outcome }),
        });
        if (!response.ok) throw new Error();
      } catch {
        // The next poll brings the bar back, so the walk-in isn't lost.
        setAlertNotice("The greeting could not be saved. Tap GREETED again.");
      }
    },
    [doorWaiting, unlockAudio],
  );

  useEffect(
    () => () => {
      if (doorTestTimer.current) window.clearTimeout(doorTestTimer.current);
    },
    [],
  );

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
      doorState.current = createDoorChimeState();
      doorReminders.current.clear();
      setDoorWaiting([]);
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
        const payload = (await response.json()) as {
          orders?: AlertOrder[];
          doorEvents?: DoorEvent[];
        };
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
        // Several walk-ins in one poll still chime once.
        updateDoor(payload.doorEvents || []);
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
  }, [authenticated, ringPending, unlockAudio, updateDoor]);

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
    doorWaiting: doorWaiting.length,
    doorOverdue: doorWaiting.some(
      (event) => event.ageSeconds >= DOOR_GREET_REMINDER_SECONDS[0],
    ),
    doorLongestWaitSeconds: doorWaiting.reduce(
      (longest, event) => Math.max(longest, event.ageSeconds),
      0,
    ),
    doorTest,
    greetWalkIns,
  };
}
