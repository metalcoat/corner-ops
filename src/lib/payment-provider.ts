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
    terminalCheckoutEnabled:
      configured && Boolean(process.env.MX_TERMINAL_API_ENABLED?.trim() === "true"),
    sandbox: process.env.MX_ENVIRONMENT?.trim().toLowerCase() !== "production",
    missing,
  };
}

function mxApiBase(): string {
  return process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production"
    ? "https://api.mxmerchant.com/checkout/v3"
    : "https://sandbox.api.mxmerchant.com/checkout/v3";
}

async function testMxMerchantConnection() {
  const merchantId = process.env.MX_MERCHANT_ID?.trim();
  const consumerKey = process.env.MX_CONSUMER_KEY?.trim();
  const consumerSecret = process.env.MX_CONSUMER_SECRET?.trim();
  if (!merchantId || !consumerKey || !consumerSecret)
    throw new Error("MX Merchant credentials are incomplete.");
  const authorization = Buffer.from(`${consumerKey}:${consumerSecret}`, "utf8").toString("base64");
  const response = await fetch(
    `${mxApiBase()}/merchant/${encodeURIComponent(merchantId)}`,
    {
      method: "GET",
      headers: { Authorization: `Basic ${authorization}`, Accept: "application/json" },
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
  await response.json();
  return {
    connected: true,
    provider: "mx_merchant" as const,
    environment: process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production" ? "production" : "sandbox",
    enabledTerminalCount: 0,
    terminals: [],
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
