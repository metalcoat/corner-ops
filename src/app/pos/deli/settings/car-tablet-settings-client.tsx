"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import "./car-tablet.css";

export type CarTabletRow = {
  id: string; name: string; paired: boolean; revoked: boolean; pairingPending: boolean; pairedAt: string | null;
  online: boolean; lastSeenAt: string | null; batteryPercent: number | null; charging: boolean | null;
  networkType: string; signalLevel: number | null; appVersion: string;
  device: { model?: string; androidVersion?: string; kiosk?: boolean; deviceOwner?: boolean; gpsState?: string; queuedPoints?: number | null; queuedPhotos?: number | null };
  location: { latitude: number; longitude: number; accuracyMeters: number | null; speedMph: number | null; heading?: number | null; capturedAt: string | null } | null;
  driver: { name: string; automatic: boolean } | null;
  pendingCommands: number; photosToday: number;
};
export type CarPhoto = {
  id: string; tabletName: string; camera: string; reason: string; displayNumber: string | null; driverName: string | null;
  requestedBy: string | null; capturedAt: string | null; latitude: number | null; longitude: number | null; url: string;
};
type Pairing = { tabletId: string; name: string; code: string; expiresAt: string | null; qr: string; server: string };

const clock = (value: string | null) => value ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "—";
const ago = (value: string | null) => {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : seconds < 86400 ? `${Math.round(seconds / 3600)}h ago` : clock(value);
};
const REASONS: Record<string, string> = { manual: "Driver", delivery_complete: "Delivered", remote_request: "Snap from POS" };

/** The tablet reaches the server over LTE, so pairing always points it at the public dev address. */
function serverAddress() {
  return typeof window !== "undefined" && window.location.protocol === "https:" ? window.location.origin : "https://dev.ordercornerdeli.com";
}

export async function snapNow(tabletId: string, camera: "cabin" | "road" | "both", orderId?: string) {
  const response = await fetch("/api/ordering/car-tablets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "snap", tabletId, camera, orderId }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The tablet couldn't be asked for a photo.");
}

