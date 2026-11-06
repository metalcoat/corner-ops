# Web, staff ordering, loyalty and pizza audit — 2026-11-06

This review covers the current `agent/pos-ordering-foundation` code, customer web/kiosk ordering, staff POS and kitchen flows, payments and refunds, menu pricing, loyalty/points, and the Jumbo Rush pizza prize game. Phone AI ordering and production deployment are excluded.

## Findings corrected

- **Unpaid reward farming:** accepting an unpaid or partly paid order no longer grants punches or points. Final payment grants the eligible amount once.
- **Concurrent reward spending:** order/customer locks and transactional finalization prevent simultaneous carts spending the same reward balance. Quoted thresholds and required quantities are retained; competing programs cannot discount the same units. Explicitly stackable rewards/promotions are capped at the affected line’s remaining price, preventing a free pizza’s excess discount spilling onto unrelated food.
- **Refund abuse:** cancelling free food cannot refund another line's cash. Cancelled items lose their earned credit, and a cancelled reward is returned once. Fully refunded purchases lose their earnings, including refunds to store credit. Refund retries and repayment cannot create extra credit. A rewarded multi-quantity line must be cancelled in full.
- **Points expiry abuse:** concurrent reads expire a balance once. New purchases do not revive expired points, and voided or fully refunded purchases do not renew the age of unrelated points.
- **Customer account takeover:** a guest entering an existing phone number cannot fill the account's empty login email with an address they control. Reward requests also require the authenticated customer and the current cart's ownership.
- **Repeated card confirmation and reversal:** repeated confirmations retain the valid recorded payment. Changed-total reversals are claimed once, so concurrent requests cannot reverse twice or overwrite a successful void. Failed/uncertain reversals remain visible in the POS and manager payment review; replacement payments are blocked. A manager can clear the review only after MX confirms a matching void or full refund. A paid draft that cannot reach the kitchen is clearly shown as requiring staff help.
- **Reward checkout:** customers review and apply rewards before placing an order. A fully rewarded zero-dollar order can be submitted without creating a card charge.
- **Included add-ons and size prices:** allowances count actual portions, so selecting many portions of one option cannot make them all free. Size prices are resolved before allowances. The server validates unavailable sizes, malformed quantities and overlapping pizza portions; submission rechecks stored choices.
- **Employee meals and Tiki tabs:** both use the same resolved size/allowance pricing. A failed employee-meal submission rolls back the meal allowance and stock changes, concurrent requests consume one daily meal, and successful meals deplete inventory once.
- **Customer/staff price estimates:** modifier quantities, size overrides, included portions and combo surcharges are reflected in displayed totals. Size-based menu items advertise their cheapest available size. Changing a pizza topping's amount on one half preserves the other half.
- **Scheduled menus:** catalog requests use the chosen fulfillment time and discard stale responses.
- **Pizza prize fabrication:** new prizes require replay of a bounded input log against a server-derived random seed. Legacy completion cannot mint prizes. Concurrent wins issue one code and consume one prize quota; codes redeem once. Invalid/lost games cannot mint rewards or exhaust the prize quota. Start requests and checkpoints are bounded; malformed loss statistics cannot break the leaderboard. Pausing/resizing remains replayable.
- **Staff workspace reliability:** switching employees clears authentication and locks other tabs without discarding the unfinished cart. Kitchen views now immediately hide when the shared session locks. Long employee names no longer cover workspace navigation. Payment actions use their actual height in the scrolling checkout panel, keeping the keypad and Back button reachable when additional tenders are available.
- **Order loyalty lookup:** a staff order’s Points & Jumbo Card opens current balances and the selected order’s reward activity, alongside recent history. Access follows staff authentication and the order’s business/customer association.
- **Missing store coordinate table:** migration `0039_store_location.sql` supplies the geocoding cache already used by ordering pages; runtime handlers do not create schema.

## Verification

All development testing used disposable PostgreSQL databases with no published database port: one development-data copy and one clean migration/menu fixture matching CI. Test credentials were generated locally. Outbound notifications and printers were disabled; card gateway calls used stand-ins. No test charge, customer message, store ticket or production data change was intentionally sent.

