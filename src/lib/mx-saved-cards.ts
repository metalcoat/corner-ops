// Saved cards ("card on file") through MX Merchant's vault.
//
// Card numbers never reach Corner Ops: the customer's browser (or the POS
// card dialog) sends the card straight to MX's /vault endpoint with a
// limited-use token, MX stores it under an MX customer, and we keep only
// MX's vault token, the brand, last 4 and expiry in
// ordering_customer_payment_methods. Charging a saved card is a server-side
// Sale on that token. Verified in the MX sandbox (Oct 2026).
import { getSql } from "@/lib/db";
import { initializeMxPayment, MxMerchantError, MxMerchantUnreachableError, mxSandboxOnProduction } from "@/lib/mx-merchant";

const MAX_SAVED_CARDS = 10; // MX's limit per customer

function base() {
  return process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production"
    ? "https://api.mxmerchant.com/checkout/v3"
    : "https://sandbox.api.mxmerchant.com/checkout/v3";
}
function credentials() {
  if (mxSandboxOnProduction()) throw new MxMerchantError("Card payments are off: this production server is not set to MX production (MX_ENVIRONMENT).");
  const merchantId = process.env.MX_MERCHANT_ID?.trim(), key = process.env.MX_CONSUMER_KEY?.trim(), secret = process.env.MX_CONSUMER_SECRET?.trim();
  if (!merchantId || !key || !secret) throw new MxMerchantError("MX Merchant is not configured.");
  return { merchantId, authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}` };
}
async function mx(path: string, init: RequestInit = {}) {
  const { authorization } = credentials();
  let response: Response;
  try {
    response = await fetch(`${base()}${path}`, { ...init, headers: { authorization, accept: "application/json", "content-type": "application/json", ...init.headers }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new MxMerchantUnreachableError("Could not reach MX.");
  }
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  if (!response.ok) throw new MxMerchantError(`MX Merchant request failed (${response.status}).`);
  return body as Record<string, unknown> | null;
}

export type SavedCard = { id: string; brand: string; last4: string; expMonth: number | null; expYear: number | null };

export async function listSavedCards(customerId: string): Promise<SavedCard[]> {
  const rows = await getSql()`SELECT id,brand,last4,exp_month,exp_year FROM ordering_customer_payment_methods
    WHERE customer_id=${customerId} AND provider='mx_merchant' AND active AND reusable ORDER BY created_at DESC`;
  return rows.map((row) => ({ id: String(row.id), brand: String(row.brand), last4: String(row.last4), expMonth: row.exp_month == null ? null : Number(row.exp_month), expYear: row.exp_year == null ? null : Number(row.exp_year) }));
}

/** The customer's MX customer id, creating the MX customer the first time. */
async function mxCustomerFor(customerId: string): Promise<string> {
  const sql = getSql();
  const customer = (await sql`SELECT id,mx_customer_id,COALESCE(NULLIF(trim(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),''),display_name,'Corner Deli customer') name FROM ordering_customers WHERE id=${customerId} AND business='Corner Deli' AND active`)[0];
  if (!customer) throw new MxMerchantError("Customer account not found.");
  if (customer.mx_customer_id) return String(customer.mx_customer_id);
  const created = await mx(`/customer?echo=true`, { method: "POST", body: JSON.stringify({ merchantId: Number(credentials().merchantId), name: String(customer.name).slice(0, 100) }) });
  const mxId = String(created?.id || "");
  if (!mxId) throw new MxMerchantError("MX did not create the customer.");
  // Two requests at once must not leave two MX customers: keep whichever was saved first.
  const saved = (await sql`UPDATE ordering_customers SET mx_customer_id=${mxId},updated_at=NOW() WHERE id=${customerId} AND mx_customer_id='' RETURNING mx_customer_id`)[0];
  return saved ? mxId : String((await sql`SELECT mx_customer_id FROM ordering_customers WHERE id=${customerId}`)[0].mx_customer_id);
}

/**
 * What a browser needs to save a card at MX: a limited-use token and the MX
 * customer. The browser POSTs the card to `${vaultUrl}?token=…&customerid=…`.
 */
export async function startCardSave(customerId: string) {
  const existing = await listSavedCards(customerId);
  if (existing.length >= MAX_SAVED_CARDS) throw new MxMerchantError("You can save up to 10 cards. Remove one first.");
  const mxCustomerId = await mxCustomerFor(customerId);
  const { token } = await initializeMxPayment();
  return { token, mxCustomerId, vaultUrl: `${base()}/vault` };
}

/** Reads the customer's cards back from MX and records them (new ones with the consent source). */
export async function syncSavedCards(customerId: string, consentSource: string): Promise<SavedCard[]> {
  const sql = getSql();
  const mxCustomerId = String((await sql`SELECT mx_customer_id FROM ordering_customers WHERE id=${customerId}`)[0]?.mx_customer_id || "");
  if (!mxCustomerId) return [];
  const listed = await mx(`/customercardaccount?id=${encodeURIComponent(mxCustomerId)}`);
  const records = (Array.isArray(listed?.records) ? listed?.records : Array.isArray(listed) ? listed : []) as Array<Record<string, unknown>>;
  const tokens: string[] = [];
  for (const card of records) {
    const token = String(card.token || "");
    if (!token) continue;
    tokens.push(token);
    const last4 = String(card.last4 || "").replace(/\D/g, "").slice(-4);
    const month = Number(card.expiryMonth) || null, year = Number(card.expiryYear) || null;
    await sql`INSERT INTO ordering_customer_payment_methods(id,business,customer_id,provider,provider_customer_reference,provider_payment_method_reference,brand,last4,exp_month,exp_year,reusable,active,consent_source,consent_at)
      VALUES(gen_random_uuid(),'Corner Deli',${customerId},'mx_merchant',${mxCustomerId},${token},${String(card.cardType || "Card")},${last4.length === 4 ? last4 : ""},${month && month >= 1 && month <= 12 ? month : null},${year && year < 100 ? 2000 + year : year},TRUE,TRUE,${consentSource},NOW())
      ON CONFLICT(business,provider,provider_payment_method_reference) DO UPDATE SET active=TRUE,customer_id=EXCLUDED.customer_id,updated_at=NOW()`;
  }
  // Cards removed at MX are no longer offered.
  await sql`UPDATE ordering_customer_payment_methods SET active=FALSE,updated_at=NOW() WHERE customer_id=${customerId} AND provider='mx_merchant' AND active AND NOT (provider_payment_method_reference = ANY(${tokens}))`;
  return listSavedCards(customerId);
}

export async function removeSavedCard(customerId: string, paymentMethodId: string) {
  const sql = getSql();
  const row = (await sql`SELECT provider_customer_reference,provider_payment_method_reference FROM ordering_customer_payment_methods WHERE id=${paymentMethodId} AND customer_id=${customerId} AND provider='mx_merchant' AND active`)[0];
  if (!row) throw new MxMerchantError("That card isn't saved on this account.");
  const listed = await mx(`/customercardaccount?id=${encodeURIComponent(String(row.provider_customer_reference))}`);
  const records = (Array.isArray(listed?.records) ? listed?.records : []) as Array<Record<string, unknown>>;
  const match = records.find((card) => String(card.token) === String(row.provider_payment_method_reference));
  if (match?.id) await mx(`/customercardaccount?id=${encodeURIComponent(String(row.provider_customer_reference))}&subId=${encodeURIComponent(String(match.id))}`, { method: "DELETE" });
  await sql`UPDATE ordering_customer_payment_methods SET active=FALSE,updated_at=NOW() WHERE id=${paymentMethodId}`;
  return listSavedCards(customerId);
}

/** A Sale on a saved card (server side). Returns MX's payment record; throws if declined. */
export async function chargeSavedCard(input: { customerId: string; paymentMethodId: string; amountCents: number; replayId: number }) {
  const row = (await getSql()`SELECT provider_customer_reference,provider_payment_method_reference FROM ordering_customer_payment_methods WHERE id=${input.paymentMethodId} AND customer_id=${input.customerId} AND provider='mx_merchant' AND active AND reusable`)[0];
  if (!row) throw new MxMerchantError("That saved card isn't available. Choose another payment.");
  const { merchantId } = credentials();
  const payment = await mx(`/payment?echo=true`, {
    method: "POST",
    body: JSON.stringify({
      merchantId: Number(merchantId), tenderType: "Card", paymentType: "Sale", amount: (input.amountCents / 100).toFixed(2),
      replayId: input.replayId, source: "API", customerId: Number(row.provider_customer_reference),
      cardAccount: { token: String(row.provider_payment_method_reference) },
    }),
  });
  if (!String(payment?.status || "").toLowerCase().includes("approve"))
    throw new MxMerchantError(String(payment?.authMessage || "The saved card was declined. Choose another payment."));
  return payment as Record<string, unknown>;
}
