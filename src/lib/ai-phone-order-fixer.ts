import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { withCallCartLock } from "@/lib/ai-phone-call-lock";
import {
  loadOrderCheckInput,
  orderCheckNote,
  type OrderCheckInput,
  type OrderCheckLine,
  type OrderCheckMismatch,
  type OrderCheckResult,
} from "@/lib/ai-phone-order-checker";
import { POST as orderingMcp } from "@/app/api/openai/ordering/mcp/route";

// Claude fixes the cart itself instead of passing a note Gemini may not act on (Chris, 2026-11-07: Gemini
// missed pepperoni, wings and dips on a dev call though the checker had flagged them). Only additions: a
// missing item, or a missing or wrong-pick topping, sauce, flavor or dip on an existing line. Removals, lower
// quantities, sizes, service, address and payment still go to Gemini as a note. A fix goes through the same
// price_order validation as Gemini's own changes and is applied only when:
// - Claude marked it sure and quoted the caller, and the quote is in the caller's saved words that Gemini has
//   already answered (not words still being handled, which Gemini may be adding right now);
// - the cart is exactly the cart Claude checked (otherwise a newer check is coming) and no question about an
//   item is open; the cart lock keeps Gemini from writing in between.
// Off unless AI_PHONE_CLAUDE_AUTOFIX is true.

export const orderAutofixEnabled = () => ["1", "true"].includes(String(process.env.AI_PHONE_CLAUDE_AUTOFIX || "").toLowerCase());

const MAX_NEW_ITEM_QUANTITY = 4;

const words = (value: string) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const cartFingerprint = (cart: OrderCheckLine[]) =>
  JSON.stringify(cart.map((line) => [line.lineId, line.name, line.variant, line.quantity, [...line.modifiers].sort()]));

/** The caller said this (exactly, ignoring case and punctuation) in a turn Gemini has already answered. */
export function quoteAnswered(transcript: OrderCheckInput["transcript"], quote: string) {
  const wanted = words(quote);
  if (wanted.replace(/[^a-z]/g, "").length < 3) return false;
  const lastAssistant = transcript.map((row) => row.speaker).lastIndexOf("assistant");
  return transcript.some((row, index) => index < lastAssistant && row.speaker === "customer" && ` ${words(row.text)} `.includes(` ${wanted} `));
}

type FixPlan = { arguments: Record<string, unknown>; summary: string };

const modifierInput = (modifier: NonNullable<OrderCheckMismatch["item"]>["modifiers"][number]) => ({
  name: modifier.name.trim(),
  ...(modifier.group.trim() ? { group: modifier.group.trim() } : {}),
  ...(modifier.placement ? { placement: modifier.placement } : {}),
  ...(modifier.portion ? { portion: modifier.portion } : {}),
  ...(modifier.amount ? { amount: modifier.amount } : {}),
});

/** The price_order call for one mismatch, or why it stays a note. */
export function planFix(input: OrderCheckInput, mismatch: OrderCheckMismatch): FixPlan | { skip: string } {
  if (mismatch.action !== "add_item" && mismatch.action !== "add_to_line") return { skip: "note" };
  if (!mismatch.sure) return { skip: "not sure" };
  if (!quoteAnswered(input.transcript, String(mismatch.callerQuote || ""))) return { skip: "caller quote not found" };
  const item = mismatch.item;
  const modifiers = (item?.modifiers || []).filter((modifier) => modifier.name.trim()).map(modifierInput);
  const serviceType = ["pickup", "delivery"].includes(input.serviceType) ? input.serviceType : "undecided";
  const named = modifiers.map((modifier) => modifier.name).join(", ");
  if (mismatch.action === "add_item") {
    const quantity = Number(item?.quantity || 0);
    if (!item?.name.trim() || mismatch.lineId) return { skip: "no item" };
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_NEW_ITEM_QUANTITY) return { skip: "quantity" };
    const label = item.variant.trim() || item.name.trim();
    return {
      arguments: {
        operation: "add",
        serviceType,
        items: [{ name: item.name.trim(), ...(item.variant.trim() ? { variant: item.variant.trim() } : {}), quantity, modifiers }],
      },
      summary: `added ${quantity > 1 ? `${quantity} ` : ""}${label}${named ? ` (${named})` : ""}`,
    };
  }
  const line = input.cart.find((row) => row.lineId && row.lineId === mismatch.lineId);
  if (!line) return { skip: "line not in cart" };
  if (!modifiers.length) return { skip: "no modifiers" };
  // The line keeps its own name, size and quantity; only the modifiers are added (price_order merges them).
  return {
    arguments: {
      operation: "replace_item",
      serviceType,
      targetLineId: line.lineId,
      items: [{ name: line.name, lineId: line.lineId, ...(line.variant ? { variant: line.variant } : {}), quantity: line.quantity, modifiers }],
    },
    summary: `added ${named} to the ${line.variant ? `${line.variant} ` : ""}${line.name}`.replace(/\s+/g, " "),
  };
}

