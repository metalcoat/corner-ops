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
