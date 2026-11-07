# Codex second review — 2026-10-24

Branch: agent/pos-ordering-foundation. Reviewed baseline 36c9eda through 86606e9, plus the local alert fix recorded below. Scope: customer website → MX checkout → kitchen first, then payment, security, operations and the remaining changed files. No production, main, Cloudflare or port-5432 changes were made.

## Validation

- Verified: npx tsc --noEmit passed; npm test passed (282/282).
- Verified: all ten requested dev-database suites passed: ordering:lifecycle, payments, online-checkout-preflight, scheduled-order-hold, void-money, ordering-availability, order-void, item-cancellation, promotions, delivery-pricing. Some scripts use rollback transactions; item-cancellation uses explicit fixture cleanup rather than a rollback, so the handoff's blanket rollback description is inaccurate.
- Verified after the local alert edit: npx tsc --noEmit and online-checkout-preflight passed, including a paid draft aged two days.
- Test-safety issue found during review: the pre-existing rollback validations could call the real POS push sender after submitDraftOrder. A push may have been attempted during the first run; delivery could not be confirmed. I added a validation-only outbound guard in scripts/validation-env.ts and the shared push, email and SMS senders, then reran the requested suites. No print or payment was intentionally sent. The MX terminal e2e script uses a stand-in but temporarily changes dev printer/station settings; it was not run during store hours. The separate MX sandbox replay/token questions remain untested.
- The diff covers 103 files and 22 commits. I read the full diff inventory and traced the highest-risk changes and their callers. Findings below distinguish source-verified paths from provider/runtime behavior that still needs a controlled reproduction.

## Findings, ranked

### High

1. **Verified source path — a charged order can receive a generic failure and need manual rescue.** In src/app/api/customer/orders/[id]/payments/mx/route.ts:57-83, the MX approval is recorded before submitDraftOrder. Only OrderConflictError is converted to a charged-but-unsent response. A plain Error from loyalty finalization or a database/other exception after the charge reaches the outer 500 handler at :175-186. The browser then displays a generic payment verification error (src/app/order/customer-order.tsx:710-745). Scenario: loyalty availability changes after preflight and finalizeLoyaltyRedemptions throws a plain Error; the customer sees failure after an MX approval. Catch all post-recording send failures, log and persist a paid-unsent incident, return paymentRecorded=true, and keep a reconciliation job for failures between MX approval and commitTender. Provider behavior was not reproduced.

2. **Verified source path — void-money resolutions can exceed the amount owed.** resolveVoidMoney reads owed before the transaction (src/lib/ordering-void-money.ts:75-87). reverseTender and settleTenderAsStoreCredit lock a payment source before the order, and only check that source's remaining amount (src/lib/ordering-payments.ts:126-145,194-204). Scenario: two $10 tenders on an order with $5 owed; two managers concurrently resolve $5 on different tenders. Both pass the $5 check and issue $10 total. Serialize on the order and recalculate owed in the same transaction before either refund or credit; use a consistent lock order and preserve MX replay safety.

3. **Verified source path — active MX sessions do not freeze the payable amount.** MX initialize creates a new session each time with the current amount (src/app/api/customer/orders/[id]/payments/mx/route.ts:120-160). Confirm checks MX amount against the session, not the order's latest due; delivery and loyalty can change totals while a session is open (their routes). Concurrent tabs or repricing can therefore leave an approved charge rejected by commitTender, or apply the wrong amount. One active session per order, reject amount-changing edits during it, and automatically void/reconcile an approved mismatch. See O1, O2 and O7. The exact MX duplicate response needs sandbox verification.

4. **Verified source path — held orders can miss the kitchen release.** releaseHeldKitchenOrders selects only release times in the previous 12 hours (src/lib/ordering-auto-print.ts:52-57). Scenario: maintenance is unavailable for 13 hours; a held order never receives a release event, first print, or push. The same flow records the release event before trying print; when auto-print is paused, the ticket becomes not_configured (:60-74 and :30-40), and retryDuePrintJobs excludes it (src/lib/ordering-hardware.ts:837-852). Resume printing must explicitly claim eligible paused tickets. Remove the 12-hour cutoff and use durable claim/retry state. A concurrent release/void race is also possible because the insert rechecks neither status nor a unique release key (:60-64); non-retry printing excludes cancelled orders only when retryOnly is true (ordering-hardware.ts:760-772).

