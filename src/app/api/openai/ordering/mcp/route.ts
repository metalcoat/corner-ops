import { randomUUID } from "node:crypto";
import {
  AI_ORDERING_TOOL_NAMES,
  executeAiOrderingTool,
  type AiOrderingToolName,
} from "@/app/api/ordering/ai/tools/route";
import { getSql } from "@/lib/db";
import {
  AiToolError,
  auditAiTool,
  priceSpokenOrder,
  serviceType,
} from "@/lib/ordering-ai-tools";
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
    required: ["callId", "query"],
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
  customer_lookup: "Find ordering-safe customer matches by name or phone.",
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
      "PRIMARY phone-order tool. Incrementally update the server-priced cart. Send only changed items; replace_order is only for an intentional full reset.",
    inputSchema: {
      type: "object",
      properties: {
        ...properties,
        operation: {
          type: "string",
          enum: ["add", "replace_item", "remove_item", "replace_order", "read"],
        },
        targetItem: { type: "string" },
        serviceType: {
          type: "string",
          enum: ["undecided", "pickup", "delivery"],
        },
        deliveryAddress: {
          type: "string",
          description: "Street address or recognized local landmark.",
        },
        deliveryUnit: { type: "string" },
        items: { type: "array", items: spokenItemSchema },
        customerText: {
          type: "string",
          description:
            "The customer's exact latest words. Required when answering a pending size or yes/no modifier question.",
        },
        callerPhone: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
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
const reply = (id: Rpc["id"], result: unknown) =>
  Response.json({ jsonrpc: "2.0", id, result });
const failure = (
  id: Rpc["id"],
  code: number,
  message: string,
  data?: unknown,
) => Response.json({ jsonrpc: "2.0", id, error: { code, message, data } });

export async function POST(request: Request) {
  if (!mcpAuthorized(request))
    return Response.json({ error: "Unauthorized." }, { status: 401 });
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
  const requestedName = String(rpc.params?.name || ""),
    name = requestedName as AiOrderingToolName,
    args = {
      ...((rpc.params?.arguments && typeof rpc.params.arguments === "object"
        ? rpc.params.arguments
        : {}) as Record<string, unknown>),
    };
  if (
    !AI_ORDERING_TOOL_NAMES.includes(name) &&
    requestedName !== "request_human_handoff" &&
    requestedName !== "price_order"
  )
    return failure(rpc.id, -32602, "Unknown ordering tool.");
  const callId = String(args.callId || "");
  delete args.callId;
  await ensureOrderingAiSchema();
  const call = (
    await getSql()`SELECT id,state,order_id,caller_phone,pending_item,operating_mode,selected_provider,selected_model FROM ordering_call_sessions WHERE business='Corner Deli' AND three_cx_call_id=${callId} AND state IN('ai','handoff_pending') LIMIT 1`
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
  delete args.customerConfirmed;
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
    const requestedOperation = ([
        "add",
        "replace_item",
        "remove_item",
        "replace_order",
        "read",
      ].includes(String(args.operation))
        ? String(args.operation)
        : "replace_order") as
        | "add"
        | "replace_item"
        | "remove_item"
        | "replace_order"
        | "read",
      pendingApplied =
        requestedName === "price_order"
          ? await applyPendingModifierAnswer({
              orderId: call.order_id ? String(call.order_id) : null,
              pendingItem: call.pending_item || null,
              customerText: String(args.customerText || ""),
              operation: requestedOperation,
              targetItem: String(args.targetItem || ""),
              items: Array.isArray(args.items) ? (args.items as any) : [],
            })
          : null,
      phoneItems =
      requestedName === "price_order"
        ? await incrementalSpokenCart(
            call.order_id ? String(call.order_id) : null,
            pendingApplied!.operation,
            pendingApplied!.targetItem,
            pendingApplied!.items,
          )
        : [];
    const result =
      requestedName === "price_order"
        ? await priceSpokenOrder({
            business: "Corner Deli",
            actor,
            service: serviceType(args.serviceType),
            items: phoneItems,
            orderId: call.order_id || null,
            callerPhone: String(args.callerPhone || call.caller_phone || ""),
            firstName: String(args.firstName || ""),
            lastName: String(args.lastName || ""),
            resolvedPendingQuestions:
              pendingApplied?.resolvedPendingQuestions,
          })
        : await executeAiOrderingTool(name, args, "Corner Deli", actor);
    const orderId = String(
      args.orderId ||
        (result && typeof result === "object"
          ? (result as Record<string, unknown>).id
          : "") ||
        "",
    );
    if (
      requestedName === "price_order" &&
      args.serviceType === "delivery" &&
      String(args.deliveryAddress || "").trim() &&
      orderId
    ) {
      const delivery = await attachSpokenDeliveryAddress(
        orderId,
        String(args.deliveryAddress),
        String(args.deliveryUnit || ""),
      );
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
    if (orderId)
      await getSql()`UPDATE ordering_call_sessions SET order_id=${orderId},pending_item=${(result as Record<string, any>).pending_item ? JSON.stringify((result as Record<string, any>).pending_item) : null}::jsonb,updated_at=NOW() WHERE id=${call.id}`;
    await auditAiTool({
      business: "Corner Deli",
      requestId,
      conversationId: callId,
      tool: requestedName,
      actor,
      orderId: orderId || undefined,
      customerId: args.customerId ? String(args.customerId) : undefined,
      outcome: "success",
      inputSummary: { customerItems: args.items || [], source: "realtime_mcp" },
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
    const known =
      error instanceof AiToolError
        ? error
        : new AiToolError(
            "INTERNAL_ERROR",
            "The ordering tool could not complete safely.",
            "Retry once, then hand off to an employee.",
            500,
          );
    const pendingItem = known.details.pendingItem || null;
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
      inputSummary: { customerItems: args.items || [], source: "realtime_mcp" },
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
