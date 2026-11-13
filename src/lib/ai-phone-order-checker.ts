import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { MENU_SHORTHAND } from "@/lib/openai-phone-prompt";
import { applyOrderFixes, orderAutofixEnabled } from "@/lib/ai-phone-order-fixer";
import { storeRulesInstructions } from "@/lib/ai-phone-store-rules";

// Background order checker for the Gemini phone line (dev trial 2026-11-06). Gemini keeps the voice; after a
// cart change the bridge asks this to compare what the caller said with the cart, and passes any mismatch to
// Gemini as a private note. It never blocks a call: every failure comes back as a status, never a throw.
// Off unless AI_PHONE_CLAUDE_CHECKER is true and ANTHROPIC_API_KEY is set. With AI_PHONE_CLAUDE_AUTOFIX also
// true, a missing item or topping is added to the cart directly instead (ai-phone-order-fixer.ts, Chris
// 2026-11-07: notes alone were often ignored).

export const ORDER_CHECK_MODEL = "claude-sonnet-5-5";
// Sonnet 5.5 $ per million tokens: cache writes 1.25x input, cache reads $0.20.
const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };

export type OrderCheckStage = "cart" | "final";
export type OrderCheckLine = {
  lineId: string;
  name: string;
  variant: string;
  quantity: number;
  modifiers: string[];
  lineTotalCents: number;
};
export type OrderCheckInput = {
  stage: OrderCheckStage;
  /** The store rules block Gemini was given (ai-phone-store-rules.ts), so a store rule isn't flagged as a mistake. */
  storeRules?: string;
  /** The assistant's recent cart changes that didn't go through: what it understood, even when speech-to-text garbled it. */
  failedAttempts?: string[];
  transcript: Array<{ speaker: "customer" | "assistant"; text: string }>;
  cart: OrderCheckLine[];
  serviceType: string;
};
export type OrderCheckModifier = { name: string; group: string; placement: "" | "side" | "topping"; portion: "" | "whole" | "left_half" | "right_half"; amount: "" | "regular" | "extra" | "double_extra" | "triple_extra" };
export type OrderCheckMismatch = {
  problem: string;
  fix: string;
  action?: "note" | "add_item" | "add_to_line" | "remove_duplicate";
  lineId?: string;
  item?: { name: string; variant: string; quantity: number; modifiers: OrderCheckModifier[] };
  callerQuote?: string;
  sure?: boolean;
};
export type OrderCheckResult = {
  // fixed: every mismatch was corrected in the cart; fixNote tells Gemini what changed.
  status: "ok" | "mismatch" | "fixed" | "disabled" | "error";
  mismatches: OrderCheckMismatch[];
  note: string;
  fixed?: string[];
  skipped?: string[];
  fixNote?: string;
  ms: number;
  costUsd: number;
  error?: string;
};

export const orderCheckerEnabled = () =>
  ["1", "true"].includes(String(process.env.AI_PHONE_CLAUDE_CHECKER || "").toLowerCase()) &&
  Boolean(process.env.ANTHROPIC_API_KEY);

