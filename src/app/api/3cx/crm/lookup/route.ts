import { timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { apiError } from "@/lib/http";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import { ingestThreeCxLiveCall } from "@/lib/three-cx-live-calls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: Request): boolean {
  const expected = process.env.THREE_CX_CRM_SECRET?.trim();
  const supplied = request.headers.get("x-corner-ops-crm-secret")?.trim();
  return Boolean(expected && supplied && equal(expected, supplied));
}

function normalizedPhone(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : "";
}

export async function GET(request: Request) {
  try {
    if (!authorized(request))
      return Response.json({ error: "Invalid 3CX CRM secret." }, { status: 401 });
    const url = new URL(request.url);
    const phone = normalizedPhone(url.searchParams.get("number") || "");
    if (!phone)
      return Response.json({ error: "A valid caller phone number is required." }, { status: 400 });

    await ensureOrderingCustomerSchema();
    const bucket = Math.floor(Date.now() / 120_000);
    await ingestThreeCxLiveCall({
      callId: `crm-${phone}-${bucket}`,
      callerNumber: phone,
      queue: process.env.THREE_CX_DELI_QUEUE || "90",
      status: "ringing",
      startedAt: new Date().toISOString(),
    });

    const customer = (await getSql()`
      SELECT customer.id, customer.first_name, customer.last_name,
             customer.display_name, customer.email
      FROM ordering_customer_phones phone
      JOIN ordering_customers customer ON customer.id=phone.customer_id
      WHERE customer.business='Corner Deli'
        AND customer.merged_into_customer_id IS NULL
        AND RIGHT(regexp_replace(phone.normalized_phone,'\\D','','g'),10)=${phone}
      ORDER BY phone.is_primary DESC, phone.last_used_at DESC NULLS LAST
      LIMIT 1
    `)[0];

    const origin = url.origin;
    return Response.json({
      contacts: customer ? [{
        id: String(customer.id),
        firstName: String(customer.first_name || customer.display_name || "Customer"),
        lastName: String(customer.last_name || ""),
        email: String(customer.email || ""),
        phone,
        contactUrl: `${origin}/pos/deli/customers?customer=${encodeURIComponent(String(customer.id))}`,
      }] : [],
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
