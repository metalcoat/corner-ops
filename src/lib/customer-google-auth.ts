import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
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
  const email = profile.email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email))
    throw new Error("Google did not return a valid email address.");
  return withTransaction(async () => {
    const sql = getSql();
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`google:${email}`}))`;
    const identity = (
      await sql`SELECT customer_id FROM ordering_customer_identities WHERE provider='google' AND provider_subject=${profile.sub}`
    )[0];
    if (identity) {
      await sql`UPDATE ordering_customer_identities SET last_login_at=NOW(),email=${email} WHERE provider='google' AND provider_subject=${profile.sub}`;
      return String(identity.customer_id);
    }
    const emailIdentity = (
      await sql`SELECT customer_id FROM ordering_customer_identities WHERE provider='google' AND email=${email}`
    )[0];
    if (emailIdentity) {
      await sql`UPDATE ordering_customer_identities SET provider_subject=${profile.sub},last_login_at=NOW() WHERE provider='google' AND email=${email}`;
      return String(emailIdentity.customer_id);
    }

    const matches = await sql`
      SELECT DISTINCT customer.id
      FROM ordering_customers customer
      LEFT JOIN ordering_customer_emails saved_email ON saved_email.customer_id=customer.id
      WHERE customer.business='Corner Deli' AND customer.active=TRUE
        AND customer.merged_into_customer_id IS NULL
        AND (lower(customer.email)=${email} OR saved_email.normalized_email=${email})
    `;
    if (matches.length > 1)
      throw new Error(
        "More than one customer account uses this email. Please call the deli so we can combine them before Google sign-in.",
      );

    const customerId = matches[0]?.id ? String(matches[0].id) : randomUUID();
    if (!matches.length) {
      const firstName = String(profile.given_name || "").trim();
      const lastName = String(profile.family_name || "").trim();
      const displayName =
        String(profile.name || "").trim() ||
        `${firstName} ${lastName}`.trim() ||
        email;
      await sql`INSERT INTO ordering_customers(id,business,display_name,first_name,last_name,email) VALUES(${customerId},'Corner Deli',${displayName},${firstName},${lastName},${email})`;
    }
    await sql`INSERT INTO ordering_customer_emails(id,customer_id,normalized_email,display_email,is_primary)
      SELECT ${randomUUID()},${customerId},${email},${profile.email.trim()},NOT EXISTS(SELECT 1 FROM ordering_customer_emails WHERE customer_id=${customerId})
      WHERE NOT EXISTS(SELECT 1 FROM ordering_customer_emails WHERE customer_id=${customerId} AND normalized_email=${email})`;
    await sql`UPDATE ordering_customers SET email=CASE WHEN trim(email)='' THEN ${profile.email.trim()} ELSE email END,updated_at=NOW() WHERE id=${customerId}`;
    await sql`INSERT INTO ordering_customer_identities(id,customer_id,provider,provider_subject,email) VALUES(${randomUUID()},${customerId},'google',${profile.sub},${email})`;
    return customerId;
  });
}
