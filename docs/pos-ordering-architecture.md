# Corner Ops POS + AI Ordering Architecture

Target: production-ready by June 1, 2027, with July 2027 reserved for parallel operation/final cutover before the current POS contract ends.

## Core rule

Corner Ops owns the deterministic business logic. The POS, website, kiosk, and AI phone agent are clients of the same order engine.

The AI may interpret conversation and request actions. It may **not** invent prices, taxes, discounts, modifier choices, availability, loyalty balances, payment approvals, delivery fees, minimum-order rules, or order totals.

## Shared order flow

```text
Employee POS ─┐
Website ──────┼────> Order Engine/API ─────> Kitchen / Print Jobs
AI via 3CX ───┤             │
Kiosk ────────┘             ├────> Payments
                            ├────> Loyalty
                            ├────> Customer history
                            └────> Realtime order updates
```

All channels create and update the same order model.

## Businesses

The platform is multi-business from the beginning:

- Corner Deli
- Tiki

Menus, availability, prices, loyalty programs, payment accounts, ticket templates, and order numbers remain business-specific while sharing application code.

The employee-facing POS products remain separate: Corner Deli does not expose Tiki bar tabs, and Tiki does not expose Corner Deli driver workflows. Reporting is business-scoped by default.

## Menu and modifier rules

Menu items are structured records, not text prompts. Required modifier groups are enforced by the order engine.

Example: every wing item can require:

- sauce selection
- dressing selection: Blue Cheese, Ranch, or None
- celery: Yes or No

The order cannot move from Draft to Confirmed while any required modifier group is unresolved.

Required questions are separate from upsells. Upsells are optional and rule-driven.

### Sub modifiers

Subs need item-specific defaults as well as additions/removals. A sub can define default bread, cheese, vegetables, condiments, preparation, and extras. The order stores explicit modifier state so kitchen tickets can distinguish normal/default selections from changes such as:

- NO ONION
- EXTRA CHEESE
- ADD BACON
- TOASTED

Defaults are configured per menu item, because the same topping can be standard on one sub and optional on another.

### Combo options

Combos are structured component groups, not loose modifiers. A menu item can offer one or more combo definitions. A combo can require component groups such as:

- Side: choose one
- Drink: choose one

Each component option can be available/unavailable and can carry an additional upcharge. An order item cannot complete a selected combo until every required combo group is resolved. The POS, website, and AI use the same combo definitions.

## Fulfillment / service types

Supported fulfillment modes include:

- Delivery
- No-contact delivery
- Pickup
- Eat in
- Curbside
- Bar/service use where applicable

Standard delivery can be paid online by card or left unpaid for cash collection. No-contact delivery is a separate fulfillment mode and **requires full online payment** before confirmation. The customer can provide drop-off instructions and the ticket must clearly identify no-contact orders.

### Delivery minimum and distance pricing

Corner Deli delivery rules are server-side and shared across web, AI phone ordering, and employee-entered phone/POS delivery orders.

Current development defaults are:

- $20.00 merchandise minimum
- delivery fee does not count toward the merchandise minimum
- 0-4 miles: $4.00
- over 4 through 8 miles: $7.75
- working contiguous outer tier over 8 through 12 miles: $10.00
- 12-mile maximum delivery distance

The minimum, mileage boundaries, maximum distance, and fee for every band are editable business settings rather than constants embedded in clients.

When a delivery is below the merchandise minimum, the normal flow is:

1. calculate the exact shortfall
2. offer useful upsells first, such as fries or another side
3. if the customer declines but still wants delivery, add a visible Minimum order adjustment equal to the exact shortfall
4. continue through the normal delivery/payment rules

Example: a $14 merchandise order against a $20 minimum first gets a $6 upsell opportunity. If the customer declines everything else, policy may add a $6 minimum-order adjustment.

A true bypass is different: the order is allowed below minimum without charging the shortfall. True bypasses require authorized management action, record who approved the exception and why, and create a management alert. The AI and website cannot independently grant a true bypass.

The shared confirmation gate blocks delivery when distance, delivery fee, or minimum resolution remains unresolved.

### Tax-inclusive pricing

Customer-facing menu prices are gross prices with tax included. Tax is therefore extracted from taxable gross amounts for reporting rather than added on top of the displayed menu price again.

The tax model is configurable by business and includes:

- whether customer-facing prices include tax
- current tax rate
- whether delivery fees are taxable
- whether minimum-order adjustments are taxable

The current tax rate is not hard-coded into menu item prices. It must be explicitly configured before production. Orders snapshot the tax rate and pricing mode used at the time of sale so later tax-setting changes never rewrite historical orders.

### Unpaid online order verification

Any web order that is allowed to remain unpaid must be verified by SMS before it can be confirmed or sent to the kitchen. This includes a standard delivery order where the customer chooses cash payment.

The verification flow uses a short-lived one-time code tied to the order and phone number. Only a hash of the code is stored. Verification tracks expiration, attempts, resends, and verification time. Changing the phone number invalidates the previous verification.

Paid web orders do not require this anti-fraud SMS step unless a future business rule explicitly enables it. SMS verification is not a substitute for payment on fulfillment modes that require prepayment.

### No-contact delivery

No-contact delivery web orders require full online payment before confirmation. Cash payment is not available for no-contact delivery.

The order captures drop-off instructions so the driver ticket can prominently show details such as:

- front/side/back door
- porch or lobby location
- knock/do not knock
- ring bell/do not ring bell
- text/call delivery preference
- other customer instructions

### Curbside

Curbside web orders require full online payment before confirmation. Cash-at-curbside is not permitted for website orders.

