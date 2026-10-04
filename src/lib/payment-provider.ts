// Card payments go through Dharma / MX Merchant (Priority). Helcim is no
// longer used; card tenders recorded with provider 'helcim' are history only.
import { listMxTerminals, type MxTerminal } from "@/lib/mx-terminal";

export type PaymentProviderKey = "mx_merchant";

export type PaymentProviderStatus = {
  provider: PaymentProviderKey;
  label: string;
  configured: boolean;
  onlineCheckoutEnabled: boolean;
  terminalCheckoutEnabled: boolean;
  sandbox: boolean;
  missing: string[];
};

export function paymentProviderStatus(): PaymentProviderStatus {
  const required = {
    MX_MERCHANT_ID: process.env.MX_MERCHANT_ID,
    MX_CONSUMER_KEY: process.env.MX_CONSUMER_KEY,
    MX_CONSUMER_SECRET: process.env.MX_CONSUMER_SECRET,
    MX_BUSINESS_ID: process.env.MX_BUSINESS_ID,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  const configured = missing.length === 0;
  return {
    provider: "mx_merchant",
    label: "Dharma / MX Merchant",
    configured,
    onlineCheckoutEnabled: configured,
    terminalCheckoutEnabled: configured && process.env.MX_TERMINAL_API_ENABLED?.trim() === "true",
    sandbox: process.env.MX_ENVIRONMENT?.trim().toLowerCase() !== "production",
    missing,
  };
}

function mxApiBase(): string {
  return process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production"
    ? "https://api.mxmerchant.com/checkout/v3"
    : "https://sandbox.api.mxmerchant.com/checkout/v3";
}

/** Checks the MX credentials against the merchant record and lists the terminals registered for it. */
export async function testActivePaymentProvider() {
  const status = paymentProviderStatus();
  if (!status.configured)
    throw new Error(`MX Merchant is missing: ${status.missing.join(", ")}.`);
  const merchantId = process.env.MX_MERCHANT_ID!.trim();
  const authorization = Buffer.from(`${process.env.MX_CONSUMER_KEY!.trim()}:${process.env.MX_CONSUMER_SECRET!.trim()}`, "utf8").toString("base64");
  const response = await fetch(`${mxApiBase()}/merchant/${encodeURIComponent(merchantId)}`, {
    method: "GET",
    headers: { Authorization: `Basic ${authorization}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "MX rejected the API credentials for this environment."
        : `MX merchant lookup failed (${response.status}).`,
    );
  }
  await response.json();
  // The terminal list comes from the separate Terminal API; a failure there should not hide a working Checkout API.
  let terminals: MxTerminal[] = [], terminalError = "";
  try {
    terminals = await listMxTerminals();
  } catch (error) {
    terminalError = error instanceof Error ? error.message : "MX terminal list failed.";
  }
  return {
    connected: true,
    provider: "mx_merchant" as const,
    environment: status.sandbox ? "sandbox" : "production",
    enabledTerminalCount: terminals.filter((terminal) => terminal.enabled).length,
    terminals: terminals.map(({ id, name, providerKey, enabled }) => ({ id, name, providerKey, enabled })),
    terminalError,
  };
}
