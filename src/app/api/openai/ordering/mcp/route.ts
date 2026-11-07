import { isoJson } from "@/lib/timestamp-values";
import { randomUUID } from "node:crypto";
import {
  AI_ORDERING_TOOL_NAMES,
  executeAiOrderingTool,
  type AiOrderingToolName,
} from "@/app/api/ordering/ai/tools/route";
import { getSql } from "@/lib/db";
import { withCallCartLock } from "@/lib/ai-phone-call-lock";
import {
  AiToolError,
  auditAiTool,
  callerCustomerLookup,
  priceSpokenOrder,
  serviceType,
  menuCatalog,
  spokenKey,
} from "@/lib/ordering-ai-tools";
import {
  bindPhoneOrderId,
  isPhoneMcpTool,
  resolvePhoneCustomerId,
} from "@/lib/ordering-ai-phone-guard";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import { attachSpokenDeliveryAddress } from "@/lib/ordering-delivery-landmarks";
import {
  mcpAuthorized,
  OPENAI_PHONE_MODEL,
  requestOpenAiHandoff,
} from "@/lib/openai-phone-ordering";
import {
  applyPendingModifierAnswer,
  incrementalSpokenCart,
  parseCartOperation,
  applyFryPlacementSpeech,
  compactPhoneOrderResult,
  compactPhoneMenuResult,
} from "@/lib/openai-phone-sideband";