const SYSTEM = `You check phone orders for Corner Deli while the call is still going. Another assistant is talking to the caller and building the cart. You see the conversation so far (speech-to-text, often noisy or mis-heard) and the current cart. Report only clear, concrete mismatches between what the caller asked for and the cart:
- an item the caller asked for (and did not cancel) that is missing, or an item in the cart the caller never asked for;
- a wrong quantity or count (e.g. caller wants 30 wings total split 10 hot / 20 medium, cart has 50), or one item split into two (e.g. one pizza with half jalapenos became two pizzas);
- a wrong size, flavor, sauce or side the caller clearly stated;
- an omission or change the caller asked for that is missing (e.g. "no tomato" on a Big Boss), or one added they never asked for;
- the assistant telling the caller an item or option isn't available when the caller kept asking for it and the cart lacks it.
Never flag: noise words or unclear speech you can't map to a request; an item in the cart whose request is garbled, mis-heard or in another language in the transcript (the other assistant hears the caller's real voice, so trust the cart unless the transcript clearly says otherwise; dev call 2026-11-06 lost a correct Turkey Big Boss this way); gravy on a hot meat meal's fries or mashed when the caller said yes to it; all of a list (e.g. blue cheese, ranch and celery) when the caller answered a list question with a bare yes or sure; menu names that differ from the caller's words but mean the same thing (rules below); store defaults the caller didn't contradict (e.g. Regular Cooked, Classic Sauce, a default cheese); prices, totals, tips, payment or delivery details; questions that are still open. When the stage is "cart" the order is still being taken: an item the assistant is asking a follow-up question about (size, sauce, sides) may legitimately be missing for now; don't flag it. When the stage is "final" the caller is about to confirm or pay: everything they asked for should be there. Never ask for an item to be removed unless the caller clearly declined, cancelled or replaced it. If unsure, don't flag. Each fix is one short instruction to the ordering assistant, naming the cart line (by item name) and what to change.

For each mismatch also choose an action; the ordering system may apply add_item and add_to_line itself:
- add_item: an item the caller clearly asked for is missing from the cart entirely. Give it as the ordering tool takes it: menu item name (e.g. Pizza, Wings, Turkey Big Boss), variant (size, e.g. Jumbo Thin, 10 Wings, Full Sub; "" if none), quantity (number of orders), and modifiers by menu option name (flavor, toppings, sauces, dips, changes).
- add_to_line: an existing cart line is missing a topping, sauce, flavor, dip, side or choice the caller clearly stated, or has the wrong pick in a pick-one choice (e.g. Mild instead of Hot). Give that line's lineId and only the modifiers to add.
- remove_duplicate: two cart lines are exactly the same item, size, quantity and options, and the caller clearly asked for it only once (never when they said two, another, both or a second one). Give the lineId of the extra line; item is {"name":"","variant":"","quantity":1,"modifiers":[]}. callerQuote is the caller's one request for it.
- note: everything else, which goes to the ordering assistant as a note: removing anything else, a lower quantity, one item split in two, a different size or item, an omission like "no tomato", pickup/delivery, address, payment, and anything you're not fully sure of.
For a modifier give group only when you know the cart's exact group name, else "". placement is "side" or "topping" only when the caller said on the side or on top, portion only for a half pizza topping, amount only for extra; otherwise "". For note, item is {"name":"","variant":"","quantity":1,"modifiers":[]} and lineId "".
callerQuote: the caller's own words in the conversation that ask for it, copied exactly. sure: true only when those words plainly ask for exactly this; false for anything garbled, mis-heard or guessed. A cart change the assistant tried that didn't go through shows what it heard from the caller's real voice: when it matches the caller's words (e.g. "30 Wayne medium with blue cheese and celery" and a failed add of 30 Wings), the request is clear, so sure can be true. Never add an item that failed as not on the menu.

Menu wording rules the ordering assistant follows:
${MENU_SHORTHAND}`;

const SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    mismatches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          problem: { type: "string" },
          fix: { type: "string" },
          action: { type: "string", enum: ["note", "add_item", "add_to_line", "remove_duplicate"] },
          lineId: { type: "string" },
          item: {
            type: "object",
            properties: {
              name: { type: "string" },
              variant: { type: "string" },
              quantity: { type: "integer" },
              modifiers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    group: { type: "string" },
                    placement: { type: "string", enum: ["", "side", "topping"] },
                    portion: { type: "string", enum: ["", "whole", "left_half", "right_half"] },
                    amount: { type: "string", enum: ["", "regular", "extra", "double_extra", "triple_extra"] },
                  },
                  required: ["name", "group", "placement", "portion", "amount"],
                  additionalProperties: false,
                },
              },
            },
            required: ["name", "variant", "quantity", "modifiers"],
            additionalProperties: false,
          },
          callerQuote: { type: "string" },
          sure: { type: "boolean" },
        },
        required: ["problem", "fix", "action", "lineId", "item", "callerQuote", "sure"],
        additionalProperties: false,
      },
    },
  },
  required: ["ok", "mismatches"],
  additionalProperties: false,
};

let client: Anthropic | null = null;

