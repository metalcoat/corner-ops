// Where Corner Deli is, for maps and route planning. DELI_ORIGIN_LATITUDE /
// DELI_ORIGIN_LONGITUDE win when set; otherwise the store address is geocoded
// once with the same Google provider used for customer addresses and saved.
import { getSql } from "@/lib/db";
import { addressProviderStatus, validateDeliveryAddress } from "@/lib/ordering-address";
import { deliveryOrigin } from "@/lib/ordering-delivery-route";

export const DEFAULT_DELI_ADDRESS = "828 Morris St, Ogdensburg, NY 13669";
type Coordinates = { latitude: number; longitude: number };

let cached: { address: string; location: Coordinates } | null = null;
let failedAt = 0;
const RETRY_AFTER_MS = 10 * 60_000;

export async function deliLocation(): Promise<Coordinates | null> {
  const fromEnv = deliveryOrigin();
  if (fromEnv) return fromEnv;
  const address = process.env.DELI_ORIGIN_ADDRESS?.trim() || DEFAULT_DELI_ADDRESS;
  if (cached?.address === address) return cached.location;
  try {
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_store_locations(address TEXT PRIMARY KEY, latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL, formatted_address TEXT NOT NULL DEFAULT '', geocoded_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    const saved = (await sql`SELECT latitude,longitude FROM ordering_store_locations WHERE address=${address}`)[0];
    if (saved) {
      cached = { address, location: { latitude: Number(saved.latitude), longitude: Number(saved.longitude) } };
      return cached.location;
    }
    if (!addressProviderStatus().configured || Date.now() - failedAt < RETRY_AFTER_MS) return null;
    const result = await validateDeliveryAddress({ enteredAddress: address, sessionToken: crypto.randomUUID() });
    await sql`INSERT INTO ordering_store_locations(address,latitude,longitude,formatted_address)VALUES(${address},${result.latitude},${result.longitude},${result.formattedAddress}) ON CONFLICT(address) DO NOTHING`;
    cached = { address, location: { latitude: result.latitude, longitude: result.longitude } };
    return cached.location;
  } catch (error) {
    failedAt = Date.now();
    console.error("Deli location lookup failed", error);
    return null;
  }
}
