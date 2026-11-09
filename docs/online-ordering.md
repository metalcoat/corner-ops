# Online ordering (customer website)

How a customer order on the website becomes food in the kitchen, what protects the money on the way, and what
must be true before it replaces Rezku. Architecture context: [ARCHITECTURE.md](ARCHITECTURE.md). Customer-flow
review updated 2026-11-09. Last recorded hosting status (2026-10-24): running on **dev** at
https://dev.ordercornerdeli.com (host Cloudflare tunnel → :3000, MX **sandbox**); live online ordering still used
Rezku. The development review does not verify the current production configuration or authorize its cutover.

Contents: [Pieces](#1-pieces) · [Customer journey](#2-customer-journey) · [Pricing and rules](#3-pricing-and-rules) ·
[Card payment](#4-card-payment) · [After the order is sent](#5-after-the-order-is-sent) · [Launch checklist](#6-launch-checklist) ·
[Known limits](#7-known-limits)

---

## 1. Pieces

| Piece | Path |
|---|---|
| Order page | `src/app/order/customer-order.tsx`, `page.tsx` |
| Confirmation page | `src/app/order/confirmation/` |
| Account pages | `src/app/account/` |
| Tracking page (delivery) | `src/app/track/[token]`, `/api/customer/tracking/[token]` |
| Catalog (public) | `GET /api/customer/catalog?serviceType=&scheduledFor=` |
| Hours / slots (public) | `GET /api/customer/availability` |
| Sign-in | `/api/customer/auth/{phone,email,google,session}` |
| Cart → draft order | `POST /api/customer/cart` |
| Delivery | `/api/customer/delivery/address/{suggest,validate}`, `/delivery/quote`, `POST /api/customer/orders/[id]/delivery` |
| Rewards | `POST /api/customer/orders/[id]/loyalty` |
| Card payment | `POST /api/customer/orders/[id]/payments/mx` (`initialize`, `confirm`) |
| Pay at pickup / delivery | `POST /api/customer/orders/[id]/pay-later` |
| Order status | `GET /api/customer/orders/[id]` |
| Session cookie | `src/lib/customer-ordering-session.ts` (`corner_customer_session`, HMAC, 30 days, HttpOnly, SameSite=Lax) |

All `/api/customer/*` routes are self-authorized in the proxy: routes that need customer or cart access check
the session themselves; catalog and availability remain public.

## 2. Customer journey

```mermaid
sequenceDiagram
  autonumber
  actor C as Customer browser
  participant A as Corner Ops API
  participant DB as PostgreSQL
  participant MX as MX Merchant
  participant P as POS / printers
  C->>A: GET catalog (web channel, fulfillment time, service type)
  opt account or pay-later verification
    C->>A: sign in (SMS code, email code or Google)
  end
  C->>C: Review order
  C->>A: POST cart (items + choices, service, timing, contact)
  A->>DB: new draft order, priced from the DB; cart row ties it to the session
  opt delivery
    C->>A: validate address (Google) → signed token (30 min)
    C->>A: POST orders/[id]/delivery → driving distance, fee band
  end
  opt reward
    C->>A: POST orders/[id]/loyalty or points
  end
  C->>C: Place order after reviewing the final total
  alt pay by card
    C->>A: payments/mx initialize
    A->>MX: look up earlier unconfirmed attempts (replayId)
    A->>DB: preflight: every send rule, rolled back
    A->>MX: checkout token
    A-->>C: token, amount, replayId
    C->>MX: charge card (browser → MX directly)
    C->>A: payments/mx confirm (replayId)
    A->>MX: look up payment by replayId (approved, amount matches)
    A->>DB: commitTender, submitDraftOrder
  else pay at pickup / delivery
    C->>A: pay-later (pickup or delivery only)
    A->>DB: submitDraftOrder (unpaid)
  end
  A->>P: kitchen ticket print job, POS push + chime
  A-->>C: confirmation page; email sent after the response
```

- **Review before placing the order.** "Review order" prices the draft and exposes available pizza and points
  rewards before any card charge or pay-later submission. The customer then places the reviewed order.
  The cart route creates a new draft each time and marks the
  session's previous cart row `replaced_at`; only the active draft can start a new payment. An earlier charge
  can still be reconciled (see §4). Changing items, service type, time, contact or delivery details clears the
  priced review. Responses from an earlier pricing, delivery or reward request cannot restore that obsolete
  review or its discounts, so the next tap prices the current choices again.
- **Guests can price and pay by card.** Pay-later requires a signed-in session or the configured temporary
  SMS bypass. Rewards require sign-in and the active cart belonging to that browser, so a web request cannot
  modify an old cart or a POS draft. Phone numbers typed by an email/Google customer are not verified by SMS.
  Guest SMS verification creates a new authenticated session, so the website rebuilds any guest review under
  that session before the customer places the order. This also covers switching from a reviewed card order to cash.
- **Service types online:** pickup, delivery and prepaid curbside. Pay-later refuses curbside.
- Future-time changes reload the menu for that fulfillment time. Changing service clears the selected time;
  older catalog or time-slot responses cannot replace the latest selection. A slot response clears a selected
  time that is no longer offered and displays the server's explanation when the date is unavailable.
- Future slots honor `allow_future`, `normal_min_minutes` and `max_future_days` for the chosen service, including
  curbside's own settings. Dates must be real calendar dates; past dates, disabled scheduling and dates beyond the
  booking horizon return no slots. The last allowed date is resolved in the store timezone and each slot is
  checked by the same timing quote used at cart creation, including across daylight-saving changes. A web draft
  left open past its scheduled time is rejected at payment preflight and first submission; the customer must
  select a new time and review again. This does not block staff reopening an already-sent order.
- Estimates and cart submissions retain modifier quantities, size-specific modifier prices, included-choice
  allowances and combo option surcharges. Distinct options count toward group selection limits; extra portions
  retain their own quantities. The item dialog shows included portions, the selected size's option prices and
  any fee charged once for choosing from a group. Hidden dependent choices are excluded when their trigger is removed.
- Delivery address routing happens before an order lock. After routing returns, the server checks that the cart
  is still active, the order is an unpaid delivery draft, and its current discounts still determine the quote.
  Saving a signed-in customer's new address, the order address and the delivery fee is one transaction. A slow
  lookup cannot change a paid or submitted order.

## 3. Pricing and rules

Everything is decided on the server; the browser's own price estimate is only a preview.

| Rule | Enforced at |
|---|---|
| Item exists, active, available; shown on the web channel (item and category visibility) | cart (`assertItemsShownOnWebsite`, `addConfiguredItem`) |
| Variant, modifier min/max, portion allowances, one-time group fees, combos, pizza toppings, light/extra levels | cart (`addConfiguredItem`); current totals, choices and requirements re-checked at preflight/send (`revalidateDraft`) |
| Prices (base, variant, modifier, combo, topping) | cart; send fails with "price changed" if they moved |
| Promotions | applied on the draft, re-applied at send |
| Ordering hours, special hours, closures, ASAP grace; web hours must be configured | **preflight at pay**; send |
| Future scheduling enabled, booking horizon, normal prep lead in the offered slots | availability; cart timing quote checks scheduling enablement/horizon |
| Future time still ahead when the first web order is submitted | **preflight at pay**; send |
| Menu schedules (breakfast, lunch) at the fulfillment time | **preflight at pay**; send |
| Delivery distance, fee band, minimum (after discounts) | delivery route (distance/fee); **preflight at pay**; send |
| Name and phone present | preflight; send |

Prices include tax (`tax_cents` = 0); totals are integer cents.
An included modifier portion can carry the group's one-time selection fee without becoming a paid extra.
Revalidation recomputes the whole group's current price, so changing its fee or included allowance requires a
fresh review. Combos are checked again for active item linkage, active/available choices, current option and
base prices, and required group counts before payment and submission.

## 4. Card payment

MX Checkout API with a browser-side charge (card data never touches our server):

1. **initialize** (order must be a draft owned by this session):
   1. Unresolved attempts across all carts owned by this browser session are looked up at MX by `replayId`,
      including `initialized`, `superseded`, and `declined` attempts without a processor reference. Local expiry,
      an old creation date or more than five attempts does not make an earlier charge safe to ignore.
      An **Approved** or **Settled** sale is recovered; for the active cart it is recorded and submitted, with
      the normal store-check warning if submission fails. An unrecorded charge for a replaced cart is reversed
      or flagged for staff review, without creating a second kitchen order.
      A processor-confirmed decline with a reference or matching full reversal closes the attempt. A decline
      without a reference remains unresolved. Pending/authorization-only,
      unknown and chargeback statuses block another token; a partial refund or amount mismatch requires review.
      Lookups run at most four at once, with a 12-second budget for starting further batches and a timeout on
      each lookup. If recovery is incomplete or MX cannot be reached, checkout asks the customer to wait and
      issues no new token. An unresolved `needs_review` on any cart in that browser session also blocks checkout.
      Every approval found is reconciled before returning success, including attempts on an already-paid order.
      An old tab can still approve a second MX token after its local 30-minute expiry: one tender and kitchen
      submission are kept, and each extra charge is reversed once. If another lookup or reversal remains uncertain,
      the response is 409 with `paymentRecorded: true` when payment was already recorded; no new token is issued.
   2. **Preflight**: `preflightDraftSubmit` runs every send rule and rolls back. A failure (closed, breakfast
      over, expired scheduled time, under the delivery minimum, price or combo changed) is shown before any charge.
      A fully rewarded order with a zero total is rechecked and submitted without contacting MX or creating
      a payment transaction, including curbside orders. Its reward is consumed once when sent.
   3. One payment attempt per order: under a per-order lock, an open session for the same amount is reused
      (same `replayId`; MX treats a repeat charge with it as the same payment and rejects a different card on
      it, verified in the sandbox). A new session starts after a decline (`retryAfterDecline`, so another card
      can be tried) or when the amount changed. The session row (`ordering_mx_checkout_sessions`: amount,
      `replayId`, `client_mutation_id`, 30-minute expiry) and a fresh MX token go to the browser.
      Immediately before creating the session, the active cart, draft status and current amount due are checked
      again under order/cart locks, since a second tab may have changed them during processor recovery or preflight.
2. The browser charges MX directly (`mx-keyed-payment-dialog.tsx`).
3. **confirm**: the server looks the payment up at MX by `replayId`, accepts an Approved or Settled sale, requires
   its exact session amount with no partial refund, and checks that the cart is still active and owes that amount.
   A processor amount/refund mismatch is flagged for review; an unrecorded charge for a replaced cart or changed
   total is reversed. A valid approval proceeds to `commitTender` (idempotent on the session's `client_mutation_id`)
   and `submitDraftOrder`. A replaced cart retains access to confirm its existing attempt, but cannot initialize
   a new payment. Confirmation and saved-card completion run the same recovery pass before returning, so
   an already-completed attempt cannot hide another approval.
   - The order row is locked while checking for an existing tender and recording a new one. Concurrent
     confirmations check the existing payment before considering a void, so an already-paid balance cannot
     trigger reversal of that same successful charge.
   - A changed-total reversal is claimed under the order/session locks and marked `needs_review` before
     contacting MX. Concurrent confirmations cannot reverse it twice or replace a successful `voided`
     result. Interrupted or failed reversals retain the processor reference for staff review and block
     another payment attempt; confirmed voids return the review-and-pay-again message without contacting MX again.
   - Uncertain web reversals ring the POS and retain a banner with the order number, MX reference and a
     link to **Settings → Hardware → Card payments to review**. A manager must void or fully refund the
     original charge in MX, then use **VERIFY VOID / REFUND IN MX**. The server reads the original payment,
     checks its reference, amount and full reversal, records the manager's note, and clears the warning.
     Approval, partial refund, missing reference or an unavailable processor leave checkout blocked; staff
     cannot take a replacement tender either. Verification itself never charges or refunds a card.
     New checkout sessions use the `online` channel; legacy `keyed` sessions are included only when the
     order is web-sourced and the session was created by a web actor.
   - If a send rule still fails after the charge (something changed between preflight and confirm), the
     customer is told the card was charged and the store alerted (409, `paymentRecorded`); the paid draft
     appears on every POS's online-order alert until staff send it from the Order Center.
     Retried confirmations preserve this warning while the order is still a draft; the confirmation page
     also displays the pending store check instead of a kitchen progress tracker.
   - A failed first print attempt never fails the request; retries and the chime cover it.
4. **Saved cards** (`src/lib/mx-saved-cards.ts`, owner request 2026-10-24): a signed-in customer can tick "Save this
   card for next time" in the card dialog. After the payment is approved the dialog sends the same card straight to
   MX's `/vault` endpoint with a limited-use token (MX customer created on first use, `ordering_customers.mx_customer_id`);
   the server then reads the customer's cards back from MX and stores only MX's vault token, brand, last 4 and expiry in
   `ordering_customer_payment_methods` (with the consent source). Next time the customer picks "Visa ····1111" and the
   server charges the token (`initialize` with `savedCardId`, same one-attempt/replayId rules). Cards are removed from
   the account page (deleted at MX). Card numbers never reach Corner Ops, so PCI scope stays as before. POS phone orders:
   the keyed-card dialog lists the attached customer's saved cards ("CHARGE VISA ····1111" after ticking that the
   customer agreed on the call) and can save a keyed card for them. `npm run test:saved-cards-mx-sandbox`.
5. Refunds of online card payments are manager tender reversals at the POS (`reverseTender` → MX void/refund).

## 5. After the order is sent

- Kitchen ticket job → network printer (retried up to 4 times within an hour), POS Web Push, and the 3-second
  online-order poll that chimes on every signed-in POS until acknowledged.
- Confirmation email (`customer-order-confirmation.ts`) after the response, idempotent; failure never blocks.
- Delivery: assignment for drivers (`ordering-driver-delivery.ts`), tracking link `/track/[token]`, proof photos.
- Scheduled (future) orders are held from the kitchen printer, the kitchen screen and the online-order chime until
  their prep time (quoted prep + 10 min, at least 35 min before due), then released once by ordering maintenance
  (`ordering-kitchen-release.ts`). On Halloween and Super Bowl Sunday they go to the kitchen when placed. The ticket
  prints a large white-on-black "DUE …" banner and the kitchen screen a purple "SCHEDULED · DUE …" bar.
- The confirmation API supplies the prep hold and refund totals. While held, the customer sees **Your order is
  scheduled** and the tracker remains on **Order placed**; it advances to **Making it** after prep release.
  Full/partial refunds display the money returned instead of asking for it again. Cancelled unpaid orders show
  no payment due; a repaid order shows **Paid** even if its history contains a reversal. Paid drafts continue to
  show the store-check warning until submission is resolved.
- ASAP preorders have a separate rule: they print immediately, as intended for store planning, but the customer
  sees **Your order is queued for opening** until the opening used in the quote (promised time minus quoted lead).
  They remain on **Order placed** during that wait. Actual **in progress** or **ready** status overrides the quote.
  Curbside check-in is hidden and rejected by the API during either this opening wait or a scheduled prep hold;
  it remains available for ordinary ASAP orders and delayed pickups, without a blanket closed-hours restriction.

## 6. Launch checklist

Before the website takes real orders in production (owner sign-off for each production step):
Unchecked items below remain production prerequisites; the development tests do not establish their current
state. The production data/configuration observations in the original rehearsal were made on 2026-10-24.

**Hosting**
- [x] `ordercornerdeli.com` and `www.ordercornerdeli.com` are production hosts; www redirects to the bare name and
      `/` opens `/order` (owner decision 2026-10-24: the address goes straight to ordering).
- [ ] Cloudflare: route `ordercornerdeli.com` and `www` to the production app (:3001) on the production tunnel and stop
      pointing them at Rezku (Cloudflare change, owner only).
- [x] The customer host serves only customer pages, `/api/customer/*`, `/_next` and assets
      (`src/lib/customer-domain-routing.ts`); everything else is a 404. Don't serve customers from `ops.*`.
- [x] Delivery tracking links use `CUSTOMER_APP_URL`, else https://ordercornerdeli.com in production.
- [ ] `CUSTOMER_APP_URL` set to the public origin; register its `/api/customer/auth/google/callback` with Google.
- [x] SMS requests filter to US/Canadian numbers and have cost caps: 10 requests/hour per IP and 400/day for
      Corner Deli, plus per-phone request and verification-attempt limits (`customer-abuse-limits.ts`, phone auth route).
- [ ] Verify live customer SMS and email delivery, Google sign-in and provider configuration on the intended public origin.

**Production `.env`** (must be checked at cutover): `APP_ENV=production`, `MX_MERCHANT_ID`, `MX_CONSUMER_KEY`,
`MX_CONSUMER_SECRET`, `MX_BUSINESS_ID`, **`MX_ENVIRONMENT=production`**, `PAYMENT_PROVIDER`,
`CUSTOMER_APP_URL`, `GOOGLE_CLIENT_ID/SECRET`, `ADDRESS_PROVIDER`, `GOOGLE_MAPS_API_KEY`,
`DELI_ORIGIN_LATITUDE/LONGITUDE`, and `TELNYX_*` for sign-in codes. Email needs `SMTP_USER`/`SMTP_PASSWORD`
and the intended SMTP/from settings (`CUSTOMER_EMAIL_FROM`), or `RESEND_API_KEY` with
`EMPLOYEE_NOTIFICATION_FROM_EMAIL`/`ALERT_FROM_EMAIL`. With `APP_ENV=production`, card checkout refuses to run
unless `MX_ENVIRONMENT=production`; missing that setting must never silently take sandbox payments.

**Store setup in the production database** (absent in the 2026-10-24 rehearsal source; verify current state before
the one-time `tools/promote-dev-config.sh` copy — see [switch-runbook.md](switch-runbook.md))
- [ ] Ordering hours (`ordering_operating_windows`) configured. Unconfigured hours make the website look closed
      (no ASAP, no slots), and web preflight/submission also refuses the order. Configure each service's future-order
      enablement, normal prep lead and booking horizon in `ordering_fulfillment_timing_settings`.
- [ ] Menu: web visibility per item/category, breakfast/lunch schedules, sold-out flags, delivery fee bands and
      minimum, sales tax rate.
- [ ] Kitchen printer and online-order alert sound set on every POS; one POS stays signed in during open hours.

**Jobs**
- [ ] Production crontab: `ordering-maintenance` every minute (scheduled prep release, print retries, terminal capture) and
      `missed-clock-outs` every 15 minutes; add them to `run_prod_cron.sh`'s allow list.

**Rehearse on staging** (refresh-staging + MX sandbox): pickup card order, delivery card order, pay at pickup,
closed-hours and expired-slot rejection before charge, delivery-minimum rejection before charge, scheduled prep
release, refund from the POS, and lost-confirm recovery (close the tab right after the card approves, then pay
again: no second charge). Physical printing, real card settlement and live customer communications still require
their approved launch checks.

## 7. Known limits

Tracked in [reviews/2026-10-24-production-review.md](reviews/2026-10-24-production-review.md):

- Card checkout starts are limited to 8/hour per browser session and 20/hour per IP; sign-in codes have
  request and verification limits. These limits reduce abuse but cannot establish that a payment card is legitimate.
- Order-ahead slots use the normal minimum prep lead and configured booking horizon, but have no capacity cap.
  The lead is a slot-list filter; the shared cart timing quote requires a future time within the booking horizon,
  and submission rejects an elapsed time. It does not reserve kitchen capacity or enforce a fresh full prep lead
  after a customer has spent time reviewing the order.
- Pay-at-pickup orders have no per-customer open-order limit. Loyalty and points now accrue only after full payment,
  including cash collected after the order was sent to the kitchen.

Development regressions: `npm run test:customer-checkout:regressions` covers payment recovery, concurrent starts,
delivery-save races and stale scheduled slots; `npm run test:pizza-pricing:regressions` includes group-fee/allowance
and combo changes. `npm run test:ordering-audit:e2e` includes customer edits while requests are pending, guest
verification repricing and scheduled/refunded confirmation displays. Database cases use disposable fixtures and
provider stand-ins; these commands do not prove live provider delivery, settlement or physical printing.
