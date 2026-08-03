# Corner Ops

Corner Ops is the private operating system for **Corner Deli** and **Tiki**.

## Current modules

- Owner authentication with a signed HTTP-only session
- Separate role-based user accounts with business-specific access
- Separate Corner Deli and Tiki business selection
- Clickable reporting periods with prior-period, prior-week, prior-month, and prior-year comparisons
- Direct Square range refreshes for Tiki sales, orders, tax, tips, items, and average ticket
- Honest Corner Deli report coverage based only on the Rezku files received by email
- Private document storage in Vercel Blob
- Tiki five-digit PIN time clock with GPS capture
- Tiki employee, rate, role, punch, overtime, and payroll views
- Corner Deli Rezku labor, order, transaction, payroll, and tip processing
- Direct Rezku inbound email processing through Resend and Vercel
- Separate double-entry accounting books for Corner Deli and Tiki

## Reporting periods

The Reports module uses a 4 AM to 4 AM `America/New_York` business day. Presets include yesterday,
last weekend, last week, last 30 days, last month, and year to date. Each range can be compared with
the immediately preceding period, the week before, the month before, or the year before.

Tiki ranges are refreshed directly from Square and combined with Corner Ops time-clock labor. Corner
Deli reports show only the labor, order, and tip information present in the Rezku reports received by
email; unavailable sales and tax totals are clearly identified instead of being represented as zero.

## Rezku inbound email flow

Rezku sends `Corner Deli Daily Reports` to a Resend receiving address. Resend posts an
`email.received` webhook to:

```text
https://<corner-ops-domain>/api/rezku/inbound
```

Corner Ops verifies the webhook signature, retrieves the received email through the Resend
Receiving API, accepts only `support@rezku.com`, extracts only Excel links hosted at
`files.reporting.rezkupos.com`, downloads the reports, and imports them into the payroll engine.

The Google Apps Script and Gmail parsing bridge are no longer used.

Required environment variables:

```text
RESEND_API_KEY
RESEND_WEBHOOK_SECRET
REZKU_ALLOWED_SENDER=support@rezku.com
```

In Resend:

1. Create or use a Resend receiving domain.
2. Add a webhook for `email.received`.
3. Point the webhook to `/api/rezku/inbound`.
4. Copy its signing secret into `RESEND_WEBHOOK_SECRET`.
5. Change the Rezku daily report recipient to the Resend receiving address.

## Other environment variables

```text
DATABASE_URL
APP_EMAIL
APP_PASSWORD
SESSION_SECRET
```

Vercel Blob uses automatic OIDC credentials when deployed on Vercel. A static
`BLOB_READ_WRITE_TOKEN` is only needed for local development outside Vercel.

## Validation

```bash
npm install
npm run typecheck
npm run build
```
