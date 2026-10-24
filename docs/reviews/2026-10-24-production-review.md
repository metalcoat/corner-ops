# Production readiness review, 2026-10-24

Whole-codebase review for production risks, with online ordering first. Done by Claude on branch
`agent/pos-ordering-foundation` at `36c9eda` (fixes in the commits that follow it). Five read-only passes ran in
parallel: checkout and payment, menu/hours/cart pricing, auth and security, the staff-side order flow, and
deployment/operations. Each finding below was checked against the code; anything that could not be confirmed
from code alone says **inferred**. The production database was not read.

Legend: **Fixed** = changed in this review · **Decide** = behavior change, needs the owner's call ·
**Open** = a real bug left for the next pass (Codex second review).

Severity: critical (money taken or orders lost with no recovery, or data loss) · high · medium · low.

---

## Fixed in this review

| # | Sev | Finding | Fix |
|---|---|---|---|
| F1 | critical | Hours, menu schedules (breakfast/lunch), delivery minimum, price/sold-out changes and missing details were checked only **after** the card was charged; a failure left a paid draft nobody saw and told the customer "payment could not be verified". | `preflightDraftSubmit` runs every send rule at MX `initialize` and rolls back (`ordering-order-lifecycle.ts`). Validated by `npm run test:online-checkout-preflight`. |
| F2 | critical | A confirm lost after MX approved (dropped connection, 12 s timeout, a second tab) let the customer pay again: double charge, first one never recorded. | `initialize` looks up earlier unconfirmed sessions for the order at MX by `replayId` and applies an approval instead of charging again; if MX can't be reached it refuses to start a new charge. |
| F3 | high | A paid web order that still fails to send was invisible to staff (alert poll only listed `sent_to_kitchen`). | Paid web drafts from the last day are on the online-order alert list (chime on every POS); the customer is told the card was charged and not to pay again (409 `paymentRecorded`). |
| F4 | high | Operational and sales-tax reports covered the wrong day from Nov 1 to mid-March (EST boundary off by 19–24 h; Nov 1 covered one hour). | `src/lib/business-day.ts` (DST-safe 4 AM Eastern boundary) + `tests/business-day.test.ts`. |
| F5 | high | Light/extra choices ("Light Mayo") were dropped by the cart route; the kitchen saw normal. | `modifierAmounts` passed through, only light/normal/heavy. |
| F6 | high | Items or categories hidden from the website (POS-only, staff, retired) could be ordered with a hand-built request. | `assertItemsShownOnWebsite` in the cart route, same filters as the web menu (checked: all 206 dev web items pass). |
| F7 | high | Changing pickup/delivery, ASAP/future, time, contact or delivery details after pricing still paid for the old draft. | The priced review is cleared when any of those change. |
| F8 | high | `payments/mx {action:"pay_later"}` sent unpaid orders without the pay-later route's service-type/source guards (curbside unpaid). Unused by the site. | Removed. |
| F9 | medium | An exception in the first print attempt turned a paid, sent order into a 500 "payment could not be verified". | Caught and logged; retries and the chime cover printing. |
| F10 | medium | Store dashboard "today" (orders, sales, unpaid, deliveries, activity) rolled over at 8 PM Eastern (`CURRENT_DATE` is UTC); sales included drafts. | Eastern day start; drafts excluded from sales. |
| F11 | low | Tip payout periods grouped by UTC date (after 8 PM fell into the next day). | Eastern dates. |
| F12 | medium | A voided order keeps its amount due, so cash/card could still be recorded on it, and terminal auto-capture could charge a hold on it. | `commitTender` refuses voided orders; `completeWithTip` releases holds on them. |
| F13 | medium | Print retries printed kitchen tickets for orders voided after the print failed. | Retries skip kitchen tickets of voided orders. |
| F14 | medium | Refunding a store-credit tender didn't give the credit back. | `reverseTender` writes a `reversal` ledger entry. |
| F15 | medium-high | Any signed-in POS employee could cancel a sent order through `/api/ordering/kitchen` (no manager, reason, loyalty reversal or `voided_at`). The UI never used it. | Kitchen transitions no longer include `cancelled`; cancelling is the void flow. |
| F16 | medium | DB pool: no `error` listener (an idle-client error from a Postgres restart crashes Node), no connect timeout (requests and health hang), broken client returned to the pool after a failed ROLLBACK. | Listener, 10 s connect timeout, 5 min idle-in-transaction timeout, `release(err)`. |
| F17 | medium | `LOCAL_DEVELOPMENT=true` copied into production would enable bulk cash void and simulated approvals; production was only recognised as `*.vercel.app`. | Local dev tools and on-screen SMS codes are refused when `APP_ENV=production` (test added). |
| F18 | low | Menu-schedule rejections were plain errors (500); several clear cart rejections showed "The cart could not be priced". | 409 with the real message. |

