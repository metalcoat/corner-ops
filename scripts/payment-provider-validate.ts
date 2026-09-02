#!/usr/bin/env node
import assert from "node:assert/strict";

async function main() {
  process.env.PAYMENT_PROVIDER = "mx_merchant";
  process.env.MX_ENVIRONMENT = "sandbox";
  process.env.MX_MERCHANT_ID = "test-merchant";
  process.env.MX_CONSUMER_KEY = "test-consumer-key";
  process.env.MX_CONSUMER_SECRET = "test-consumer-secret";
  process.env.MX_BUSINESS_ID = "test-business";
  process.env.MX_TERMINAL_API_ENABLED = "false";

  const { paymentProviderStatus } = await import("../src/lib/payment-provider");
  const status = paymentProviderStatus();
  assert.equal(status.provider, "mx_merchant");
  assert.equal(status.configured, true);
  assert.equal(status.sandbox, true);
  assert.equal(status.terminalCheckoutEnabled, false);

  delete process.env.MX_CONSUMER_SECRET;
  const missing = paymentProviderStatus();
  assert.equal(missing.configured, false);
  assert.deepEqual(missing.missing, ["MX_CONSUMER_SECRET"]);

  console.log(JSON.stringify({ priorityCredentialModel: true, safeTerminalGate: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