After confirmation, the customer-facing order page must provide an **I'm here** action. The check-in updates the live order and alerts the store POS. The arrival record supports:

- waiting for customer
- customer arrived
- employee acknowledged
- completed
- optional vehicle/location details

The same arrival action can later be exposed through a signed SMS link without changing the order model.

## Availability / 86

Availability is centralized. Changing an item, modifier, or combo option to unavailable immediately affects:

- employee POS
- website ordering
- AI phone ordering
- kiosk

Later phases can support quantity-limited availability, schedules, and automatic depletion from prep counts.

## Customers and caller ID

A customer has one stable customer ID and may have multiple phone numbers and addresses.

3CX caller ID is normalized and matched against `customer_phones`. An incoming call session is associated with the customer and, once ordering begins, with a live draft order.

Caller ID is a lookup key, not proof of identity. Sensitive customer information should only be disclosed when appropriate.

## AI conversation order

The AI should follow the customer rather than fighting them over question order. If it asks whether an order is pickup or delivery and the caller immediately starts ordering food, it captures the food first, keeps fulfillment unresolved in structured state, and asks again at the next natural item boundary or before confirmation.

The model decides conversational timing. The deterministic order engine decides whether fulfillment and every other required field are complete enough to confirm.

## Live AI order and human handoff

The AI updates a real Draft order as the conversation happens. The store POS subscribes to order changes.

A handoff transfers two things:

1. the telephone call through 3CX
2. ownership of the existing Draft order to the store POS

The employee sees the exact order already built, including unresolved questions and a short handoff reason. The order is not reconstructed from a transcript.

Optimistic order versioning prevents the AI and an employee from silently overwriting each other during handoff.

## Loyalty

Loyalty is ledger-based rather than a mutable counter.

Example program:

- qualifying event: paid/completed pizza order
- earn: 1 credit
- threshold: 10 credits
- reward: next qualifying pizza free

Refunds/voids produce reversing ledger entries. Every balance can be audited back to an order.

## Upsells

Upsell rules are stored in Corner Ops and evaluated from the current cart. They can consider:

- item/category in cart
- missing meal component
- customer history
- business priority
- availability
- order source
- time/day
- delivery-minimum shortfall

When a delivery is under minimum, upsell rules should prefer useful items that reduce the shortfall before a minimum-order adjustment fee is offered.

Every offer and acceptance should eventually be logged for conversion and incremental-revenue reporting.

## Payments

The application uses a provider abstraction. Orders reference internal payment records, not provider-specific IDs throughout the codebase.

Initial providers under evaluation:

- Helcim
- Stripe

Corner Ops never stores PAN, CVV, or PIN. Phone-payment card data must go directly through a PCI-compliant payment collection/tokenization path. The AI receives only non-sensitive results such as approved/declined, brand, last four, token/payment-method reference, and amount.

Payment state is separate from order state.

Suggested payment states:

- unpaid
- pending
- partially_paid
- paid
- partially_refunded
- refunded
- failed

Suggested order states:

- draft
- confirmed
- sent_to_kitchen
- in_progress
- ready
- completed
- cancelled

## Kitchen tickets

Ticket generation is a separate service from order storage. A confirmed order can create multiple print jobs based on routing rules.

Examples:

- Pizza items -> Pizza printer
- Wings/fries -> Fryer printer
- Subs/salads -> Deli printer
- Complete order -> Expo printer

Templates must support configurable visibility, font size, emphasis, copies, and conditional formatting for fields including:

- order number
- customer name/phone
- fulfillment type
- no-contact indicator
- curbside indicator
- promised time
- item/modifier/combo text
- special instructions
- delivery fee
- minimum-order adjustment where applicable
- total
- amount paid
- amount due
- payment status
- SMS verification state where relevant
- reprint marker

Printer delivery should eventually use a tiny store-side print agent while the source order remains cloud-hosted.

## Hosting

The live Corner Ops application remains separate while the replacement POS is under construction. Automatic Vercel Git deployment is disabled during this heavy development phase. The replacement POS can be integrated into the existing application deliberately when preview/parallel testing is useful and safe.

The web/POS/admin application remains suitable for Vercel. PostgreSQL remains external/managed (currently Neon-compatible). Long-lived 3CX voice streaming may be hosted separately if Vercel's execution model is not appropriate for that process.

Do not couple order logic to a specific host. Keep voice, payments, SMS, and printing behind adapters.

## Phase 1 acceptance criteria

The first foundation is complete when we can:

1. create customers and associate multiple phone numbers
2. create menu categories/items and modifier groups/options
3. configure item-specific default sub modifiers and explicit removals/extras
4. configure combo definitions with required component groups and upcharges
5. mark menu items/modifiers/combo options available or unavailable
6. create a Draft order from any source
7. add items/modifiers/combos using stable IDs
8. detect unresolved required modifier and combo groups
9. calculate deterministic line/order totals
10. apply fulfillment rules for delivery, no-contact, pickup, eat-in, and curbside
11. enforce configurable delivery minimums and distance-based delivery fees across web, AI, and employee-entered phone/POS orders
12. offer upsells before an exact minimum-order shortfall fee and audit/alert true minimum bypasses
13. support tax-inclusive customer pricing with a configurable business tax rate and historical snapshots
14. require full online payment for curbside and no-contact web orders
15. require SMS verification for any web order that is allowed to remain unpaid, including standard cash delivery
16. record curbside customer arrival and alert the POS
17. increment an order version on changes
18. confirm an order only when all channel/payment/verification/delivery validation passes
19. record loyalty ledger entries tied to orders

No production deployment is authorized by this document. Use preview/test environments only after the owner explicitly authorizes them.
