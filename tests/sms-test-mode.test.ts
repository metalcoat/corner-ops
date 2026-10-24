import assert from "node:assert/strict";
import test from "node:test";
import { smsCodesShownOnScreen } from "../src/lib/sms-test-mode";

test("SMS test mode: only with the dev flag and no Telnyx key", () => {
  assert.equal(smsCodesShownOnScreen({ DEV_SHOW_SMS_CODES: "true" }), true);
  assert.equal(smsCodesShownOnScreen({}), false);
  assert.equal(smsCodesShownOnScreen({ DEV_SHOW_SMS_CODES: "false" }), false);
  // Production has Telnyx: never show codes there, even if the flag were set by mistake.
  assert.equal(smsCodesShownOnScreen({ DEV_SHOW_SMS_CODES: "true", TELNYX_API_KEY: "key" }), false);
});
