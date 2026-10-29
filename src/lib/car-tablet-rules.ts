/**
 * Pure rules for the delivery-car tablet (tools/car-tablet): pairing codes, GPS batch checks,
 * online status. Kept free of database imports so tests can load it directly.
 */

/** No 0/O, 1/I/L: the code is read off the POS screen and typed on the tablet. */
export const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_MINUTES = 15;
/** The tablet heartbeats every 30 s and long-polls for commands; 90 s of silence is offline. */
export const ONLINE_SECONDS = 90;
export const MAX_POINTS_PER_BATCH = 500;
export const CAMERAS = ["cabin", "road"] as const;
export const PHOTO_REASONS = ["manual", "delivery_complete", "remote_request"] as const;
export type CarCamera = typeof CAMERAS[number];
export type CarPhotoReason = typeof PHOTO_REASONS[number];

export function pairingCode(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH * 2);
  let code = "";
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % PAIRING_ALPHABET.length);
  for (let index = 0; index < bytes.length && code.length < PAIRING_CODE_LENGTH; index++) {
    if (bytes[index] < limit) code += PAIRING_ALPHABET[bytes[index] % PAIRING_ALPHABET.length];
  }
  if (code.length < PAIRING_CODE_LENGTH) return pairingCode(randomBytes);
  return code;
}

/** What the person typed: spaces, dashes and lower case allowed. */
export function normalizePairingCode(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[\s-]/g, "");
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export type CarPoint = {
  id: string;
  capturedAt: Date;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
};

function optionalNumber(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

/**
 * Checks a batch from the tablet. Bad points are dropped (and counted) rather than failing
 * the batch, so one garbage fix can't wedge the tablet's upload queue forever.
 */
export function parsePointBatch(input: unknown, now = new Date()): { points: CarPoint[]; rejected: number } {
  const list = Array.isArray(input) ? input.slice(0, MAX_POINTS_PER_BATCH) : [];
  const points: CarPoint[] = [];
  let rejected = Array.isArray(input) ? Math.max(0, input.length - MAX_POINTS_PER_BATCH) : 0;
  for (const raw of list) {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = String(item.id ?? "").trim().slice(0, 64);
    const capturedAt = new Date(typeof item.capturedAt === "number" ? item.capturedAt : String(item.capturedAt ?? ""));
    const latitude = Number(item.latitude ?? item.lat), longitude = Number(item.longitude ?? item.lng);
    const valid = id.length >= 8
      && Number.isFinite(capturedAt.getTime())
      // A wrong clock (no network time yet after boot) gives points far in the future.
      && capturedAt.getTime() <= now.getTime() + 5 * 60_000
      && capturedAt.getTime() >= now.getTime() - 14 * 24 * 3600_000
      && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      && !(latitude === 0 && longitude === 0);
    if (!valid) { rejected++; continue; }
    points.push({
      id,
      capturedAt,
      latitude,
      longitude,
      accuracy: optionalNumber(item.accuracy, 0, 100_000),
      speed: optionalNumber(item.speed, 0, 120),
      heading: optionalNumber(item.heading, 0, 360),
    });
  }
  return { points, rejected };
}

export function isOnline(lastSeenAt: string | Date | null | undefined, now = new Date()): boolean {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt).getTime();
  return Number.isFinite(seen) && now.getTime() - seen <= ONLINE_SECONDS * 1000;
}

/** "cabin", "road" or "both" from the POS → the cameras to fire, in order. */
export function snapCameras(value: unknown): CarCamera[] {
  if (value === "both") return ["cabin", "road"];
  return CAMERAS.includes(value as CarCamera) ? [value as CarCamera] : [];
}

/** Within this of the address with the car (nearly) stopped = arrived. */
export const ARRIVE_METRES = 60;
export const STOPPED_MPS = 2.5;
/** Arrived, then this far away = the car has left the stop. */
export const DEPART_METRES = 200;
/** A real drop-off: at least this long between arriving and leaving. */
export const MIN_STOP_SECONDS = 20;

export type StopDelivery = { id: string; status: string; latitude: number; longitude: number; enRouteAt: Date | null; arrivedAt: Date | null };
export type StopTransition = { deliveryId: string; action: "arrived" | "delivered"; at: Date };

export function metresBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude), dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Which delivery the car stopped at, from GPS alone (owner request 2026-10-29): a slow or stopped
 * point near an on-the-way delivery's address marks it arrived; driving off (DEPART_METRES away,
 * after at least MIN_STOP_SECONDS) marks an arrived delivery delivered. Points are replayed in
 * time order, so a batch sent after a dead zone gives the same answer as live points.
 */
export function stopTransitions(deliveries: StopDelivery[], points: CarPoint[]): StopTransition[] {
  const state = new Map(deliveries.map((delivery) => [delivery.id, { ...delivery }]));
  const transitions: StopTransition[] = [];
  for (const point of [...points].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())) {
    for (const delivery of state.values()) {
      if (delivery.enRouteAt && point.capturedAt < delivery.enRouteAt) continue;
      const distance = metresBetween(point, delivery);
      if (delivery.status === "EN_ROUTE" && distance <= ARRIVE_METRES && (point.speed == null || point.speed <= STOPPED_MPS)) {
        delivery.status = "ARRIVED";
        delivery.arrivedAt = point.capturedAt;
        transitions.push({ deliveryId: delivery.id, action: "arrived", at: point.capturedAt });
      } else if (delivery.status === "ARRIVED" && delivery.arrivedAt && distance >= DEPART_METRES
        && point.capturedAt.getTime() - delivery.arrivedAt.getTime() >= MIN_STOP_SECONDS * 1000) {
        delivery.status = "DELIVERED";
        transitions.push({ deliveryId: delivery.id, action: "delivered", at: point.capturedAt });
      }
    }
  }
  return transitions;
}
