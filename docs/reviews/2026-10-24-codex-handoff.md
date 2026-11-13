# Codex second review: handoff

What to give Codex so it can check the 2026-10-24 production review independently. Paste the prompt in §4 into
Codex with this repository open; everything it needs is in the repo.

## 1. Files to read first (in this order)

1. `AGENTS.md`: branch, deploy and secret rules (no `main`, no production, no Cloudflare, 5432 stays private).
2. `docs/PROCESS-MAP.md`: machines, environments, scheduled jobs, outside services.
3. `docs/ARCHITECTURE.md`: request path, order engine, payments, printing, time and money rules.
4. `docs/online-ordering.md`: the customer journey, card payment sequence and launch checklist.
5. `docs/reviews/2026-10-24-production-review.md`: findings, what was fixed, what is open.

## 2. What changed and needs a second pair of eyes

`git log 36c9eda..HEAD` on `agent/pos-ordering-foundation`. The riskiest changes, in order:

| Change | Files | What to try to break |
|---|---|---|
| Checkout preflight | `src/lib/ordering-order-lifecycle.ts` (`preflightDraftSubmit`, `runDraftSubmit`, `rollbackOnPreflight`) | Can a preflight ever commit anything (promotions, delivery fee, restored reopen, loyalty, print job, inventory, push)? Top level and nested in a caller's transaction. Does `submitDraftOrder` behave exactly as before? |
| Lost-confirm recovery | `src/app/api/customer/orders/[id]/payments/mx/route.ts` | Double charge or double record across: confirm lost then pay again; two tabs; confirm and initialize racing; MX down; declined first attempt; session amount ≠ current amount due. |
| Paid-but-not-sent handling | same route, `src/lib/ordering-online-alerts.ts`, `src/app/order/customer-order.tsx` | Does every path where the card is charged either send the order or leave it on the POS alert list? Can a customer be told "payment failed" after a charge? |
| Cart guards | `src/app/api/customer/cart/route.ts` | Web-visibility query vs `orderingMenu(…,"web")` (item/category channel overrides, moved categories); `modifierAmounts` with intensity rules. |
| Business day | `src/lib/business-day.ts`, `src/lib/ordering-operational-report.ts` | DST edges (2026-11-01, 2027-03-14), year ends, report ranges. |
| Void/payment guards | `ordering-payments.ts` (`commitTender` cancelled check, store-credit reversal), `mx-terminal-payments.ts` (`completeWithTip`), `ordering-hardware.ts` (retry skip), lifecycle `transitions` | Anything legitimate now refused? A voided order with an authorized terminal hold. |
| DB pool | `src/lib/db.ts` | `idle_in_transaction_session_timeout` 5 min: any transaction that waits on an outside call that long? `release(err)` semantics. |
| Security fixes | `credential-resets.ts`, `rate-limit.ts` (`clientIp`, `clearRateLimit`), `api/auth/session`, customer code verification (`auth/phone`, `customer-email-auth.ts`, `account/phone`), `safe-image-response.ts` | Is `cf-connecting-ip` trustworthy on every path that reaches the app (direct :3000 too)? Do staff photos still display (HEIC from iPhones)? Any login now locked out wrongly? |
| Customer host | `src/lib/customer-domain-routing.ts`, `src/proxy.ts`, `src/app/manifest.ts`, `robots.ts`, `sitemap.ts`, `src/lib/customer-seo.ts` | Can anything other than customer pages and `/api/customer` be reached on ordercornerdeli.com (path tricks, `X-Forwarded-Host`)? Does the cross-site guard in the proxy block any legitimate flow (ops business switch, payment station, Capacitor app, webhooks)? |
| Abuse limits | `customer-abuse-limits.ts`, `phone-region.ts`, `rate-limit.ts` (`consumeRateLimit`), pay-later 2-in-20-min rule | Limits a real customer hits by accident; ways around them. |
| Closed without hours, slot lead time, delivery minimum after discounts | lifecycle (`websiteOrder`), `ordering-availability.ts` (`leadMinutes`), `ordering-delivery.ts` (`merchandiseAfterDiscounts`) and its callers | Staff channels unchanged? AI phone / POS / website agree on the minimum? |
| Scheduled-order hold | `ordering-kitchen-release.ts`, lifecycle (`kitchen_release_at`), `ordering-hardware.ts` (dispatch filter), `ordering-auto-print.ts` (`releaseHeldKitchenOrders`), `ordering-online-alerts.ts`, KDS client, `kitchen-ticket-layout.ts` (`DUE_BANNER`), migration 0017 | Released exactly once? Printed when auto-print is paused then resumed? Reopened/add-on orders? DST and the Halloween / Super Bowl exceptions? The ESC/POS inverted banner on a real printer. |
| Voided money | `ordering-void-money.ts`, `api/ordering/order-center/void-money`, `void-money-panel.tsx`, item-cancel `refundMethod: "later"` | Is "owed" right after partial refunds, item cancellations, tips, gift cards, split checks? Can it go negative or double-refund? Only managers? |
| Kitchen screen paid-up-front rule; chime after unlock; menu-edit persistence | lifecycle `listKitchenOrders`, `pos-offline-sync-policy.ts`, `use-online-order-alert.ts`, `ordering-db.ts` | Old orders chiming on every reload; orders lingering on the board. |
| Ops | `deploy/update.sh` (Asterisk only when changed, prunes), `deploy/offsite-backup.sh`, `.github/workflows/*`, zod override | Prune removing something still needed; backup script failure modes (no alert today). |
| Store dashboard / tips SQL | `ordering-store-dashboard.ts`, `ordering-tips.ts` | Eastern day boundary at 8 PM and across DST. |

