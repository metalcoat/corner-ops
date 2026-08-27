import { createHash, timingSafeEqual } from "node:crypto";

const HELCIM_API = "https://api.helcim.com/v2";

export class HelcimError extends Error {}

export function helcimStatus() {
  return {
    apiTokenConfigured: Boolean(process.env.HELCIM_API_TOKEN?.trim()),
    terminalIdConfigured: Boolean(process.env.HELCIM_TERMINAL_ID?.trim()),
    deviceCodeConfigured: Boolean(process.env.HELCIM_DEVICE_CODE?.trim()),
    checkoutEnabled: Boolean(process.env.HELCIM_API_TOKEN?.trim()),
  };
}

function token(): string {
  const value = process.env.HELCIM_API_TOKEN?.trim();
  if (!value) throw new HelcimError("Helcim is not configured. Add HELCIM_API_TOKEN to the server environment.");
  return value;
}

async function helcimFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${HELCIM_API}${path}`, {
    ...init,
    headers: { "api-token": token(), "content-type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new HelcimError(String(body.error || body.message || `Helcim returned ${response.status}.`));
  return body;
}

export async function testHelcimConnection() {
  await helcimFetch("/connection-test", { method: "GET" });
  return { connected: true };
}

export async function initializeHelcimPay(amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new HelcimError("A valid payment amount is required.");
  const terminalId = process.env.HELCIM_TERMINAL_ID?.trim();
  const body = await helcimFetch("/helcim-pay/initialize", {
    method: "POST",
    body: JSON.stringify({
      paymentType: "purchase",
      paymentMethod: "cc",
      amount: Number((amountCents / 100).toFixed(2)),
      currency: "USD",
      confirmationScreen: false,
      ...(terminalId ? { terminalId } : {}),
    }),
  });
  const checkoutToken = String(body.checkoutToken || "");
  const secretToken = String(body.secretToken || "");
  if (!checkoutToken || !secretToken) throw new HelcimError("Helcim did not return a checkout token.");
  return { checkoutToken, secretToken };
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(left: string, right: string) {
  const a = Buffer.from(left.toLowerCase(), "utf8"), b = Buffer.from(right.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function helcimCanonicalJson(data: unknown) {
  return JSON.stringify(data).replace(/[^\x00-\x7f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function validateHelcimPayResponse(data: unknown, responseHash: string, secretToken: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HelcimError("Helcim returned an invalid payment response.");
  const expected = sha256(helcimCanonicalJson(data) + secretToken);
  if (!safeEqual(expected, responseHash)) throw new HelcimError("Helcim payment verification failed.");
  return data as Record<string, unknown>;
}