5. **Verified source path — failed owner email can be recorded as sent.** remindUnresolvedVoidMoney inserts the daily audit row before sending, then ignores sendTransactionalEmail's returned sent/failures (src/lib/ordering-void-money.ts:114-133; src/lib/transactional-email.ts:50-103). An SMTP/Resend failure suppresses every later attempt for that day. Use an outbox/claim with a delivered state; retry unsuccessful recipients under an idempotency key. The unresolved list also excludes orders whose updated_at is older than 14 days (ordering-void-money.ts:26-36), so an old debt vanishes from both the POS list and reminder without resolution.

### Medium

6. **Verified and fixed locally — paid drafts disappeared from POS alerts.** The previous online-alert query discarded paid drafts after one day and capped sent and draft orders together at 200. I changed src/lib/ordering-online-alerts.ts to include every unresolved paid draft, and to cap only the 200 newest sent orders. scripts/online-checkout-preflight-validate.ts now tests a paid draft two days old. This has passed typecheck and the rollback validation. It is not pushed or running on dev yet.

7. **Verified source path — cancelled items return during recalculation/reopen.** recalculateOrder sums all line_total_cents (src/lib/ordering-orders.ts:412-433), promotions use every line (src/lib/ordering-promotions.ts:61-72), and revalidateDraft reads every line (src/lib/ordering-order-lifecycle.ts:229-237), without accounting for cancelled quantity. Add a cancelled-quantity fixture covering reopen, promotion, and send; then make all three use effective quantity and subtotal. See O3.

8. **Verified source path — refunded orders can look overdue.** reverseTender resets payment_status to unpaid and amount_due to the original total when paid_cents reaches zero (src/lib/ordering-payments.ts:171-174). Order Center's unpaid selection can include the refunded order. Define a refunded/voided display state and keep it out of overdue/KDS selectors. See O4.

9. **Verified source path — direct dev-port requests can spoof the rate-limit IP.** clientIp trusts cf-connecting-ip in src/lib/rate-limit.ts:40-44, while docs/PROCESS-MAP.md says port 3000 is reachable on the LAN. Restrict direct access or trust that header only from a verified Cloudflare proxy; do not expose PostgreSQL. See SD6.

10. **Verified source path — public request limits can be exceeded in a burst.** consumeRateLimit first reads blocked_until and then increments in separate statements (src/lib/rate-limit.ts:77-145). Many concurrent SMS-code or card-start requests can all pass the read before any update sets blocked_until. Claim quota atomically in the upsert and reject the request that exceeds its policy; keep per-IP and global counters consistent.

11. **Verified source path — concurrent pay-later orders can exceed the chosen two-order rule.** The pay-later route counts earlier submitted unpaid orders, then calls submitDraftOrder without a customer/phone lock (src/app/api/customer/orders/[id]/pay-later/route.ts:29-43). Two tabs can both see one previous order and send, leaving three in twenty minutes. Serialize by customer or normalized phone across count and send, with a rollback fixture.

## Open-item disposition (O1–O19)

“Verified” means the described source path was checked; it does not claim a live provider reproduction.

| Item | Status and fix |
|---|---|
| O1 | Verified source: multiple initialized MX sessions; use per-order session claim and automatic mismatch void. |
| O2 | Verified source: delivery/loyalty edit paths lack session guard; freeze amount-changing edits. |
| O3 | Verified source: three calculations ignore item cancellations; effective quantity plus validation fixture. |
| O4 | Verified source: refund resets unpaid state; add refunded display/filter rule. |
| O5 | Verified source: additions route reads draft without FOR UPDATE; serialize append and submit on the order row. |
| O6 | Verified source: loyalty locks application rows, not customer balance across orders; lock customer/program before reward check. |
| O7 | Verified source: send reapplies promotions to a paid draft; freeze priced promotion snapshot during active/paid checkout. |
| O8 | Inferred latent: variant override/free-included pricing has no dev fixture; add a sized-item fixture before editing. |
| O9 | Verified source: slot enumeration calls availability repeatedly; batch windows/capacity reads per request. |
| O10 | Verified source: order number advances inside the pricing transaction; allocate number after expensive pricing or separate claim. |
| O11 | Inferred MX outcome: partial-refund timeout may retry with a new replayId; reconcile previous attempt at MX before issuing another. |
| O12 | Verified source: voided delivery remains eligible in driver list; inventory reversal absent; filter delivery and restore stock transactionally. |
| O13 | Verified source: per-item option override shown by menu is not a send/cart guard; validate selected option availability. |
| O14 | Verified source: delivery confirmation copy/fee and paid-only confirmation state; use service type and sent status. |
| O15 | Verified source: cart quantity clamping and incomplete pizza option guards; reject invalid inputs and cap total quantities. |
| O16 | Inferred runtime: 3 AM single-shot scheduler/retry behavior; durable per-day claim/outbox. |
| O17 | Verified script structure: migration application and record transactions are separate; couple them before production migration. |
| O18 | Verified source: device-zone picker and timing defaults/window handling; use store zone and preserve explicit null. |
| O19 | Mixed: deploy configuration issues are visible in repo; running disk/log/secret-file state was not independently inspected. Pin images and add log/disk controls. |

