# Online ordering (customer website)

How a customer order on the website becomes food in the kitchen, what protects the money on the way, and what
must be true before it replaces Rezku. Architecture context: [ARCHITECTURE.md](ARCHITECTURE.md). Status as of
2026-10-24: running on **dev** at https://dev.ordercornerdeli.com (host Cloudflare tunnel → :3000, MX
**sandbox**); live online ordering is still Rezku.

Contents: [Pieces](#1-pieces) · [Customer journey](#2-customer-journey) · [Pricing and rules](#3-pricing-and-rules) ·
[Card payment](#4-card-payment) · [After the order is sent](#5-after-the-order-is-sent) · [Launch checklist](#6-launch-checklist) ·
[Known limits](#7-known-limits)

---

## 1. Pieces

| Piece | Path |
|---|---|
| Order page (single React client, ~1,500 lines) | `src/app/order/customer-order.tsx`, `page.tsx` |
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

All `/api/customer/*` routes are self-authorized in the proxy: each checks the customer session itself.

## 2. Customer journey

```mermaid
sequenceDiagram
  autonumber
  actor C as Customer browser
  participant A as Corner Ops API
  participant DB as PostgreSQL
  participant MX as MX Merchant
  participant P as POS / printers
  C->>A: GET catalog (web channel, current time, service type)
  C->>A: sign in (SMS code, email code or Google)
  C->>A: POST cart (items + choices, service, timing, contact)
  A->>DB: new draft order, priced from the DB; cart row ties it to the session
  opt delivery
    C->>A: validate address (Google) → signed token (30 min)
    C->>A: POST orders/[id]/delivery → driving distance, fee band
  end
  opt reward
    C->>A: POST orders/[id]/loyalty
  end
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

- **Every "Place order" prices a fresh draft.** The cart route creates a new draft each time and marks the
  session's previous cart row `replaced_at`; only the newest draft can be paid. Changing service type, time,
  contact or delivery details after pricing clears the priced review, so the next tap prices again.
- **Sign-in is required to price a cart** (any authenticated session: SMS code, email code or Google). Phone
  numbers typed by an email/Google customer are not verified by SMS.
- **Service types online:** pickup and delivery (curbside exists in code; pay-later refuses it).

## 3. Pricing and rules

Everything is decided on the server; the browser's own price estimate is only a preview.

| Rule | Enforced at |
|---|---|
| Item exists, active, available; shown on the web channel (item and category visibility) | cart (`assertItemsShownOnWebsite`, `addConfiguredItem`) |
| Variant, modifier min/max, allowances (free first N), combos, pizza toppings, light/extra levels | cart (`addConfiguredItem`); re-checked at send (`revalidateDraft`) |
| Prices (base, variant, modifier, combo, topping) | cart; send fails with "price changed" if they moved |
| Promotions | applied on the draft, re-applied at send |
| Ordering hours, special hours, closures, ASAP grace | timing quote at cart; **preflight at pay**; send |
| Menu schedules (breakfast, lunch) at the fulfillment time | **preflight at pay**; send |
| Delivery distance, fee band, minimum | delivery route (distance/fee); **preflight at pay**; send |
| Name and phone present | preflight; send |

Prices include tax (`tax_cents` = 0); totals are integer cents.

## 4. Card payment

MX Checkout API with a browser-side charge (card data never touches our server):

1. **initialize** (order must be a draft owned by this session):
   1. Earlier `initialized` checkout sessions for this order from the last 6 hours are looked up at MX by
      `replayId`. If one was approved (the customer was charged but our confirm never arrived), it is applied
      and the order is sent; the browser goes straight to the confirmation page. If MX can't be reached, the
      customer is asked to wait rather than risk a second charge.
   2. **Preflight**: `preflightDraftSubmit` runs every send rule and rolls back. A failure (closed, breakfast
      over, under the delivery minimum, price changed) is shown before any charge.
   3. A checkout session row (`ordering_mx_checkout_sessions`: amount, `replayId`, `client_mutation_id`,
      30-minute expiry) and an MX token are returned to the browser.
2. The browser charges MX directly (`mx-keyed-payment-dialog.tsx`).
3. **confirm**: the server looks the payment up at MX by `replayId`, requires "approved" and the exact session
   amount, then `commitTender` (idempotent on the session's `client_mutation_id`) and `submitDraftOrder`.
   - If a send rule still fails after the charge (something changed between preflight and confirm), the
     customer is told the card was charged and the store alerted (409, `paymentRecorded`); the paid draft
     appears on every POS's online-order alert until staff send it from the Order Center.
   - A failed first print attempt never fails the request; retries and the chime cover it.
4. Refunds of online card payments are manager tender reversals at the POS (`reverseTender` → MX void/refund).

## 5. After the order is sent

- Kitchen ticket job → network printer (retried up to 4 times within an hour), POS Web Push, and the 3-second
  online-order poll that chimes on every signed-in POS until acknowledged.
- Confirmation email (`customer-order-confirmation.ts`) after the response, idempotent; failure never blocks.
- Delivery: assignment for drivers (`ordering-driver-delivery.ts`), tracking link `/track/[token]`, proof photos.
- Scheduled (future) orders are sent and printed **when placed**, not when due (see §7).

## 6. Launch checklist

Before the website takes real orders in production (owner sign-off for each production step):

**Hosting**
- [ ] Add the public hostnames (`ordercornerdeli.com`, `www.ordercornerdeli.com`) to `PRODUCTION_HOSTS` in
      `src/proxy.ts`, or production answers 404 (`APP_ENV=production`). Decide whether www redirects to the apex.
- [ ] Cloudflare: route those hostnames to the production app (:3001) on the production tunnel and stop
      pointing them at Rezku (Cloudflare change, owner only).
- [ ] A customer-host branch in the proxy: the public hostnames serve only customer pages, `/api/customer/*`,
      `/_next` and assets (not `/ops`, `/pos` or other APIs). Don't serve customers from `ops.*`.
- [ ] Delivery tracking links: built today on `team.ordercornerdeli.com` (`publicTeamBaseUrl`), where `/track` is
      denied, so texted links would 404. Build them from `CUSTOMER_APP_URL`.
- [ ] `CUSTOMER_APP_URL` set to the public origin; register its `/api/customer/auth/google/callback` with Google.
- [ ] SMS cost caps on sign-in codes (per IP, daily, US/CA only) before Telnyx is live for customers.

**Production `.env`** (none of these are in production today): `MX_MERCHANT_ID`, `MX_CONSUMER_KEY`,
`MX_CONSUMER_SECRET`, `MX_BUSINESS_ID`, **`MX_ENVIRONMENT=production`** (unset = sandbox: orders would show paid with
no money taken), `PAYMENT_PROVIDER`, `GOOGLE_CLIENT_ID/SECRET`, `ADDRESS_PROVIDER`, `GOOGLE_MAPS_API_KEY`,
`DELI_ORIGIN_LATITUDE/LONGITUDE`, `SMTP_*` / `CUSTOMER_EMAIL_FROM`, and `TELNYX_*` (already there) for sign-in
codes.

**Store setup in the production database**
- [ ] Ordering hours (`ordering_operating_windows`) configured. Unconfigured hours make the website look closed
      (no ASAP, no slots) while the send step skips the hours check.
- [ ] Menu: web visibility per item/category, breakfast/lunch schedules, sold-out flags, delivery fee bands and
      minimum, sales tax rate.
- [ ] Kitchen printer and online-order alert sound set on every POS; one POS stays signed in during open hours.

**Jobs**
- [ ] Production crontab: `ordering-maintenance` every minute (print retries, terminal capture) and
      `missed-clock-outs` every 15 minutes; add them to `run_prod_cron.sh`'s allow list.

**Rehearse on staging** (refresh-staging + MX sandbox): pickup card order, delivery card order, pay at pickup,
closed-hours rejection before charge, delivery-minimum rejection before charge, refund from the POS,
lost-confirm recovery (close the tab right after the card approves, then pay again: no second charge).

## 7. Known limits

Tracked in [reviews/2026-10-24-production-review.md](reviews/2026-10-24-production-review.md):

- No rate limit on `initialize` (card-testing risk); sign-in codes are limited (3 per 15 min, 5 tries).
- Two tabs paying the same order at the same moment can still produce one unrecorded charge.
- Order-ahead slots have no prep lead time or capacity cap.
- Future orders print at placement; the KDS sorts by send time.
- Pay-at-pickup orders have no per-customer limit and earn loyalty before payment.
- Delivery minimum is measured before discounts.
- The slot list makes ~500 queries per request (unauthenticated).
