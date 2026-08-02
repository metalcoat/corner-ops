# Corner Ops scheduler and integrations

## Nightly scheduler

Vercel Cron calls two UTC routes so one lands at 3 AM in `America/New_York` across daylight-saving changes. The route ignores the call that does not land at local hour 3 and de-duplicates each local date.

Nightly work:

- flag open Tiki punches for review
- verify Corner Deli Rezku reports are fresh
- synchronize all connected Plaid bank feeds
- synchronize the connected Tiki Square seller
- save previous-week payroll calculations on Mondays
- send an issue digest when `ALERT_FROM_EMAIL` is configured

Required variable: `CRON_SECRET`.

Cron jobs only execute on a production Vercel deployment.

## Bank mapping

- SEACOMM connection → Corner Deli
- NBT Bank connection → Tiki

Both use Plaid Transactions Sync. Each connection stores its own encrypted access token and cursor. Transactions enter a review queue, receive suggested GL categories, and can be approved with `Approve & teach` to create a future matching rule.

Required variables:

- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV=production` after Plaid production access is approved

CSV and Excel import remains available when an institution is unavailable or temporarily broken in Plaid.

## Square

Square is Tiki-only. Corner Ops uses Square OAuth, stores the seller token encrypted, and synchronizes payment and tip totals. Tiki employee time remains sourced from the Corner Ops PIN clock.

Required variables:

- `SQUARE_APPLICATION_ID`
- `SQUARE_APPLICATION_SECRET`
- `SQUARE_ENV=production`
- `SQUARE_API_VERSION=2026-07-15`

Register the following OAuth redirect URL in the Square Developer dashboard:

```text
https://<corner-ops-domain>/api/square/callback
```
