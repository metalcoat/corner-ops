# POS business separation and AI fulfillment flow

## Development boundary

The replacement POS/ordering platform remains development-only and is not blended into the live Corner Ops user experience yet. Automatic Vercel Git deployments remain disabled during heavy development.

The long-term application may share one Vercel project and common infrastructure, but the live operations application and replacement POS stay operationally separate until parallel testing and cutover work are explicitly authorized.

## Corner Deli and Tiki are separate POS products

Corner Deli and Tiki share low-level infrastructure where doing so reduces duplicated engineering: authentication, database access, customer identity primitives, tender abstractions, menu/order validation, audit conventions, and reusable UI components.

They do **not** share one switchable POS product.

### Corner Deli POS

Route: `/pos/deli`

Business-specific features include:

- pickup
- delivery
- no-contact delivery
- curbside
- eat-in
- driver assignment and cash settlement
- deli menu/modifiers/combos
- deli inventory
- deli registers and closeout
- deli-only reporting

Corner Deli does not expose bar-tab workflows.

### Tiki POS

Route: `/pos/tiki`

Business-specific features include:

- bar/service ordering
- open bar tabs
- bartender ownership/transfer
- pickup/eat-in where configured
- Tiki menu/modifiers
- Tiki inventory
- Tiki registers and closeout
- Tiki-only reporting

Tiki does not expose the deli driver workflow by default.

### Reporting

The default reporting experience is permanently scoped to one business. Sales, tenders, labor, inventory, delivery/driver activity, bar tabs, register closeout, discounts, comps, and refunds are not silently combined across Corner Deli and Tiki.

An owner-level consolidated report can be added later, but it must be an explicit separate report rather than the default behavior of either POS.

## AI phone ordering: conversational order matters

The AI should behave like a competent employee rather than a phone tree.

Opening example:

> "Thanks for calling Corner Deli. Is this going to be pickup or delivery?"

A customer may ignore the question and immediately say:

> "I need a large pepperoni and 20 mild wings..."

The AI should **not** interrupt with "pickup or delivery?" again while the customer is actively giving the order.

Instead:

1. Mark fulfillment as unresolved (`undecided`).
2. Capture the customer's order content immediately.
3. Ask required item questions such as wing sauce/dressing/celery when needed.
4. At the next natural item boundary or pause, return to the missing fulfillment question.
5. Never confirm/send the order while fulfillment is still unresolved.

A natural follow-up is:

> "Got the large pepperoni and 20 mild wings. Is that for pickup or delivery?"

If the customer starts another item instead of answering, the AI may continue capturing the order and defer the question again. It should avoid nagging the customer after every sentence, but the deterministic order engine blocks confirmation until the missing field is resolved.

## Required-question priority

The AI tracks missing information as structured state, not merely prompt memory. A useful priority is:

1. Finish understanding the customer's current spoken item.
2. Resolve required choices for that item where ambiguity would prevent adding it correctly.
3. Ask deferred order-level fields at a natural break, including pickup/delivery.
4. Resolve customer/address/payment information when relevant to the selected fulfillment mode.
5. Offer at most the configured upsell attempts.
6. Read back/confirm the final order and total.

The system must not discard already-captured items simply because an earlier question went unanswered.

## Handoff behavior

If the AI hands the call to an employee, the POS should show:

- current order draft
- current item and modifier state
- caller/customer match
- fulfillment status, including `UNDECIDED` when still missing
- deferred required questions
- handoff reason

The employee should not need to ask the customer to restart the order.

## Deterministic enforcement

`undecided` is permitted only while an order remains a draft. Confirmation validation rejects an unresolved fulfillment type.

This supports natural conversation without making fulfillment optional. The model controls conversational timing; the order engine controls whether the order is actually complete.
