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
  throw new Error(
    "MX Merchant credentials are staged, but live connection testing remains locked until Dharma supplies sandbox access and enables the Terminal API.",
  );
}
