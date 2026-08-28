import { randomUUID, timingSafeEqual } from "node:crypto";
import OpenAI from "openai";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import { getSql } from "@/lib/db";
import {
  HUMAN_HANDOFF_POLICY,
  MENU_SHORTHAND,
  ORDERING_POLICY,
  PHONE_BEHAVIOR,
} from "@/lib/openai-phone-prompt";

export const OPENAI_PHONE_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-1.5";
export const OPENAI_PHONE_FAST_MODEL =
  process.env.OPENAI_PHONE_FAST_MODEL || "gpt-realtime-2.1-mini";
export const OPENAI_PHONE_FAST_MODEL_PERCENT = Math.max(
  0,
  Math.min(100, Number(process.env.OPENAI_PHONE_FAST_MODEL_PERCENT || "100")),
);
export function modelForCall(callId: string) {
  let bucket = 0;
  for (const char of callId) bucket = (bucket * 31 + char.charCodeAt(0)) % 100;
  return bucket < OPENAI_PHONE_FAST_MODEL_PERCENT
    ? OPENAI_PHONE_FAST_MODEL
    : OPENAI_PHONE_MODEL;
}
export const OPENAI_PHONE_GREETING =
  "Thanks for calling Corner Deli, is this going to be pickup or delivery?";
export const OPENAI_PRICE_ORDER_TOOL = {
  type: "function" as const,
  name: "price_order",
  description:
    "Strictly validate every requested product, size, and modifier against the current Corner Deli catalog, then atomically price the complete order. Never rename a request to a similar item. A failed call means nothing was added.",
  parameters: {
    type: "object",
    properties: {
      serviceType: { type: "string", enum: ["pickup", "delivery"] },
      deliveryAddress: {
        type: "string",
        description:
          "Customer's street address or recognized local landmark for delivery.",
      },
      deliveryUnit: {
        type: "string",
        description: "Department, entrance, room, lane, or meeting point.",
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Customer's actual requested menu name or confirmed exact alias; never an inferred substitute.",
            },
            variant: { type: "string" },
            quantity: { type: "integer", minimum: 1 },
            modifiers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
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
        },
      },
      callerPhone: {
        type: "string",
        description:
          "Customer callback phone collected only when caller ID is unavailable.",
      },
      firstName: { type: "string" },
      lastName: { type: "string" },
      paymentMethod: {
        type: "string",
        enum: ["cash", "card"],
        description: "Customer's confirmed payment choice, collected only after the final order readback is confirmed.",
      },
      tipCents: {
        type: "integer",
        minimum: 0,
        maximum: 100000,
        description: "Confirmed driver tip in cents. Use 0 when a delivery card customer declines. Never add a driver tip to cash or pickup orders.",
      },
    },
    required: ["serviceType", "items"],
    additionalProperties: false,
  },
};
export const OPENAI_MENU_SEARCH_TOOL = {
  type: "function" as const,
  name: "menu_search",
  description:
    "Immediately retrieve current Corner Deli item descriptions, aliases, sizes, and modifiers. Use for what-is-it and what-comes-on-it questions; never answer those from memory.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Customer's exact menu wording." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};
export const OPENAI_HUMAN_HANDOFF_TOOL = {
  type: "function" as const,
  name: "request_human_handoff",
  description: "Transfer the active call to the configured Corner Deli staff destination while preserving and displaying the current order draft.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Concise operational reason staff assistance is needed." },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};
const required = () => ({
  apiKey: Boolean(process.env.OPENAI_API_KEY),
  webhookSecret: Boolean(process.env.OPENAI_WEBHOOK_SECRET),
  mcpUrl: Boolean(process.env.OPENAI_ORDERING_MCP_URL),
  mcpToken: Boolean(process.env.OPENAI_ORDERING_MCP_TOKEN),
  testDids: testDids().length > 0,
  handoffTarget: Boolean(process.env.OPENAI_PHONE_HANDOFF_TARGET),
});
const digits = (value: string) =>
  value
    .replace(/\D/g, "")
    .replace(/^1(?=\d{10}$)/, "")
    .slice(-10);
