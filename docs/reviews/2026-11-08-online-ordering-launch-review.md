# Development online-ordering launch review — 2026-11-08

This is a second walkthrough of the development ordering application, starting from `2438658a`, after the November 6 audit. It covers customer checkout, displayed and server prices, pickup/curbside/delivery, payment recovery, rewards, timing and confirmation. It does not authorize a production deployment or merge to `main`. Phone AI ordering remains outside scope.

## Confirmed defects addressed

- **Payment recovery:** an approved charge could be missed when its attempt was locally expired, superseded, marked declined by the browser, older than six hours, beyond the five newest attempts, or attached to a replaced cart. Two tabs with different replay IDs after local expiry could also both charge, with recovery stopping after the first approval. Recovery now considers every unresolved attempt across the browser session, recognizes settled payments, blocks uncertain processor statuses and amount/refund discrepancies, and reverses replaced-cart or extra charges once. Already-paid confirmation retries and saved-card checkout also reconcile other attempts. A failed reversal remains visible for staff review. Token creation rechecks active-cart ownership, unpaid draft status and balance under locks. Provider lookups run in bounded batches; incomplete recovery does not authorize another payment.
- **Delivery edits during payment:** routing finishes outside the transaction, then the order is locked and checked again. A paid, submitted or replaced order cannot receive a late address/fee update. Address and total changes commit together.
- **Included modifiers and combinations:** submit-time validation now correctly accepts an included portion carrying its group's one-time fee, while detecting changed allowances/fees. Combo ownership, availability, required choices and current prices are revalidated before payment/submission.
- **Checkout review state:** a delayed price, pizza-reward or points response cannot restore an obsolete review after the cart/contact/fulfillment changes. SMS verification rebuilds the draft under the new session before presenting the final review. The verification button says “VERIFY & REVIEW ORDER.”
- **Quantity and price explanation:** option quantities are independent of the limit on distinct choices. Requests send unique option IDs plus actual quantities. The UI shows variant-specific prices, included portions, one-time group fees and repeated portions in cart details.
- **Scheduled orders:** offered slots respect service type, configured future-order horizon, opening windows, prep lead time and daylight-saving boundaries. A slot that expires before first submission fails preflight before a new charge. Existing staff reopen behavior is preserved.
- **Confirmation:** scheduled kitchen holds remain at “Order placed” until scheduled prep release. Refunds and cancellations do not present refunded money as a new amount due; legitimately unpaid accepted orders retain their balance, and repaid orders show paid.
- **After-hours ASAP preorders:** the actual mobile walkthrough exposed “We're making it” before the next opening. The confirmation now says the preorder is queued for opening; the UI and arrival API prevent early curbside check-in. Normal ASAP orders, delayed pickups and actual kitchen progress remain eligible. The existing policy of immediately printing ASAP preorders is preserved.

## Verification approach

Mutation tests use disposable PostgreSQL databases with no published ports: a development-data copy and a fresh database built from the same migrations and sanitized menu fixture used in CI. The copied hardware devices are disabled, queued print jobs removed, and outbound notifications disabled. No live customer order or physical ticket is submitted by these tests.

The browser walkthrough uses the actual MX **sandbox**, not a gateway stub, and actual Google address validation/routing for a public business address. It verifies saved order and payment totals, confirmation items/payment state, and repeated confirmation behavior. Every approved sandbox charge is reversed and read back from MX to verify the reversal. SMS verification uses the existing on-screen development code mode. Live messages and production card settlement are separate checks.

Passing evidence before the final runtime update includes:

- 461 unit tests; runtime schema-DDL and dependency security guards.
- 37 desktop browser scenarios against the production build, including customer checkout, confirmations, pizza quantities, kiosk, the order-linked loyalty card, driver views and the pizza game. All 26 customer/confirmation/pizza cases also pass at mobile size. Four manager-access cases pass with isolated test sessions.
- Fresh CI-style database: 18 loyalty abuse scenarios, nine order-linked loyalty-card checks, 249 pizza/variant-pricing assertions, employee-meal invariants, 28 new modifier-fee/combo cases, pizza-game abuse/concurrency invariants, existing checkout-race checks, 30 new payment-start/delivery-race cases and scheduled availability/preflight boundaries. The final checkout rerun includes preopening confirmation/check-in and both daylight-saving transitions.
- An additional temporary pricing fixture passed 38 cases, including optional/multi-choice/negative-surcharge combos and fee/portion-price ties.
- Nine existing database validators: order lifecycle, checkout preflight, modifier allowances, combo dependencies, menu refinement, Deluxe pricing, pizza toppings, payment workflow, and scheduled kitchen holding/release. Temporary bootstrap changes restricted them to the disposable database; their test bodies were unchanged.
- Real browser checkout for guest card pickup, verified pay-at-pickup, mobile curbside, delivery with its distance fee, saving a card with consent, and using then removing that saved card. Duplicate confirmation creates no second tender; unpaid orders earn no points. Saved card removal is verified through the account API; sandbox payment reversals are verified at MX.

The final application build and standalone TypeScript check pass. All six sandbox journeys also pass against that production build, with all five card charges reversed and no cleanup errors. The delivery target for this milestone is only `origin/agent/pos-ordering-foundation`; after the required development updater, verify source/runtime SHAs, `/api/health`, PostgreSQL health and unpublished port 5432. No production deployment is included.

## Current menu observations

Two prior price observations are resolved in the current development menu: the full Pepperoni Chicken Parmesan Sub is $12.50 versus $11.75 for Chicken Parmesan, and Breakfast Pizza's default garlic sauce adds $0.00. Jalapeño Ranch 4 oz remains $1.25 versus $1.75 for regular Ranch/Blue Cheese 4 oz. This is a business pricing choice to confirm, not evidence of a calculation exploit. This audit does not establish food-cost margins.

## Launch limits

Automated tests and sandbox purchases reduce demonstrated risks; they cannot prove the system has no flaws. The production host and production credentials/configuration are not changed or certified here. A real production payment/refund, physical kitchen ticket and staff alert, live SMS/email delivery, and the scheduled-order maintenance job need a store-side launch rehearsal. Production routing, Google callback registration, menu/hours/fees/tax settings and MX live mode must match the intended launch setup.

Previously documented policy limits still apply: verified pay-later orders can be placed without prepayment; replay validation does not exclude every legal automated game player; and proportional loyalty reversal for amount-only partial refunds is a business-policy decision. Concurrent prepaid reward claims cannot spend the same reward twice, but a losing checkout may require staff payment recovery.
