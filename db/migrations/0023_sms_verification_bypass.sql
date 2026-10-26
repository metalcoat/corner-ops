-- Online pay-at-pickup/delivery orders need a texted code unless the customer is signed in.
-- A manager can switch the code off for a while (texting down, a rush); it switches itself
-- back on at sms_verification_bypass_until. Card orders never need the code.
ALTER TABLE ordering_business_ordering_settings ADD COLUMN IF NOT EXISTS sms_verification_bypass_until timestamptz;
ALTER TABLE ordering_business_ordering_settings ADD COLUMN IF NOT EXISTS sms_verification_bypass_by text NOT NULL DEFAULT '';