export function testDids() {
  return (process.env.OPENAI_PHONE_TEST_DIDS || "")
    .split(",")
    .map(digits)
    .filter((value) => value.length === 10);
}
export function calledDidFromSipHeaders(
  headers: Array<{ name: string; value: string }>,
) {
  for (const name of [
    "x-corner-ops-did",
    "x-original-to",
    "p-called-party-id",
    "diversion",
    "to",
    "request-uri",
  ]) {
    const value =
        headers.find((row) => row.name.toLowerCase() === name)?.value || "",
      match = value.match(/(?:\+?1)?(\d{10})(?:\D|$)/);
    if (match) return match[1];
  }
  return "";
}
export function testDidAllowed(did: string) {
  return Boolean(did) && testDids().includes(digits(did));
}
export function lineForDid(did: string) {
  const normalized = digits(did),
    entries = (process.env.OPENAI_PHONE_DID_LINES || "").split(",");
  for (const entry of entries) {
    const [number, label] = entry.split("=");
    if (digits(number || "") === normalized) return String(label || "").trim();
  }
  return "TEST";
}
export function openAiPhoneReadiness() {
  const configured = required();
  return {
    enabled: process.env.OPENAI_PHONE_ORDERING_ENABLED === "true",
    testMode: true,
    configured,
    ready:
      Object.values(configured).every(Boolean) &&
      process.env.OPENAI_PHONE_ORDERING_ENABLED === "true",
    model: OPENAI_PHONE_MODEL,
    testDidsConfigured: testDids().length,
  };
}
export function openAiClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "missing",
    webhookSecret: process.env.OPENAI_WEBHOOK_SECRET,
  });
}
export function mcpAuthorized(request: Request) {
  const expected = process.env.OPENAI_ORDERING_MCP_TOKEN || "",
    supplied = (request.headers.get("authorization") || "").replace(
      /^Bearer\s+/i,
      "",
    );
  const a = Buffer.from(expected),
    b = Buffer.from(supplied);
  return Boolean(expected) && a.length === b.length && timingSafeEqual(a, b);
}
export function callerFromSipHeaders(
  headers: Array<{ name: string; value: string }>,
) {
  const preferred = [
    "x-corner-ops-caller",
    "p-asserted-identity",
    "remote-party-id",
    "from",
  ];
  for (const name of preferred) {
    const value =
        headers.find((row) => row.name.toLowerCase() === name)?.value || "",
      normalized = digits(value);
    if (normalized.length === 10) return normalized;
  }
  return "";
}
export async function registerOpenAiCall(
  callId: string,
  callerPhone: string,
  calledDid = "",
  lineLabel = "TEST",
  selectedModel = "",
  operatingMode: "shadow" | "assisted" | "autonomous" = "shadow",
) {
  await ensureOrderingAiSchema();
  const id = randomUUID();
  await getSql()`INSERT INTO ordering_call_sessions(id,business,three_cx_call_id,caller_phone,called_did,line_label,selected_model,operating_mode,state,owner_type,owner_id)VALUES(${id},'Corner Deli',${callId},${callerPhone},${calledDid},${lineLabel},${selectedModel},${operatingMode},'ai','ai',${`openai:${callId}`})ON CONFLICT(three_cx_call_id)DO UPDATE SET caller_phone=EXCLUDED.caller_phone,called_did=EXCLUDED.called_did,line_label=EXCLUDED.line_label,selected_model=EXCLUDED.selected_model,operating_mode=EXCLUDED.operating_mode,state='ai',owner_type='ai',owner_id=EXCLUDED.owner_id,updated_at=NOW()`;
  return id;
}
export async function requestOpenAiHandoff(callId: string, reason: string) {
  await ensureOrderingAiSchema();
  const target = process.env.OPENAI_PHONE_HANDOFF_TARGET || "";
  if (!target) throw new Error("Human handoff target is not configured.");
  const updated =
    await getSql()`UPDATE ordering_call_sessions SET state='handoff_pending',handoff_reason=${reason.slice(0, 500)},owner_type='none',owner_id='',updated_at=NOW() WHERE business='Corner Deli' AND three_cx_call_id=${callId} AND state='ai' RETURNING id`;
  if (!updated[0])
    throw new Error("The active AI call could not be handed off.");
  try {
    await openAiClient().realtime.calls.refer(callId, { target_uri: target });
  } catch (error) {
    await getSql()`UPDATE ordering_call_sessions SET state='ai',handoff_reason='',owner_type='ai',owner_id=${`openai:${callId}`},updated_at=NOW() WHERE three_cx_call_id=${callId}`;
    throw error;
  }
  return { handoff: true, target: "configured_3cx_destination" };
}
export const PHONE_INSTRUCTIONS = [
  PHONE_BEHAVIOR,
  ORDERING_POLICY,
  MENU_SHORTHAND,
  HUMAN_HANDOFF_POLICY,
].join("\n\n");