All checks passed after the fixes: `npx tsc --noEmit`, `npm test` (274), and the dev-database suites
`test:ordering:lifecycle`, `test:payments`, `test:ordering-availability`, `test:item-cancellation`,
`test:operational-reporting`, `test:order-void`, `test:store-dashboard`, `test:modifier-intensity`,
`test:delivery-pricing`, `test:scheduled-menu-availability`, `test:promotions`, `test:payment-provider`,
`test:tiki-pos`, `test:split-checks`, `test:gift-cards`, `test:online-checkout-preflight`.

## Needs a decision (owner)

| # | Sev | Finding | Recommendation |
|---|---|---|---|
| D1 | critical | **Backups never leave the store server**, and the secrets that decrypt employment forms and sessions (`.env`) aren't backed up at all. A disk failure or ransomware loses orders, payments and payroll history. | **Done 2026-10-24** (owner chose Google Drive): `deploy/offsite-backup.sh` nightly at 07:50 UTC, encrypted with rclone crypt, prod + dev backups + `.env`/config, 30 days; first upload restored and compared byte-for-byte. Follow-up: rclone's shared Google client id is being retired in 2026; create our own OAuth client before it stops. |
| D2 | high (launch blocker) | Production can't serve online ordering: `PRODUCTION_HOSTS` lacks `ordercornerdeli.com`/`www` (404 when `APP_ENV=production`), the prod tunnel doesn't route them, and the prod `.env` has none of the MX/Google/maps/email settings. **Unset `MX_ENVIRONMENT` silently means sandbox** (orders look paid, no money). | **Code done 2026-10-24:** ordercornerdeli.com is the customer host (www redirects; opens on /order; customer pages only); card checkout refuses on production until `MX_ENVIRONMENT=production`. Still to do at the switch: Cloudflare routing and the production `.env` ([online-ordering.md §6](../online-ordering.md#6-launch-checklist)). |
| D3 | high | With no ordering hours configured, the website shows closed but the send step skips the hours check (scripted orders at 3 AM). | Treat unconfigured hours as closed for web orders; configure hours before launch. |
| D4 | high | **Voiding a paid order refunds nothing** (card, cash, gift card, store credit), doesn't restore inventory, cancel the delivery or release terminal holds. The Order Center offers VOID on paid orders. | Block VOID while money is on the order, or make the void ask for a refund per payment in the same step. |
| D5 | high | Disk at 84%: 19 GB Docker build cache never pruned by `update.sh`, container logs unbounded (no `daemon.json`), 83k update logs (one per minute). The disk filled once before; a full disk stops prod Postgres. | `docker builder prune --filter until=72h` + image prune in `update.sh`; Docker log rotation (needs a scheduled Docker restart); log only on change; disk alert. |
| D6 | high | CI never runs tests/typecheck/build: the dependency-audit step fails first on every run (`@vercel/blob`, `zod`), and workflows only trigger for `main`. Schema verify skips 0002–0007 and doesn't use `db-migrate.sh`. | Drop `@vercel/blob`/bump zod; trigger on this branch; run `db-migrate.sh` in schema verify. |
| D7 | high | Production crontab lacks ordering maintenance (print retries, terminal capture) and missed clock-outs; they only run when a KDS happens to be open. | Add both at the switch (and to `run_prod_cron.sh`'s allow list). |
| D8 | medium-high | Every app restart rewrites category names/parents and the Burger Toppings › Egg price (`ensureOrderingSchema` in `ordering-db.ts`), undoing manager edits. | Move to a one-time migration. |
| D9 | medium | `initialize` has no rate limit; email/Google sign-in skips phone verification, so a throwaway email can test stolen cards against the MX account (decline limits, freeze). | Rate-limit initialize and declines per session/customer/IP; cap attempts per order. |
| D10 | medium | Future orders print and show on the KDS when placed (a 5 PM order prints at 9 AM, sorted by send time). Labels already wait until 45 min before. | Hold kitchen tickets and KDS until due − prep time; sort KDS by due time. |
| D11 | medium | Every dev deploy force-recreates Asterisk (drops live AI-phone calls; 23 deploys on Oct 22), and production-facing things run from dev: menu TVs, greeter, AI phone line, the Android APK download URL, the Monday payroll preview. | Recreate Asterisk only when `asterisk/` changes; plan where each moves at the switch. |
| D12 | medium | dev.ordercornerdeli.com is public with on-screen sign-in codes (anyone can sign in as any phone on dev). | Cloudflare Access on the dev hostname, or hide codes for requests that came through Cloudflare. |
| D13 | medium | Online-order chime is lost when a POS idle-locks or reloads (polling stops; first poll after unlock is a silent baseline). | Keep polling while locked, or chime for orders sent in the last ~30 min still waiting. Touches the live POS screen, so not changed here. |
| D14 | medium | Pay-at-pickup orders have no per-customer limit and earn loyalty at send, before payment. | Business call. |
| D15 | medium | Delivery minimum measured before discounts (policy says after). | Use subtotal − discount. |
| D16 | low | The KDS hides in-store orders paid up front (filter `payment_status <> 'paid' OR online`, commit 1d18b27). | Confirm that's intended. |
| D17 | low | Order-ahead slots have no prep lead time (12:15 offered at 12:14) or capacity cap. | Earliest slot = now + quoted prep. |

## Open bugs for the next pass

| # | Sev | Finding | Where |
|---|---|---|---|
| O1 | medium | Two tabs paying the same order at once can still leave one charge unrecorded ("no remaining balance" at the second confirm). Needs one active checkout session per order and an automatic MX void on mismatch. | `payments/mx/route.ts` |
| O2 | medium | Delivery and loyalty routes can change the amount due between `initialize` and `confirm`; the session amount is fixed at initialize. | `delivery/route.ts`, `loyalty/route.ts` |
| O3 | medium | Item cancellations are ignored by `recalculateOrder`, `applyPromotionsToOrder` and `revalidateDraft`: a cancelled item comes back on reopen, or Send fails "total changed". | `ordering-orders.ts:412`, `ordering-promotions.ts:63`, lifecycle `revalidateDraft` |
| O4 | medium | After a full refund `payment_status` becomes `unpaid` with the full amount due; Order Center shows it overdue and it can return to the KDS. | `reverseTender`, `ordering-order-center.ts:95` |
| O5 | medium | Items can be added while another terminal sends the order (no row lock in the additions route). | `api/ordering/orders/[id]/additions` |
| O6 | medium | Loyalty redemption isn't locked per customer; two concurrent sends can spend one reward. Plain `Error` at finalize. | `ordering-loyalty.ts:22` |
| O7 | medium | Send re-applies promotions to a paid order; if promotions changed mid-checkout the paid order is over/under-paid. | lifecycle `applyPromotionsToOrder` call |
| O8 | medium | Free included choices are charged on sized items with per-size modifier prices (variant override overwrites the free price). No such data in dev today (0 rows), so latent. | `ordering-orders-with-variants.ts:131` |
| O9 | medium | The future-slot list runs ~500 queries per request, unauthenticated, re-called on every toggle. | `ordering-availability.ts:198` |
| O10 | medium | The order-number counter row stays locked while a whole cart is priced; a big web cart stalls order creation on every channel. | `ordering-orders.ts:99`, `ordering-timed-orders.ts:94` |
| O11 | low-medium | A timed-out partial MX refund is marked failed; a retry with a new replayId can refund twice. | `mx-merchant.ts:87`, `mx-refunds.ts:84` |
| O12 | low-medium | Voided delivery orders stay on the driver app; inventory never restored on void/cancel. | `ordering-driver-delivery.ts:80`, `ordering-inventory.ts:39` |
| O13 | low | Option sold-out per item (`available_override`) is shown in the menu but not enforced by cart/send. | `ordering-menu.ts` vs `ordering-orders.ts:139` |
| O14 | low | Confirmation email says "Pickup"/"Total due at pickup" for delivery and omits the delivery fee line; the confirmation page says "sent" from payment status alone. | `customer-order-confirmation.ts:65`, `order-confirmation.tsx:160` |
| O15 | low | Quantities are clamped instead of rejected; no order-level cap; pizza portion/amount not validated (bad value → 500); whole + both halves of one topping charged twice. | cart route, `ordering-pizza-toppings.ts` |
| O16 | low | The scheduler has one trigger at 3 AM; a deploy on that minute skips the day; a retry re-sends notifications. | `scheduler.ts:136` |
| O17 | low | `db-migrate.sh` records a migration in a separate transaction from applying it. `0014` is ~3,000 lines in one transaction: run it on production with the store closed. | `tools/db-migrate.sh` |
| O18 | low | Future-date picker uses the device time zone; `ensureOrderingTimingSchema` resets a NULL busy threshold to 8 on every start; split windows with a cutoff skip the next window. | `customer-order.tsx:25`, `ordering-timing-schema.ts:47`, `ordering-availability.ts:176` |
| O19 | low | Ops hygiene: production cron log has no timestamps/job names; unpinned images (`cloudflared:latest`, `postgres:17`, `node:22`); no container memory limits; prod tunnel metrics on `*:20242`; leftover secret files and dumps in `/opt/corner-ops/production`; dead Neon migration step in `npm run build`. | deploy |

## Security pass

### Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| S1 | high | PIN-reset completion answered "That PIN is already assigned at this location", and the link stayed valid for 30 min with no limit: an employee could map every coworker's (and owner's) PIN. | Generic message; a link that hits a taken PIN is spent (`credential-resets.ts`). |
| S2 | high | Rate limits keyed on the first `X-Forwarded-For` value, which the client controls behind Cloudflare; a successful login also cleared the business-wide counter. Made 4-digit employee/deli-board PIN logins brute-forceable from the internet (a hit can change direct-deposit details). | `clientIp` prefers `cf-connecting-ip`; business counters are never cleared on success; same IP source for reset requests and address suggestions. |
| S3 | high | Stored XSS: staff photo uploads trust the declared type, and photos were served with it (an SVG with a script ran on the ops site with the owner's session). | Photos are served only as raster types with `nosniff` and a sandbox CSP (`safe-image-response.ts`). Upload-side magic-byte checks still open (S-open). |
| S4 | medium-high | Customer code verification (SMS, email, phone add) read `attempts`, compared, then wrote: parallel guesses all passed the 5-try limit. | Attempt counted atomically before comparing; codes single-use. |
| S5 | medium-high | Owner/staff password login had no rate limit. | 10 failures per 15 min per IP and per account. |
| S6 | medium | Any clocked-in employee could merge customer records (moving orders and loyalty). | Manager required. |
| S7 | low-medium | Reflected XSS on the manager menu-media page (`itemId` into HTML); open redirect after sign-in (`returnTo=/%09/evil.com`). | UUID-only item id; same-origin return path. |

### Needs a decision

| # | Sev | Finding | Recommendation |
|---|---|---|---|
| SD1 | **critical (live on dev)** | dev.ordercornerdeli.com shows customer sign-in codes on screen (`DEV_SHOW_SMS_CODES=true`, no Telnyx): anyone on the internet can sign in as any phone number and see that customer's addresses, orders and loyalty. Worse if the AI phone line has put real customers in the dev database (inferred; not checked). | **Done 2026-10-24** (owner approved): `DEV_SHOW_SMS_CODES=false` in the dev `.env`. Dev phone sign-in now answers "SMS verification is not configured"; use email or Google sign-in on dev. |
| SD2 | high (launch) | SMS pumping: phone sign-in allows any +1 number (incl. Caribbean premium codes) with only 3 codes per phone per 15 min; no per-IP or daily cap or captcha. Email codes likewise (email bombing). | Per-IP and global daily caps with an alert; US/CA area codes only; captcha. |
| SD3 | medium (launch) | Customer host routing: production would 404 the public hostnames, and delivery tracking links are built on `team.ordercornerdeli.com`, where `/track` is denied. Serving customers from `ops.*` would share a site with owner sessions. | **Done 2026-10-24** (see D2). |
| SD4 | medium | dev.* and ops.* are the same site to browsers, so SameSite cookies don't stop dev pages from making requests to production. | Reject cross-site non-GET requests by `Origin`/`Sec-Fetch-Site` in the proxy; long term, move dev to another domain. |
| SD5 | medium | POS network approval works for anyone holding the emailed link (owner session optional); approvals never expire; the 30-day network cookie isn't re-checked. | Owner session on approve, expiry, re-check. |
| SD6 | medium | Port 3000 is published on `0.0.0.0` (Docker bypasses ufw) and the proxy trusts `cf-connecting-ip` from anyone who reaches it directly (LAN/VPN). | Bind to 127.0.0.1 or firewall DOCKER-USER; check which LAN devices call :3000 first (greeter TV). |
| SD7 | medium | `VOICE_PAYMENT_INTERNAL_SECRET` falls back to `THREE_CX_CRM_SECRET` (empty on dev), so one secret unlocks voice payments, the AI-phone session context and CRM lookups. | Separate secrets, no fallback (Asterisk and app change together). |
| SD8 | medium | Game prize codes can be minted with forged scores (client-reported, no sign-in or caps); the redeem routes are unreachable for most staff (proxy wants an owner session, route wants a POS manager). | Caps per device/IP, conditional status update, fix the redeem policy. |
| SD9 | medium | Email-only customers can place unlimited pay-at-pickup orders, and an unverified phone typed at checkout becomes the account's primary phone (a later phone sign-in by the real owner lands in that account). | SMS-verified phone for pay-later; keep unverified phones on the order only. |

### Open (smaller)

Raw `error.message` from several public customer routes (Postgres text on a bad id); Google Maps validate route
unauthenticated and unlimited (cost); cookie `Secure` flag off on dev (http `APP_URL`) and keyed on `NODE_ENV` for
the customer cookie; shared `SESSION_SECRET` HMAC without a token type; client `X-Forwarded-Host` drives host
rules; password/PIN reset requests unlimited and claimable twice in a race; push subscriptions accept any https
endpoint (blind SSRF); upload paths not UUID-checked; upload type checks by declared MIME only; POS sessions not
revocable server-side (no session version); 10-year screen passes creatable by any PIN user.

Sound: all cron routes (constant-time bearer, closed when unset), 3CX/Telnyx/OpenAI webhook checks, Google OAuth
state and redirect, customer order access by session-bound cart, parameterized SQL everywhere, ASCII-filtered
printer output, no `NEXT_PUBLIC_*` secrets, driver and employee routes scoped to their user, Postgres not published.

## What was checked and found sound

- Prices, modifiers, combos, toppings and promotions are computed on the server from the database; the browser's
  numbers are never trusted, and Send re-prices every line.
- Tax-inclusive math: tax is never added on top; reports back it out with the rate history.
- Customer orders are tied to the session's cart row; no way found to read or pay another customer's order by id.
- `commitTender` is idempotent per request id and locks the order; refunds are logged outside the transaction so
  a retry reuses an MX approval; terminal sessions are claimed atomically with replay-id lookups.
- Delivery distance comes from a server-signed (HMAC, 30 min) address token and a server driving route.
- Print jobs are claimed atomically (no double prints), retried with backoff, and the offline POS queue replays
  idempotently.
- Hot ordering tables are well indexed; Postgres 5432 is not published; `update.sh` locks, migrates before
  restart and rolls back on a failed health check; no destructive statements in migrations.
- Wall-clock ↔ UTC conversion for hours and slots handles the Nov 1 DST change; ESC/POS and label printing escape
  special characters.
