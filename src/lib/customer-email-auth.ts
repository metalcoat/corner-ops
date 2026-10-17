import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { getSql } from "@/lib/db";
import { sendTransactionalEmail } from "@/lib/transactional-email";

const normalize = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 320);
function digest(email: string, code: string) {
  return createHmac("sha256", process.env.SESSION_SECRET || "")
    .update(`${email}:${code}`)
    .digest("hex");
}
function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function requestCustomerEmailCode(rawEmail: unknown) {
  const email = normalize(rawEmail);
  if (!/^\S+@\S+\.\S+$/.test(email))
    throw new Error("Enter a valid email address.");
  await ensureCustomerOrderingSchema();
  const sql = getSql();
  const recent =
    await sql`SELECT COUNT(*)::integer count FROM ordering_customer_email_codes WHERE email=${email} AND created_at>NOW()-INTERVAL '15 minutes'`;
  if (Number(recent[0]?.count || 0) >= 3)
    throw new Error("Too many codes requested. Wait 15 minutes and try again.");
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  await sql`INSERT INTO ordering_customer_email_codes(id,email,code_hash,expires_at)VALUES(${randomUUID()},${email},${digest(email, code)},NOW()+INTERVAL '10 minutes')`;
  const sent = await sendTransactionalEmail({
    to: email,
    subject: "Your Corner Deli sign-in code",
    text: `Your Corner Deli sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not request this code, you can ignore this email.`,
  });
  if (!sent.sent)
    throw new Error("The sign-in email could not be sent. Please try again.");
  return { sent: true };
}

export async function verifyCustomerEmailCode(
  rawEmail: unknown,
  rawCode: unknown,
) {
  const email = normalize(rawEmail),
    code = String(rawCode || "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit code.");
  await ensureCustomerOrderingSchema();
  const sql = getSql();
  const row = (
    await sql`SELECT * FROM ordering_customer_email_codes WHERE email=${email} AND used_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`
  )[0];
  if (
    !row ||
    Number(row.attempts) >= 5 ||
    !equal(String(row.code_hash), digest(email, code))
  ) {
    if (row)
      await sql`UPDATE ordering_customer_email_codes SET attempts=attempts+1 WHERE id=${row.id}`;
    throw new Error("The code is incorrect or expired.");
  }
  await sql`UPDATE ordering_customer_email_codes SET used_at=NOW() WHERE id=${row.id}`;
  let customer = (
    await sql`SELECT id FROM ordering_customers WHERE business='Corner Deli' AND lower(email)=${email} AND active=TRUE ORDER BY created_at LIMIT 1`
  )[0];
  if (!customer) {
    const id = randomUUID();
    await sql`INSERT INTO ordering_customers(id,business,display_name,email)VALUES(${id},'Corner Deli',${email.split("@")[0]},${email})`;
    customer = { id };
  }
  await sql`UPDATE ordering_orders SET customer_id=${customer.id} WHERE business='Corner Deli' AND source='web' AND customer_id IS NULL AND lower(email_snapshot)=${email}`;
  return String(customer.id);
}