## Owner decisions (D1–D17)

I treated the owner's chosen rules as requirements. “Code verified” means I inspected the implementation or passing test, not a production rehearsal.

| Item | Disposition |
|---|---|
| D1 | Code verified: encrypted offsite script and scheduling documented; upload/restore not repeated here. |
| D2 | Code verified: customer host routing and production MX guard; production tunnel/env setup remains a launch task. |
| D3 | Verified by lifecycle and preflight suites: web send checks configured hours. |
| D4 | Verified by void-money suite: money can remain after void and manager resolution exists; findings 2 and 5 remain. |
| D5 | Code verified: updater pruning; Docker log rotation and disk alert remain open. |
| D6 | Code verified: workflows include this branch and dependency override; CI run result not independently checked. |
| D7 | Verified from process map/config: production maintenance and missed-clock-out jobs remain switch tasks. |
| D8 | Code verified: category seed updates only missing values; no live manager-edit rehearsal. |
| D9 | Code verified: initialize limit is present; see O1 and SD6. |
| D10 | Verified by scheduled-order suite: future orders held until prep, exception days computed; finding 4 remains. |
| D11 | Code verified: Asterisk recreate condition; dev-dependent devices still a switch task. |
| D12 | Verified dev configuration without printing values: on-screen codes are disabled; MX is sandbox and LOCAL_DEVELOPMENT is enabled. |
| D13 | Code verified: first poll after unlock includes recent orders and paid drafts; finding 6 fixed locally. |
| D14 | Open business decision; no rule was invented in this review. |
| D15 | Verified by delivery-pricing suite: minimum after discounts on tested channels. |
| D16 | Code verified: paid-up-front counter-order KDS exception. |
| D17 | Verified by availability suite: slot lead time; capacity remains open. |

## Security disposition (SD1–SD9)

| Item | Disposition |
|---|---|
| SD1 | Verified dev configuration without printing values: on-screen codes are disabled. Real customer data in dev was not audited. |
| SD2 | Code verified: per-IP/day and phone-region guards; CAPTCHA remains absent. |
| SD3 | Code verified: customer host/SEO paths; production routing is a launch step. |
| SD4 | Code verified: proxy cross-site mutation guard; browser matrix not run. |
| SD5 | Open, source verified: approval link/session lifetime and cookie recheck need hardening. |
| SD6 | Open, source verified: direct :3000 and trusted client-IP header; finding 9. |
| SD7 | Open, source verified: voice secret fallback; remove it in an Asterisk/app coordinated change. |
| SD8 | Open, source verified: client-reported game scores and redemption policy need controls. |
| SD9 | Open, source verified: unverified checkout phone may become primary; require verified phone for pay later. |

## MX sandbox questions and next steps

The actual MX replayId shape after a decline then approval, duplicate-charge deduplication, and browser-token permissions were **not verified**. retrieveMxPayment expects a top-level approved status (src/lib/mx-merchant.ts:16), while findMxPaymentByReplayId accepts records but returns only its first record (:18). Use controlled sandbox attempts and inspect the full response shape; do not assume one record or idempotency. The existing test:mx-terminal:e2e uses a local MX stand-in and temporarily changes dev hardware settings, so it cannot answer those provider questions.

Next code work should prioritize a durable charged-but-unsent recovery path, order-level refund serialization, MX session freezing/reconciliation, and durable scheduled-order release/printing. Add focused rollback fixtures for the concurrency and cancellation scenarios. No production deployment is authorized.

## Claude's follow-up (2026-10-24)

