import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { normalizeCallerPhone } from "@/lib/ordering-core";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingLoyaltySchema } from "@/lib/ordering-loyalty-schema";

export function displayPhone(normalized: string): string {
  const digits = normalized.replace(/\D/g, "");
  const local =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length === 10
    ? `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`
    : normalized;
}

export async function findCustomers(business: OrderingBusiness, query = "") {
  await ensureOrderingCustomerSchema();
  const sql = getSql();
  const q = query.trim();
  const phone = normalizeCallerPhone(q);
  const phoneDigits = q.replace(/\D/g, "");
  const phonePrefix = phoneDigits
    ? `${phoneDigits.length <= 10 ? `+1${phoneDigits}` : `+${phoneDigits}`}%`
    : "";
  const like = `%${q}%`;
  return sql`
    SELECT c.id,c.first_name,c.last_name,c.display_name,c.email,c.notes,c.active,c.created_at,c.updated_at,c.last_order_at,
      p.normalized_phone,p.display_phone,
      COALESCE((SELECT json_agg(phone ORDER BY phone.is_primary DESC,phone.last_used_at DESC NULLS LAST,phone.created_at) FROM ordering_customer_phones phone WHERE phone.customer_id=c.id),'[]') phones,
      COALESCE((SELECT json_agg(a ORDER BY a.is_primary DESC,a.last_used_at DESC NULLS LAST,a.created_at DESC) FROM ordering_customer_addresses a WHERE a.customer_id=c.id AND a.active=TRUE),'[]') addresses
    FROM ordering_customers c
    LEFT JOIN LATERAL (SELECT normalized_phone,display_phone FROM ordering_customer_phones WHERE customer_id=c.id ORDER BY is_primary DESC,created_at LIMIT 1) p ON TRUE
    WHERE c.business=${business} AND c.active=TRUE AND c.merged_into_customer_id IS NULL
      AND (${q}='' OR c.first_name ILIKE ${like} OR c.last_name ILIKE ${like} OR c.display_name ILIKE ${like}
        OR EXISTS (SELECT 1 FROM ordering_customer_phones match_phone WHERE match_phone.customer_id=c.id AND (match_phone.normalized_phone=${phone} OR (${phonePrefix}<>'' AND match_phone.normalized_phone LIKE ${phonePrefix}))))
    ORDER BY c.last_order_at DESC NULLS LAST,c.display_name LIMIT ${q ? 20 : 100}
  `;
}

export async function findPhoneMatches(
  business: OrderingBusiness,
  value: string,
  excludeCustomerId = "",
) {
  const normalized = normalizeCallerPhone(value);
  if (!/^\+1\d{10}$/.test(normalized)) return [];
  await ensureOrderingCustomerSchema();
  return getSql()`
    SELECT c.id customer_id,c.display_name,phone.id phone_id,phone.label,phone.normalized_phone,phone.display_phone
    FROM ordering_customer_phones phone JOIN ordering_customers c ON c.id=phone.customer_id
    WHERE c.business=${business} AND c.active=TRUE AND c.merged_into_customer_id IS NULL
      AND phone.normalized_phone=${normalized} AND (${excludeCustomerId || null}::uuid IS NULL OR c.id<>${excludeCustomerId || null}::uuid)
    ORDER BY c.display_name
  `;
}

export async function createCustomer(input: {
  business: OrderingBusiness;
  firstName: string;
  lastName?: string;
  phone: string;
  email?: string;
  notes?: string;
}) {
  await ensureOrderingCustomerSchema();
  const normalized = normalizeCallerPhone(input.phone);
  if (!/^\+1\d{10}$/.test(normalized))
    throw new Error("Enter a valid 10-digit US/Canada phone number.");
  const first = input.firstName.trim();
  if (!first) throw new Error("First name is required.");
  const last = String(input.lastName || "").trim();
  return withTransaction(async () => {
    const sql = getSql();
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.business}:${normalized}`}))`;
    const existing = await findCustomers(input.business, normalized);
    if (existing.length) return { customer: existing[0], duplicate: true };
    const id = randomUUID();
    await sql`INSERT INTO ordering_customers (id,business,display_name,first_name,last_name,email,notes) VALUES (${id},${input.business},${`${first} ${last}`.trim()},${first},${last},${String(input.email || "").trim()},${String(input.notes || "").trim()})`;
    await sql`INSERT INTO ordering_customer_phones (id,customer_id,normalized_phone,display_phone,is_primary) VALUES (${randomUUID()},${id},${normalized},${displayPhone(normalized)},TRUE)`;
    return {
      customer: (await findCustomers(input.business, normalized))[0],
      duplicate: false,
    };
  });
}