## 3. Open items to confirm or fix

From the review's **Open** table (O1–O19), the ones worth Codex's time first:

1. O1/O2: one active MX checkout session per order, reject delivery/loyalty changes while a session is open,
   automatic MX void when the confirmed amount doesn't match.
2. O3: item cancellations vs `recalculateOrder` / promotions / `revalidateDraft` (write a validation script).
3. O4: refunded orders shown unpaid/overdue.
4. O5/O6: row lock in the additions route; per-customer lock for loyalty redemption.
5. O8: free included choices on sized items (needs a fixture; no such data in dev).
6. O9/O10: slot listing query count; order-number counter held inside the pricing transaction.

And the MX questions only the sandbox can answer (`npm run test:mx-terminal:e2e` and the keyed dialog against the
MX sandbox; dev `.env` is sandbox):

- Does MX dedupe a retried charge with the same `replayId`, and what does `GET /payment?replayId=` return after
  a decline followed by an approval on the same replayId (one record or `{records:[…]}`)? `retrieveMxPayment`
  doesn't handle the `records` shape that `findMxPaymentByReplayId` does.
- Can the browser checkout token do anything besides a Sale (Return, list payments)?

## 4. Prompt to paste into Codex

> Read AGENTS.md, then docs/PROCESS-MAP.md, docs/ARCHITECTURE.md, docs/online-ordering.md and
> docs/reviews/2026-10-24-production-review.md. Claude did a production-readiness review of this repository on
> 2026-10-24 and committed fixes and the owner's decisions after 36c9eda on agent/pos-ordering-foundation. Do an independent second
> review, with online ordering (customer website → MX card payment → kitchen) as the top priority:
>
> 1. Review every change in `git diff 36c9eda..HEAD` for correctness. Follow docs/reviews/2026-10-24-codex-handoff.md
>    §2 for what to try to break. Report anything wrong with file:line and a concrete failing scenario.
> 2. Independently look for anything the review missed that would lose an order, charge a customer wrongly,
>    leave staff unaware of an order, or take production down. Don't just re-check the listed findings.
> 3. Confirm or refute the Open items O1–O19, the Decide items D1–D17 and the security items SD1–SD9 (some are inferred; say which you
>    verified). For each confirmed Open item, propose a fix; implement only small, behavior-preserving ones.
> 4. Run `npx tsc --noEmit`, `npm test`, and the dev-database suites (`npm run test:ordering:lifecycle`,
>    `test:payments`, `test:online-checkout-preflight`, `test:scheduled-order-hold`, `test:void-money`,
>    `test:ordering-availability`, `test:order-void`, `test:item-cancellation`, `test:promotions`, `test:delivery-pricing`); they run inside rolled-back
>    transactions on the dev database.
>
> The owner's decisions in the review's Decide table (marked Done) are business rules: check the code does what
> they say, don't argue the rule. Validation scripts must never send real email, texts or pushes: dev holds real
> credentials, so stub any sender.
>
> Rules: follow AGENTS.md. Never touch production (/opt/corner-ops/production, port 3001, the prod database),
> Cloudflare, or main. Don't print secrets from any .env. Pushing to agent/pos-ordering-foundation redeploys the
> dev app within a minute, and dev drives the store's menu TVs, greeter and AI phone line, so push only outside
> store hours (Sun–Thu after 9:30 PM, Fri–Sat after 10:30 PM Eastern, before 10:20 AM). Write your findings to
> docs/reviews/2026-10-24-codex-second-review.md, ranked by severity, each marked verified or inferred.

## 5. What Codex should not need

No credentials, production access or database dumps. The dev database and MX sandbox are enough for every check
above. Questions about business rules (voids and refunds, unconfigured hours, pay-later limits, when future
orders print) are listed as **Decide** items for the owner, not for Codex.
