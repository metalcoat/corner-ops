#!/usr/bin/env node
import assert from "node:assert/strict";

async function main() {
  // A leftover setting from the Helcim days must not change anything: cards always go through MX.
  process.env.PAYMENT_PROVIDER = "helcim";
  process.env.MX_ENVIRONMENT = "sandbox";
  process.env.MX_MERCHANT_ID = "test-merchant";
  process.env.MX_CONSUMER_KEY = "test-consumer-key";
  process.env.MX_CONSUMER_SECRET = "test-consumer-secret";
  process.env.MX_BUSINESS_ID = "test-business";
  process.env.MX_TERMINAL_API_ENABLED = "false";

  const { paymentProviderStatus } = await import("../src/lib/payment-provider");
  const status = paymentProviderStatus();
  assert.equal(status.provider, "mx_merchant");
  assert.equal(status.label, "Dharma / MX Merchant");
  assert.equal(status.configured, true);
  assert.equal(status.onlineCheckoutEnabled, true);
  assert.equal(status.sandbox, true);
  assert.equal(status.terminalCheckoutEnabled, false);

  process.env.MX_TERMINAL_API_ENABLED = "true";
  assert.equal(paymentProviderStatus().terminalCheckoutEnabled, true);

  process.env.MX_ENVIRONMENT = "production";
  assert.equal(paymentProviderStatus().sandbox, false);

  delete process.env.MX_CONSUMER_SECRET;
  const missing = paymentProviderStatus();
  assert.equal(missing.configured, false);
  assert.equal(missing.onlineCheckoutEnabled, false);
  assert.equal(missing.terminalCheckoutEnabled, false);
  assert.deepEqual(missing.missing, ["MX_CONSUMER_SECRET"]);

  console.log(JSON.stringify({ dharmaOnly: true, priorityCredentialModel: true, safeTerminalGate: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
