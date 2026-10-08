// Pure guards for the AI phone-ordering MCP endpoint. No "@/..." imports so
// this module can be unit tested directly.

/** Tools advertised to (and executable by) the phone model. */
export const PHONE_MCP_TOOL_NAMES = [
  "price_order",
  "menu_search",
  "customer_lookup",
  "get_draft",
  "hold",
  "send",
  "request_human_handoff",
] as const;
export type PhoneMcpToolName = (typeof PHONE_MCP_TOOL_NAMES)[number];

export function isPhoneMcpTool(name: string): name is PhoneMcpToolName {
  return (PHONE_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Last ten digits of a NANP phone number, or "" when not a full number. */
export function tenDigitPhone(value: unknown): string {
  const digits = String(value || "").replace(/\D/g, "");
  const local =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length === 10 ? local : "";
}

export type CallerCustomerRow = {
  id: unknown;
  first_name?: unknown;
  normalized_phone?: unknown;
};

/**
 * Phone callers only learn whether their own caller ID matches an account:
 * an opaque id, the first name, and the last four digits of the number.
 */
export function redactCallerCustomer(row: CallerCustomerRow) {
  const digits = String(row.normalized_phone || "").replace(/\D/g, "");
  return {
    customerId: String(row.id),
    firstName: String(row.first_name || "").trim(),
    phoneLast4: digits.slice(-4),
  };
}

/**
 * A model-supplied customerId is honored only when it is already bound to the
 * call/order or is one of the accounts whose phone exactly matches caller ID.
 */
export function resolvePhoneCustomerId(
  requested: unknown,
  bound: {
    orderCustomerId?: unknown;
    callCustomerId?: unknown;
    callerMatchIds?: readonly string[];
  },
): string | undefined {
  const orderCustomerId = String(bound.orderCustomerId || "");
  const callCustomerId = String(bound.callCustomerId || "");
  const wanted = String(requested || "").trim();
  if (
    wanted &&
    (wanted === orderCustomerId ||
      wanted === callCustomerId ||
      (bound.callerMatchIds || []).includes(wanted))
  )
    return wanted;
  return orderCustomerId || callCustomerId || undefined;
}

/**
 * Tools that act on an order always use the call's own order; any orderId the
 * model supplied is discarded. Returns ok:false when the tool needs an order
 * but the call has none yet.
 */
export function bindPhoneOrderId(
  tool: string,
  args: Record<string, unknown>,
  callOrderId: unknown,
): { ok: true } | { ok: false } {
  delete args.orderId;
  if (!["get_draft", "hold", "send"].includes(tool)) return { ok: true };
  const orderId = String(callOrderId || "");
  if (!orderId) return { ok: false };
  args.orderId = orderId;
  return { ok: true };
}
