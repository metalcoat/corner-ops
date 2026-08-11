# POS Operational Foundation

This document tracks the normal restaurant/bar POS features that sit around the shared menu/order engine.

## Deployment posture

Automatic Vercel deployments are disabled while this POS is under active construction. Development continues on `agent/pos-ordering-foundation`. Re-enable deployments deliberately when preview testing is worth the infrastructure/build cost.

## Cash control and closeout

The POS must support:

- terminal/register identity
- one active drawer session per terminal
- opening float
- cash sales and cash refunds
- paid-in / paid-out
- cash drops
- driver cash turn-in
- expected cash vs counted cash
- over/short
- manager review for unusual differences
- business-day closeout

The drawer ledger is authoritative. Closing a register or business day summarizes existing transactions; it does not rewrite them.

## Driver cash settlement

A driver can select all eligible cash delivery orders for a business day and settle them as one batch. The screen shows every included order, expected cash, actual cash turned in, and over/short. Individual orders still receive their own cash payment transaction and remain linked to the settlement.

## Order editing / follow-up

Order changes depend on lifecycle state:

- Draft/Confirmed: edit the order directly and increment version.
- Sent to kitchen/In progress: changes create a delta/add-on ticket containing only changed/new items.
- Ready/Completed/locked: create a linked supplemental order rather than rewriting history.

Relationships include add-on, payment follow-up, replacement/remake, split, merge, reopen, and duplicate.

## Refunds, voids, comps, and price overrides

All value changes use explicit adjustment records with reason, employee, manager approval where required, amount, order/item reference, and reversal state. Payment refunds remain payment transactions and are not treated as discounts.

Manager thresholds should be configurable by business and role.

## Future orders and kitchen capacity

Orders can have a scheduled fulfillment time. Capacity windows can be configured by service type and time range using maximum orders and/or capacity points.

This allows a large pizza order to consume more capacity than a single sandwich while still giving the website, AI, and POS one deterministic availability decision.

Future work will add configurable production-point weights and automatic alternative-time suggestions.

## Delivery operations

Delivery assignments track driver, assignment time, out-for-delivery, delivered/failed/returned state, and expected cash. This feeds driver settlement and delivery performance reporting.

No-contact delivery and curbside remain prepay-only for web ordering. Standard delivery may be cash with SMS verification.

## Bar tabs

Tiki tabs support:

- customer/tab name
- opening/current bartender
- processor token/payment method reference
- processor preauthorization reference/amount
- multiple linked orders during the visit
- transfer to another bartender
- closing/abandoned/needs-review states
- end-of-night warning for open tabs

Raw card data never enters Corner Ops.

## Promotions and discounts

Promotion records support amount off, percent off, fixed-price specials, BOGO, bundles, and automatic promotions. Rules include schedule, priority, code requirement, manager-only behavior, and stackability.

The pricing engine remains deterministic and shared across POS, web, and AI.

## Gift cards and store credit

Gift cards and store credit are separate liabilities/ledgers.

Gift cards:

- token/hash based identifier
- issue, redeem, reload, refund, adjustment, expiration, reversal
- no editable balance field; balance derives from ledger

Store credit:

- customer-linked
- issue/redeem/refund/adjustment/expiration/reversal
- manager approval and reason where configured

## Receipts

Receipt delivery is tracked separately for print, email, and SMS so retries/failures are visible without changing the order/payment record.

## Offline direction

Cash ordering should remain usable during an internet outage using a cached menu and local mutation queue. Every offline mutation carries a terminal-scoped client mutation ID so replay after reconnection is idempotent.

Card processing, cloud customer lookup, AI phone tools, and other online services may be unavailable while offline. The UI must make that limitation explicit.

## Audit

Consequential POS events are auditable, including:

- drawer open/close and cash movement
- refund/void/comp/price override
- manager override
- driver settlement
- order reopen/add-on/merge/split
- bar-tab transfer/close
- gift/store-credit adjustment
- inventory adjustment
- house-account activity
- employee meal override
- offline conflict/replay

## Build order

Near-term implementation sequence:

1. POS shell and menu/order APIs
2. order lifecycle and modifier/combo completion
3. payments/tenders and cash drawer
4. refunds/voids/manager approval
5. future-order capacity and kitchen routing
6. delivery assignment and batch cash settlement
7. bar tabs
8. promotions/gift cards/store credit
9. closeout/reporting
10. offline mutation queue and recovery UX

This remains development-only until explicit production authorization.
