import { getSql } from "@/lib/db";
import { ensureOrderingAddressSchema } from "@/lib/ordering-address-schema";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";

let promise: Promise<void> | null = null;

/** Additive CRM, POS preference, and immutable order-snapshot schema. */
export function ensureOrderingCustomerSchema(): Promise<void> {
  if (!promise)
    promise = (async () => {
      await ensureOrderingAddressSchema();
      await ensureOrderingMenuOverrideSchema();
      const sql = getSql();
      await sql`INSERT INTO ordering_customer_emails(id,customer_id,normalized_email,display_email,is_primary)
        SELECT gen_random_uuid(),id,lower(trim(email)),trim(email),TRUE FROM ordering_customers customer
        WHERE trim(email)<>'' AND NOT EXISTS(SELECT 1 FROM ordering_customer_emails existing WHERE existing.customer_id=customer.id AND existing.normalized_email=lower(trim(customer.email)))`;
      await sql`WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY customer_id ORDER BY created_at,id) position FROM ordering_customer_emails WHERE is_primary=TRUE) UPDATE ordering_customer_emails email SET is_primary=FALSE,updated_at=NOW() FROM ranked WHERE email.id=ranked.id AND ranked.position>1`;
      await sql`UPDATE ordering_customer_addresses SET label=CASE
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('3000fordstreetextension','3000fordstextension','3000fordstreetext') THEN 'Walmart'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('1515knox','1515knoxstreet','1515knoxst') THEN 'Step by Step'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('830proctoravenue','830proctorave') THEN 'New Ansen'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('100chimneypointdrive','100chimneypointdr') THEN 'Old Ansen'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('214kingstreet','214kingst') THEN 'Claxton-Hepburn Medical Center'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('1chimneypointdrive','1chimneypointdr') THEN 'State Hospital (Psych Center)'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('1121patersonstreet','1121patersonst','1121pattersonstreet','1121pattersonst') THEN 'Ogdensburg Bowl'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('1210patersonstreet','1210patersonst') THEN 'Advance Auto Parts'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('809newyorkavenue','809newyorkave') THEN 'Howie''s Bar'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('17commercestreet','17commercest') THEN 'Shipwreck Bar'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('1110tibbittsdrive','1110tibbittsdr') THEN 'Riverview Correctional Facility'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('728cantonstreet','728cantonst') THEN 'Sunoco · Canton Street'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('301champlainstreet','301champlainst') THEN 'Sunoco · Champlain Street'
        WHEN regexp_replace(lower(line1),'[^a-z0-9]','','g') IN ('1117newyorkavenue','1117newyorkave') THEN 'Sunoco · New York Avenue'
        ELSE label END,updated_at=NOW()
        WHERE active=TRUE AND lower(trim(label)) IN ('','home','address','delivery','other','imported')`;
      await sql`WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY customer_id ORDER BY created_at,id) position FROM ordering_customer_phones WHERE is_primary=TRUE) UPDATE ordering_customer_phones phone SET is_primary=FALSE,updated_at=NOW() FROM ranked WHERE phone.id=ranked.id AND ranked.position>1`;
      await sql`WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY customer_id ORDER BY last_used_at DESC NULLS LAST,created_at,id) position FROM ordering_customer_addresses WHERE is_primary=TRUE AND active=TRUE) UPDATE ordering_customer_addresses address SET is_primary=FALSE,updated_at=NOW() FROM ranked WHERE address.id=ranked.id AND ranked.position>1`;
      await sql`INSERT INTO ordering_business_settings (business) VALUES ('Corner Deli'), ('Tiki') ON CONFLICT DO NOTHING`;
    })().catch((error) => {
      promise = null;
      throw error;
    });
  return promise;
}
