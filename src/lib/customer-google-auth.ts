import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("Customer authentication is not configured.");
  return value;
}
function signature(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}
export function googleState() {
  const value = Buffer.from(
    JSON.stringify({
      nonce: randomBytes(24).toString("base64url"),
      expires: Date.now() + 600000,
    }),
  ).toString("base64url");
  return `${value}.${signature(value)}`;
}
export function verifyGoogleState(value: string) {
  const [body, supplied] = value.split(".");
  if (!body || !supplied) return false;
  const expected = signature(body),
    a = Buffer.from(expected),
    b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    return (
      JSON.parse(Buffer.from(body, "base64url").toString()).expires > Date.now()
    );
  } catch {
    return false;
  }
}
export async function linkGoogleCustomer(profile: {
  sub: string;
  email: string;
  email_verified: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
}) {
  if (!profile.sub || !profile.email_verified)
    throw new Error("Google did not return a verified email address.");
  await ensureCustomerOrderingSchema();
  const sql = getSql(),
    email = profile.email.trim().toLowerCase();
  const identity = (
    await sql`SELECT customer_id FROM ordering_customer_identities WHERE provider='google' AND provider_subject=${profile.sub}`
  )[0];
  let customerId = identity?.customer_id as string | undefined;
  if (!customerId) {
    const existing = (
      await sql`SELECT id FROM ordering_customers WHERE business='Corner Deli' AND lower(email)=${email} AND active=TRUE LIMIT 1`
    )[0];
    customerId = String(existing?.id || randomUUID());
    if (!existing)
      await sql`INSERT INTO ordering_customers(id,business,display_name,first_name,last_name,email)VALUES(${customerId},'Corner Deli',${profile.name || email},${profile.given_name || ""},${profile.family_name || ""},${email})`;
    await sql`INSERT INTO ordering_customer_identities(id,customer_id,provider,provider_subject,email)VALUES(${randomUUID()},${customerId},'google',${profile.sub},${email})`;
  } else
    await sql`UPDATE ordering_customer_identities SET last_login_at=NOW() WHERE provider='google' AND provider_subject=${profile.sub}`;
  return customerId;
}