export async function addCustomerPhone(input: {
  business: OrderingBusiness;
  customerId: string;
  phone: string;
  label?: string;
  isPrimary?: boolean;
  allowShared?: boolean;
}) {
  await ensureOrderingCustomerSchema();
  const normalized = normalizeCallerPhone(input.phone);
  if (!/^\+1\d{10}$/.test(normalized))
    throw new Error("Enter a valid 10-digit US/Canada phone number.");
  return withTransaction(async () => {
    const sql = getSql();
    const customer =
      await sql`SELECT id FROM ordering_customers WHERE id=${input.customerId} AND business=${input.business} AND active=TRUE AND merged_into_customer_id IS NULL FOR UPDATE`;
    if (!customer[0]) throw new Error("Active customer not found.");
    const existing =
      await sql`SELECT * FROM ordering_customer_phones WHERE customer_id=${input.customerId} AND normalized_phone=${normalized}`;
    if (existing[0])
      return { phone: existing[0], duplicate: false, alreadyAssociated: true };
    const matches = await findPhoneMatches(
      input.business,
      normalized,
      input.customerId,
    );
    if (matches.length && !input.allowShared)
      return { duplicate: true, matches };
    const primaryRows =
      await sql`SELECT id FROM ordering_customer_phones WHERE customer_id=${input.customerId} AND is_primary=TRUE`;
    const isPrimary = Boolean(input.isPrimary) || primaryRows.length === 0;
    if (isPrimary)
      await sql`UPDATE ordering_customer_phones SET is_primary=FALSE,updated_at=NOW() WHERE customer_id=${input.customerId}`;
    const id = randomUUID();
    const rows =
      await sql`INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,label,is_primary,last_used_at) VALUES(${id},${input.customerId},${normalized},${displayPhone(normalized)},${String(input.label || "Mobile").trim()},${isPrimary},NOW()) RETURNING *`;
    return { phone: rows[0], duplicate: false, shared: matches.length > 0 };
  });
}

export async function addCustomerAddress(input: {
  business: OrderingBusiness;
  customerId: string;
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  standardizedAddress?: string;
  provider?: string;
  providerReferenceId?: string;
  latitude?: number | null;
  longitude?: number | null;
  isPrimary?: boolean;
}) {
  await ensureOrderingCustomerSchema();
  const customer =
    await getSql()`SELECT id FROM ordering_customers WHERE id=${input.customerId} AND business=${input.business} AND active=TRUE AND merged_into_customer_id IS NULL`;
  if (!customer[0]) throw new Error("Active customer not found.");
  if (
    !input.line1.trim() ||
    !input.city.trim() ||
    !input.state.trim() ||
    !input.postalCode.trim()
  )
    throw new Error("Street, city, state, and postal code are required.");
  return withTransaction(async () => {
    const sql = getSql();
    const line1 = input.line1.trim(),
      line2 = String(input.line2 || "").trim(),
      postal = input.postalCode.trim();
    const existing =
      await sql`SELECT id FROM ordering_customer_addresses WHERE customer_id=${input.customerId} AND active=TRUE AND lower(line1)=lower(${line1}) AND lower(line2)=lower(${line2}) AND postal_code=${postal}`;
    if (existing[0]) {
      if (input.isPrimary) {
        await sql`UPDATE ordering_customer_addresses SET is_primary=FALSE,updated_at=NOW() WHERE customer_id=${input.customerId} AND active=TRUE`;
        await sql`UPDATE ordering_customer_addresses SET is_primary=TRUE,last_used_at=NOW(),updated_at=NOW() WHERE id=${existing[0].id}`;
      }
      return String(existing[0].id);
    }
    const primaryRows =
      await sql`SELECT id FROM ordering_customer_addresses WHERE customer_id=${input.customerId} AND active=TRUE AND is_primary=TRUE`;
    const isPrimary = Boolean(input.isPrimary) || primaryRows.length === 0;
    if (isPrimary)
      await sql`UPDATE ordering_customer_addresses SET is_primary=FALSE,updated_at=NOW() WHERE customer_id=${input.customerId} AND active=TRUE`;
    const id = randomUUID();
    await sql`INSERT INTO ordering_customer_addresses (id,customer_id,label,line1,line2,city,state,postal_code,standardized_address,provider,provider_reference_id,latitude,longitude,last_used_at,is_primary) VALUES (${id},${input.customerId},${String(input.label || "Address")},${line1},${line2},${input.city.trim()},${input.state.trim()},${postal},${String(input.standardizedAddress || "").trim()},${String(input.provider || "")},${String(input.providerReferenceId || "")},${input.latitude ?? null},${input.longitude ?? null},NOW(),${isPrimary})`;
    return id;
  });
}

