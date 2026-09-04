import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { getSql } from "@/lib/db";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import {
  AiToolError,
  auditAiTool,
  menuCatalog,
  modifierAliases,
  priceSpokenOrder,
  setAiPaymentDetails,
  serviceType,
  type SpokenOrderItem,
} from "@/lib/ordering-ai-tools";
import { recordAiRegression } from "@/lib/ordering-ai-regressions";
import {
  openAiClient,
  requestOpenAiHandoff,
  requestOpenAiVoicePayment,
} from "@/lib/openai-phone-ordering";
import { attachSpokenDeliveryAddress } from "@/lib/ordering-delivery-landmarks";
import { quoteDelivery } from "@/lib/ordering-delivery";

const sockets = new Map<string, WebSocket>();

async function event(
  callId: string,
  eventKey: string,
  eventType: string,
  role: string,
  label: string,
  detail = "",
  durationMs?: number,
) {
  await ensureOrderingAiSchema();
  await getSql()`INSERT INTO ordering_ai_call_events(id,business,call_id,event_key,event_type,role,label,detail,duration_ms)VALUES(${randomUUID()},'Corner Deli',${callId},${eventKey},${eventType},${role},${label.slice(0, 160)},${detail.slice(0, 2000)},${durationMs ?? null})ON CONFLICT(business,event_key)DO NOTHING`;
}
async function transcript(
  callId: string,
  eventKey: string,
  speaker: "customer" | "assistant" | "system",
  text: string,
  metadata: Record<string, unknown> = {},
) {
  const value = text.trim();
  if (!value) return;
  await ensureOrderingAiSchema();
  await getSql()`INSERT INTO ordering_call_transcript_segments(id,business,call_id,event_key,speaker,transcript,metadata)VALUES(${randomUUID()},'Corner Deli',${callId},${eventKey},${speaker},${value.slice(0, 5000)},${JSON.stringify(metadata)}::jsonb)ON CONFLICT(business,event_key)DO NOTHING`;
}
async function latency(
  callId: string,
  turnId: string,
  metric: string,
  durationMs: number,
  model: string,
) {
  await ensureOrderingAiSchema();
  await getSql()`INSERT INTO ordering_ai_latency_samples(id,business,call_id,turn_id,metric,duration_ms,model)VALUES(${randomUUID()},'Corner Deli',${callId},${turnId},${metric},${Math.max(0, Math.round(durationMs))},${model})`;
}
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

type CartOperation =
  "add" | "replace_item" | "remove_item" | "replace_order" | "read";
async function spokenCart(orderId: string): Promise<SpokenOrderItem[]> {
  const sql = getSql(),
    lines =
      await sql`SELECT id,item_name_snapshot,variant_name_snapshot,quantity FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`,
    modifiers =
      await sql`SELECT modifier.order_item_id,modifier.option_name_snapshot,modifier.quantity,modifier.pizza_topping_portion,modifier.pizza_topping_amount FROM ordering_order_item_modifiers modifier JOIN ordering_order_items item ON item.id=modifier.order_item_id WHERE item.order_id=${orderId} AND modifier.selection_state IN('selected','extra') AND (modifier.print_on_ticket=TRUE OR modifier.pizza_topping_portion IS NOT NULL) ORDER BY modifier.created_at,modifier.id`;
  return lines.map((line) => ({
    name: String(line.item_name_snapshot),
    variant: String(line.variant_name_snapshot || "") || undefined,
    quantity: Number(line.quantity),
    modifiers: modifiers
      .filter((modifier) => String(modifier.order_item_id) === String(line.id))
      .flatMap((modifier) =>
        Array.from(
          { length: Math.max(1, Number(modifier.quantity || 1)) },
          () => ({
            name: String(modifier.option_name_snapshot),
            portion: (modifier.pizza_topping_portion ||
              undefined) as SpokenOrderItem["modifiers"] extends Array<infer M>
              ? M extends { portion?: infer P }
                ? P
                : never
              : never,
            amount: (modifier.pizza_topping_amount ||
              undefined) as SpokenOrderItem["modifiers"] extends Array<infer M>
              ? M extends { amount?: infer A }
                ? A
                : never
              : never,
          }),
        ),
      ),
  }));
}
const affirmative = (value: string) =>
  /^(?:yes|yeah|yep|sure|absolutely|please|yes please|yeah please|yep please)(?:\b|$)/i.test(
    value.trim(),
  );