/** Ask Claude whether the cart matches the conversation. Never throws. */
export async function checkOrder(input: OrderCheckInput, timeoutMs = 12_000): Promise<OrderCheckResult> {
  const started = Date.now();
  const result = (partial: Partial<OrderCheckResult>): OrderCheckResult => ({
    status: "error",
    mismatches: [],
    note: "",
    costUsd: 0,
    ...partial,
    ms: Date.now() - started,
  });
  if (!process.env.ANTHROPIC_API_KEY) return result({ status: "disabled" });
  try {
    client ??= new Anthropic({ maxRetries: 0 });
    const conversation = input.transcript.map((row) => `${row.speaker === "customer" ? "Caller" : "Assistant"}: ${row.text}`).join("\n");
    const cart = input.cart.length
      ? input.cart
          .map((line) => `- [lineId ${line.lineId}] ${line.quantity}x ${line.name}${line.variant ? ` (${line.variant})` : ""}${line.modifiers.length ? ` [${line.modifiers.join(", ")}]` : ""}`)
          .join("\n")
      : "(empty)";
    const message = await client.messages.create(
      {
        model: ORDER_CHECK_MODEL,
        max_tokens: 2048,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        thinking: { type: "adaptive" },
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        messages: [
          {
            role: "user",
            content: `${input.storeRules ? `${input.storeRules}\n\n` : ""}${input.failedAttempts?.length ? `Cart changes the assistant tried that did not go through (oldest first):\n${input.failedAttempts.map((row) => `- ${row}`).join("\n")}\n\n` : ""}Stage: ${input.stage}\nService: ${input.serviceType || "not chosen yet"}\n\nConversation so far:\n${conversation || "(nothing yet)"}\n\nCurrent cart:\n${cart}`,
          },
        ],
      },
      { timeout: timeoutMs },
    );
    const usage = message.usage;
    const costUsd =
      (usage.input_tokens * PRICE.input +
        usage.output_tokens * PRICE.output +
        (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
        (usage.cache_read_input_tokens || 0) * PRICE.cacheRead) /
      1e6;
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    if (message.stop_reason !== "end_turn" || !text) return result({ costUsd, error: `stop_reason ${message.stop_reason}` });
    const parsed = JSON.parse(text) as { ok: boolean; mismatches: OrderCheckMismatch[] };
    const mismatches = (parsed.mismatches || []).filter((row) => row.problem && row.fix).slice(0, 4);
    return result({
      status: mismatches.length ? "mismatch" : "ok",
      mismatches,
      note: orderCheckNote(mismatches),
      costUsd,
    });
  } catch (error) {
    return result({ error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "check failed" });
  }
}

export function orderCheckNote(mismatches: Array<Pick<OrderCheckMismatch, "problem" | "fix">>) {
  if (!mismatches.length) return "";
  const items = mismatches.map((row, index) => `${index + 1}) ${row.problem} Fix: ${row.fix}`).join(" ");
  return `(Private order check, not from the caller: ${items} Correct the cart with price_order if the caller clearly asked for it; if you're not sure, ask the caller one short question. Never mention this check.)`;
}

/** Transcript saved for a call plus words the bridge hasn't saved yet, and the current cart. */
export async function loadOrderCheckInput(callId: string, stage: OrderCheckStage, pendingCustomerText = ""): Promise<OrderCheckInput & { orderId: string | null }> {
  const sql = getSql();
  const call = (await sql`SELECT order_id FROM ordering_call_sessions WHERE business='Corner Deli' AND three_cx_call_id=${callId} LIMIT 1`)[0];
  const orderId = call?.order_id ? String(call.order_id) : null;
  const segments = await sql`SELECT speaker,transcript FROM ordering_call_transcript_segments WHERE business='Corner Deli' AND call_id=${callId} ORDER BY completed_at,id`;
  const transcript = segments.map((row: any) => ({ speaker: row.speaker === "customer" ? ("customer" as const) : ("assistant" as const), text: String(row.transcript) }));
  if (pendingCustomerText.trim()) transcript.push({ speaker: "customer", text: pendingCustomerText.trim() });
  const failed = await sql`SELECT input_summary,error_code FROM ordering_ai_tool_events WHERE business='Corner Deli' AND conversation_id=${callId} AND tool_name='price_order' AND outcome<>'success' ORDER BY created_at DESC LIMIT 6`;
  const failedAttempts = failed
    .reverse()
    .map((row: any) => {
      const summary = typeof row.input_summary === "string" ? JSON.parse(row.input_summary) : row.input_summary || {};
      const items = (Array.isArray(summary.customerItems) ? summary.customerItems : [])
        .map((item: any) => `${item.quantity && item.quantity > 1 ? `${item.quantity}x ` : ""}${[item.name, item.variant].filter(Boolean).join(" ")}${Array.isArray(item.modifiers) && item.modifiers.length ? ` [${item.modifiers.map((mod: any) => mod?.name).filter(Boolean).join(", ")}]` : ""}`)
        .join("; ");
      return items ? `${summary.operation || "add"} ${items} (${row.error_code || "failed"})` : "";
    })
    .filter(Boolean);
  if (!orderId) return { stage, transcript, cart: [], serviceType: "", orderId, failedAttempts };
  const order = (await sql`SELECT service_type FROM ordering_orders WHERE id=${orderId}`)[0];
  const lines = await sql`SELECT i.cart_line_id,i.item_name_snapshot,i.variant_name_snapshot,i.quantity,i.line_total_cents,COALESCE((SELECT json_agg(json_build_object('name',m.option_name_snapshot,'portion',m.pizza_topping_portion,'toppingAmount',m.pizza_topping_amount,'amount',m.amount,'quantity',m.quantity) ORDER BY m.created_at,m.id) FROM ordering_order_item_modifiers m WHERE m.order_item_id=i.id AND m.selection_state='selected'),'[]') mods FROM ordering_order_items i WHERE i.order_id=${orderId} ORDER BY i.sort_order,i.created_at,i.id`;
  return {
    stage,
    transcript,
    failedAttempts,
    serviceType: String(order?.service_type || ""),
    orderId,
    cart: lines.map((row: any) => ({
      lineId: String(row.cart_line_id || ""),
      name: String(row.item_name_snapshot),
      variant: String(row.variant_name_snapshot || ""),
      quantity: Number(row.quantity),
      lineTotalCents: Number(row.line_total_cents),
      modifiers: (typeof row.mods === "string" ? JSON.parse(row.mods) : row.mods).map(modifierLabel),
    })),
  };
}

// "Onions (left half)", "Pepperoni (extra)", "2x Ranch (4oz)": a half topping must not read as a whole one.
function modifierLabel(row: { name: string; portion?: string | null; toppingAmount?: string | null; amount?: string | null; quantity?: number | null }) {
  const notes = [
    row.portion && row.portion !== "whole" ? row.portion.replace(/_/g, " ") : "",
    row.toppingAmount && row.toppingAmount !== "regular" ? row.toppingAmount : "",
    row.amount && row.amount !== "normal" ? row.amount : "",
  ].filter(Boolean);
  return `${Number(row.quantity) > 1 ? `${row.quantity}x ` : ""}${row.name}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/** Check a live call and log the outcome as a claude.orderCheck call event (shown with the call's events). */
export async function checkPhoneCall(callId: string, stage: OrderCheckStage, pendingCustomerText = ""): Promise<OrderCheckResult> {
  if (!orderCheckerEnabled()) return { status: "disabled", mismatches: [], note: "", ms: 0, costUsd: 0 };
  let checked: OrderCheckResult;
  try {
    const input = { ...(await loadOrderCheckInput(callId, stage, pendingCustomerText)), storeRules: await storeRulesInstructions() };
    checked = await checkOrder(input);
    if (checked.status === "mismatch" && orderAutofixEnabled()) checked = await applyOrderFixes(callId, input, checked);
  } catch (error) {
    checked = { status: "error", mismatches: [], note: "", ms: 0, costUsd: 0, error: error instanceof Error ? error.message.slice(0, 300) : "load failed" };
  }
  try {
    const detail = JSON.stringify({ stage, status: checked.status, mismatches: checked.mismatches, fixed: checked.fixed, skipped: checked.skipped, costUsd: Number(checked.costUsd.toFixed(5)), model: ORDER_CHECK_MODEL, error: checked.error }).slice(0, 4000);
    await getSql()`INSERT INTO ordering_ai_call_events(id,business,call_id,event_key,event_type,role,label,detail,duration_ms) VALUES(${randomUUID()},'Corner Deli',${callId},${`${callId}:claude:orderCheck:${randomUUID()}`},'claude.orderCheck','system',${checked.status === "mismatch" ? "Claude order check: mismatch" : `Claude order check: ${checked.status}`},${detail},${checked.ms})`;
  } catch {
    // Logging must not change the answer the bridge gets.
  }
  return checked;
}