export async function mergeCustomers(input: {
  business: OrderingBusiness;
  survivorId: string;
  mergedId: string;
  actorId: string;
}) {
  if (input.survivorId === input.mergedId)
    throw new Error("Choose two different customers.");
  await ensureOrderingCustomerSchema();
  await ensureOrderingLoyaltySchema();
  return withTransaction(async () => {
    const sql = getSql();
    const rows =
      await sql`SELECT * FROM ordering_customers WHERE business=${input.business} AND id IN (${input.survivorId},${input.mergedId}) FOR UPDATE`;
    const survivor = rows.find((row) => row.id === input.survivorId);
    const merged = rows.find((row) => row.id === input.mergedId);
    if (
      !survivor ||
      !merged ||
      survivor.merged_into_customer_id ||
      merged.merged_into_customer_id
    )
      throw new Error("Both customers must be active canonical records.");
    await sql`UPDATE ordering_orders SET customer_id=${input.survivorId},updated_at=NOW() WHERE customer_id=${input.mergedId}`;
    await sql`UPDATE ordering_loyalty_ledger SET customer_id=${input.survivorId} WHERE customer_id=${input.mergedId}`;
    await sql`UPDATE ordering_order_loyalty_applications application SET customer_id=${input.survivorId} FROM ordering_orders orders WHERE application.customer_id=${input.mergedId} AND application.redemption_event_id IS NULL AND orders.id=application.order_id AND orders.status='draft'`;
    await sql`UPDATE ordering_customer_addresses a SET customer_id=${input.survivorId},is_primary=FALSE,updated_at=NOW() WHERE customer_id=${input.mergedId} AND NOT EXISTS (SELECT 1 FROM ordering_customer_addresses s WHERE s.customer_id=${input.survivorId} AND s.active=TRUE AND a.active=TRUE AND ((s.standardized_address<>'' AND lower(s.standardized_address)=lower(a.standardized_address)) OR (lower(s.line1)=lower(a.line1) AND lower(s.line2)=lower(a.line2) AND s.postal_code=a.postal_code)))`;
    await sql`UPDATE ordering_customer_addresses SET active=FALSE WHERE customer_id=${input.mergedId}`;
    await sql`UPDATE ordering_customer_phones p SET customer_id=${input.survivorId},is_primary=FALSE WHERE customer_id=${input.mergedId} AND NOT EXISTS (SELECT 1 FROM ordering_customer_phones s WHERE s.customer_id=${input.survivorId} AND s.normalized_phone=p.normalized_phone)`;
    await sql`DELETE FROM ordering_customer_phones WHERE customer_id=${input.mergedId}`;
    if (
      !(
        await sql`SELECT id FROM ordering_customer_phones WHERE customer_id=${input.survivorId} AND is_primary=TRUE`
      )[0]
    )
      await sql`UPDATE ordering_customer_phones SET is_primary=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM ordering_customer_phones WHERE customer_id=${input.survivorId} ORDER BY last_used_at DESC NULLS LAST,created_at LIMIT 1)`;
    if (
      !(
        await sql`SELECT id FROM ordering_customer_addresses WHERE customer_id=${input.survivorId} AND active=TRUE AND is_primary=TRUE`
      )[0]
    )
      await sql`UPDATE ordering_customer_addresses SET is_primary=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM ordering_customer_addresses WHERE customer_id=${input.survivorId} AND active=TRUE ORDER BY last_used_at DESC NULLS LAST,created_at LIMIT 1)`;
    const combinedNotes = [
      survivor.notes,
      merged.notes && `Merged from ${merged.display_name}: ${merged.notes}`,
    ]
      .filter(Boolean)
      .join("\n");
    await sql`UPDATE ordering_customers SET notes=${combinedNotes},updated_at=NOW() WHERE id=${input.survivorId}`;
    await sql`UPDATE ordering_customers SET active=FALSE,merged_into_customer_id=${input.survivorId},merged_at=NOW(),updated_at=NOW() WHERE id=${input.mergedId}`;
    await sql`INSERT INTO ordering_customer_merge_events (id,business,surviving_customer_id,merged_customer_id,actor_id,field_choices) VALUES (${randomUUID()},${input.business},${input.survivorId},${input.mergedId},${input.actorId},${JSON.stringify({ name: "survivor", notes: "combined", phones: "deduplicated_normalized", addresses: "deduplicated_standardized", primary: "survivor_retained" })}::jsonb)`;
    return { survivorId: input.survivorId, mergedId: input.mergedId };
  });
}
