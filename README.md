# Corner Ops

Corner Ops is the private operating system for **Corner Deli** and **Tiki**.

## Current modules

- Owner authentication with a signed HTTP-only session
- Separate Corner Deli and Tiki business selection
- Private document storage in Vercel Blob
- Tiki five-digit PIN time clock with GPS capture
- Tiki employee, rate, role, punch, overtime, and payroll views
- Corner Deli Rezku labor, order, transaction, payroll, and tip processing
- Direct Rezku inbound email processing through Resend and Vercel
- Separate double-entry accounting books for Corner Deli and Tiki

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