async function priceOrder(callId: string, args: Record<string, unknown>) {
  const response = await orderingMcp(
    new Request("http://127.0.0.1/api/openai/ordering/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_ORDERING_MCP_TOKEN || ""}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `claude-fix-${randomUUID()}`, method: "tools/call", params: { name: "price_order", arguments: { callId, ...args } } }),
    }),
  );
  const body = (await response.json()) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  const text = body.result?.content?.[0]?.text || "{}";
  const result = JSON.parse(text) as Record<string, unknown>;
  // A follow-up before anything changed ("What sauce?") or an error means the fix didn't go in; Gemini handles it
  // from a note. A priced cart with a question still to ask (mashed gravy) did change: Gemini asks it.
  const failed = Boolean(body.result?.isError || result.error || result.pending);
  return {
    ok: !failed,
    code: String((result.error as Record<string, unknown> | undefined)?.code || result.code || ""),
    followUp: failed ? "" : String(result.required_follow_up || ""),
  };
}

export function fixNote(fixed: string[], followUps: string[] = []) {
  if (!fixed.length) return "";
  const ask = followUps.length ? ` Then ask the caller: ${followUps.join(" ")}` : "";
  return `(Private order update, not from the caller: the cart was already corrected: ${fixed.join("; ")}. Do NOT call price_order for these again. Include them in your readback; if the caller hasn't heard them yet, mention them in a few words, like "and I've got the pepperoni on that."${ask} Never mention this check.)`;
}

/** Apply the safe fixes from a mismatch check; the rest stay in the note for Gemini. Never throws. */
export async function applyOrderFixes(callId: string, input: OrderCheckInput, checked: OrderCheckResult): Promise<OrderCheckResult> {
  const plans = checked.mismatches.map((mismatch) => ({ mismatch, plan: planFix(input, mismatch) }));
  if (!plans.some((row) => "arguments" in row.plan)) return { ...checked, skipped: plans.map((row) => ("skip" in row.plan ? row.plan.skip : "")) };
  const fixed: string[] = [];
  const followUps: string[] = [];
  const remaining: OrderCheckMismatch[] = [];
  const skipped: string[] = [];
  try {
    await withCallCartLock(callId, async () => {
      const session = (
        await getSql()`SELECT state,pending_item FROM ordering_call_sessions WHERE business='Corner Deli' AND three_cx_call_id=${callId} LIMIT 1`
      )[0];
      const current = await loadOrderCheckInput(callId, input.stage);
      const blocked =
        session?.state !== "ai" ? "call not with the AI" : session?.pending_item ? "question open" : cartFingerprint(current.cart) !== cartFingerprint(input.cart) ? "cart changed" : "";
      for (const { mismatch, plan } of plans) {
        if (!("arguments" in plan) || blocked) {
          skipped.push("skip" in plan ? plan.skip : blocked);
          remaining.push(mismatch);
          continue;
        }
        const applied = await priceOrder(callId, plan.arguments).catch(() => ({ ok: false, code: "FAILED", followUp: "" }));
        if (applied.ok) {
          fixed.push(plan.summary);
          if (applied.followUp) followUps.push(applied.followUp);
        } else {
          skipped.push(applied.code || "rejected");
          remaining.push(mismatch);
          // A fix that raised a question leaves it for Gemini to ask from the note, not half-answered.
          await getSql()`UPDATE ordering_call_sessions SET pending_item=NULL,updated_at=NOW() WHERE business='Corner Deli' AND three_cx_call_id=${callId}`;
        }
      }
    });
  } catch {
    return checked;
  }
  if (fixed.length || skipped.length)
    await getSql()`INSERT INTO ordering_ai_call_events(id,business,call_id,event_key,event_type,role,label,detail,duration_ms) VALUES(${randomUUID()},'Corner Deli',${callId},${`${callId}:claude:orderFix:${randomUUID()}`},'claude.orderFix','system',${fixed.length ? `Claude fixed: ${fixed.join("; ")}`.slice(0, 300) : "Claude fix not applied"},${JSON.stringify({ fixed, skipped, left: remaining.length }).slice(0, 4000)},${0})`.catch(() => undefined);
  return {
    ...checked,
    status: remaining.length ? "mismatch" : "fixed",
    mismatches: remaining,
    note: orderCheckNote(remaining),
    fixed,
    skipped,
    fixNote: fixNote(fixed, followUps),
  };
}
