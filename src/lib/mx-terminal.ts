// Card-present payments on an MX-registered terminal (the Dejavoo at the
// payment station) through MX's Terminal API
// (https://developer.mxmerchant.com/reference/terminal-overview).
//
// The Terminal API lives on api2 and uses a bearer JWT issued from the same
// consumer key/secret as the Checkout API. A sale is sent to the terminal,
// the POS polls its status, and the approved payment is then read back from
// the Checkout API by replayId, so the amount and card come from MX itself.
import { randomInt } from "node:crypto";
import { MxMerchantError, MxMerchantUnreachableError } from "@/lib/mx-merchant";

/**
 * MX's answer never arrived (timeout, dropped connection, gateway error), so a
 * sale may or may not have reached the terminal. Callers must look the sale up
 * by replayId before treating it as failed.
 */
export class MxTerminalUnreachableError extends MxMerchantUnreachableError {}

const production = () => process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production";
function api2Base() {
  if (production()) return "https://api2.mxmerchant.com";
  // Test-only override for a local stand-in of the MX sandbox; ignored in production.
  return (process.env.MX_TEST_TERMINAL_API_BASE_URL?.trim() || "https://sandbox-api2.mxmerchant.com").replace(/\/+$/, "");
}
function credentials() {
  const merchantId = process.env.MX_MERCHANT_ID?.trim(), key = process.env.MX_CONSUMER_KEY?.trim(), secret = process.env.MX_CONSUMER_SECRET?.trim();
  if (!merchantId || !key || !secret) throw new MxMerchantError("MX Merchant is not configured.");
  return { merchantId, key, basic: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}` };
}

/** Terminal sales are switched on separately, once the terminal is certified on the account. */
export function mxTerminalEnabled() {
  return process.env.MX_TERMINAL_API_ENABLED?.trim() === "true"
    && Boolean(process.env.MX_MERCHANT_ID?.trim() && process.env.MX_CONSUMER_KEY?.trim() && process.env.MX_CONSUMER_SECRET?.trim());
}

// MX's terminal routes only accept the terminal's GUID (not its numeric id), upper case.
const TERMINAL_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;
export function normalizeMxTerminalId(value: unknown) {
  const id = String(value ?? "").trim().toUpperCase();
  return TERMINAL_ID.test(id) ? id : "";
}

/** The Terminal API wants a unique 15-digit replayId (the keyed Checkout flow uses int32 instead). */
export function newTerminalReplayId() {
  const seven = () => String(randomInt(0, 10_000_000)).padStart(7, "0");
  return Number(`${randomInt(1, 10)}${seven()}${seven()}`);
}

let cachedJwt: { cacheKey: string; token: string; refreshAt: number } | null = null;
async function jwt(forceRefresh = false) {
  const { merchantId, key, basic } = credentials(), cacheKey = `${api2Base()}|${merchantId}|${key}`;
  if (!forceRefresh && cachedJwt?.cacheKey === cacheKey && cachedJwt.refreshAt > Date.now()) return cachedJwt.token;
  const response = await fetch(`${api2Base()}/security/v1/application/merchantId/${encodeURIComponent(merchantId)}/token`, {
    headers: { authorization: basic, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new MxMerchantError(response.status === 401 || response.status === 403 ? "MX rejected the API credentials for the terminal API." : `MX terminal sign-in failed (${response.status}).`);
  const token = String(((await response.json().catch(() => null)) as { jwtToken?: unknown } | null)?.jwtToken || "");
  if (!token) throw new MxMerchantError("MX did not issue a terminal API token.");
  // MX tokens last 24 hours; refresh five minutes early, or after an hour if the expiry can't be read.
  let refreshAt = Date.now() + 3_600_000;
  try { const exp = Number(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp); if (exp) refreshAt = exp * 1000 - 300_000; } catch {}
  cachedJwt = { cacheKey, token, refreshAt };
  return token;
}

/** MX answers most terminal errors with a bare JSON string, e.g. "…The terminal is not connected". */
async function errorText(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") return String((parsed as Record<string, unknown>).message || text);
  } catch {}
  return text;
}

async function terminalFetch(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const authorization = `Bearer ${await jwt(retried)}`;
  let response: Response;
  try {
    response = await fetch(`${api2Base()}/terminal/v1${path}`, {
      ...init, headers: { authorization, accept: "application/json", ...init.headers }, cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new MxTerminalUnreachableError(error instanceof Error && error.name === "TimeoutError" ? "MX did not answer in time." : "Could not reach MX.");
  }
  if (response.status === 401 && !retried) return terminalFetch(path, init, true);
  if ([502, 503, 504].includes(response.status)) throw new MxTerminalUnreachableError(`MX is not responding (${response.status}).`);
  if (!response.ok) {
    const detail = (await errorText(response)).trim().slice(0, 300);
    if (/not connected/i.test(detail)) throw new MxMerchantError("The card terminal is not connected. Check that it is powered on and online, then try again.");
    throw new MxMerchantError(detail ? `MX terminal error: ${detail}` : `MX terminal request failed (${response.status}).`);
  }
  return response;
}

export type MxTerminal = { id: string; name: string; description: string; providerKey: string; enabled: boolean; uniqueIdentifier: string };
export async function listMxTerminals(): Promise<MxTerminal[]> {
  const { merchantId } = credentials();
  const rows = await (await terminalFetch(`/merchantid/${encodeURIComponent(merchantId)}`)).json() as unknown;
  return (Array.isArray(rows) ? rows : []).map((row: Record<string, unknown>) => ({
    id: String(row.id || "").toUpperCase(),
    name: String(row.name || ""),
    description: String(row.description || ""),
    providerKey: String(row.providerKey || ""),
    enabled: row.enabled === true && !row.deleted,
    uniqueIdentifier: String(row.uniqueIdentifier || row.iid || ""),
  }));
}

/**
 * Sends a sale, or an authorization to be completed with a tip later, to the terminal.
 * Resolves once MX has handed it to the device; the card is not read yet.
 */
export async function sendMxTerminalSale(input: { terminalId: string; amountCents: number; replayId: number; type?: "Sale" | "Authorization" }) {
  const terminalId = normalizeMxTerminalId(input.terminalId);
  if (!terminalId) throw new MxMerchantError("This payment terminal has no valid MX terminal ID. Fix it in POS settings → Hardware.");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new MxMerchantError("Enter a card amount above $0.00.");
  const { merchantId } = credentials();
  const response = await terminalFetch(`/transaction/merchantid/${encodeURIComponent(merchantId)}/terminalid/${terminalId}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: Number((input.amountCents / 100).toFixed(2)), type: input.type ?? "Sale", replayId: String(input.replayId).padStart(15, "0") }),
  });
  const data = await response.json().catch(() => null) as Record<string, any> | null;
  const terminalPaymentId = String(data?.prioritypaymentsystems?.mxmerchant?.merchant?.devicePaymentAuditId || "");
  if (!terminalPaymentId) throw new MxMerchantError(String(data?.message || "MX did not confirm that the sale reached the terminal."));
  return { terminalPaymentId, status: String(data?.status || "") };
}

export type MxTerminalState = "pending" | "approved" | "declined" | "failed";
export function mxTerminalState(status: unknown): MxTerminalState {
  const value = String(status ?? "").trim().toLowerCase();
  if (value === "approved") return "approved";
  if (value === "declined") return "declined";
  if (["error", "canceled", "cancelled", "failed", "timeout", "timedout"].includes(value)) return "failed";
  return "pending";
}

export async function getMxTerminalTransaction(terminalPaymentId: string) {
  const { merchantId } = credentials();
  const data = await (await terminalFetch(`/transaction/merchantid/${encodeURIComponent(merchantId)}/transactionid/${encodeURIComponent(terminalPaymentId)}`)).json().catch(() => null) as Record<string, unknown> | null;
  return { state: mxTerminalState(data?.status), status: String(data?.status || ""), message: String(data?.message || "") };
}