| Codex # | Status |
|---|---|
| 1 Charged order, generic failure | **Fixed:** any error after the payment is recorded returns `paymentRecorded` with "your card was charged" and leaves the paid draft on the POS alert. A durable reconciliation job for an approval that never reached `commitTender` is still open (with O1). |
| 2 Void-money over-refund race | **Fixed:** `resolveVoidMoney` locks the order and re-reads what's owed inside one transaction. |
| 3 MX session not frozen | Open (O1/O2/O7); needs MX sandbox answers first. |
| 4 Held orders missing release | **Fixed:** no 12-hour cutoff (7-day safety), release claim requires `sent_to_kitchen`, and no dispatch path prints a kitchen ticket for a voided order. Paused auto-print still means "print by hand" (unchanged behavior). |
| 5 Reminder recorded before sending; 14-day window | **Fixed:** the day is marked only after a successful send; failures retry every 30 minutes; the list covers 90 days by order creation. |
| 6 Paid drafts dropped from alerts | Codex's fix kept; after a reload only paid drafts from the last day ring again (older ones stay listed without chiming). |
| 7 Cancelled items return (O3) | Open. |
| 8 Refunded looks overdue (O4) | Open. |
| 9 Direct :3000 IP spoofing (SD6) | Open: binding :3000 to localhost would break the greeter TV and LAN devices; needs a plan with the owner. |
| 10 Burst past rate limits | **Fixed:** `consumeRateLimit` is one atomic upsert per policy; `npm run test:rate-limit-burst` (30 parallel → exactly 5 through). |
| 11 Pay-later race | **Fixed:** count and send under per-customer and per-phone advisory locks in one transaction. |

Not pushed until after store hours (pushing redeploys dev, which runs the TVs and phone line).

## Recheck after Claude follow-up (2026-10-24, HEAD 844831f)

Read-only review of `be498b7..844831f`. `npx tsc --noEmit`, 282 unit tests, 12 dev-database suites (rolled back or cleaned up), the MX sandbox validation, `git diff --check`, and the dev health endpoint passed. Dev checkout and runtime both report `844831f`. No printing or deployment was triggered.

1. **High — concurrent confirmation can report failure after a charge (inferred from code).** In `src/app/api/customer/orders/[id]/payments/mx/route.ts:203-219`, two confirms can both read an `initialized` session. `commitTender` checks the mutation ID before locking the order (`src/lib/ordering-payments.ts:264-279`). After the first commits, the second reaches the unique payment index (`db/migrations/0014_runtime_schema.sql:698`) and returns a generic error rather than `paymentRecorded`. Serialize confirmation per session and recheck its status and mutation after locking.
2. **High — changed amount can still leave an MX charge unrecorded (inferred from code).** The due check at `src/app/api/customer/orders/[id]/payments/mx/route.ts:61` is outside the order lock later taken by `commitTender` (`src/lib/ordering-payments.ts:274-299`). If another payment or discount lowers due between those steps, the card has been charged but `commitTender` rejects the overpayment. The route returns a generic conflict without voiding or alerting staff. Reconcile every provider approval even if recording fails.
3. **High — failed automatic void is absent from the POS alert list (verified code path).** The changed-order branch marks the MX session `needs_review` (`src/app/api/customer/orders/[id]/payments/mx/route.ts:63-68`) without recording a tender. The POS alert query only includes paid drafts (`src/lib/ordering-online-alerts.ts:31-38`), so staff do not see this case. Add an alert for keyed MX sessions needing review and an explicit resolution path.
4. **Medium — refund lock order is inverted (inferred concurrency failure).** Void-money resolution locks the order then calls `reverseTender` (`src/lib/ordering-void-money.ts:79-93`); direct payment reversal locks the source tender then the order (`src/lib/ordering-payments.ts:126-142`). Concurrent actions on the same payment can deadlock. MX reversal attempts are persisted outside the order transaction, so one request may have approved at MX before its transaction aborts. Use a consistent lock order and surface approved-but-unapplied attempts.
5. **Medium — unresolved voids disappear after 90 days (verified code path).** `listUnresolvedVoidMoney` filters on `created_at > NOW()-INTERVAL '90 days'` (`src/lib/ordering-void-money.ts:31`). That same list feeds the manager resolution flow and reminder, leaving older unpaid refunds invisible. Keep unresolved balances visible until resolved.

The sandbox test proves sequential attempt reuse and a changed-order void. It does not cover simultaneous tabs, a failed MX void, or the timing gap between due check and tender commit. No branch changes were pushed during store hours.
