# Corner Ops POS + AI Ordering Architecture

Target: production-ready by June 1, 2027, with July 2027 reserved for parallel operation/final cutover before the current POS contract ends.

## Core rule

Corner Ops owns the deterministic business logic. The POS, website, kiosk, and AI phone agent are clients of the same order engine.

The AI may interpret conversation and request actions. It may **not** invent prices, taxes, discounts, modifier choices, availability, loyalty balances, payment approvals, or order totals.

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

## Menu and modifier rules

Menu items are structured records, not text prompts. Required modifier groups are enforced by the order engine.

Example: every wing item can require:

- sauce selection
- dressing selection: Blue Cheese, Ranch, or None
- celery: Yes or No

The order cannot move from Draft to Confirmed while any required modifier group is unresolved.

Required questions are separate from upsells. Upsells are optional and rule-driven.

## Availability / 86

Availability is centralized. Changing an item or modifier to unavailable immediately affects:

- employee POS
- website ordering
- AI phone ordering
- kiosk

Later phases can support quantity-limited availability, schedules, and automatic depletion from prep counts.

## Customers and caller ID

A customer has one stable customer ID and may have multiple phone numbers and addresses.

3CX caller ID is normalized and matched against `customer_phones`. An incoming call session is associated with the customer and, once ordering begins, with a live draft order.

Caller ID is a lookup key, not proof of identity. Sensitive customer information should only be disclosed when appropriate.

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
- pickup/delivery
- promised time
- item/modifier text
- special instructions
- total
- amount paid
- amount due
- payment status
- reprint marker

Printer delivery should eventually use a tiny store-side print agent while the source order remains cloud-hosted.

## Hosting

The web/POS/admin application remains suitable for Vercel. PostgreSQL remains external/managed (currently Neon-compatible). Long-lived 3CX voice streaming may be hosted separately if Vercel's execution model is not appropriate for that process.

Do not couple order logic to a specific host. Keep voice, payments, and printing behind adapters.

## Phase 1 acceptance criteria

The first foundation is complete when we can:

1. create customers and associate multiple phone numbers
2. create menu categories/items and modifier groups/options
3. mark menu items/options available or unavailable
4. create a Draft order from any source
5. add items/modifiers using stable IDs
6. detect unresolved required modifier groups
7. calculate deterministic line/order totals
8. increment an order version on changes
9. confirm an order only when validation passes
10. record loyalty ledger entries tied to orders

No production deployment is authorized by this document. Use preview/test environments until the owner explicitly approves production deployment.