const negative = (value: string) =>
  /^(?:no|nope|no thanks|i(?:'| a)?m good)(?:\b|$)/i.test(value.trim());

export async function applyPendingModifierAnswer(input: {
  orderId: string | null;
  pendingItem: Record<string, any> | null;
  customerText: string;
  operation: CartOperation;
  targetItem: string;
  items: SpokenOrderItem[];
}): Promise<{
  orderId: string | null;
  pendingItem: Record<string, any> | null;
  customerText: string;
  operation: CartOperation;
  targetItem: string;
  items: SpokenOrderItem[];
  resolvedPendingQuestions?: string[];
}> {
  const pending = input.pendingItem;
  if (!input.orderId || !pending) return { ...input };
  const current = await spokenCart(input.orderId);
  const activeName = String(pending.activeItem || pending.category || "");
  const line = [...current]
    .reverse()
    .find((item) => cartKey(item.name) === cartKey(activeName));
  if (!line) return { ...input };
  if ((pending.missingRequiredFields || []).includes("mashed size")) {
    const size = /\b(small|medium)\b/i.exec(input.customerText)?.[1];
    if (!size) return { ...input };
    return {
      ...input,
      operation: "replace_item" as CartOperation,
      targetItem: line.name,
      items: [
        {
          ...line,
          modifiers: [
            ...(line.modifiers || []).filter(
              (modifier) =>
                !/\b(?:small|medium)\s+(?:mashed|french fries|curly fries|waffle fries|tater tots)\b/i.test(
                  modifier.name,
                ),
            ),
            { name: `${size} mashed` },
          ],
        },
      ],
    };
  }
  if (pending.pendingQuestion === "mashed_gravy") {
    if (!affirmative(input.customerText) && !negative(input.customerText))
      return { ...input };
    return {
      ...input,
      operation: "replace_item" as CartOperation,
      targetItem: line.name,
      items: [
        affirmative(input.customerText)
          ? {
              ...line,
              modifiers: [
                ...(line.modifiers || []).filter(
                  (modifier) => !/^gravy$/i.test(modifier.name),
                ),
                { name: "Gravy" },
              ],
            }
          : line,
      ],
      resolvedPendingQuestions: ["mashed_gravy"],
    };
  }
  return { ...input };
}
const cartKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/s\b/g, "");
const modifierKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/\(\s*\d+(?:\.\d+)?\s*oz\s*\)/g, "")
    .replace(/\bon side\b/g, "")
    .replace(/^(?:add|extra|xtra)\s+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
export async function attachStandaloneModifierAnswer(
  orderId: string | null,
  operation: CartOperation,
  changed: SpokenOrderItem[],
) {
  if (
    !orderId ||
    operation !== "add" ||
    changed.length !== 1 ||
    changed[0].variant ||
    changed[0].modifiers?.length
  )
    return null;
  const requestedParts = changed[0].name
    .split(/\s*(?:,|\band\b)\s*/i)
    .map(modifierKey)
    .filter(Boolean);
  if (!requestedParts.length) return null;
  const current = await spokenCart(orderId);
  for (const line of [...current].reverse()) {
    const catalog = await menuCatalog("Corner Deli", new Date(), line.name),
      item = catalog
        .flatMap((category) => category.items || [])
        .find((entry) => cartKey(String(entry.name)) === cartKey(line.name));
    const choices =
      item?.modifiers?.flatMap((group: any) =>
        group.presentationContext === "hidden"
          ? []
          : (group.options || [])
              .filter((entry: any) => entry.available)
              .map((entry: any) => ({ group, option: entry })),
      ) || [];
    const selected = requestedParts
      .map(
        (part) =>
          choices.find((choice: any) =>
            modifierAliases(
              String(choice.option.name),
              String(choice.group.name),
            ).some((alias) => modifierKey(alias) === part),
          )?.option,
      )
      .filter(Boolean);
    if (selected.length !== requestedParts.length) continue;
    return {
      operation: "replace_item" as CartOperation,
      targetItem: line.name,
      items: [
        {
          ...line,
          modifiers: [
            ...(line.modifiers || []),
            ...selected.map((option: any) => ({ name: String(option.name) })),
          ],
        },
      ],
    };
  }
  return null;
}
export async function incrementalSpokenCart(
  orderId: string | null,
  operation: CartOperation,
  targetItem: string,
  changed: SpokenOrderItem[],
) {
  if (!orderId || operation === "replace_order") return changed;
  const current = await spokenCart(orderId);
  if (operation === "read") return current;
  const target = cartKey(targetItem || changed[0]?.name || "");
  if (operation === "add") return [...current, ...changed];
  const matches = (item: SpokenOrderItem) => cartKey(item.name) === target;
  if (operation === "replace_item")
    return [...current.filter((item) => !matches(item)), ...changed];
  if (operation === "remove_item") {
    const removeQuantity = Math.max(1, Number(changed[0]?.quantity || 1));
    let remaining = removeQuantity;
    return current.flatMap((item) => {
      if (!matches(item) || remaining <= 0) return [item];
      const quantity = Math.max(1, Number(item.quantity || 1)),
        taken = Math.min(quantity, remaining);
      remaining -= taken;
      return quantity > taken ? [{ ...item, quantity: quantity - taken }] : [];
    });
  }
  return changed;
}
export async function compactPhoneOrderResult(
  result: Record<string, any>,
  operation: CartOperation,
) {
  const sql = getSql(),
    modifiers =
      await sql`SELECT modifier.order_item_id,modifier.option_name_snapshot,modifier.quantity,modifier.pizza_topping_portion,modifier.pizza_topping_amount FROM ordering_order_item_modifiers modifier JOIN ordering_order_items item ON item.id=modifier.order_item_id WHERE item.order_id=${String(result.id)} AND modifier.selection_state IN('selected','extra') AND modifier.print_on_ticket=TRUE ORDER BY modifier.created_at,modifier.id`;
  return {
    ok: true,
    operation,
    orderId: String(result.id),
    displayNumber: String(result.display_number || ""),
    version: Number(result.version),
    serviceType: String(result.service_type),
    totalCents: Number(result.total_cents),
    amountDueCents: Number(result.amount_due_cents),
    paymentMethod: String(result.payment_preference || ""),
    tipCents: Number(result.tip_cents || 0),
    lines: (result.lines || []).map((line: Record<string, any>) => ({
      name: String(line.item_name_snapshot),
      variant: String(line.variant_name_snapshot || ""),
      quantity: Number(line.quantity),
      modifiers: modifiers
        .filter(
          (modifier) => String(modifier.order_item_id) === String(line.id),
        )
        .map((modifier) => ({
          name: String(modifier.option_name_snapshot),
          quantity: Number(modifier.quantity || 1),
          portion: modifier.pizza_topping_portion || undefined,
          amount: modifier.pizza_topping_amount || undefined,
        })),
    })),
    warnings: result.warnings || [],
    requiredFollowUp: result.required_follow_up || undefined,
  };
}
export function compactPhoneMenuResult(result: any[]) {
  return result
    .slice(0, 3)
    .map((category) => ({
      category: category.name,
      items: (category.items || [])
        .slice(0, 3)
        .map((item: any) => ({
          name: item.name,
          description: item.description || "",
          priceCents: item.basePriceCents,
          variants: (item.variants || [])
            .filter((variant: any) => variant.available !== false)
            .map((variant: any) => ({
              name: variant.name,
              priceCents: variant.basePriceCents,
            })),
          modifierGroups: (item.modifiers || [])
            .filter((group: any) => group.presentationContext !== "hidden")
            .map((group: any) => ({
              name: group.name,
              required: Number(group.minSelections) > 0,
              options: (group.options || [])
                .filter((option: any) => option.available)
                .map((option: any) => ({
                  name: option.name,
                  priceCents: option.priceDeltaCents,
                })),
            })),
        })),
    }));
}

export function startOpenAiSideband(
  callId: string,
  greeting: string,
  model: string,
) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OpenAI API key is not configured.");
  sockets.get(callId)?.terminate();
  const socket = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  sockets.set(callId, socket);
  const openedAt = Date.now(),
    hardStop = setTimeout(() => socket.close(), 4 * 60 * 60 * 1000),
    firstAudio = new Set<string>();
  let ping: ReturnType<typeof setInterval> | undefined,
    turnTimer: ReturnType<typeof setTimeout> | undefined,
    bargeInTimer: ReturnType<typeof setTimeout> | undefined,
    lastSpeechStoppedAt = 0,
    lastTurnId = "",
    responseActive = false,
    customerSpeaking = false,
    customerTurnPending = false,
    toolUsedForTurn = false,
    lastCustomerTranscript = "",
    lastAssistantTranscript = "",
    completionRetryUsed = false,
    rateLimitRetryTimer: ReturnType<typeof setTimeout> | undefined,
    hangupAfterPlayback = false,
    hangupRequested = false;
  const hangup = async () => {
    if (hangupRequested) return;
    hangupRequested = true;
    try {
      await event(
        callId,
        `${callId}:hangup:${Date.now()}`,
        "call.hangup_requested",
        "system",
        "Final closing completed",
      );
      await openAiClient().realtime.calls.hangup(callId);
      await getSql()`UPDATE ordering_call_sessions SET state='ended',ended_at=NOW(),updated_at=NOW() WHERE business='Corner Deli' AND three_cx_call_id=${callId}`;
    } catch (error) {
      hangupRequested = false;
      console.error("OpenAI realtime call hangup failed.", {
        callId,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  };
  const scheduleTurn = () => {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      turnTimer = undefined;
      if (
        socket.readyState === WebSocket.OPEN &&
        !customerSpeaking &&
        !responseActive
      )
        socket.send(
          JSON.stringify({
            type: "response.create",
            response: { output_modalities: ["audio"], tool_choice: "auto" },
          }),
        );
    }, 750);
  };
  socket.once("open", () => {
    void event(
      callId,
      `${callId}:sideband-open`,
      "sideband.connected",
      "system",
      "Realtime connection active",
    );
    ping = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 20_000);
    socket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions: `Say exactly: \"${greeting}\" Do not add, remove, or change any word. Then stop speaking.`,
          output_modalities: ["audio"],
          max_output_tokens: 128,
          tool_choice: "none",
        },
      }),
    );
  });
  const executePriceOrder = async (row: Record<string, any>) => {
    const started = Date.now(),
      requestId = randomUUID(),
      actor = {
        id: `openai:${callId}`,
        name: "Corner Deli AI Phone",
        type: "employee" as const,
        role: "employee" as const,
      };
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(row.arguments || "{}")) as Record<
        string,
        unknown
      >;
      let spokenItems = Array.isArray(args.items)
        ? (args.items as SpokenOrderItem[])
        : [];
      const sauceMatch = lastCustomerTranscript.match(
        /\b(mild|medium|hot|suicide|bbq|sweet and sassy|plain|sweet and sour|garlic parmesan|open pit bbq)\b/i,
      );
      if (/\bwings?\b/i.test(lastCustomerTranscript) && sauceMatch) {
        for (const item of spokenItems) {
          if (!/^(?:boneless )?wings?$/i.test(String(item.name))) continue;
          const modifiers = Array.isArray(item.modifiers) ? item.modifiers : [];
          if (
            !modifiers.some((modifier) =>
              /^(mild|medium|hot|suicide|bbq|sweet and sassy|plain|sweet and sour|garlic parmesan|open pit bbq)$/i.test(
                String(modifier.name),
              ),
            )
          )
            item.modifiers = [...modifiers, { name: sauceMatch[1] }];
        }
      }
      const sql = getSql();
      const call = (
        await sql`SELECT call.id,call.order_id,call.caller_phone,call.pending_item,orders.service_type,orders.customer_id,orders.first_name_snapshot,orders.last_name_snapshot,address.route_distance_miles FROM ordering_call_sessions call LEFT JOIN ordering_orders orders ON orders.id=call.order_id LEFT JOIN ordering_order_delivery_addresses address ON address.order_id=orders.id WHERE call.business='Corner Deli' AND call.three_cx_call_id=${callId} AND call.state IN('ai','handoff_pending') LIMIT 1`
      )[0];
      if (!call)
        throw new AiToolError(
          "NOT_AUTHORIZED",
          "The active phone call was not found.",
          "Ask the caller to try again.",
          403,
        );
      let operation = (
        [
          "add",
          "replace_item",
          "remove_item",
          "replace_order",
          "read",
        ].includes(String(args.operation))
          ? String(args.operation)
          : "replace_order"
      ) as CartOperation;
      if (call.order_id) {
        const savedWingSauces = await sql`
          SELECT items.item_name_snapshot,modifier.option_name_snapshot
          FROM ordering_order_items items
          JOIN ordering_order_item_modifiers modifier ON modifier.order_item_id=items.id
          WHERE items.order_id=${String(call.order_id)}
            AND modifier.group_name_snapshot='Wing Sauce'
          ORDER BY items.sort_order,modifier.created_at
        `;
        for (const item of spokenItems) {
          if (!/^(?:boneless )?wings?$/i.test(String(item.name))) continue;
          const modifiers = Array.isArray(item.modifiers) ? item.modifiers : [];
          const hasSauce = modifiers.some((modifier) =>
            /^(mild|medium|hot|suicide|bbq|sweet and sassy|plain|sweet and sour|garlic parmesan|open pit bbq)$/i.test(
              String(modifier.name),
            ),
          );
          if (!hasSauce) {
            const saved = savedWingSauces.find((entry) =>
              /boneless/i.test(String(item.name))
                ? /boneless/i.test(String(entry.item_name_snapshot))
                : !/boneless/i.test(String(entry.item_name_snapshot)),
            );
            if (saved)
              item.modifiers = [
                ...modifiers,
                { name: String(saved.option_name_snapshot) },
              ];
          }
        }
      }
      let targetItem = String(args.targetItem || "");
      const pendingApplied = await applyPendingModifierAnswer({
        orderId: call.order_id ? String(call.order_id) : null,
        pendingItem: call.pending_item || null,
        customerText: lastCustomerTranscript,
        operation,
        targetItem,
        items: spokenItems,
      });
      operation = pendingApplied.operation;
      targetItem = pendingApplied.targetItem;
      spokenItems = pendingApplied.items;
      const attached = await attachStandaloneModifierAnswer(
        call.order_id ? String(call.order_id) : null,
        operation,
        spokenItems,
      );
      if (attached) {
        operation = attached.operation;
        targetItem = attached.targetItem;
        spokenItems = attached.items;
      }
      const callerPhone = String(call.caller_phone || args.callerPhone || "")
        .replace(/\D/g, "")
        .replace(/^1(?=\d{10}$)/, "")
        .slice(-10);
      const touchedItems = spokenItems;
      spokenItems = await incrementalSpokenCart(
        call.order_id ? String(call.order_id) : null,
        operation,
        targetItem,
        touchedItems,
      );
      const result = await priceSpokenOrder({
        business: "Corner Deli",
        actor,
        service: serviceType(
          args.serviceType || call.service_type || "undecided",
        ),
        items: spokenItems,
        orderId: call.order_id || null,
        customerId: String(args.customerId || call.customer_id || "") || null,
        callerPhone,
        firstName: String(args.firstName || call.first_name_snapshot || ""),
        lastName: String(args.lastName || call.last_name_snapshot || ""),
        resolvedPendingQuestions: pendingApplied.resolvedPendingQuestions,
      });
      await sql`UPDATE ordering_call_sessions SET order_id=${String(result.id)},pending_item=${result.pending_item ? JSON.stringify(result.pending_item) : null}::jsonb,updated_at=NOW() WHERE id=${call.id}`;
      if (
        args.serviceType === "delivery" &&
        String(args.deliveryAddress || "").trim()
      ) {
        let delivery;
        try {
          const customerAddress =
            args.customerId && args.customerAddressId
              ? (
                  await sql`SELECT id FROM ordering_customer_addresses WHERE id=${String(args.customerAddressId)} AND customer_id=${String(args.customerId)} AND active=TRUE`
                )[0]
              : null;
          delivery = await attachSpokenDeliveryAddress(
            String(result.id),
            String(args.deliveryAddress),
            String(args.deliveryUnit || ""),
            customerAddress ? String(customerAddress.id) : null,
          );
        } catch (error) {
          throw new AiToolError(
            "INVALID_INPUT",
            "I couldn't verify that delivery address.",
            "Ask the caller to repeat the street number and street. For an address outside Ogdensburg, also ask for city, state, and ZIP.",
            409,
            {
              field: "deliveryAddress",
              reason:
                error instanceof Error
                  ? error.message
                  : "address_validation_failed",
            },
          );
        }
        const updated = (
          await sql`SELECT total_cents,amount_due_cents,delivery_fee_cents FROM ordering_orders WHERE id=${String(result.id)}`
        )[0];
        Object.assign(result, {
          delivery,
          total_cents: Number(updated.total_cents),
          amount_due_cents: Number(updated.amount_due_cents),
          delivery_fee_cents: Number(updated.delivery_fee_cents),
        });
      } else if (
        serviceType(args.serviceType || call.service_type || "undecided") ===
          "delivery" &&
        call.route_distance_miles != null
      ) {
        const quote = await quoteDelivery({
          business: "Corner Deli",
          distanceMiles: Number(call.route_distance_miles),
          merchandiseSubtotalCents: Number(result.subtotal_cents),
        });
        await sql`UPDATE ordering_orders SET delivery_fee_cents=${quote.deliveryFeeCents},total_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${quote.deliveryFeeCents}),amount_due_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${quote.deliveryFeeCents}-paid_cents),version=version+1,updated_at=NOW() WHERE id=${String(result.id)}`;
        Object.assign(
          result,
          (
            await sql`SELECT delivery_fee_cents,total_cents,amount_due_cents,version FROM ordering_orders WHERE id=${String(result.id)}`
          )[0],
        );
      }
      if (args.paymentMethod === "cash" || args.paymentMethod === "card") {
        const paymentResult = await setAiPaymentDetails({
          orderId: String(result.id),
          business: "Corner Deli",
          service: serviceType(args.serviceType),
          paymentMethod: args.paymentMethod,
          tipCents: Number(args.tipCents || 0),
          actor,
        });
        Object.assign(result, paymentResult);
      }
      const wingNeedsAddOn =
        args.wingAddOnDecision !== "declined" &&
        touchedItems.some(
          (item) =>
            /^(?:boneless )?wings?$/i.test(String(item.name)) &&
            !(item.modifiers || []).some((modifier) =>
              /^(blue cheese|ranch|celery)$/i.test(String(modifier.name)),
            ),
        );
      const burgerItems = touchedItems.filter((item) =>
          /burger/i.test(String(item.name)),
        ),
        burgerHasToppings = burgerItems.some((item) =>
          (item.modifiers || []).some((modifier) =>
            /^(lettuce|tomatoes?|raw onions?|onions?|ketchup|mayo|mayonnaise|mustard|pickles?|relish|hot peppers?)$/i.test(
              String(modifier.name),
            ),
          ),
        ),
        burgerNeedsToppings =
          burgerItems.length > 0 &&
          !burgerHasToppings &&
          args.burgerToppingsDecision !== "declined",
        burgerNeedsFries =
          burgerItems.length > 0 &&
          !burgerNeedsToppings &&
          args.burgerFriesDecision !== "declined" &&
          !spokenItems.some((item) =>
            /fr(?:y|ies)|poutine/i.test(String(item.name)),
          );
      if (wingNeedsAddOn)
        Object.assign(result, {
          required_follow_up:
            "Would you like blue cheese, ranch, or celery with that?",
        });
      else if (burgerNeedsToppings)
        Object.assign(result, {
          required_follow_up: "Would you like anything on that burger?",
        });
      else if (burgerNeedsFries)
        Object.assign(result, {
          required_follow_up: "Would you like fries with that burger?",
        });
      await auditAiTool({
        business: "Corner Deli",
        requestId,
        conversationId: callId,
        tool: "price_order",
        actor,
        orderId: String(result.id),
        outcome: "success",
        inputSummary: {
          customerItems: args.items || [],
          operation,
          targetItem,
          source: "realtime_function",
        },
        resultSummary: {
          lineCount: result.lines.length,
          totalCents: result.total_cents,
        },
        durationMs: Date.now() - started,
        model,
      });
      const compactResult = await compactPhoneOrderResult(result, operation);
      if (result.required_follow_up)
        compactResult.requiredFollowUp = result.required_follow_up;
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: row.call_id,
            output: JSON.stringify(compactResult),
          },
        }),
      );
    } catch (error) {
      const known =
        error instanceof AiToolError
          ? error
          : new AiToolError(
              "INTERNAL_ERROR",
              "Pricing failed.",
              "Ask one precise clarification, then retry.",
              500,
            );
      const pendingItem = known.details.pendingItem || null;
      if (pendingItem)
        await getSql()`UPDATE ordering_call_sessions SET pending_item=${JSON.stringify(pendingItem)}::jsonb,updated_at=NOW() WHERE business='Corner Deli' AND three_cx_call_id=${callId}`;
      await auditAiTool({
        business: "Corner Deli",
        requestId,
        conversationId: callId,
        tool: "price_order",
        actor,
        outcome: known.code === "FOLLOW_UP_REQUIRED" ? "blocked" : "error",
        errorCode: known.code,
        inputSummary: {
          customerItems: args.items || [],
          operation: args.operation || "",
          targetItem: args.targetItem || "",
          source: "realtime_function",
        },
        resultSummary: { message: known.message, details: known.details },
        durationMs: Date.now() - started,
        model,
      });
      if (known.code !== "FOLLOW_UP_REQUIRED")
        await recordAiRegression({
          business: "Corner Deli",
          caseType: "order_resolution",
          source: `production_tool_${known.code}`,
          callId,
          payload: args,
          expected: { mustResolve: true },
        });
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: row.call_id,
            output: JSON.stringify(
              known.code === "FOLLOW_UP_REQUIRED"
                ? {
                    ok: false,
                    pending: true,
                    requiredFollowUp: known.message,
                    details: known.details,
                  }
                : {
                    error: {
                      code: known.code,
                      message: known.message,
                      remedy: known.remedy,
                      details: known.details,
                    },
                  },
            ),
          },
        }),
      );
    }
    socket.send(
      JSON.stringify({
        type: "response.create",
        response: { output_modalities: ["audio"], tool_choice: "auto" },
      }),
    );
  };
  const executeMenuSearch = async (row: Record<string, any>) => {
    let result: unknown;
    try {
      const args = JSON.parse(String(row.arguments || "{}")) as Record<
        string,
        unknown
      >;
      result = compactPhoneMenuResult(
        await menuCatalog("Corner Deli", new Date(), String(args.query || "")),
      );
    } catch {
      result = {
        error: {
          code: "CATALOG_UNAVAILABLE",
          message: "I can't verify that item right now.",
        },
      };
    }
    socket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: row.call_id,
          output: JSON.stringify(result),
        },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "response.create",
        response: { output_modalities: ["audio"], tool_choice: "auto" },
      }),
    );
  };
  const executeHumanHandoff = async (row: Record<string, any>) => {
    try {
      const args = JSON.parse(String(row.arguments || "{}")) as Record<
        string,
        unknown
      >;
      const reason = String(
        args.reason || "Customer requested store assistance.",
      );
      await event(
        callId,
        `${callId}:handoff:${row.call_id}`,
        "ordering.human_handoff",
        "system",
        "Transferring call to store",
        reason,
      );
      await requestOpenAiHandoff(callId, reason);
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: row.call_id,
            output: JSON.stringify({
              error: {
                code: "HANDOFF_FAILED",
                message:
                  "The call could not be transferred. Ask the caller to stay on the line and retry once.",
              },
            }),
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "response.create",
          response: { output_modalities: ["audio"], tool_choice: "auto" },
        }),
      );
    }
  };
  const executeVoicePayment = async (row: Record<string, any>) => {
    try {
      const args = JSON.parse(String(row.arguments || "{}")) as Record<
        string,
        unknown
      >;
      const sql = getSql(),
        order = (
          await sql`SELECT orders.id,orders.service_type FROM ordering_call_sessions call JOIN ordering_orders orders ON orders.id=call.order_id WHERE call.business='Corner Deli' AND call.three_cx_call_id=${callId} AND call.state='ai' LIMIT 1`
        )[0];
      if (!order)
        throw new Error("A priced AI order was not found for secure payment.");
      await setAiPaymentDetails({
        orderId: String(order.id),
        business: "Corner Deli",
        service: serviceType(order.service_type),
        paymentMethod: "card",
        tipCents: Number(args.tipCents || 0),
        actor: {
          id: `openai:${callId}`,
          name: "Corner Deli AI Phone",
          type: "employee",
          role: "employee",
        },
      });
      await event(
        callId,
        `${callId}:voice-payment:${row.call_id}`,
        "ordering.secure_voice_payment",
        "system",
        "Leaving AI for secure sandbox payment",
      );
      await requestOpenAiVoicePayment(callId);
    } catch (error) {
      console.error("OpenAI secure voice payment transfer failed.", {
        callId,
        error: error instanceof Error ? error.message : "unknown error",
      });
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: row.call_id,
            output: JSON.stringify({
              error: {
                code: "VOICE_PAYMENT_FAILED",
                message:
                  "Secure voice payment could not start. Transfer the caller to an employee.",
              },
            }),
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "response.create",
          response: { output_modalities: ["audio"], tool_choice: "auto" },
        }),
      );
    }
  };
  socket.on("message", (data) => {
    try {
      const row = JSON.parse(String(data)) as Record<string, any>,
        type = String(row.type || ""),
        eventId = String(row.event_id || `${type}:${Date.now()}`),
        key = `${callId}:${eventId}`;
      if (type === "input_audio_buffer.speech_started") {
        customerSpeaking = true;
        if (turnTimer) {
          clearTimeout(turnTimer);
          turnTimer = undefined;
        }
        if (responseActive) {
          if (bargeInTimer) clearTimeout(bargeInTimer);
          bargeInTimer = setTimeout(() => {
            bargeInTimer = undefined;
            if (
              customerSpeaking &&
              responseActive &&
              socket.readyState === WebSocket.OPEN
            ) {
              socket.send(JSON.stringify({ type: "response.cancel" }));
              socket.send(
                JSON.stringify({ type: "output_audio_buffer.clear" }),
              );
              void event(
                callId,
                key,
                "conversation.sustained_barge_in",
                "system",
                "Sustained caller speech interrupted AI",
              );
            }
          }, 1800);
        }
        void event(callId, key, type, "customer", "Customer speaking");
      } else if (type === "input_audio_buffer.speech_stopped") {
        customerSpeaking = false;
        if (bargeInTimer) {
          clearTimeout(bargeInTimer);
          bargeInTimer = undefined;
        }
        lastSpeechStoppedAt = Date.now();
        lastTurnId = eventId;
        customerTurnPending = true;
        toolUsedForTurn = false;
        void event(callId, key, type, "system", "Processing customer request");
      } else if (
        type === "conversation.item.input_audio_transcription.completed"
      ) {
        if (rateLimitRetryTimer) {
          clearTimeout(rateLimitRetryTimer);
          rateLimitRetryTimer = undefined;
        }
        const value = text(row.transcript);
        lastCustomerTranscript = value;
        completionRetryUsed = false;
        void transcript(callId, key, "customer", value, {
          languages: row.languages || [],
        });
        void event(callId, key, type, "customer", "Customer", value);
        scheduleTurn();
      } else if (type === "response.created") {
        responseActive = true;
        if (lastSpeechStoppedAt)
          void latency(
            callId,
            lastTurnId,
            "model_response_start",
            Date.now() - lastSpeechStoppedAt,
            model,
          );
      } else if (type === "response.output_audio.delta") {
        const responseId = String(row.response_id || "");
        if (responseId && !firstAudio.has(responseId)) {
          firstAudio.add(responseId);
          const delay = lastSpeechStoppedAt
            ? Date.now() - lastSpeechStoppedAt
            : 0;
          void latency(
            callId,
            lastTurnId,
            "speech_generation_start",
            delay,
            model,
          );
          void event(
            callId,
            key,
            type,
            "assistant",
            "AI started speaking",
            "",
            delay,
          );
        }
      } else if (type === "response.output_audio_transcript.done") {
        const value = text(row.transcript);
        lastAssistantTranscript = value;
        if (
          /thanks for calling[—-]see you then!?$/i.test(value) ||
          /this line is only for corner deli orders and restaurant questions\. please call back if you need to place an order\. goodbye\.?$/i.test(
            value,
          )
        )
          hangupAfterPlayback = true;
        void transcript(callId, key, "assistant", value);
        void event(callId, key, type, "assistant", "AI", value);
        if (customerTurnPending && !toolUsedForTurn)
          void event(
            callId,
            `${key}:missing-tool`,
            "ordering.turn_without_tool",
            "error",
            "No ordering tool used after customer turn",
            value,
          );
        customerTurnPending = false;
      } else if (
        type === "response.output_item.added" &&
        (row.item?.type === "mcp_call" || row.item?.type === "function_call")
      ) {
        toolUsedForTurn = true;
        void event(
          callId,
          key,
          type,
          "tool",
          `Using ${row.item.name || "ordering tool"}`,
        );
      } else if (
        type === "response.function_call_arguments.done" &&
        row.name === "price_order"
      ) {
        toolUsedForTurn = true;
        void executePriceOrder(row);
      } else if (
        type === "response.function_call_arguments.done" &&
        row.name === "menu_search"
      ) {
        toolUsedForTurn = true;
        void executeMenuSearch(row);
      } else if (
        type === "response.function_call_arguments.done" &&
        row.name === "request_human_handoff"
      ) {
        toolUsedForTurn = true;
        void executeHumanHandoff(row);
      } else if (
        type === "response.function_call_arguments.done" &&
        row.name === "request_secure_voice_payment"
      ) {
        toolUsedForTurn = true;
        void executeVoicePayment(row);
      } else if (type === "response.mcp_call.completed") {
        toolUsedForTurn = true;
        void event(callId, key, type, "tool", "Ordering tool completed");
      } else if (type === "response.mcp_call.failed")
        void event(callId, key, type, "error", "Ordering tool failed");
      else if (type === "output_audio_buffer.stopped" && hangupAfterPlayback) {
        hangupAfterPlayback = false;
        void hangup();
      } else if (type === "response.done") {
        responseActive = false;
        const status = String(row.response?.status || ""),
          errorCode = String(row.response?.status_details?.error?.code || ""),
          errorMessage = text(row.response?.status_details?.error?.message),
          unfinished =
            /[,;:\-–—]$/.test(lastAssistantTranscript) ||
            /\b(and|or|with|for|to|the|a|do|does|would|could)$/.test(
              lastAssistantTranscript.toLowerCase(),
            ),
          truncated = status === "failed" || unfinished;
        if (status === "failed")
          console.error("OpenAI realtime response failed.", {
            callId,
            statusDetails: row.response?.status_details || null,
            transcript: lastAssistantTranscript,
          });
        if (truncated && !customerSpeaking && !completionRetryUsed) {
          completionRetryUsed = true;
          void recordAiRegression({
            business: "Corner Deli",
            caseType: "speech_completion",
            source: "production_truncated_response",
            callId,
            payload: { status, transcript: lastAssistantTranscript },
            expected: { retry: true },
          });
          const secondsMatch = errorMessage.match(
              /try again in\s+(-?[\d.]+)s/i,
            ),
            millisecondsMatch = errorMessage.match(/try again in\s+(\d+)ms/i),
            delayMs =
              errorCode === "rate_limit_exceeded"
                ? Math.max(
                    750,
                    Math.min(
                      12000,
                      secondsMatch
                        ? Number(secondsMatch[1]) * 1000
                        : millisecondsMatch
                          ? Number(millisecondsMatch[1])
                          : 2500,
                    ),
                  )
                : 0,
            retryTurn = lastTurnId;
          void event(
            callId,
            `${key}:completion-retry`,
            "response.completion_retry",
            "system",
            errorCode === "rate_limit_exceeded"
              ? "Rate limited — retry scheduled"
              : "Retrying truncated response",
            errorCode === "rate_limit_exceeded"
              ? `Retrying in ${(delayMs / 1000).toFixed(1)} seconds`
              : `${status}: ${lastAssistantTranscript}`,
          );
          const retry = () => {
            rateLimitRetryTimer = undefined;
            if (
              socket.readyState !== WebSocket.OPEN ||
              customerSpeaking ||
              responseActive ||
              retryTurn !== lastTurnId
            )
              return;
            socket.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  instructions:
                    "Continue the same logical turn in one short, complete sentence. Do not repeat completed words. If the caller's latest turn changes the order or answers a pending modifier question, call price_order and wait for success before verbally confirming it.",
                  output_modalities: ["audio"],
                  max_output_tokens: 128,
                  tool_choice: "auto",
                },
              }),
            );
          };
          if (delayMs) {
            rateLimitRetryTimer = setTimeout(retry, delayMs);
          } else retry();
        }
      } else if (type === "error") {
        void event(
          callId,
          key,
          type,
          "error",
          "Realtime error",
          text(row.error?.message),
        );
        console.error("OpenAI realtime sideband error.", {
          callId,
          error: row.error?.message || "unknown error",
        });
      }
    } catch (error) {
      console.warn("OpenAI realtime sideband event could not be parsed.", {
        callId,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  });
  socket.once("error", (error) => {
    void event(
      callId,
      `${callId}:sideband-error:${Date.now()}`,
      "sideband.error",
      "error",
      "Realtime connection error",
      error.message,
    );
  });
  socket.once("close", (code, reasonBuffer) => {
    clearTimeout(hardStop);
    if (turnTimer) clearTimeout(turnTimer);
    if (bargeInTimer) clearTimeout(bargeInTimer);
    if (rateLimitRetryTimer) clearTimeout(rateLimitRetryTimer);
    if (ping) clearInterval(ping);
    if (sockets.get(callId) === socket) sockets.delete(callId);
    const connectedMs = Date.now() - openedAt;
    void (async () => {
      const call = (
        await getSql()`SELECT state,bridge_action,handoff_reason FROM ordering_call_sessions WHERE business='Corner Deli' AND three_cx_call_id=${callId} LIMIT 1`
      )[0];
      const bridgeAction = String(call?.bridge_action || ""),
        handoffReason = String(call?.handoff_reason || ""),
        closeReason = reasonBuffer.toString().trim(),
        expectedPayment =
          bridgeAction === "payment" ||
          /secure.*payment|payment/i.test(handoffReason),
        expectedHandoff =
          bridgeAction === "handoff" ||
          ["handoff_pending", "human"].includes(String(call?.state || "")),
        expectedCompletion = hangupRequested || bridgeAction === "complete";
      let label = "Realtime connection ended unexpectedly";
      if (expectedPayment) label = "AI session ended for secure payment";
      else if (expectedHandoff) label = "AI session handed to the store";
      else if (expectedCompletion) label = "AI call completed";
      const durationSeconds = Math.round(connectedMs / 1000),
        diagnostic = [
          `Connected ${durationSeconds} seconds`,
          `close code ${code}`,
          closeReason ? `reason: ${closeReason}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
      await event(
        callId,
        `${callId}:sideband-close:${Date.now()}`,
        "sideband.closed",
        expectedPayment || expectedHandoff || expectedCompletion
          ? "system"
          : "error",
        label,
        diagnostic,
      );
      console.info("OpenAI realtime sideband closed.", {
        callId,
        code,
        reason: closeReason,
        connectedMs,
        bridgeAction,
        callState: call?.state || "unknown",
        expected:
          expectedPayment || expectedHandoff || expectedCompletion,
      });
    })().catch((error) => {
      console.error("OpenAI realtime close event could not be classified.", {
        callId,
        code,
        error: error instanceof Error ? error.message : "unknown error",
      });
    });
  });
}