- 51 existing database/workflow validators cover order lifecycle, holds, availability, customers, modifier allowances, promotions, tax/receipts, cash/registers, gift cards, house accounts, splits, refunds/voids, hardware/print descriptions, kitchen, Tiki, delivery/driver workflows and operational reporting.
- 18 targeted loyalty/account/refund abuse scenarios pass against the clean fixture; the first 17 also passed against the development-data copy.
- 249 pizza size/topping/quantity and variant-allowance assertions pass against the clean menu fixture.
- Checkout regressions exercise concurrent confirmations, failed kitchen submission, cart/reward ownership, zero-dollar curbside, guest identity, and successful/failed concurrent changed-total reversals.
- Employee-meal regressions pass size pricing, missing-size rejection, failed-submit rollback, concurrent daily allowance and single stock depletion; the Tiki validator also checks variant allowances.
- Game regressions exercise seeded replay, eight simultaneous completion requests, one quota charge, one code redemption, checkpoint races, invalid/overflow counters, early completion, closed runs, zero-progress flooding and restart throttling.
- The order-linked loyalty API passes 9 checks for real staff authentication, cross-business/customer isolation, complete order history and read-only expiry. Its five browser scenarios also pass at phone size.
- 418 unit tests pass, along with TypeScript, the application build, the runtime-DDL guard and the dependency guard.

The targeted database regressions are added to the existing CI workflow. `npm run test:ordering-audit:e2e` groups the customer, kiosk, POS, kitchen, employee access, driver and game browser checks. Fixture updates remove invalid assumptions about old labels, opening hours, deleted employees and transaction timestamp ordering. Expected payment failures roll back to a savepoint inside fixture transactions; the payment-station validator passed after this fixture correction.

## Menu prices requiring a business decision

The audited development menu has 208 items in 31 categories. These exceptions were flagged, not automatically repriced:

| Products | Current price | Review |
| --- | --- | --- |
| Full Chicken Parmesan Sub / Pepperoni Chicken Parmesan Sub | $11.75 / $11.50 | The pepperoni version costs 25¢ less despite the added ingredient. |
| Breakfast Pizza with default garlic sauce | Base price + $0.50 | The default selection adds 50¢ above the advertised starting price; confirm this is intended. |
| Jalapeño Ranch 4 oz / Ranch or Blue Cheese 4 oz | $1.25 / $1.75 | Same size has a 50¢ difference; confirm intentional. |

The pizza matrix checks use the configured base and topping prices, including premium chicken and rounded half portions. Correct arithmetic does not establish profitability: ingredient costs, portions, promotions and intended value pricing still need owner review.

## Limits and remaining decisions

- These checks reduce demonstrated risks; they do not prove the absence of all flaws. Real card settlement, physical terminals/printers, live texts/emails and production customer traffic were not exercised.
- A legal automated player can still play the deterministic game. Replay blocks fabricated counters, not all bots. Prize limits depend on the trusted client-IP path; direct access must not trust spoofed proxy headers.
- Rewards are finalized at submission. Two concurrent prepaid carts can both pass an earlier reward quote; the second cannot spend the reward twice, but its payment may need staff recovery if the balance is consumed before submission. A cross-cart reservation system would be a separate change.
- Simultaneous staff refund and item cancellation can encounter an existing database lock-order conflict and roll back one operation; staff may need to retry. It does not permit duplicate reward spending.
- Amount-only partial refunds preserve earned credit until the purchase is fully refunded. Item cancellations reconcile the specific items immediately. Whether a courtesy partial refund should proportionally reduce rewards is a business-policy decision.
- Verified pay-later ordering remains available. Reward farming is blocked, but the business may separately choose limits on unpaid open orders.
- Prices listed above are from the development snapshot, not a reconciliation of production pricing or ingredient costs.

## Final validation and development runtime

- **38/38 desktop browser scenarios pass** against the built application, covering customer checkout, kiosk, POS, kitchen, staff access, workspace navigation, delivery, the game and the order-linked loyalty card.
- **15/15 mobile browser scenarios pass:** ten customer/pizza cases and five loyalty-card cases.
- **3/3 card-terminal browser simulations pass:** approval with tip, pending-payment cancellation before cash/retry, and decline. The final run includes the checkout layout correction and restores its isolated fixtures.
- **418/418 unit tests pass.** The final application build and TypeScript checks pass; runtime-DDL and dependency guards pass. All 51 database/workflow validators passed, including the corrected payment-station fixture rerun.

These results cover the audited commit and the upstream commits incorporated before its final test run. Subsequent concurrent changes require their own validation. The delivery target is the development branch `agent/pos-ordering-foundation`; runtime SHA and health checks are performed after the required development updater. No production deployment or `main` merge is included. Phone AI behavior is not part of this audit.