export const runtime = "nodejs";
type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};
const properties = {
  callId: {
    type: "string",
    description:
      "Exact immutable call ID supplied in the phone session instructions.",
  },
};
const draftItemSchema = {
  type: "object",
  properties: {
    itemId: {
      type: "string",
      description: "Stable item ID returned by menu_search.",
    },
    variantId: {
      type: ["string", "null"],
      description: "Stable size/form variant ID returned by menu_search.",
    },
    quantity: { type: "integer", minimum: 1 },
    modifierSelections: {
      type: "object",
      additionalProperties: { type: "array", items: { type: "string" } },
      description: "Modifier group IDs mapped to selected option IDs.",
    },
    modifierQuantities: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    modifierAmounts: {
      type: "object",
      additionalProperties: {
        type: "string",
        enum: ["light", "normal", "heavy"],
      },
    },
    modifierDeclines: { type: "array", items: { type: "string" } },
    pizzaToppings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          modifierOptionId: { type: "string" },
          portion: {
            type: "string",
            enum: ["whole", "left_half", "right_half"],
          },
          amount: {
            type: "string",
            enum: ["regular", "extra", "double_extra", "triple_extra"],
          },
        },
        required: ["modifierOptionId", "portion", "amount"],
        additionalProperties: false,
      },
    },
    specialInstructions: { type: "string" },
  },
  required: ["itemId", "quantity"],
  additionalProperties: false,
};
const spokenItemSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "Canonical item name, for example Pizza, Wings, or Large French Fries.",
    },
    lineId: { type: "string", description: "Stable existing cart lineId; include each corrected line's own ID for batch edits." },
    variant: {
      type: "string",
      description: "Size/form, for example Jumbo Thin or 20 Wings.",
    },
    quantity: { type: "integer", minimum: 1 },
    modifiers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Exact spoken modifier such as Pepperoni, Onions, Mild, or Nacho Cheese.",
          },
          group: { type: "string" },
          remove: { type: "boolean" },
          placement: { type: "string", enum: ["side", "topping"] },
          portion: {
            type: "string",
            enum: ["whole", "left_half", "right_half"],
          },
          amount: {
            type: "string",
            enum: ["regular", "extra", "double_extra", "triple_extra"],
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "quantity"],
  additionalProperties: false,
};
const schemas: Record<AiOrderingToolName, Record<string, unknown>> = {
  describe_capabilities: {
    type: "object",
    properties,
    required: ["callId"],
    additionalProperties: false,
  },
  menu_browse: {
    type: "object",
    properties: { ...properties, scheduledFor: { type: "string" } },
    required: ["callId"],
    additionalProperties: false,
  },
  menu_search: {
    type: "object",
    properties: {
      ...properties,
      query: { type: "string" },
      scheduledFor: { type: "string" },
    },
    required: ["callId", "query"],
    additionalProperties: false,
  },
  ordering_availability: {
    type: "object",
    properties: {
      ...properties,
      serviceType: { type: "string" },
      at: { type: "string" },
    },
    required: ["callId", "serviceType"],
    additionalProperties: false,
  },
  future_slots: {
    type: "object",
    properties: {
      ...properties,
      serviceType: { type: "string" },
      date: { type: "string" },
    },
    required: ["callId", "serviceType", "date"],
    additionalProperties: false,
  },
  promotions: {
    type: "object",
    properties,
    required: ["callId"],
    additionalProperties: false,
  },
  customer_lookup: {
    type: "object",
    properties: { ...properties, query: { type: "string" } },
    required: ["callId"],
    additionalProperties: false,
  },
  create_draft: {
    type: "object",
    properties: {
      ...properties,
      serviceType: {
        type: "string",
        enum: [
          "undecided",
          "pickup",
          "delivery",
          "no_contact_delivery",
          "dine_in",
          "curbside",
          "bar",
        ],
      },
      items: { type: "array", items: draftItemSchema },
      customerId: { type: "string" },
      callerPhone: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      scheduledFor: { type: "string" },
    },
    required: ["callId", "serviceType", "items"],
    additionalProperties: false,
  },
  update_draft: {
    type: "object",
    properties: {
      ...properties,
      orderId: { type: "string" },
      expectedVersion: { type: "integer" },
      serviceType: {
        type: "string",
        enum: [
          "undecided",
          "pickup",
          "delivery",
          "no_contact_delivery",
          "dine_in",
          "curbside",
          "bar",
        ],
      },
      items: { type: "array", items: draftItemSchema },
      customerId: { type: "string" },
      callerPhone: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      scheduledFor: { type: "string" },
    },
    required: ["callId", "orderId", "expectedVersion", "serviceType", "items"],
    additionalProperties: false,
  },
  get_draft: {
    type: "object",
    properties: { ...properties, orderId: { type: "string" } },
    required: ["callId", "orderId"],
    additionalProperties: false,
  },
  attach_delivery_address: {
    type: "object",
    properties: {
      ...properties,
      orderId: { type: "string" },
      address: { type: "string" },
      validationToken: { type: "string" },
      unit: { type: "string" },
      customerAddressId: { type: "string" },
    },
    required: ["callId", "orderId", "address", "validationToken"],
    additionalProperties: false,
  },
  validate_delivery: {
    type: "object",
    properties: {
      ...properties,
      distanceMiles: { type: "number" },
      merchandiseSubtotalCents: { type: "integer" },
    },
    required: ["callId", "distanceMiles", "merchandiseSubtotalCents"],
    additionalProperties: false,
  },
  hold: {
    type: "object",
    properties: { ...properties, orderId: { type: "string" } },
    required: ["callId", "orderId"],
    additionalProperties: false,
  },
  send: {
    type: "object",
    properties: {
      ...properties,
      orderId: { type: "string" },
      customerConfirmed: {
        type: "boolean",
        description:
          "True only after an explicit spoken yes to the full readback and authoritative total.",
      },
    },
    required: ["callId", "orderId", "customerConfirmed"],
    additionalProperties: false,
  },
};
const descriptions: Record<AiOrderingToolName, string> = {
  describe_capabilities: "Get ordering capabilities and safety rules.",
  menu_browse: "Browse the current effective menu using stable IDs.",
  menu_search: "Search current menu items, variants, and modifiers.",
  ordering_availability:
    "Check whether ordering is available for a service and time.",
  future_slots: "List valid future fulfillment slots.",
  promotions: "List currently active promotion descriptions.",
  customer_lookup:
    "Check whether this call's caller ID matches a saved customer. Returns only an opaque customerId, first name, and last four phone digits; spoken names or numbers are not searched.",
  create_draft: "Create a server-priced phone order draft.",
  update_draft: "Replace a draft using optimistic version control.",
  get_draft: "Read the authoritative current draft and total.",
  attach_delivery_address:
    "Attach a previously validated address and calculate routed delivery pricing.",
  validate_delivery: "Quote configured distance-based delivery pricing.",
  hold: "Validate required fields and prepare a full customer readback.",
  send: "Send a confirmed draft to the kitchen. Requires explicit customer confirmation.",
};
const phoneToolNames = [
  "menu_search",
  "customer_lookup",
  "get_draft",
  "hold",
  "send",
] as const;
const tools = [
  {
    name: "price_order",
    description:
      "PRIMARY phone-order tool. Incrementally update the server-priced cart. Send only changed items. Edits require the stable lineId returned by the cart.",
    inputSchema: {
      type: "object",
      properties: {
        ...properties,
        operation: {
          type: "string",
          enum: ["add", "replace_item", "remove_item", "read"],
        },
        targetLineId: { type: "string" },
        targetItem: { type: "string", description: "Stable cart lineId" },
        serviceType: {
          type: "string",
          enum: ["undecided", "pickup", "delivery"],
        },
        deliveryAddress: {
          type: "string",
          description: "Street address or recognized local landmark.",
        },
        deliveryUnit: { type: "string" },
        customerAddressId: {
          type: "string",
          description: "The caller's saved address id, once they confirm they are still going there.",
        },
        items: { type: "array", items: spokenItemSchema },
        customerText: {
          type: "string",
          description:
            "The customer's exact latest words. Required when answering a pending size or yes/no modifier question.",
        },
        serviceChangeRequested: {
          type: "boolean",
          description: "True only when the caller clearly asked to switch between pickup and delivery after it was set.",
        },
        callerPhone: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        coldSubCondimentsDecision: {
          type: "string",
          enum: ["selected", "declined"],
        },
        coldSubVegetablesDecision: {
          type: "string",
          enum: ["selected", "declined"],
        },
        steakStyleCondimentDecision: { type: "string", enum: ["selected", "declined"] },
        steakStyleToppingsDecision: { type: "string", enum: ["selected", "declined"] },
        steakStyleCheeseDecision: { type: "string", enum: ["selected", "declined"] },
        steakStyleDoubleMeatDecision: { type: "string", enum: ["selected", "declined"] },
      },
      required: ["callId", "operation", "serviceType", "items"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  ...phoneToolNames.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: schemas[name],
    annotations: {
      readOnlyHint: ["customer_lookup", "get_draft", "hold"].includes(name),
    },
  })),
  {
    name: "request_human_handoff",
    description:
      "Transfer this active call to the configured 3CX human intervention destination while preserving its current order draft.",
    inputSchema: {
      type: "object",
      properties: {
        ...properties,
        reason: {
          type: "string",
          description: "Concise operational reason an employee is needed.",
        },
      },
      required: ["callId", "reason"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];
const sameName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const reply = (id: Rpc["id"], result: unknown) =>
  isoJson({ jsonrpc: "2.0", id, result });
const failure = (
  id: Rpc["id"],
  code: number,
  message: string,
  data?: unknown,
) => isoJson({ jsonrpc: "2.0", id, error: { code, message, data } });

export async function POST(request: Request) {
  if (!mcpAuthorized(request))
    return isoJson({ error: "Unauthorized." }, { status: 401 });
  const rpc = (await request.json()) as Rpc;
  if (rpc.method === "initialize")
    return reply(rpc.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "corner-ops-ordering", version: "1.0.0" },
    });
  if (rpc.method === "notifications/initialized")
    return new Response(null, { status: 202 });
  if (rpc.method === "tools/list") return reply(rpc.id, { tools });
  if (rpc.method !== "tools/call")
    return failure(rpc.id, -32601, "Method not found.");
  // Cart writes for one call run one at a time (Gemini and Claude's cart fixes, ai-phone-call-lock.ts).
  if (rpc.params?.name === "price_order")
    return withCallCartLock(String((rpc.params?.arguments as Record<string, unknown> | undefined)?.callId || ""), () => callTool(rpc));
  return callTool(rpc);
}

async function callTool(rpc: Rpc) {
  const requestedName = String(rpc.params?.name || ""),
    name = requestedName as AiOrderingToolName,
    args = {
      ...((rpc.params?.arguments && typeof rpc.params.arguments === "object"
        ? rpc.params.arguments
        : {}) as Record<string, unknown>),
    };
  // Only the advertised phone tools may run; staff-only tools such as
  // create_draft/update_draft/attach_delivery_address are not reachable here.
  if (
    !isPhoneMcpTool(requestedName) ||
    (!AI_ORDERING_TOOL_NAMES.includes(name) &&
      requestedName !== "request_human_handoff" &&
      requestedName !== "price_order")
  )
    return failure(rpc.id, -32602, "Unknown ordering tool.");
  const callId = String(args.callId || "");
  delete args.callId;
  await ensureOrderingAiSchema();
  const call = (
    await getSql()`SELECT call.id,call.state,call.order_id,call.caller_phone,call.customer_id call_customer_id,call.pending_item,call.deferred_required_fields,call.operating_mode,call.selected_provider,call.selected_model,orders.customer_id order_customer_id,orders.first_name_snapshot,orders.last_name_snapshot FROM ordering_call_sessions call LEFT JOIN ordering_orders orders ON orders.id=call.order_id WHERE call.business='Corner Deli' AND call.three_cx_call_id=${callId} AND call.state IN('ai','handoff_pending') LIMIT 1`
  )[0];
  if (!call)
    return reply(rpc.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "NOT_AUTHORIZED",
              message:
                "This tool request is not linked to an active Corner Deli AI call.",
            },
          }),
        },
      ],
      isError: true,
    });
  // Order and customer are bound to the call row, never to model input.
  const orderBound = bindPhoneOrderId(requestedName, args, call.order_id).ok;
  if (requestedName === "customer_lookup") {
    const customers = await callerCustomerLookup(
      "Corner Deli",
      String(call.caller_phone || ""),
    );
    return reply(rpc.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            customers,
            privacy:
              "Matches only this call's caller ID. Caller ID is not proof of identity; confirm the name before using it and never read other details aloud.",
          }),
        },
      ],
    });
  }
  if (requestedName === "price_order") {
    const callerMatchIds =
      call.order_customer_id || call.call_customer_id || !call.caller_phone
        ? []
        : (
            await callerCustomerLookup(
              "Corner Deli",
              String(call.caller_phone),
            )
          ).map((match) => match.customerId);
    const customerId = resolvePhoneCustomerId(args.customerId, {
      orderCustomerId: call.order_customer_id,
      callCustomerId: call.call_customer_id,
      callerMatchIds,
    });
    const autoMatched =
      !customerId && callerMatchIds.length === 1 ? callerMatchIds[0] : "";
    if (customerId) args.customerId = customerId;
    else if (autoMatched) args.customerId = autoMatched;
    else delete args.customerId;
    if (
      args.customerId &&
      !call.order_customer_id &&
      !call.call_customer_id
    ) {
      await getSql()`UPDATE ordering_call_sessions SET customer_id=${String(args.customerId)},updated_at=NOW() WHERE id=${call.id}`;
      call.call_customer_id = String(args.customerId);
    }
  } else delete args.customerId;
  if (requestedName === "request_human_handoff") {
    try {
      const result = await requestOpenAiHandoff(
        callId,
        String(args.reason || "Employee assistance requested."),
      );
      return reply(rpc.id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    } catch (error) {
      return reply(rpc.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "HANDOFF_FAILED",
                message:
                  "The call could not be transferred. Ask the caller to remain on the line and retry once.",
              },
            }),
          },
        ],
        isError: true,
      });
    }
  }
  if (name === "send" && args.customerConfirmed !== true)
    return reply(rpc.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "SEND_BLOCKED",
              message:
                "Explicit customer confirmation is required after the complete readback.",
            },
          }),
        },
      ],
      isError: true,
    });
  if (name === "send" && call.operating_mode !== "autonomous")
    return reply(rpc.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ORDER_REVIEW_PENDING",
            mode: call.operating_mode,
            orderId: String(args.orderId || call.order_id || ""),
            message:
              "The confirmed draft is visible to Corner Deli staff for review. It has not been accepted by the kitchen.",
          }),
        },
      ],
    });
  if (!orderBound)
    return reply(rpc.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "NOT_FOUND",
              message: "This call does not have an order draft yet.",
              remedy: "Use price_order to start the order first.",
            },
          }),
        },
      ],
      isError: true,
    });
  delete args.customerConfirmed;
  if (requestedName === "price_order") {
    const placeholder = /^(?:customer|caller|guest|unknown|test|n\/?a)$/i;
    const customerId = String(
      args.customerId || call.order_customer_id || call.call_customer_id || "",
    ).trim();
    const firstName = String(
      args.firstName || call.first_name_snapshot || "",
    ).trim();
    const lastName = String(args.lastName || call.last_name_snapshot || "").trim();
    if (
      !customerId &&
      (!firstName ||
        !lastName ||
        placeholder.test(firstName) ||
        placeholder.test(lastName))
    )
      return reply(rpc.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "FOLLOW_UP_REQUIRED",
                message: "What's the first and last name for the order?",
                retryable: true,
              },
            }),
          },
        ],
        isError: true,
      });
  }
  // Answers already given for an item that is still waiting on another question (applyPendingModifierAnswer).
  let carried: { items: Array<{ name: string; modifiers?: unknown[]; quantity?: number; variant?: string }>; questions: string[] } | null = null;
  const started = Date.now(),
    requestId = randomUUID(),
    provider = String(call.selected_provider || "openai"),
    actor = {
      id: `${provider}:${callId}`,
      name:
        provider === "gemini"
          ? "Corner Deli Gemini Phone"
          : "Corner Deli AI Phone",
      type: "employee" as const,
      role: "employee" as const,
    };
  try {
    const resolvedQuestions = new Set<string>(
      Array.isArray(call.deferred_required_fields)
        ? call.deferred_required_fields.map(String)
        : [],
    );
    if (args.coldSubCondimentsDecision)
      resolvedQuestions.add("cold_sub_condiments");
    if (args.coldSubVegetablesDecision)
      resolvedQuestions.add("cold_sub_vegetables");
    if (args.steakStyleCondimentDecision) resolvedQuestions.add("steak_style_condiment");
    if (args.steakStyleToppingsDecision) resolvedQuestions.add("steak_style_toppings");
    if (args.steakStyleCheeseDecision) resolvedQuestions.add("steak_style_cheese");
    if (args.steakStyleDoubleMeatDecision) resolvedQuestions.add("steak_style_double_meat");
    if (requestedName === "price_order")
      await getSql()`UPDATE ordering_call_sessions SET deferred_required_fields=${JSON.stringify([...resolvedQuestions])}::jsonb,updated_at=NOW() WHERE id=${call.id}`;
    const requestedOperation = requestedName === "price_order" ? parseCartOperation(args.operation, args.items) : "read",
      pendingApplied =
        requestedName === "price_order"
          ? await applyPendingModifierAnswer({
              orderId: call.order_id ? String(call.order_id) : null,
              pendingItem: call.pending_item || null,
              customerText: String(args.customerText || ""),
              operation: requestedOperation,
              targetItem: String(args.targetLineId || args.targetItem || ""),
              items: applyFryPlacementSpeech(Array.isArray(args.items) ? (args.items as any) : [],String(args.customerText || "")),
            })
          : null,
      carriedItem = pendingApplied
        ? (carried = { items: pendingApplied.items, questions: pendingApplied.resolvedPendingQuestions || [] })
        : null,
      phoneItems =
      requestedName === "price_order"
        ? await incrementalSpokenCart(
            call.order_id ? String(call.order_id) : null,
            pendingApplied!.operation,
            pendingApplied!.targetItem,
            pendingApplied!.items,
            String(args.customerText || ""),
          )
        : [];
    // Pickup/delivery, once set, only changes when the caller asks (dev test call 2026-11-06 flipped twice on
    // mis-heard speech). A different serviceType without serviceChangeRequested changes nothing.
    if (requestedName === "price_order" && call.order_id) {
      const order = (
        await getSql()`SELECT orders.service_type,(SELECT count(*) FROM ordering_order_items item WHERE item.order_id=orders.id)::int lines FROM ordering_orders orders WHERE orders.id=${String(call.order_id)}`
      )[0];
      // Before anything is ordered the caller is still answering "pickup or delivery?": a correction there is
      // always taken (a mis-heard opening must never lock the wrong type in).
      const current = Number(order?.lines || 0) > 0 ? String(order?.service_type || "") : "";
      const wanted = String(args.serviceType || "");
      if (["pickup", "delivery"].includes(current) && wanted === "undecided") args.serviceType = current;
      else if (["pickup", "delivery"].includes(current) && ["pickup", "delivery"].includes(wanted) && wanted !== current && args.serviceChangeRequested !== true)
        return reply(rpc.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "SERVICE_ALREADY_SET",
                  message: `This order is already ${current}. Nothing changed.`,
                  remedy: `Keep it ${current} and don't ask again. Only if the caller clearly asked to switch to ${wanted}, send the same change again with serviceChangeRequested true.`,
                },
              }),
            },
          ],
          isError: true,
        });
    }
    delete args.serviceChangeRequested;
    const priceCart = (items: typeof phoneItems) =>
      priceSpokenOrder({
            business: "Corner Deli",
            actor,
            service: serviceType(args.serviceType),
            items,
            orderId: call.order_id || null,
            callerPhone: String(args.callerPhone || call.caller_phone || ""),
            customerId:
              String(
                args.customerId ||
                  call.order_customer_id ||
                  call.call_customer_id ||
                  "",
              ) || undefined,
            firstName: String(
              args.firstName || call.first_name_snapshot || "",
            ),
            lastName: String(
              args.lastName || call.last_name_snapshot || "",
            ),
            resolvedPendingQuestions: [
              ...resolvedQuestions,
              ...(pendingApplied?.resolvedPendingQuestions || []),
            ],
            customerText: String(args.customerText || ""),
          });
    // Several new items where one still needs an answer: the others go in now and the question is asked (dev call
    // 2026-11-07 20:16: 30 wings rode along with a Hamburger Steak still waiting on mashed size, so they never went on).
    let partialFollowUp: { error: AiToolError; held: { name: string; modifiers?: unknown[]; quantity?: number; variant?: string } } | null = null;
    const pricePhoneOrder = () =>
      priceCart(phoneItems).catch(async (error: unknown) => {
        const added = pendingApplied?.operation === "add" ? pendingApplied.items : [];
        const pendingRequest = sameName(String((error instanceof AiToolError && (error.details.pendingItem as { customerRequest?: string } | undefined)?.customerRequest) || ""));
        if (!(error instanceof AiToolError) || error.code !== "FOLLOW_UP_REQUIRED" || added.length < 2 || !pendingRequest) throw error;
        const held = added.filter((item) => sameName(String(item.name)) === pendingRequest);
        const rest = added.filter((item) => sameName(String(item.name)) !== pendingRequest);
        if (held.length !== 1 || !rest.length) throw error;
        const priced = await priceCart(await incrementalSpokenCart(call.order_id ? String(call.order_id) : null, "add", "", rest, String(args.customerText || "")));
        partialFollowUp = { error, held: held[0] as { name: string; modifiers?: unknown[]; quantity?: number; variant?: string } };
        return priced;
      });
    const result =
      requestedName === "price_order"
        ? await pricePhoneOrder()
        : await executeAiOrderingTool(name, args, "Corner Deli", actor).then((value) =>
            // The full menu payload was ~54 KB per search: costly on every later turn, and once rejected by
            // Gemini (1007) in a replay. The phone model only needs names, sizes, prices and options.
            requestedName === "menu_search" && value && typeof value === "object" && Array.isArray((value as Record<string, any>).categories)
              ? { query: (value as Record<string, any>).query, results: compactPhoneMenuResult((value as Record<string, any>).categories) }
              : value,
          );
    const orderId = String(
      args.orderId ||
        (result && typeof result === "object"
          ? (result as Record<string, unknown>).id
          : "") ||
        "",
    );
    // A confirmed saved address (customerAddressId) counts even when the model leaves out the street text;
    // without it the card line refuses delivery orders ("Delivery address is required"), dev call 2026-10-25.
    const boundCustomerId = String(call.order_customer_id || call.call_customer_id || "");
    const savedAddress =
      requestedName === "price_order" && args.serviceType === "delivery" && args.customerAddressId && boundCustomerId
        ? (
            await getSql()`SELECT id,line1,line2,city,state,postal_code FROM ordering_customer_addresses WHERE id=${String(args.customerAddressId)} AND customer_id=${boundCustomerId} AND active=TRUE`
          )[0]
        : undefined;
    const spokenAddress =
      String(args.deliveryAddress || "").trim() ||
      (savedAddress
        ? [savedAddress.line1, savedAddress.city, [savedAddress.state, savedAddress.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")
        : "");
    if (
      requestedName === "price_order" &&
      args.serviceType === "delivery" &&
      spokenAddress &&
      orderId
    ) {
      // An address Google can't place is a question for the caller, not an internal error that hands them off
      // (dev replay 2026-10-25: "Claxton-Hepburn Medical Center").
      const delivery = await attachSpokenDeliveryAddress(
        orderId,
        spokenAddress,
        String(args.deliveryUnit || savedAddress?.line2 || ""),
        savedAddress ? String(savedAddress.id) : null,
      ).catch((error: unknown) => {
        throw new AiToolError(
          "INVALID_INPUT",
          "I couldn't verify that delivery address.",
          "Ask the caller to repeat the street number and street. For an address outside Ogdensburg, also ask for city, state, and ZIP.",
          409,
          { field: "deliveryAddress", reason: error instanceof Error ? error.message : "address_validation_failed" },
        );
      });
      const updated = (
        await getSql()`SELECT total_cents,amount_due_cents,delivery_fee_cents FROM ordering_orders WHERE id=${orderId}`
      )[0];
      Object.assign(result as Record<string, unknown>, {
        delivery,
        total_cents: Number(updated.total_cents),
        amount_due_cents: Number(updated.amount_due_cents),
        delivery_fee_cents: Number(updated.delivery_fee_cents),
      });
    }
    // The model must see each line's id and modifiers (flavor, dressing, No Tomato) to read the cart back
    // and to target a correction at the right line.
    if (
      orderId &&
      ["price_order", "get_draft"].includes(requestedName) &&
      Array.isArray((result as Record<string, any>)?.lines) &&
      (result as Record<string, any>).lines.every((line: Record<string, unknown>) => line.id)
    ) {
      const compact = await compactPhoneOrderResult({ ...(result as Record<string, any>), id: orderId }, "read");
      (result as Record<string, any>).lines = (result as Record<string, any>).lines.map(
        (line: Record<string, any>, index: number) => ({
          ...line,
          say: compact.lines[index]?.say,
          lineId: compact.lines[index]?.lineId,
          modifiers: compact.lines[index]?.modifiers || [],
        }),
      );
      if (compact.wingReadback) (result as Record<string, any>).wingReadback = compact.wingReadback;
    }
    if (partialFollowUp && result && typeof result === "object") {
      const { error, held } = partialFollowUp as { error: AiToolError; held: { name: string; modifiers?: unknown[]; quantity?: number; variant?: string } };
      Object.assign(result as Record<string, any>, {
        required_follow_up: error.message,
        pending_item: {
          ...(error.details.pendingItem as Record<string, unknown>),
          question: error.message,
          ...(held.modifiers?.length ? { collectedModifiers: held.modifiers } : {}),
          collectedQuantity: Number(held.quantity || 1),
          collectedVariant: String(held.variant || ""),
        },
        held_back: `${held.name} isn't on the order yet; everything else was added.`,
      });
    }
    // A pizza added with nothing on it is asked about (dev call 2026-11-07 18:34: "two jumbo pizzas" went in plain and
    // nobody asked), unless the caller said cheese or plain, or named a topping (the order checker handles a missed one).
    if (requestedName === "price_order" && String(args.operation || "") === "add" && result && typeof result === "object" && !(result as Record<string, any>).required_follow_up) {
      const bare = (Array.isArray(args.items) ? (args.items as Array<Record<string, any>>) : []).filter(
        (item) => /^(?:sheet\s+)?pizza$/i.test(String(item?.name || "").trim()) && !(Array.isArray(item.modifiers) && item.modifiers.length),
      );
      const said = ` ${spokenKey(String(args.customerText || ""))} `;
      if (bare.length && !/ (?:cheese|plain|nothing|just sauce) /.test(said)) {
        const pizza = (await menuCatalog("Corner Deli", new Date(), "Pizza")).flatMap((category) => category.items || []).find((item: any) => /^pizza$/i.test(item.name));
        const toppings = (pizza?.modifiers || []).find((group: any) => group.name === "Pizza Toppings")?.options || [];
        const namedTopping = toppings.some((option: any) => {
          const key = spokenKey(String(option.name));
          return key.length > 2 && said.includes(` ${key} `);
        });
        if (!namedTopping)
          (result as Record<string, any>).required_follow_up = bare.some((item) => Number(item.quantity || 1) > 1)
            ? "What would you like on them? If they're different, tell me each one."
            : "What would you like on it, or just cheese?";
      }
    }
    // The delivery address rides on every cart result, so Gemini can drop old call audio (a shorter context
    // window, 2026-11-07) without asking for the address again.
    if (orderId && ["price_order", "get_draft"].includes(requestedName) && result && typeof result === "object" && (result as Record<string, any>).service_type === "delivery") {
      const address = (await getSql()`SELECT line1,line2 FROM ordering_order_delivery_addresses WHERE order_id=${orderId}`)[0];
      if (address) (result as Record<string, any>).deliveryTo = [address.line1, address.line2].filter(Boolean).join(", ");
    }
    // An open question about an item not in the cart yet stays open through a read or an add of other items (dev call
    // 2026-11-07 20:17: a read after "What sauce?" cleared it and the wings were never added).
    const openPending = call.pending_item && typeof call.pending_item === "object" ? (call.pending_item as Record<string, any>) : null;
    const pendingName = sameName(String(openPending?.customerRequest || ""));
    const keepPending =
      requestedName === "price_order" &&
      Boolean(openPending?.actualMenuItemId && pendingName) &&
      !(pendingApplied?.items || []).some((item) => sameName(String(item.name)) === pendingName || sameName(String(item.name)) === sameName(String(openPending?.category || "")));
    const nextPending = (result as Record<string, any>).pending_item || (keepPending ? openPending : null);
    if (keepPending && !(result as Record<string, any>).pending_item && !(result as Record<string, any>).required_follow_up && openPending?.question)
      (result as Record<string, any>).still_open = `${openPending.customerRequest} isn't on the order yet: ask “${openPending.question}”`;
    if (orderId) {
      resolvedQuestions.delete("cold_sub_condiments");
      resolvedQuestions.delete("cold_sub_vegetables");
      await getSql()`UPDATE ordering_call_sessions SET order_id=${orderId},pending_item=${nextPending ? JSON.stringify(nextPending) : null}::jsonb,deferred_required_fields=${JSON.stringify([...resolvedQuestions])}::jsonb,updated_at=NOW() WHERE id=${call.id}`;
    }
    await auditAiTool({
      business: "Corner Deli",
      requestId,
      conversationId: callId,
      tool: requestedName,
      actor,
      orderId: orderId || undefined,
      customerId: args.customerId ? String(args.customerId) : undefined,
      outcome: "success",
      inputSummary: { customerItems: args.items || [], operation: args.operation || "", targetLineId: args.targetLineId || args.targetItem || "", source: "realtime_mcp" },
      resultSummary: {
        orderId,
        itemIds:
          result && typeof result === "object"
            ? (result as Record<string, any>).lines?.map(
                (line: Record<string, unknown>) => line.item_id,
              ) || []
            : [],
      },
      durationMs: Date.now() - started,
      model: String(call.selected_model || OPENAI_PHONE_MODEL),
    });
    return reply(rpc.id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
    });
  } catch (error) {
    if (!(error instanceof AiToolError))
      console.error("AI ordering MCP tool failed unexpectedly.", {
        callId,
        tool: requestedName,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    const known =
      error instanceof AiToolError
        ? error
        : new AiToolError(
            "INTERNAL_ERROR",
            "The ordering tool could not complete safely.",
            "Retry once, then hand off to an employee.",
            500,
          );
    // The voice model often re-sends the item bare with just the answer, so what it already said about this item
    // (toppings, earlier answers) is kept on the pending question.
    const sameItem = carried?.items.filter(
      (item) => sameName(item.name) === sameName(String((known.details.pendingItem as { customerRequest?: string } | undefined)?.customerRequest || "")),
    );
    const collected = sameItem?.length === 1 ? sameItem[0].modifiers || [] : [];
    const pendingItem = known.details.pendingItem
      ? {
          ...known.details.pendingItem,
          question: known.message,
          ...(collected.length ? { collectedModifiers: collected } : {}),
          ...(sameItem?.length === 1 ? { collectedQuantity: Number((sameItem[0] as { quantity?: number }).quantity || 1), collectedVariant: String((sameItem[0] as { variant?: string }).variant || "") } : {}),
          ...(sameItem?.length === 1 && carried?.questions.length ? { resolvedQuestions: carried.questions } : {}),
        }
      : null;
    if (requestedName === "price_order" && pendingItem)
      await getSql()`UPDATE ordering_call_sessions SET pending_item=${JSON.stringify(pendingItem)}::jsonb,updated_at=NOW() WHERE id=${call.id}`;
    await auditAiTool({
      business: "Corner Deli",
      requestId,
      conversationId: callId,
      tool: requestedName,
      actor,
      orderId: args.orderId ? String(args.orderId) : undefined,
      outcome: known.status >= 500 ? "error" : "blocked",
      errorCode: known.code,
      inputSummary: { customerItems: args.items || [], operation: args.operation || "", targetLineId: args.targetLineId || args.targetItem || "", source: "realtime_mcp" },
      resultSummary: { message: known.message, details: known.details },
      durationMs: Date.now() - started,
      model: String(call.selected_model || OPENAI_PHONE_MODEL),
    });
    if (known.code === "FOLLOW_UP_REQUIRED")
      return reply(rpc.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              pending: true,
              code: "FOLLOW_UP_REQUIRED",
              requiredFollowUp: known.message,
              details: known.details,
            }),
          },
        ],
      });
    return reply(rpc.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: known.code,
              message: known.message,
              remedy: known.remedy,
              details: known.details,
            },
          }),
        },
      ],
      isError: true,
    });
  }
}
