# AI ordering tool/API foundation

`POST /api/ordering/ai/tools` is the deterministic server boundary for future voice and chat clients. It requires the same authenticated, business-scoped authorization as the employee ordering APIs. No telephony, outbound SMS/email, payment collection, or live customer communication is connected by this endpoint.

## Request and response

```json
{
  "business": "Corner Deli",
  "requestId": "provider-tool-call-id",
  "conversationId": "future-conversation-id",
  "model": "optional-observability-label",
  "tool": "menu_search",
  "arguments": { "query": "pizza", "scheduledFor": "2026-08-16T17:00:00Z" }
}
```

Successful responses are `{ "ok": true, "requestId": "...", "tool": "...", "result": ... }`. Rejections are `{ "ok": false, "error": { "code", "message", "remedy", "details" } }`. Remedies are deterministic next actions suitable for orchestration; customer-facing wording remains the conversational client's responsibility.

Call `describe_capabilities` for the supported tool names and service types. The foundation provides:

- `menu_browse`, `menu_search`: stable authoritative menu IDs, configured descriptions, variants, modifiers, combos, and scheduled availability. An AI must not add claims absent from these records.
- `ordering_availability`, `future_slots`: store/order hours, closure state, future fulfillment choices, and server time.
- `promotions`: active configured promotion metadata. Applied discounts are still decided by server pricing.
- `customer_lookup`: authorized business-scoped lookup. A match or caller ID is not identity proof and should not cause sensitive disclosure.
- `create_draft`, `update_draft`, `get_draft`: shared live drafts and integer-cent quotes. Updates are full cart replacements, retain the original order ID, and require `expectedVersion`.
- `attach_delivery_address`: accepts only a token from the existing authoritative address validation interface and persists its routed result and delivery quote.
- `validate_delivery`: applies configured distance bands and minimum policy to a routed distance and server merchandise subtotal.
- `hold`: keeps the order in Draft and returns missing required customer/fulfillment/delivery fields plus a send-readiness remedy.
- `send`: invokes the shared confirmation and kitchen-send gate. It cannot bypass required fields, menu/price revalidation, hours, delivery, payment, or manager-only policy.

All `*Cents` values are authoritative integer USD cents. Clients must read back the returned server total and must never derive price from natural-language interpretation.

## Safety and lifecycle

Draft content can change. A client must fetch/retain `version`, submit it as `expectedVersion`, and resolve `VERSION_CONFLICT` by fetching and merging rather than overwriting. Submitted and historical order snapshots are never updated through these tools.

`HOLD` is not kitchen submission. `SEND` is available only where the existing lifecycle and employee authorization permit it. A future telephony adapter should use a real Draft throughout a call and hand that same ID to the POS.

## Observability

Every attempted authenticated tool call writes an `ordering_ai_tool_events` record with business, request/conversation IDs, tool, actor, affected order/customer IDs, outcome, deterministic error code, sanitized structural summaries, duration, and optional model label. Raw utterances, hidden reasoning, complete request payloads, payment secrets, and credentials are not stored in this trace.

The `requestId` must be unique per business. This supports trace correlation and prevents ambiguous duplicate event identities; order mutation safety is additionally enforced by draft versions and the idempotent shared submission lifecycle.
