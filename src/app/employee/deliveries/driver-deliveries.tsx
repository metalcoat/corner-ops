"use client";
// The driver tablet: a list of today's deliveries (who, where, how much to
// collect) beside the selected order (what's in the bag), with 3CX calling,
// navigation, status buttons, proof photos, and foreground GPS for tracking.
// Managers also get the dispatch board: every driver on a live map.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StreetMap, { type MapPoint } from "@/components/street-map";
import { callLink } from "@/lib/driver-call-link";

type Delivery = {
  delivery_id: string;
  order_id: string;
  display_number: string;
  delivery_status: string;
  order_status: string;
  payment_status: string;
  payment_preference: string;
  total_cents: number;
  paid_cents: number;
  amount_due_cents: number;
  tip_cents: number;
  item_count: number;
  service_type: string;
  timing_mode: string;
  scheduled_for: string | null;
  created_at: string;
  en_route_at: string | null;
  customer_name: string;
  delivery_phone: string;
  delivery_address: string;
  delivery_unit: string;
  delivery_notes: string;
  driver_name: string | null;
  assigned_employee_id: string | null;
  destination_latitude: number | string | null;
  destination_longitude: number | string | null;
  driver_latitude: number | null;
  driver_longitude: number | null;
  driver_location_captured_at: string | null;
};
type RouteStop = { deliveryId: string; displayNumber: string; customerName: string; address: string; sequence: number; estimatedArrival: string; dueAt: string; timingRisk: "on_track" | "due_soon" | "late"; legMiles: number };
type RoutePlan = { driverEmployeeId: string; driverName: string; plan: { stops: RouteStop[]; navigationUrl: string | null; totalStraightLineMiles: number; urgentStops: number } };
type Settings = { showLiveDriver: boolean; callLinkTemplate: string; autoAssignSolo: boolean; anyoneCanDeliver: boolean };
type Payload = {
  actor: { name: string; manager: boolean; driver: boolean };
  deliveries: Delivery[];
  drivers: Array<{ id: string; name: string; position: string; role_group: string; clocked_in: boolean }>;
  routePlans: RoutePlan[];
  settings: Settings;
  origin: { latitude: number; longitude: number } | null;
  mapTileUrl: string | null;
};
type OrderDetail = {
  deliveryId: string;
  displayNumber: string;
  customerName: string;
  phone: string;
  callUrl: string | null;
  address: string;
  unit: string;
  deliveryNotes: string;
  specialInstructions: string;
  serviceType: string;
  timingMode: string;
  scheduledFor: string | null;
  paymentStatus: string;
  paymentPreference: string;
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  paidCents: number;
  amountDueCents: number;
  trackingUrl: string | null;
  items: Array<{ id: string; name: string; variant: string; quantity: number; cancelledQuantity: number; lineTotalCents: number; instructions: string; combo: string; options: string[] }>;
};
type QueuedProof = { id: string; deliveryId: string; file: File; note: string; capturedAt: string };

const FINISHED = ["DELIVERED", "RETURNED", "CANCELLED"];
/** Android delivers a GPS fix about once a second; upload one every 10 s, or sooner after 50 m. */
const GPS_MIN_INTERVAL_MS = 10_000;
const GPS_MIN_METRES = 50;
function metresBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180, dLat = (b.latitude - a.latitude) * rad, dLng = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}
const TRACKING = ["EN_ROUTE", "ARRIVED", "NO_CONTACT"];
const statusActions: Record<string, Array<[string, string]>> = {
  ASSIGNED: [["PICKED UP", "PICKED_UP"]],
  READY_FOR_DRIVER: [["PICKED UP", "PICKED_UP"]],
  PICKED_UP: [["START THIS STOP", "EN_ROUTE"]],
  EN_ROUTE: [["ARRIVED", "ARRIVED"], ["DELIVERED", "DELIVERED"], ["NO CONTACT", "NO_CONTACT"], ["DELIVERY FAILED", "DELIVERY_FAILED"]],
  ARRIVED: [["DELIVERED", "DELIVERED"], ["NO CONTACT", "NO_CONTACT"], ["DELIVERY FAILED", "DELIVERY_FAILED"]],
  NO_CONTACT: [["DELIVERED", "DELIVERED"], ["DELIVERY FAILED", "DELIVERY_FAILED"]],
  DELIVERY_FAILED: [["RETURNED", "RETURNED"]],
};
const statusLabel: Record<string, string> = {
  ASSIGNED: "Assigned",
  READY_FOR_DRIVER: "Ready",
  PICKED_UP: "In car",
  EN_ROUTE: "On the way",
  ARRIVED: "Arrived",
  NO_CONTACT: "No contact",
  DELIVERY_FAILED: "Failed",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
};
const money = (cents: number) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const clock = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const finished = (delivery: Delivery) => FINISHED.includes(delivery.delivery_status);
const fullAddress = (address: string, unit: string) => `${address}${unit ? `, ${unit}` : ""}`;
const navigateUrl = (address: string, unit: string) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${address} ${unit || ""}`.trim())}`;

