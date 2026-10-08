import { getSql } from "@/lib/db";
import { ensureOrderingSchema } from "@/lib/ordering-db";
import type { ValidatedDeliveryAddress } from "@/lib/ordering-address";

let schemaPromise: Promise<void> | null = null;
export function ensureOrderingAddressSchema(): Promise<void> {
  if (!schemaPromise)
    schemaPromise = (async () => {
      await ensureOrderingSchema();
      const sql = getSql();
      await sql`
      CREATE TABLE IF NOT EXISTS ordering_order_delivery_addresses (
        order_id UUID PRIMARY KEY REFERENCES ordering_orders(id) ON DELETE CASCADE,
        entered_address TEXT NOT NULL, formatted_address TEXT NOT NULL, line1 TEXT NOT NULL,
        line2 TEXT NOT NULL DEFAULT '', city TEXT NOT NULL, state TEXT NOT NULL,
        postal_code TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'US', latitude NUMERIC(10,7) NOT NULL,
        longitude NUMERIC(10,7) NOT NULL, provider TEXT NOT NULL, provider_reference_id TEXT NOT NULL DEFAULT '',
        validation_status TEXT NOT NULL CHECK (validation_status IN ('validated')),
        validated_at TIMESTAMPTZ NOT NULL, route_distance_miles NUMERIC(7,2),
        route_duration_seconds INTEGER, route_provider TEXT NOT NULL DEFAULT '', route_calculated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
      await sql`ALTER TABLE ordering_order_delivery_addresses ADD COLUMN IF NOT EXISTS delivery_notes_snapshot TEXT NOT NULL DEFAULT ''`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  return schemaPromise;
}

export async function saveOrderDeliveryAddress(input: {
  orderId: string;
  address: ValidatedDeliveryAddress;
  line2?: string;
  customerAddressId?: string | null;
  route?: {
    distanceMiles: number;
    durationSeconds: number;
    provider: string;
    calculatedAt: string;
  } | null;
}) {
  await ensureOrderingAddressSchema();
  const sql = getSql();
  const note = input.customerAddressId
    ? String(
        (
          await sql`SELECT delivery_notes FROM ordering_customer_addresses WHERE id=${input.customerAddressId}`
        )[0]?.delivery_notes || "",
      )
    : "";
  await sql`
    INSERT INTO ordering_order_delivery_addresses (
      order_id, entered_address, formatted_address, line1, line2, city, state, postal_code,
      country, latitude, longitude, provider, provider_reference_id, validation_status,
      validated_at, route_distance_miles, route_duration_seconds, route_provider, route_calculated_at, customer_address_id, delivery_notes_snapshot
    ) VALUES (
      ${input.orderId}, ${input.address.enteredAddress}, ${input.address.formattedAddress}, ${input.address.line1}, ${String(
        input.line2 || "",
      )
        .trim()
        .slice(0, 120)},
      ${input.address.city}, ${input.address.state}, ${input.address.postalCode}, ${input.address.country}, ${input.address.latitude}, ${input.address.longitude},
      ${input.address.provider}, ${input.address.providerReferenceId}, 'validated', ${input.address.validatedAt},
      ${input.route?.distanceMiles ?? null}, ${input.route?.durationSeconds ?? null}, ${input.route?.provider || ""}, ${input.route?.calculatedAt || null}, ${input.customerAddressId || null}, ${note}
    )
    ON CONFLICT (order_id) DO UPDATE SET
      entered_address=EXCLUDED.entered_address,formatted_address=EXCLUDED.formatted_address,line1=EXCLUDED.line1,line2=EXCLUDED.line2,
      city=EXCLUDED.city,state=EXCLUDED.state,postal_code=EXCLUDED.postal_code,country=EXCLUDED.country,
      latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,provider=EXCLUDED.provider,provider_reference_id=EXCLUDED.provider_reference_id,
      validation_status='validated',validated_at=EXCLUDED.validated_at,route_distance_miles=EXCLUDED.route_distance_miles,
      route_duration_seconds=EXCLUDED.route_duration_seconds,route_provider=EXCLUDED.route_provider,route_calculated_at=EXCLUDED.route_calculated_at,
      customer_address_id=EXCLUDED.customer_address_id,delivery_notes_snapshot=EXCLUDED.delivery_notes_snapshot
  `;
  if (input.customerAddressId)
    await sql`UPDATE ordering_customer_addresses SET last_used_at=NOW(),updated_at=NOW() WHERE id=${input.customerAddressId}`;
  if (input.route)
    await sql`UPDATE ordering_orders SET delivery_distance_miles = ${input.route.distanceMiles}, updated_at = NOW() WHERE id = ${input.orderId}`;
}
