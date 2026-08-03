# Corner Ops

Corner Ops is the private operating system for **Corner Deli** and **Tiki**.

## Current modules

- Owner authentication with a signed HTTP-only session
- Separate role-based user accounts with business-specific access
- Separate Corner Deli and Tiki business selection
- Clickable reporting periods with prior-period, prior-week, prior-month, and prior-year comparisons
- Weather-to-demand reporting with daily history, correlations, similar-day forecasts, and operating recommendations
- Direct Square range refreshes for Tiki sales, orders, tax, tips, items, and average ticket
- Honest Corner Deli report coverage based only on the Rezku files received by email
- Weekly draft scheduling with one publish action and personalized employee schedule emails
- Missed-shift detection with secure Employee Hub corrections and management approval
- Plaid checking, savings, and credit-card transaction feeds
- Credit-card payment matching between bank withdrawals and card credits
- Receipt uploads, Google Drive folder monitoring, Document AI OCR, and receipt-to-transaction matching
- Private document storage in Vercel Blob
- Tiki five-digit PIN time clock with GPS capture
- Corner Deli four-digit and Tiki five-digit Employee Hub PINs
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

## Weather intelligence

The Weather module stores daily Ogdensburg conditions from Open-Meteo and joins them to business-day
results. Tiki uses Square sales and order data. Corner Deli uses sales totals when a recognizable total
field exists in the Rezku order export; otherwise it clearly uses order count as the demand measure.

The upcoming ten-day view finds the most similar historical weather days, estimates sales or orders and
labor demand, and produces business-specific operating recommendations. These estimates should still be
adjusted for events, promotions, closures, and river traffic.

No weather API key is required for the proof of concept. Coordinates can be overridden with:

```text
WEATHER_LATITUDE=44.6942
WEATHER_LONGITUDE=-75.4863
```

## Cards, payments, and receipts

Plaid Transactions supplies checking, savings, and credit-card activity. Each issuer should be connected
under the correct business. The same institution connection can return multiple authorized accounts,
including credit cards.

The `/ops/expense-control` module distinguishes account types and searches for the two sides of a
credit-card payment:

- the withdrawal from a checking account
- the matching credit on the card account

High-confidence pairs can be matched automatically. Other pairs remain suggestions for owner review. A
confirmed payment is posted once from cash to the Credit Cards liability account; the card-feed mirror is
ignored. Credit-card purchases post through the Credit Cards liability control account rather than
incorrectly reducing bank cash.

Receipts can be uploaded directly or discovered recursively in separate Corner Deli and Tiki Google
Drive folders. The original upload is retained, Google Document AI extracts the merchant, date, total,
tax, currency, and OCR text, and Corner Ops compares the result with bank and card purchases by amount,
date, and merchant.

Required Google settings:

```text
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
GOOGLE_CLOUD_PROJECT_ID
GOOGLE_DOCUMENT_AI_LOCATION=us
GOOGLE_DOCUMENT_AI_EXPENSE_PROCESSOR_ID
GOOGLE_DRIVE_RECEIPTS_FOLDER_CORNER_DELI
GOOGLE_DRIVE_RECEIPTS_FOLDER_TIKI
```

Enable the Google Drive API and Document AI API in the Google Cloud project. Create an Expense Parser
processor, then share each receipt folder with the service-account email as a Viewer. The nightly
scheduler scans both folders and reruns payment and receipt matching after Plaid synchronization.

Supported receipt inputs include PDF, GIF, TIFF, JPEG, PNG, BMP, and WebP. Online OCR uploads are
limited to 40 MB.

## Schedule publishing and staff email

New, copied, moved, and edited shifts remain drafts until the week is published. One **Publish Week**
action publishes every assigned shift, converts unassigned drafts to open shifts, posts an Employee Hub
announcement, and emails each active employee their personalized schedule.

Required outbound email settings:

```text
RESEND_API_KEY
EMPLOYEE_NOTIFICATION_FROM_EMAIL
APP_URL
```

`EMPLOYEE_NOTIFICATION_FROM_EMAIL` falls back to `ALERT_FROM_EMAIL`.

## Missed-shift corrections

The nightly scheduler checks published shifts against Tiki time records and imported Corner Deli Rezku
labor. Tiki cases are eligible after a two-hour delay. Corner Deli cases wait 30 hours so the emailed
Rezku report has time to arrive.

When no matching time record exists, Corner Ops creates a missed-shift case and emails the employee a
secure link to `/employee/attendance`. The employee signs in with the normal Employee Hub PIN, enters
the exact times worked, and explains the missing record. Attendance emails are notification-only and
replies are not processed.

The correction stays pending in `/ops/attendance` until management approves or rejects it. Approval
creates a corrected Tiki time entry or a manual Corner Deli labor record.

## Rezku inbound email flow

Rezku sends `Corner Deli Daily Reports` to a Resend receiving address. Resend posts an
`email.received` webhook to:

```text
https://<corner-ops-domain>/api/rezku/inbound
```

Corner Ops verifies the webhook signature, retrieves the received email through the Resend Receiving
API, and accepts only `support@rezku.com` Rezku report emails with the expected subject. Rezku Excel
links must be hosted at `files.reporting.rezkupos.com` before they are downloaded and imported.

The Google Apps Script and Gmail parsing bridge are no longer used.

Required inbound environment variables:

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
PLAID_CLIENT_ID
PLAID_SECRET
PLAID_ENV
```

Vercel Blob uses automatic OIDC credentials when deployed on Vercel. A static
`BLOB_READ_WRITE_TOKEN` is only needed for local development outside Vercel.

## Validation

```bash
npm install
npm run typecheck
npm run build
```