/** What the driver has to collect at the door, or that it's already paid. */
function moneyBadge(input: { paymentStatus: string; preference: string; totalCents: number; paidCents: number; amountDueCents: number }) {
  const due = input.amountDueCents > 0 ? input.amountDueCents : Math.max(0, input.totalCents - input.paidCents);
  if (input.paymentStatus === "paid" || (due === 0 && input.totalCents > 0)) return { tone: "paid", text: `PAID ${money(input.totalCents)}` };
  if (input.paymentStatus.includes("refund")) return { tone: "warn", text: input.paymentStatus.replaceAll("_", " ").toUpperCase() };
  const how = input.preference === "cash" ? " CASH" : input.preference === "card" ? " CARD" : "";
  return { tone: "due", text: `COLLECT ${money(due)}${how}` };
}
const badgeFor = (delivery: Delivery) =>
  moneyBadge({ paymentStatus: delivery.payment_status, preference: delivery.payment_preference, totalCents: Number(delivery.total_cents), paidCents: Number(delivery.paid_cents), amountDueCents: Number(delivery.amount_due_cents) });

// ---- offline queues (status updates in localStorage, proof photos in IndexedDB) ----
const queueKey = "corner-ops-driver-queue-v1";
function queued() {
  try {
    return JSON.parse(localStorage.getItem(queueKey) || "[]") as Array<{ url: string; body: unknown }>;
  } catch {
    return [];
  }
}
function enqueue(url: string, body: unknown) {
  localStorage.setItem(queueKey, JSON.stringify([...queued(), { url, body }]));
}
function proofDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("corner-ops-driver", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("proofs", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function queueProofUpload(deliveryId: string, file: File, note: string) {
  const db = await proofDb(), record = { id: crypto.randomUUID(), deliveryId, file, note, capturedAt: new Date().toISOString() };
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction("proofs", "readwrite").objectStore("proofs").put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
}
async function flushProofUploads() {
  const db = await proofDb();
  const records = await new Promise<QueuedProof[]>((resolve, reject) => {
    const request = db.transaction("proofs").objectStore("proofs").getAll();
    request.onsuccess = () => resolve(request.result as QueuedProof[]);
    request.onerror = () => reject(request.error);
  });
  for (const record of records) {
    const form = new FormData();
    form.set("photo", record.file);
    form.set("proofType", "no_contact");
    form.set("capturedAt", record.capturedAt);
    form.set("note", record.note);
    try {
      const response = await fetch(`/api/driver/deliveries/${record.deliveryId}/proof`, { method: "POST", body: form });
      if (response.ok)
        await new Promise<void>((resolve, reject) => {
          const request = db.transaction("proofs", "readwrite").objectStore("proofs").delete(record.id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
    } catch {
      break;
    }
  }
  db.close();
}
async function message(response: Response) {
  const body = await response.json().catch(() => ({}));
  return body.error || `Request failed (${response.status}).`;
}
function deviceLabel() {
  return /iphone/i.test(navigator.userAgent) ? "iPhone" : /ipad/i.test(navigator.userAgent) ? "iPad" : /android/i.test(navigator.userAgent) ? "Android tablet" : "Vehicle tablet";
}

export default function DriverDeliveries() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [dispatch, setDispatch] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [online, setOnline] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const watch = useRef<number | null>(null);
  const activeTracking = useRef<string | null>(null);
  const lastSent = useRef<{ at: number; latitude: number; longitude: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/driver/deliveries?${new URLSearchParams({ q: query, dispatch: dispatch ? "1" : "0" })}`, { cache: "no-store" });
      if (response.status === 401) {
        setData(null);
        setError("");
        return;
      }
      if (!response.ok) throw new Error(await message(response));
      setData(await response.json());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Deliveries could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [query, dispatch]);

  const loadDetail = useCallback(async (deliveryId: string) => {
    try {
      const response = await fetch(`/api/driver/deliveries/${deliveryId}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await message(response));
      const body = await response.json();
      setDetail(body.order);
      setDetailError("");
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : "Order could not be loaded.");
    }
  }, []);

  const flush = useCallback(async () => {
    if (!navigator.onLine) return;
    await flushProofUploads().catch(() => undefined);
    const pending = queued(), remaining = [] as typeof pending;
    for (const item of pending) {
      try {
        const response = await fetch(item.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item.body) });
        if (!response.ok) remaining.push(item);
      } catch {
        remaining.push(item);
      }
    }
    localStorage.setItem(queueKey, JSON.stringify(remaining));
    if (pending.length !== remaining.length) void load();
  }, [load]);

  useEffect(() => {
    setOnline(navigator.onLine);
    void load();
    void flush();
    const onOnline = () => {
      setOnline(true);
      void flush();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [load, flush]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("dispatch") === "1") setDispatch(true);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
      if (selectedId) void loadDetail(selectedId);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load, loadDetail, selectedId]);
  useEffect(() => {
    setDetail(null);
    setDetailError("");
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // GPS follows the stop the driver started most recently, so the customer
  // being driven to now is the one who can see the car.
  const trackingDelivery = useMemo(
    () =>
      data?.deliveries
        .filter((delivery) => TRACKING.includes(delivery.delivery_status) && (!dispatch || delivery.assigned_employee_id))
        .toSorted((a, b) => new Date(b.en_route_at || 0).getTime() - new Date(a.en_route_at || 0).getTime())[0] ?? null,
    [data?.deliveries, dispatch],
  );
  const trackingId = !dispatch && data?.actor.driver ? trackingDelivery?.delivery_id ?? null : null;
  useEffect(() => {
    if (!trackingId || !("geolocation" in navigator)) {
      if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
      watch.current = null;
      activeTracking.current = null;
      return;
    }
    if (activeTracking.current === trackingId) return;
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    activeTracking.current = trackingId;
    lastSent.current = null;
    watch.current = navigator.geolocation.watchPosition(
      (position) => {
        const here = { latitude: position.coords.latitude, longitude: position.coords.longitude }, previous = lastSent.current;
        if (previous && position.timestamp - previous.at < GPS_MIN_INTERVAL_MS && metresBetween(previous, here) < GPS_MIN_METRES) return;
        lastSent.current = { at: position.timestamp, ...here };
        const body = {
          clientEventId: crypto.randomUUID(),
          capturedAt: new Date(position.timestamp).toISOString(),
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          metadata: { source: "vehicle-tablet" },
        };
        const url = `/api/driver/deliveries/${trackingId}/location`;
        fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => enqueue(url, body));
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
    return () => {
      if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
      watch.current = null;
      activeTracking.current = null;
    };
  }, [trackingId]);

  // Keep the mounted tablet's screen on while a delivery is in progress.
  useEffect(() => {
    if (!trackingId || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = () =>
      navigator.wakeLock
        .request("screen")
        .then((sentinel) => {
          if (cancelled) void sentinel.release();
          else lock = sentinel;
        })
        .catch(() => undefined);
    void request();
    const onVisible = () => document.visibilityState === "visible" && void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [trackingId]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy("login");
    const response = await fetch("/api/employee/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ business: "Corner Deli", pin, deviceLabel: deviceLabel() }),
    });
    setPin("");
    setBusy("");
    if (!response.ok) {
      setError(await message(response));
      return;
    }
    await load();
  }

  async function action(deliveryId: string, status: string) {
    const body = { status, note }, url = `/api/driver/deliveries/${deliveryId}/action`;
    setBusy(`${deliveryId}:${status}`);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await message(response));
      setNote("");
      setNotice(status === "DELIVERED" ? "Marked delivered." : `Marked ${statusLabel[status]?.toLowerCase() || status}.`);
      await load();
      await loadDetail(deliveryId);
    } catch (reason) {
      if (!navigator.onLine) {
        enqueue(url, body);
        setNotice("Saved offline. Keep this screen open; it will sync when service returns.");
      } else setError(reason instanceof Error ? reason.message : "Update failed.");
    } finally {
      setBusy("");
    }
  }

  async function proof(deliveryId: string, file: File) {
    setBusy(`${deliveryId}:proof`);
    try {
      const position = await new Promise<GeolocationPosition | null>((resolve) =>
        navigator.geolocation ? navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { enableHighAccuracy: true, timeout: 10000 }) : resolve(null),
      );
      const form = new FormData();
      form.set("photo", file);
      form.set("proofType", "no_contact");
      form.set("capturedAt", new Date().toISOString());
      form.set("note", note);
      if (position) {
        form.set("latitude", String(position.coords.latitude));
        form.set("longitude", String(position.coords.longitude));
        form.set("accuracy", String(position.coords.accuracy));
      }
      const response = await fetch(`/api/driver/deliveries/${deliveryId}/proof`, { method: "POST", body: form });
      if (!response.ok) throw new Error(await message(response));
      setNotice("Delivery photo saved.");
      await load();
    } catch (reason) {
      try {
        await queueProofUpload(deliveryId, file, note);
        setNotice("Photo saved on this tablet and queued. It will upload when service returns.");
      } catch {
        setError(reason instanceof Error ? `${reason.message} Keep this screen open and retry so the photo is not lost.` : "Proof upload failed.");
      }
    } finally {
      setBusy("");
    }
  }

  // Calls go through the tablet's calling app (3CX), so customers see the deli's number.
  async function call(deliveryId: string, phone: string) {
    const fallback = callLink(data?.settings.callLinkTemplate || "", phone);
    let url = fallback;
    try {
      const response = await fetch(`/api/driver/deliveries/${deliveryId}/call`, { method: "POST" });
      if (response.ok) url = (await response.json()).url || fallback;
    } catch {
      // Offline: still place the call, it just isn't logged.
    }
    if (!url) {
      setError("This order has no phone number.");
      return;
    }
    if (url.startsWith("https:")) window.open(url, "_blank", "noopener");
    else window.location.href = url;
  }

  async function assign(deliveryId: string, employeeId: string) {
    const response = await fetch("/api/driver/deliveries", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId, employeeId }),
    });
    if (!response.ok) {
      setError(await message(response));
      return;
    }
    await load();
  }

  // Small crews: take deliveries in one tap, give one back, or leave with every ready bag at once.
  async function dispatchAction(key: string, body: Record<string, unknown>, done: string) {
    setBusy(key);
    try {
      const response = await fetch("/api/driver/deliveries", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await message(response));
      const result = await response.json().catch(() => ({}));
      setNotice(done.replace("{n}", String(result.claimed ?? result.started ?? "")));
      await load();
      if (selectedId) await loadDetail(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That didn't save.");
    } finally {
      setBusy("");
    }
  }

  async function saveSettings(next: Partial<Settings>) {
    setBusy("settings");
    try {
      const response = await fetch("/api/driver/deliveries", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "settings", ...next }),
      });
      if (!response.ok) throw new Error(await message(response));
      setNotice("Dispatch settings saved.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Settings could not be saved.");
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (loading) return <main className="driverApp"><p className="driverLoading">Loading deliveries…</p></main>;
  if (!data)
    return (
      <main className="driverApp">
        <section className="driverLogin">
          <p className="eyebrow">CORNER DELI DRIVER</p>
          <h1>Employee sign in</h1>
          <form onSubmit={login}>
            <label>
              Employee PIN
              <input inputMode="numeric" type="password" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
            </label>
            <button disabled={pin.length !== 4 || busy === "login"}>{busy ? "SIGNING IN…" : "SIGN IN"}</button>
          </form>
          {error && <p role="alert">{error}</p>}
        </section>
      </main>
    );

  const routePlan = !dispatch ? data.routePlans[0]?.plan : null;
  const stopNumber = new Map(data.routePlans.flatMap((plan) => plan.plan.stops.map((stop) => [stop.deliveryId, stop] as const)));
  const current = data.deliveries.filter((delivery) => !finished(delivery) && (dispatch || delivery.assigned_employee_id));
  // Deliveries nobody has taken yet (several or no drivers on shift).
  const upForGrabs = dispatch ? [] : data.deliveries.filter((delivery) => !finished(delivery) && !delivery.assigned_employee_id);
  const readyToGrab = upForGrabs.filter((delivery) => delivery.delivery_status === "READY_FOR_DRIVER");
  const readyToLeave = current.filter((delivery) => ["READY_FOR_DRIVER", "PICKED_UP"].includes(delivery.delivery_status));
  const done = data.deliveries.filter(finished);
  const ordered = current.toSorted((a, b) => (stopNumber.get(a.delivery_id)?.sequence ?? 99) - (stopNumber.get(b.delivery_id)?.sequence ?? 99));
  const selected = data.deliveries.find((delivery) => delivery.delivery_id === selectedId) ?? null;
  const toCollect = current.reduce((sum, delivery) => {
    const badge = badgeFor(delivery);
    return badge.tone === "due" ? sum + Math.max(0, Number(delivery.amount_due_cents) || Number(delivery.total_cents) - Number(delivery.paid_cents)) : sum;
  }, 0);

  // Dispatch map: each driver's latest position plus every open stop.
  const mapPoints: MapPoint[] = [];
  if (dispatch) {
    if (data.origin) mapPoints.push({ id: "store", kind: "store", ...data.origin, label: "Deli" });
    const seen = new Set<string>();
    for (const delivery of data.deliveries) {
      if (delivery.assigned_employee_id && delivery.driver_latitude != null && delivery.driver_longitude != null && !seen.has(delivery.assigned_employee_id)) {
        seen.add(delivery.assigned_employee_id);
        const age = Date.now() - new Date(delivery.driver_location_captured_at || 0).getTime();
        if (age < 2 * 60 * 60_000)
          mapPoints.push({
            id: `driver-${delivery.assigned_employee_id}`,
            kind: "driver",
            latitude: Number(delivery.driver_latitude),
            longitude: Number(delivery.driver_longitude),
            label: `${(delivery.driver_name || "Driver").split(" ")[0]} · ${clock(delivery.driver_location_captured_at!)}`,
            stale: age > 5 * 60_000,
          });
      }
    }
    for (const delivery of current)
      if (delivery.destination_latitude != null && delivery.destination_longitude != null)
        mapPoints.push({ id: delivery.delivery_id, kind: "stop", latitude: Number(delivery.destination_latitude), longitude: Number(delivery.destination_longitude), label: `#${delivery.display_number}` });
  }

  const list = showDone ? done : ordered;
  return (
    <main className={`driverApp ${selected ? "hasSelection" : ""}`}>
      <header className="driverTop">
        <div>
          <p className="eyebrow">{dispatch ? "DISPATCH BOARD" : "MY DELIVERIES"}</p>
          <h1>{data.actor.name}</h1>
        </div>
        <div className="driverTotals">
          <span><b>{current.length}</b> open</span>
          {toCollect > 0 && <span className="collect"><b>{money(toCollect)}</b> to collect</span>}
        </div>
        <span className={online ? "online" : "offline"}>{online ? (trackingId ? "GPS ON" : "ONLINE") : `OFFLINE · ${queued().length} QUEUED`}</span>
      </header>
      <div className="driverTools">
        <input aria-label="Search orders" placeholder="Order #, name, phone, address" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={() => void load()}>REFRESH</button>
        {data.actor.manager && (
          <button
            onClick={() => {
              setDispatch((value) => !value);
              setSelectedId(null);
            }}
          >
            {dispatch ? "MY DELIVERIES" : "DISPATCH"}
          </button>
        )}
      </div>
      {error && (
        <p className="driverError" role="alert">
          {error} <button onClick={() => setError("")}>DISMISS</button>
        </p>
      )}
      {notice && <p className="driverNotice" role="status">{notice}</p>}

      {dispatch && (
        <section className="dispatchPanel">
          {mapPoints.length > 0 ? (
            <StreetMap points={mapPoints} tileUrl={data.mapTileUrl} height={340} label="Drivers and open delivery stops" />
          ) : (
            <p className="mapEmpty">No driver positions yet. Drivers appear here while a stop is in progress.</p>
          )}
          <div className="dispatchSettings">
            <label className="toggle">
              <input type="checkbox" checked={data.settings.showLiveDriver} disabled={busy === "settings"} onChange={(e) => void saveSettings({ showLiveDriver: e.target.checked })} />
              <span>
                <b>Show the driver on the customer&apos;s order page</b>
                <small>Only the customer the driver is heading to now sees the car, at about 100 m accuracy.</small>
              </span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={data.settings.autoAssignSolo} disabled={busy === "settings"} onChange={(e) => void saveSettings({ autoAssignSolo: e.target.checked })} />
              <span>
                <b>One driver on shift gets every delivery</b>
                <small>When exactly one Driver is clocked in, new deliveries go straight to their tablet. Nobody has to hand them out.</small>
              </span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={data.settings.anyoneCanDeliver} disabled={busy === "settings"} onChange={(e) => void saveSettings({ anyoneCanDeliver: e.target.checked })} />
              <span>
                <b>Anyone on the clock can take a delivery</b>
                <small>For short-staffed mornings: whoever is free signs in to the tablet and taps TAKE.</small>
              </span>
            </label>
            <form
              className="callSetting"
              onSubmit={(e) => {
                e.preventDefault();
                const value = new FormData(e.currentTarget).get("template");
                void saveSettings({ callLinkTemplate: String(value || "") });
              }}
            >
              <label>
                Call link for the tablet
                <input name="template" defaultValue={data.settings.callLinkTemplate} key={data.settings.callLinkTemplate} placeholder="tel:{phone}" />
              </label>
              <button disabled={busy === "settings"}>SAVE</button>
            </form>
          </div>
        </section>
      )}

      <div className="driverShell">
        <section className="deliveryColumn" aria-label="Deliveries">
          {!dispatch && !showDone && readyToLeave.length > 0 && (
            <button className="leaveNow" disabled={Boolean(busy)} onClick={() => void dispatchAction("run", { action: "start_run" }, "On the way with {n} deliveries. Customers' trackers now show you're on the way.")}>
              {busy === "run" ? "STARTING…" : `LEAVING NOW · ${readyToLeave.length} ${readyToLeave.length === 1 ? "ORDER" : "ORDERS"}`}
            </button>
          )}
          {!dispatch && !showDone && upForGrabs.length > 0 && (
            <section className="grabs" aria-label="Deliveries nobody has taken">
              <header>
                <strong>UP FOR GRABS ({upForGrabs.length})</strong>
                {readyToGrab.length > 0 && (
                  <button disabled={Boolean(busy)} onClick={() => void dispatchAction("claim-all", { action: "claim", allReady: true }, "Took {n} deliveries.")}>
                    {busy === "claim-all" ? "TAKING…" : `TAKE ALL READY (${readyToGrab.length})`}
                  </button>
                )}
              </header>
              <ul>
                {upForGrabs.map((delivery) => (
                  <li key={delivery.delivery_id}>
                    <button className="grabInfo" onClick={() => setSelectedId(delivery.delivery_id)}>
                      <b>#{delivery.display_number} {delivery.customer_name}</b>
                      <span>{fullAddress(delivery.delivery_address, delivery.delivery_unit)}</span>
                      <small>{delivery.delivery_status === "READY_FOR_DRIVER" ? "Food is ready" : "Still in the kitchen"} · {badgeFor(delivery).text}</small>
                    </button>
                    <button className="take" disabled={Boolean(busy)} onClick={() => void dispatchAction(`claim:${delivery.delivery_id}`, { action: "claim", deliveryIds: [delivery.delivery_id] }, "It's yours.")}>
                      {busy === `claim:${delivery.delivery_id}` ? "…" : "TAKE"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {routePlan && routePlan.stops.length > 1 && (
            <div className="driverRoute">
              <strong>{routePlan.stops.length} STOPS · {routePlan.totalStraightLineMiles.toFixed(1)} MI</strong>
              {routePlan.navigationUrl && <a target="_blank" rel="noreferrer" href={routePlan.navigationUrl}>NAVIGATE ALL STOPS</a>}
            </div>
          )}
          <div className="listTabs" role="tablist">
            <button role="tab" aria-selected={!showDone} onClick={() => setShowDone(false)}>OPEN ({current.length})</button>
            <button role="tab" aria-selected={showDone} onClick={() => setShowDone(true)}>DONE TODAY ({done.length})</button>
          </div>
          {list.length === 0 ? (
            <p className="emptyList">{showDone ? "Nothing finished yet." : upForGrabs.length ? "Tap TAKE on a delivery above and it moves here." : "No open deliveries. New orders show up here automatically."}</p>
          ) : (
            <ol className="deliveryList">
              {list.map((delivery) => {
                const stop = stopNumber.get(delivery.delivery_id), badge = badgeFor(delivery);
                return (
                  <li key={delivery.delivery_id}>
                    <button className={`deliveryRow ${delivery.delivery_id === selectedId ? "selected" : ""} ${delivery.delivery_status.toLowerCase()}`} onClick={() => setSelectedId(delivery.delivery_id)}>
                      <span className="stopNumber">{stop?.sequence ?? "•"}</span>
                      <span className="rowMain">
                        <strong>{delivery.customer_name}</strong>
                        <span className="rowAddress">{fullAddress(delivery.delivery_address, delivery.delivery_unit)}</span>
                        <span className="rowMeta">
                          #{delivery.display_number} · {delivery.item_count} item{delivery.item_count === 1 ? "" : "s"} ·{" "}
                          {delivery.timing_mode === "asap" ? "ASAP" : delivery.scheduled_for ? clock(delivery.scheduled_for) : "Scheduled"}
                          {stop && !finished(delivery) && <> · ETA {clock(stop.estimatedArrival)}</>}
                          {dispatch && <> · {delivery.driver_name || "Unassigned"}</>}
                        </span>
                      </span>
                      <span className="rowSide">
                        <span className={`moneyBadge ${badge.tone}`}>{badge.text}</span>
                        <span className={`statusChip ${delivery.delivery_status.toLowerCase()} ${stop?.timingRisk || ""}`}>{statusLabel[delivery.delivery_status] || delivery.delivery_status}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="orderColumn" aria-label="Order details">
          {!selected ? (
            <div className="orderEmpty">
              <p>Tap a delivery to see what&apos;s in the bag.</p>
            </div>
          ) : (
            <article className="orderPanel">
              <header className="orderHeader">
                <button className="backButton" onClick={() => setSelectedId(null)} aria-label="Back to deliveries">‹ LIST</button>
                <div>
                  <span>ORDER #{selected.display_number}</span>
                  <h2>{selected.customer_name}</h2>
                </div>
                <strong className={`statusChip ${selected.delivery_status.toLowerCase()}`}>{statusLabel[selected.delivery_status] || selected.delivery_status}</strong>
              </header>
              <address>{fullAddress(selected.delivery_address, selected.delivery_unit)}</address>
              {selected.delivery_notes && <p className="notes">{selected.delivery_notes}</p>}
              <div className="contactActions">
                <button className="callButton" onClick={() => void call(selected.delivery_id, selected.delivery_phone)} disabled={!selected.delivery_phone}>
                  CALL {selected.delivery_phone ? `· ${selected.delivery_phone.replace(/\D/g, "").replace(/^1?(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3")}` : ""}
                </button>
                <a target="_blank" rel="noreferrer" href={navigateUrl(selected.delivery_address, selected.delivery_unit)}>NAVIGATE</a>
              </div>

              {detail && detail.deliveryId === selected.delivery_id ? (
                <>
                  {(() => {
                    const badge = moneyBadge({ paymentStatus: detail.paymentStatus, preference: detail.paymentPreference, totalCents: detail.totalCents, paidCents: detail.paidCents, amountDueCents: detail.amountDueCents });
                    return <div className={`collectBanner ${badge.tone}`}>{badge.text}</div>;
                  })()}
                  {detail.specialInstructions && <p className="notes">Order note: {detail.specialInstructions}</p>}
                  <ul className="orderItems">
                    {detail.items.map((item) => {
                      const quantity = item.quantity - item.cancelledQuantity;
                      return (
                        <li key={item.id} className={quantity <= 0 ? "cancelled" : ""}>
                          <span className="qty">{Math.max(quantity, 0)}×</span>
                          <span className="itemText">
                            <b>{item.variant ? `${item.variant} ` : ""}{item.name}</b>
                            {item.combo && <small>{item.combo}</small>}
                            {item.options.map((option) => <small key={option}>{option}</small>)}
                            {item.instructions && <em>“{item.instructions}”</em>}
                            {item.cancelledQuantity > 0 && <small className="void">{item.cancelledQuantity} cancelled</small>}
                          </span>
                          <span className="itemPrice">{money(item.lineTotalCents)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <dl className="orderMoney">
                    <div><dt>Subtotal</dt><dd>{money(detail.subtotalCents)}</dd></div>
                    {detail.discountCents > 0 && <div><dt>Discounts</dt><dd>−{money(detail.discountCents)}</dd></div>}
                    {detail.deliveryFeeCents > 0 && <div><dt>Delivery fee</dt><dd>{money(detail.deliveryFeeCents)}</dd></div>}
                    <div><dt>Tax</dt><dd>{money(detail.taxCents)}</dd></div>
                    {detail.tipCents > 0 && <div><dt>Tip</dt><dd>{money(detail.tipCents)}</dd></div>}
                    <div className="total"><dt>Total</dt><dd>{money(detail.totalCents)}</dd></div>
                    <div><dt>Paid</dt><dd>{money(detail.paidCents)}</dd></div>
                    <div className="due"><dt>Due at door</dt><dd>{money(detail.paymentStatus === "paid" ? 0 : detail.amountDueCents || Math.max(0, detail.totalCents - detail.paidCents))}</dd></div>
                  </dl>
                </>
              ) : detailError ? (
                <p className="driverError">{detailError}</p>
              ) : (
                <p className="detailLoading">Loading order…</p>
              )}

              {dispatch && (
                <select aria-label={`Assign order ${selected.display_number}`} value={selected.assigned_employee_id || ""} onChange={(e) => void assign(selected.delivery_id, e.target.value)}>
                  <option value="">UP FOR GRABS (NOBODY YET)</option>
                  {data.drivers.map((driver) => (
                    <option key={driver.id} value={driver.id}>
                      {driver.name}{driver.clocked_in ? " · on the clock" : ""}{driver.role_group === "Driver" ? "" : ` · ${driver.position || driver.role_group}`}
                    </option>
                  ))}
                </select>
              )}
              {!finished(selected) && (
                <div className="statusDock">
                  <label className="deliveryNote">
                    Note (optional)
                    <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Gate code, left with neighbor…" />
                  </label>
                  <div className="statusActions">
                    {!dispatch && !selected.assigned_employee_id && (
                      <button className="success" disabled={Boolean(busy)} onClick={() => void dispatchAction(`claim:${selected.delivery_id}`, { action: "claim", deliveryIds: [selected.delivery_id] }, "It's yours.")}>
                        TAKE THIS DELIVERY
                      </button>
                    )}
                    {!dispatch && selected.assigned_employee_id && ["ASSIGNED", "READY_FOR_DRIVER"].includes(selected.delivery_status) && (
                      <button className="giveBack" disabled={Boolean(busy)} onClick={() => void dispatchAction(`release:${selected.delivery_id}`, { action: "release", deliveryId: selected.delivery_id }, "Given back. It's up for grabs again.")}>
                        GIVE BACK
                      </button>
                    )}
                    {(dispatch || selected.assigned_employee_id ? statusActions[selected.delivery_status] || [] : []).map(([label, status]) => (
                      <button
                        className={status === "DELIVERED" ? "success" : status.includes("FAILED") ? "danger" : ""}
                        disabled={Boolean(busy)}
                        key={status}
                        onClick={() => void action(selected.delivery_id, status)}
                      >
                        {busy === `${selected.delivery_id}:${status}` ? "SAVING…" : label}
                      </button>
                    ))}
                    {TRACKING.includes(selected.delivery_status) && (
                      <label className="photoButton">
                        {busy === `${selected.delivery_id}:proof` ? "UPLOADING…" : "DELIVERY PHOTO"}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          capture="environment"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void proof(selected.delivery_id, file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>
              )}
            </article>
          )}
        </section>
      </div>
    </main>
  );
}
