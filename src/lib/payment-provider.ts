import { helcimStatus, testHelcimConnection } from "@/lib/helcim";

export type PaymentProviderKey = "helcim" | "mx_merchant";

export type PaymentProviderStatus = {
  provider: PaymentProviderKey;
  label: string;
  configured: boolean;
  onlineCheckoutEnabled: boolean;
  terminalCheckoutEnabled: boolean;
  sandbox: boolean;
  missing: string[];
};

export function activePaymentProvider(): PaymentProviderKey {
  return process.env.PAYMENT_PROVIDER?.trim().toLowerCase() === "mx_merchant"
    ? "mx_merchant"
    : "helcim";
}

export function mxMerchantStatus(): PaymentProviderStatus {
  const required = {
    MX_MERCHANT_ID: process.env.MX_MERCHANT_ID,
    MX_API_KEY: process.env.MX_API_KEY,
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
    onlineCheckoutEnabled: false,
    terminalCheckoutEnabled:
      configured && Boolean(process.env.MX_TERMINAL_API_ENABLED?.trim() === "true"),
    sandbox: process.env.MX_ENVIRONMENT?.trim().toLowerCase() !== "production",
    missing,
  };
}

function mxApiBase(): string {
  return process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production"
    ? "https://api2.mxmerchant.com"
    : "https://sandbox-api2.mxmerchant.com";
}

type MxTerminal = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
};

async function testMxMerchantConnection() {
  const merchantId = process.env.MX_MERCHANT_ID?.trim();
  const apiKey = process.env.MX_API_KEY?.trim();
  if (!merchantId || !apiKey) throw new Error("MX Merchant credentials are incomplete.");
  const response = await fetch(
    `${mxApiBase()}/terminal/v1/merchantid/${encodeURIComponent(merchantId)}?status=enabled`,
    {
      method: "GET",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Priority rejected the MX API credentials for this environment."
        : `Priority terminal lookup failed (${response.status}).`,
    );
  }
  const payload = await response.json() as unknown;
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const terminals = rows.filter((row): row is MxTerminal => Boolean(row && typeof row === "object"));
  return {
    connected: true,
    provider: "mx_merchant" as const,
    environment: process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production" ? "production" : "sandbox",
    enabledTerminalCount: terminals.filter((terminal) => terminal.enabled !== false).length,
    terminals: terminals.map((terminal) => ({
      id: String(terminal.id || ""),
      name: String(terminal.name || terminal.description || "MX Terminal"),
      enabled: terminal.enabled !== false,
    })),
  };
}

export function paymentProviderStatus(): PaymentProviderStatus {
  if (activePaymentProvider() === "mx_merchant") return mxMerchantStatus();
  const status = helcimStatus();
  return {
    provider: "helcim",
    label: "Helcim",
    configured: status.apiTokenConfigured,
    onlineCheckoutEnabled: status.checkoutEnabled,
    terminalCheckoutEnabled:
      status.apiTokenConfigured && status.deviceCodeConfigured,
    sandbox: false,
    missing: status.apiTokenConfigured ? [] : ["HELCIM_API_TOKEN"],
  };
}

export async function testActivePaymentProvider() {
  const status = paymentProviderStatus();
  if (status.provider === "helcim") return testHelcimConnection();
  if (!status.configured)
    throw new Error(`MX Merchant is missing: ${status.missing.join(", ")}.`);
  return testMxMerchantConnection();
}