export function CarPhotoGrid({ photos }: { photos: CarPhoto[] }) {
  const [open, setOpen] = useState<CarPhoto | null>(null);
  if (!photos.length) return <p className="posSettingsHint">No photos yet.</p>;
  return <>
    <div className="carPhotoGrid">{photos.map((photo) => <button type="button" key={photo.id} onClick={() => setOpen(photo)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.url} alt={`${photo.camera} photo ${clock(photo.capturedAt)}`} loading="lazy" />
      <span><b>{photo.camera === "cabin" ? "Cabin" : "Road"}</b> · {clock(photo.capturedAt)}</span>
      <small>{REASONS[photo.reason] || photo.reason}{photo.requestedBy ? ` (${photo.requestedBy})` : ""}{photo.displayNumber ? ` · #${photo.displayNumber}` : ""}</small>
    </button>)}</div>
    {open && <div className="carPhotoViewer" role="dialog" aria-modal="true" aria-label="Car tablet photo" onClick={() => setOpen(null)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={open.url} alt={`${open.camera} photo`} />
      <p>{open.tabletName} · {open.camera === "cabin" ? "Cabin" : "Road"} · {clock(open.capturedAt)} · {REASONS[open.reason] || open.reason}{open.driverName ? ` · ${open.driverName}` : ""}
        {open.latitude != null && open.longitude != null && <> · <a href={`https://www.google.com/maps/search/?api=1&query=${open.latitude},${open.longitude}`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>map</a></>}</p>
      <button type="button">Close</button>
    </div>}
  </>;
}

/** POS Settings › Car tablet: pair the delivery car's tablet, watch it, ask it for photos. */
export default function CarTabletSettingsClient() {
  const [tablets, setTablets] = useState<CarTabletRow[] | null>(null);
  const [photos, setPhotos] = useState<CarPhoto[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [name, setName] = useState("Delivery car");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/ordering/car-tablets", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(payload.error || "Couldn't load the car tablets."); return; }
    setTablets(payload.tablets);
    setPhotos(payload.photos);
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(timer); }, [load]);

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(String(body.action) + (body.tabletId || ""));
    setMessage("");
    try {
      const response = await fetch("/api/ordering/car-tablets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "That didn't work.");
      if (body.action === "pair") {
        const server = serverAddress();
        const link = `cornerops-car://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(payload.code)}`;
        setPairing({ ...payload, server, qr: await QRCode.toDataURL(link, { margin: 1, width: 240 }) });
      }
      setMessage(done);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That didn't work.");
    } finally {
      setBusy("");
    }
  }

  async function snap(tabletId: string, camera: "cabin" | "road" | "both") {
    setBusy(`snap${tabletId}`);
    try { await snapNow(tabletId, camera); setMessage("Asked the tablet for a photo. It shows up below in a few seconds if the tablet is online."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "That didn't work."); }
    finally { setBusy(""); }
    window.setTimeout(() => void load(), 4000);
  }

  return <section className="posSettingsCard carTabletSettings">
    <p className="posDevEyebrow">Delivery car</p>
    <h2>Car tablet</h2>
    <p className="posSettingsHint">The tablet mounted in the delivery car tracks GPS all the time, shows the driver&apos;s deliveries, and takes cabin (front camera) and road (rear camera) photos. Install the app from <a href="/downloads/corner-ops-car-tablet.apk">/downloads/corner-ops-car-tablet.apk</a>; setup steps are in <code>tools/car-tablet/README.md</code>.</p>

    {pairing && <article className="carPairing">
      <div>
        <h3>Pair “{pairing.name}”</h3>
        <p>On the tablet, enter the server and this code (or scan the QR with the tablet&apos;s camera):</p>
        <p className="carPairingServer">{pairing.server}</p>
        <p className="carPairingCode">{pairing.code}</p>
        <small>Works once, until {clock(pairing.expiresAt)}.</small>
        <p><button type="button" onClick={() => setPairing(null)}>Done</button></p>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={pairing.qr} alt="Pairing QR code" width={240} height={240} />
    </article>}

    {tablets === null ? <p>Loading…</p> : tablets.length === 0 ? <p>No car tablet yet.</p> : tablets.map((tablet) => <article key={tablet.id} className={`carTablet ${tablet.revoked ? "revoked" : tablet.online ? "online" : "offline"}`}>
      <header>
        <div>
          <strong>{tablet.name}</strong>
          <span className="carTabletState">{tablet.revoked ? "Unpaired" : !tablet.paired ? (tablet.pairingPending ? "Waiting for pairing" : "Not paired") : tablet.online ? "Online" : `Offline · last seen ${ago(tablet.lastSeenAt)}`}</span>
        </div>
        {tablet.paired && <div className="posTools">
          <button type="button" disabled={!!busy} onClick={() => void snap(tablet.id, "cabin")}>Snap cabin</button>
          <button type="button" disabled={!!busy} onClick={() => void snap(tablet.id, "road")}>Snap road</button>
          <button type="button" disabled={!!busy} onClick={() => void snap(tablet.id, "both")}>Snap both</button>
        </div>}
      </header>
      {!tablet.revoked && <dl className="carTabletFacts">
        <div><dt>Driver</dt><dd>{tablet.driver ? `${tablet.driver.name}${tablet.driver.automatic ? " (only driver on the clock)" : ""}` : "Nobody signed in"}</dd></div>
        <div><dt>Battery</dt><dd>{tablet.batteryPercent == null ? "—" : `${tablet.batteryPercent}%${tablet.charging ? " · charging" : tablet.charging === false ? " · on battery" : ""}`}</dd></div>
        <div><dt>Network</dt><dd>{tablet.networkType || "—"}{tablet.signalLevel != null ? ` · signal ${tablet.signalLevel}/4` : ""}</dd></div>
        <div><dt>GPS</dt><dd>{tablet.location ? <><a href={`https://www.google.com/maps/search/?api=1&query=${tablet.location.latitude},${tablet.location.longitude}`} target="_blank" rel="noreferrer">{ago(tablet.location.capturedAt)}</a>{tablet.location.speedMph != null ? ` · ${tablet.location.speedMph} mph` : ""}{tablet.location.accuracyMeters != null ? ` · ±${Math.round(tablet.location.accuracyMeters)} m` : ""}</> : "No fix yet"}{tablet.device.gpsState ? ` · ${tablet.device.gpsState}` : ""}</dd></div>
        <div><dt>Waiting to upload</dt><dd>{tablet.device.queuedPoints ?? 0} points · {tablet.device.queuedPhotos ?? 0} photos{tablet.pendingCommands ? ` · ${tablet.pendingCommands} snap request(s) pending` : ""}</dd></div>
        <div><dt>App</dt><dd>{tablet.appVersion || "—"}{tablet.device.model ? ` · ${tablet.device.model}` : ""}{tablet.device.androidVersion ? ` · Android ${tablet.device.androidVersion}` : ""}{tablet.device.deviceOwner ? " · kiosk (device owner)" : tablet.paired ? " · not locked down" : ""}</dd></div>
      </dl>}
      <div className="posTools">
        {!tablet.revoked && <button type="button" disabled={!!busy} onClick={() => { const next = window.prompt("Tablet name", tablet.name); if (next) void act({ action: "rename", tabletId: tablet.id, name: next }, "Renamed."); }}>Rename</button>}
        <button type="button" disabled={!!busy} onClick={() => void act({ action: "pair", tabletId: tablet.id }, "New pairing code below. The tablet's old pairing stops working once the new code is used.")}>{tablet.paired ? "Pair again" : "Pairing code"}</button>
        {!tablet.revoked && <button type="button" disabled={!!busy} onClick={() => { if (window.confirm(`Unpair ${tablet.name}? It stops sending GPS and photos until paired again.`)) void act({ action: "revoke", tabletId: tablet.id }, "Unpaired."); }}>Unpair</button>}
      </div>
    </article>)}

    <div className="posTools carPairNew">
      <label><span>New tablet name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} /></label>
      <button type="button" disabled={!!busy} onClick={() => void act({ action: "pair", name }, "Pairing code below.")}>Pair car tablet</button>
    </div>
    {message && <p role="status">{message}</p>}

    <h3>Latest photos</h3>
    <CarPhotoGrid photos={photos} />
  </section>;
}
