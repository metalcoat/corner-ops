# AI Customer Service and Complaint Handling

## Goal

The AI phone agent may handle routine customer complaints, explain order facts, and offer only business-approved remedies. It must not invent refunds, store credit, policy exceptions, or facts about what happened.

## Complaint intake

The AI should identify the complaint intent and gather the minimum facts needed to investigate:

- customer identity / caller phone
- related order, using recent order lookup when possible
- item(s) in dispute
- what the customer expected
- what they received
- requested resolution

The AI then retrieves the structured order record, item/modifier selections, fulfillment type, payment state, order source, timestamps, and relevant order events.

## Reasoning about responsibility

The AI may compare the customer's claim with the stored order facts and explain the discrepancy calmly.

Examples:

- If the customer says onions were incorrectly added but the web order explicitly included onions, the AI may explain that the submitted order shows onions selected.
- If the kitchen ticket/order record shows no onions and the customer received onions, the AI may identify this as a likely store-preparation error.
- If the evidence is incomplete or conflicting, the AI must not decide fault and should escalate.

The AI should avoid argumentative language. Its job is to establish facts and resolve the issue within policy, not to win a dispute.

## Resolution policy engine

All remedies are deterministic business rules exposed as tools. Example approved actions may include:

- remake affected item
- replace missing item
- issue store credit up to an authorized amount
- refund an affected item or amount when policy allows
- offer a discounted remake when the submitted order matches what was made but the customer wants a different item
- schedule manager callback
- transfer to store/manager

The AI cannot call a remedy tool unless the current complaint and user role satisfy that remedy's policy limits.

Suggested policy dimensions:

- complaint category
- age of order
- order value
- affected item value
- customer history
- prior complaint frequency
- whether evidence indicates store error, customer-entry error, or unresolved dispute
- automatic-resolution dollar ceiling
- manager-only actions

## Mandatory escalation

Immediately hand off or create a manager callback for cases involving:

- food allergy or alleged allergic reaction
- injury or illness claim
- food-safety allegation
- legal threat
- chargeback threat or payment dispute above configured threshold
- abusive/threatening caller
- high-dollar refund above AI authority
- repeated complaint pattern requiring review
- conflicting evidence the AI cannot resolve confidently

## Live store handoff

When a complaint is transferred, the store POS should receive a live customer-service card before or with the call transfer.

The card should show:

- customer name and phone
- order number and time
- source: POS / web / AI phone
- payment status and amount
- affected items and exact modifiers
- customer complaint summary
- customer's requested resolution
- system evidence / discrepancy summary
- complaint history count where appropriate
- AI confidence
- recommended policy-compliant options

Suggested employee buttons:

- TAKE CALL
- REMAKE ITEM
- REPLACE MISSING ITEM
- ISSUE STORE CREDIT
- PARTIAL REFUND
- FULL REFUND (manager permission)
- DISCOUNTED REMAKE
- CALLBACK
- NO ACTION / DOCUMENT ONLY
- ESCALATE TO MANAGER

Role permissions control which buttons appear or require manager authorization.

## Store-initiated AI assistance

If an employee answers a complaint directly, the POS can optionally invoke the same complaint engine to summarize the order facts and show suggested resolutions without speaking to the customer. This makes the AI an employee-assist tool as well as a phone agent.

## Audit trail

Each complaint should create a customer-service case linked to the order and customer. Record:

- complaint category
- customer statement summary
- system evidence summary
- AI/human ownership changes
- remedies offered
- remedy accepted
- refund/credit/remake amounts
- approving employee/manager
- final disposition
- timestamps

Do not rely on a raw transcript as the authoritative record of the order. Structured order and payment data remain the source of truth.
