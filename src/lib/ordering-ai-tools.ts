import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import type { OrderingBusiness, ServiceType } from "@/lib/ordering-core";
import type { VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import { createTimedDraftOrder } from "@/lib/ordering-timed-orders";
import { orderingMenuWithVariants } from "@/lib/ordering-menu-variants";
import { consolidateQuantities } from "@/lib/cart-line-consolidation";
import { PIZZA_TOPPING_COOK_WARNING } from "@/lib/ordering-pizza-toppings";
import { applyScheduledMenuAvailability } from "@/lib/ordering-menu-availability";
import {
  resolveOrderingAvailability,
  listFutureOrderingSlots,
} from "@/lib/ordering-availability";
import {
  getDeliveryPricingSettings,
  quoteDelivery,
} from "@/lib/ordering-delivery";
import { findCustomers } from "@/lib/ordering-customers";
import { ensureOrderingPromotionSchema } from "@/lib/ordering-promotion-schema";
import {
  submitDraftOrder,
  OrderConflictError,
} from "@/lib/ordering-order-lifecycle";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import { setCheckoutTip } from "@/lib/ordering-payments";

export type AiToolErrorCode =
  | "FOLLOW_UP_REQUIRED"
  | "INVALID_INPUT"
  | "ITEM_NOT_ON_MENU"
  | "INVALID_MODIFIER"
  | "INVALID_VARIANT"
  | "CATALOG_UNAVAILABLE"
  | "FULFILLMENT_REQUIRED"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "VALIDATION_REQUIRED"
  | "NOT_AUTHORIZED"
  | "NOT_AVAILABLE"
  | "SEND_BLOCKED"
  | "INTERNAL_ERROR";
export class AiToolError extends Error {
  constructor(
    public code: AiToolErrorCode,
    message: string,
    public remedy: string,
    public status = 409,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type AiItemInput = VariantConfiguredOrderItemInput & {
  quantity: number;
};
export type SpokenOrderItem = {
  name: string;
  variant?: string;
  quantity?: number;
  modifiers?: Array<{
    name: string;
    portion?: "whole" | "left_half" | "right_half";
    amount?: "regular" | "extra" | "double_extra" | "triple_extra";
  }>;
};
const services: ServiceType[] = [
  "undecided",
  "pickup",
  "delivery",
  "no_contact_delivery",
  "dine_in",
  "curbside",
  "bar",
];
export function serviceType(value: unknown): ServiceType {
  if (services.includes(value as ServiceType)) return value as ServiceType;
  throw new AiToolError(
    "INVALID_INPUT",
    "The service type is not supported.",
    "Use one of the serviceTypes returned by describe_capabilities.",
    400,
  );
}
export function requestedDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime()))
    throw new AiToolError(
      "INVALID_INPUT",
      "The scheduled fulfillment time is invalid.",
      "Choose an ISO timestamp returned by future_slots.",
      400,
    );
  return date;
}
export function itemInputs(value: unknown): AiItemInput[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new AiToolError(
      "INVALID_INPUT",
      "Items must be an array of at most 50 entries.",
      "Use stable menu IDs from menu_search or menu_browse.",
      400,
    );
  return value.map((raw) => {
    if (!raw || typeof raw !== "object")
      throw new AiToolError(
        "INVALID_INPUT",
        "An order item is invalid.",
        "Send structured item IDs and selections from the menu response.",
        400,
      );
    const row = raw as Record<string, unknown>;
    return {
      itemId: String(row.itemId || ""),
      variantId: row.variantId ? String(row.variantId) : null,
      quantity: Math.trunc(Number(row.quantity || 1)),
      modifierSelections: objectOfStringArrays(row.modifierSelections),
      modifierQuantities: objectOfNumbers(row.modifierQuantities),
      modifierAmounts: (row.modifierAmounts &&
      typeof row.modifierAmounts === "object"
        ? row.modifierAmounts
        : {}) as Record<string, "light" | "normal" | "heavy">,
      modifierDeclines: Array.isArray(row.modifierDeclines)
        ? row.modifierDeclines.map(String)
        : [],
      pizzaToppings: Array.isArray(row.pizzaToppings)
        ? (row.pizzaToppings as AiItemInput["pizzaToppings"])
        : [],
      comboId: row.comboId ? String(row.comboId) : null,
      comboSelections: objectOfStringArrays(row.comboSelections),
      specialInstructions: String(row.specialInstructions || "").slice(0, 500),
    };
  });
}
function objectOfStringArrays(value: unknown) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      Array.isArray(v) ? v.map(String) : [],
    ]),
  );
}
function objectOfNumbers(value: unknown) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, Number(v)]),
  );
}

export async function menuCatalog(
  business: OrderingBusiness,
  at: Date,
  query = "",
) {
  const categories = await applyScheduledMenuAvailability(
    business,
    at,
    (await orderingMenuWithVariants(business, "pos")) as unknown as Array<
      Record<string, any>
    >,
  );
  const q = query.trim().toLocaleLowerCase(),
    tokens = q.match(/[a-z0-9]+/g) || [];
  if (!q)
    return categories.map((category: any) => ({
      id: category.id,
      name: category.displayName,
      items: category.items.map((item: any) => ({
        id: item.id,
        name: item.name,
        description: item.description || "",
        available: Boolean(item.available),
        basePriceCents: Number(item.basePriceCents),
        variants: item.variants,
        modifiers: item.modifiers,
        combos: item.combos,
      })),
    }));
  const ranked = categories
    .flatMap((category: any) =>
      category.items
        .map((item: any) => {
          const name = String(item.name || "").toLocaleLowerCase(),
            haystack = JSON.stringify(item).toLocaleLowerCase();
          if (
            tokens.length &&
            !tokens.every((token) => haystack.includes(token))
          )
            return null;
          const score =
            (name === q ? 1000 : q.includes(name) ? 500 : 0) +
            Math.max(0, 100 - name.length);
          return {
            categoryId: category.id,
            categoryName: category.displayName,
            score,
            item,
          };
        })
        .filter(Boolean),
    )
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 5);
  const grouped = new Map<string, { id: string; name: string; items: any[] }>();
  for (const match of ranked as any[]) {
    const category: { id: string; name: string; items: any[] } = grouped.get(
      match.categoryId,
    ) || { id: match.categoryId, name: match.categoryName, items: [] };
    category.items.push({
      id: match.item.id,
      name: match.item.name,
      description: match.item.description || "",
      available: Boolean(match.item.available),
      basePriceCents: Number(match.item.basePriceCents),
      variants: match.item.variants,
      modifiers: match.item.modifiers,
      combos: match.item.combos,
    });
    grouped.set(match.categoryId, category);
  }
  return [...grouped.values()];
}

export async function availabilityBundle(
  business: OrderingBusiness,
  service: ServiceType,
  at = new Date(),
) {
  const [availability, delivery] = await Promise.all([
    resolveOrderingAvailability({ business, serviceType: service, at }),
    getDeliveryPricingSettings(business),
  ]);
  return {
    serverTime: new Date().toISOString(),
    availability,
    deliveryPolicy: {
      enabled: delivery.enabled,
      minimumOrderCents: delivery.minimumOrderCents,
      maxDistanceMiles: delivery.maxDistanceMiles,
      feeBands: delivery.feeBands,
    },
  };
}

export async function futureSlots(
  business: OrderingBusiness,
  service: ServiceType,
  date: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new AiToolError(
      "INVALID_INPUT",
      "A valid business date is required.",
      "Use YYYY-MM-DD.",
      400,
    );
  return (
    await listFutureOrderingSlots({
      business,
      serviceType: service,
      businessDate: date,
    })
  ).map((value) => value.toISOString());
}

async function pricedOrder(orderId: string, business: OrderingBusiness) {
  const sql = getSql();
  const rows =
    await sql`SELECT id,business,display_number,status,payment_status,payment_preference,service_type,timing_mode,scheduled_for,version,customer_id,first_name_snapshot,last_name_snapshot,phone_snapshot,subtotal_cents,discount_cents,tax_cents,tip_cents,delivery_fee_cents,total_cents,paid_cents,amount_due_cents,timing_message_snapshot FROM ordering_orders WHERE id=${orderId} AND business=${business}`;
  if (!rows[0])
    throw new AiToolError(
      "NOT_FOUND",
      "The order was not found.",
      "Use the order ID returned by create_draft.",
      404,
    );
  const lines =
    await sql`SELECT id,item_id,item_name_snapshot,variant_id,variant_name_snapshot,quantity,unit_price_cents,modifier_total_cents,combo_total_cents,line_total_cents,special_instructions FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`;
  const promotions =
    await sql`SELECT promotion_id,label_snapshot,discount_cents FROM ordering_order_promotion_applications WHERE order_id=${orderId} ORDER BY application_sequence`;
  const heavyPizzas =
    await sql`SELECT item.item_name_snapshot,COUNT(DISTINCT modifier.option_id)::integer topping_count FROM ordering_order_items item JOIN ordering_order_item_modifiers modifier ON modifier.order_item_id=item.id AND modifier.pizza_topping_portion IS NOT NULL WHERE item.order_id=${orderId} GROUP BY item.id,item.item_name_snapshot HAVING COUNT(DISTINCT modifier.option_id)>6`;
  return {
    ...(rows[0] as Record<string, unknown>),
    lines,
    promotions,
    warnings: heavyPizzas.map(
      (item) => `${item.item_name_snapshot}: ${PIZZA_TOPPING_COOK_WARNING}`,
    ),
    pricingAuthority: "corner_ops_server",
    currency: "USD",
  } as Record<string, any>;
}

export async function setAiPaymentDetails(input: {
  orderId: string;
  business: OrderingBusiness;
  service: ServiceType;
  paymentMethod: "cash" | "card";
  tipCents: number;
  actor: OrderingActor;
}) {
  if (
    !Number.isSafeInteger(input.tipCents) ||
    input.tipCents < 0 ||
    input.tipCents > 100000
  )
    throw new AiToolError(
      "INVALID_INPUT",
      "The tip amount is invalid.",
      "Confirm a non-negative driver tip in cents.",
      400,
    );
  if (
    input.tipCents > 0 &&
    (input.paymentMethod !== "card" || input.service !== "delivery")
  )
    throw new AiToolError(
      "INVALID_INPUT",
      "Driver tips can only be added to delivery orders paid by card.",
      "Use tipCents 0 for pickup or cash orders.",
      400,
    );
  await setCheckoutTip({
    orderId: input.orderId,
    business: input.business,
    tipCents: input.tipCents,
    actor: input.actor,
  });
  const sql = getSql();
  await sql`UPDATE ordering_orders SET payment_preference=${input.paymentMethod},updated_at=NOW() WHERE id=${input.orderId} AND business=${input.business}`;
  await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) SELECT ${randomUUID()},id,version,'payment_preference_updated',${input.actor.type},${input.actor.id},${JSON.stringify({ paymentMethod: input.paymentMethod })}::jsonb FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business}`;
  return pricedOrder(input.orderId, input.business);
}

export async function createAiDraft(input: {
  business: OrderingBusiness;
  actor: OrderingActor;
  service: ServiceType;
  items: AiItemInput[];
  customerId?: string | null;
  callerPhone?: string;
  firstName?: string;
  lastName?: string;
  scheduledFor?: Date | null;
}) {
  await validateAiCatalogIds(input.business, input.items);
  const timing = input.scheduledFor ? "future" : "asap";
  const order = await createTimedDraftOrder({
    business: input.business,
    source: "ai_phone",
    serviceType: input.service,
    customerId: input.customerId || null,
    callerPhone: input.callerPhone || "",
    customerFirstName: input.firstName || "",
    customerLastName: input.lastName || "",
    orderOrigin: "ai",
    createdBy: input.actor.id,
    createdByName: input.actor.name,
    items: input.items,
    timingMode: timing,
    requestedFor: input.scheduledFor || null,
  });
  return pricedOrder(String(order.id), input.business);
}

export const spokenKey = (value: string) =>
  value
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/s\b/g, "");
export const normalizedSpokenName = (value: string) =>
  spokenKey(
    value
      .replace(/\b\d+\s*\/\s*\d+\s*(?:lb|lbs|pounds?)\b/gi, " ")
      .replace(/\(\s*\d+\s*\/\s*\d+\s*(?:lb|lbs|pounds?)\s*\)/gi, " ")
      .replace(/\(\s*(?:on (?:the )?salad|on (?:the )?side)\s*\)/gi, " ")
      .replace(/\b(?:on (?:the )?side|side of)\b/gi, " ")
      .replace(/\b\d+(?:\.\d+)?\s*oz\b/gi, " ")
      .replace(/\bsm\b/gi, " small ")
      .replace(/\blg\b/gi, " large ")
      .replace(/\bsal\b/gi, " salad "),
  );
export const BUSINESS_ITEM_ALIASES: Record<string, string[]> = {
  pizza: ["pie"],
  "cheeseburger 1 4lb": [
    "cheeseburger",
    "quarter pound cheeseburger",
    "quarter pounder cheeseburger",
    "cheeseburger quarter pound",
  ],
  turkey: ["turkey sub", "regular turkey sub"],
  "turkey big bos": [
    "turkey big boss sub",
    "big boss turkey",
    "big boss turkey sub",
  ],
  "hot roast beef": ["hot roast beef sandwich", "hot roast beef sandwhich"],
  "double cheeseburger 1 2lb": [
    "double cheeseburger",
    "half pound double cheeseburger",
  ],
  wing: ["wing", "bone in wing", "bone in wings", "chicken wings"],
  "boneles wing": ["boneless wing", "boneless wings"],
  "2l pepsi": [
    "2 liter pepsi",
    "2 litre pepsi",
    "two liter pepsi",
    "two litre pepsi",
    "2 l pepsi",
  ],
  "2l diet pepsi": [
    "2 liter diet pepsi",
    "2 litre diet pepsi",
    "two liter diet pepsi",
    "two litre diet pepsi",
    "2 l diet pepsi",
  ],
  "large french frie": ["large fry", "large fries", "large regular fries"],
  "small french frie": ["small fry", "small fries"],
  "buffalo chip": ["buffalo chip", "chips"],
  "breaded mushroom": [
    "fried mushroom",
    "fried mushrooms",
    "battered mushroom",
    "battered mushrooms",
  ],
  "breaded cauliflower": ["fried cauliflower", "battered cauliflower"],
  "nacho w cheese": [
    "nachos with cheese",
    "nacho with cheese",
    "cheese nachos",
    "nachos and cheese",
  ],
  "pizza log": ["pizza roll", "pizza rolls", "pizza logs"],
};
const itemAliases = BUSINESS_ITEM_ALIASES;
export function generatedItemAliases(name: string) {
  const canonical = spokenKey(name),
    simple = normalizedSpokenName(name),
    aliases = [name, simple];
  if (simple.startsWith("humpty dumpty ")) {
    const flavor = simple.replace(/^humpty dumpty /, "").trim();
    aliases.push(flavor);
    if (!flavor.endsWith("chip")) aliases.push(`${flavor} chips`);
  }
  if (/cheeseburger/.test(simple))
    aliases.push(
      simple.replace(/\b1 4lb\b|\b1 2lb\b|\b3 4lb\b/g, "").trim(),
      "cheese burger",
    );
  if (simple === "cheeseburger")
    aliases.push("burger with cheese", "regular cheeseburger");
  if (/mozzarella stick/.test(simple))
    aliases.push("mozz sticks", "mozz stick", "cheese sticks", "cheese stick");
  if (/tater tot/.test(simple))
    aliases.push(simple.replace("tater ", ""), "tots", "tater tots");
  if (simple === "wing")
    aliases.push(
      "traditional wings",
      "regular wings",
      "bone in wings",
      "chicken wings",
    );
  if (simple === "boneles wing") aliases.push("boneless", "boneless wings");
  if (simple === "small tossed salad")
    aliases.push("small salad", "side salad");
  if (simple === "medium mashed potato")
    aliases.push("medium mashed", "medium mash");
  if (simple === "small mashed potato")
    aliases.push("small mashed", "small mash");
  return [
    ...new Set(
      [...aliases, ...(itemAliases[canonical] || [])]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}
const editDistance = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prior = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prior + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prior = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
};
const similarity = (a: string, b: string) => {
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a))
    return (
      0.92 -
      (Math.abs(a.length - b.length) / Math.max(a.length, b.length)) * 0.12
    );
  return 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);
};
export const modifierAliases = (name: string, groupName = "") => {
  const withoutPortion = name.replace(
      /\s*\(\s*\d+(?:\.\d+)?\s*oz\s*\)\s*$/i,
      "",
    ),
    withoutPlacement = name.replace(/\s*\(\s*on salad\s*\)\s*$/i, ""),
    aliases = [
      name,
      withoutPortion,
      withoutPlacement,
      name.replace(/\s*\(\s*on (?:burger\/?steak|burger|steak)\s*\)\s*$/i, ""),
      normalizedSpokenName(name),
    ];
  for (const value of [...aliases]) {
    aliases.push(value.replace(/\bparmesan\b/gi, "parm"));
    aliases.push(value.replace(/\bsauce\b/gi, ""));
    if (/^mayo$/i.test(value)) aliases.push("mayonnaise");
    if (/^extra cheese$/i.test(value)) aliases.push("cheese");
  }
  const group = spokenKey(groupName),
    simple = normalizedSpokenName(name),
    negative = /^(?:no|without|remove|hold|skip)\s+(.+)$/i.exec(simple);
  if (negative) {
    const subject = negative[1].trim();
    aliases.push(
      `no ${subject}`,
      `without ${subject}`,
      `remove ${subject}`,
      `hold ${subject}`,
      `skip ${subject}`,
      `leave off ${subject}`,
      `take off ${subject}`,
    );
  }
  if (/dressing/.test(group))
    aliases.push(
      simple.replace(/\bdressing\b/g, "").trim(),
      `${simple.replace(/\bdressing\b/g, "").trim()} dressing`,
    );
  if (/sub mod/.test(group) && /^onions?$/.test(simple))
    aliases.push("raw onion", "raw onions", "onion", "onions");
  if (/hamburger.*steak/.test(group) && /^onions?$/.test(simple))
    aliases.push(
      "cooked onion",
      "cooked onions",
      "grilled onion",
      "grilled onions",
      "cooked onions on burger steak",
    );
  if (/hamburger.*steak/.test(group) && /^peppers?$/.test(simple))
    aliases.push(
      "cooked pepper",
      "cooked peppers",
      "sweet pepper",
      "sweet peppers",
      "green pepper",
      "green peppers",
      "cooked peppers on burger steak",
    );
  if (/hamburger.*steak/.test(group) && /^mushrooms?$/.test(simple))
    aliases.push("cooked mushroom", "cooked mushrooms", "mushrooms on burger steak");
  if (/sauce|fry option|mashed mod/.test(group))
    aliases.push(simple.replace(/\b(?:sauce|cheese|on side)\b/g, "").trim());
  if (/side/.test(group))
    aliases.push(simple.replace(/\b(?:frie|potato|tater tot)\b/g, "").trim());
  if (/crust/.test(group))
    aliases.push(simple.replace(/\bcrust\b/g, "").trim());
  if (/blue cheese/.test(simple)) aliases.push("blue", "bleu", "bleu cheese");
  if (/italian/.test(simple)) aliases.push("italian");
  if (/mashed/.test(simple)) aliases.push("mashed", "mash");
  if (/curly frie/.test(simple)) aliases.push("curly");
  if (/waffle frie/.test(simple)) aliases.push("waffle");
  if (/nacho cheese/.test(simple))
    aliases.push(
      "nacho",
      "nachos",
      "cheese sauce",
      "side nacho",
      "side of nacho",
    );
  if (/^gravy$/.test(simple) && /mashed mod/.test(group))
    aliases.push(
      "gravy on mashed",
      "gravy on the mashed",
      "gravy on mashed potatoes",
      "gravy on the mashed potatoes",
    );
  return [
    ...new Set(aliases.map((value) => value.replace(/\s+/g, " ").trim())),
  ];
};
export function compositeModifierEffects(
  optionNames: string[],
  intent: string,
) {
  const key = spokenKey(intent);
  if (
    !/\b(poutine|poutin|pountine|poutene)\b/.test(key) &&
    !(/\bcheese\b/.test(key) && /\bgravy\b/.test(key))
  )
    return [];
  const dedicated = optionNames.find((name) => /poutine/i.test(name));
  if (dedicated) return [dedicated];
  const cheese = optionNames.find((name) =>
      /^(?:shredded )?cheese$/i.test(name),
    ),
    gravy = optionNames.find((name) =>
      /^gravy(?: on (?:the )?side)?$/i.test(name),
    );
  return cheese && gravy ? [cheese, gravy] : [];
}
function pizzaVariantAlias(value: string) {
  const key = spokenKey(value);
  if (!key) return undefined;
  if (key.includes("sheet")) return "sheet pizza";
  if (key.includes("thick")) return "jumbo thick";
  if (key.includes("jumbo") || key.includes("large") || /\b16\b/.test(key))
    return "jumbo thin";
  if (key.includes("regular") || key.includes("medium") || /\b14\b/.test(key))
    return "regular";
  if (key.includes("small") || /\b12\b/.test(key)) return "small";
  return undefined;
}
function subVariantAlias(value: string, defaultFull = false) {
  const key = spokenKey(value);
  if (key.includes("wrap")) return "wrap";
  if (key.includes("half") || key.includes("1 2") || key.includes("small"))
    return "1 2 sub";
  if (key.includes("full") || key.includes("whole") || key.includes("large"))
    return "full sub";
  return defaultFull ? "full sub" : undefined;
}
function strictMatch<T>(
  query: string,
  rows: T[],
  terms: (row: T) => string[],
  code: "ITEM_NOT_ON_MENU" | "INVALID_MODIFIER" | "INVALID_VARIANT",
  kind: string,
) {
  const wanted = spokenKey(query),
    indexed = rows.map((row) => ({ row, terms: terms(row).map(spokenKey) })),
    exact = indexed.filter((candidate) => candidate.terms.includes(wanted));
  if (exact.length === 1) return exact[0].row;
  if (exact.length > 1)
    throw new AiToolError(
      code,
      `${kind} is ambiguous: ${query}.`,
      "Ask one short clarification question.",
      409,
    );
  const contained = indexed
      .map((candidate) => ({
        ...candidate,
        best:
          candidate.terms
            .filter(
              (term) =>
                term.length >= 4 &&
                term.includes(" ") &&
                ` ${wanted} `.includes(` ${term} `),
            )
            .sort((a, b) => b.length - a.length)[0] || "",
      }))
      .filter((candidate) => candidate.best)
      .sort((a, b) => b.best.length - a.best.length),
    bestLength = contained[0]?.best.length || 0,
    bestContained = contained.filter(
      (candidate) => candidate.best.length === bestLength,
    );
  if (bestContained.length === 1) return bestContained[0].row;
  if (bestContained.length > 1)
    throw new AiToolError(
      code,
      `${kind} is ambiguous: ${query}.`,
      "Ask one short clarification question.",
      409,
    );
  const partial = indexed.filter(
    (candidate) =>
      wanted.length >= 3 &&
      candidate.terms.some(
        (term) =>
          term !== wanted &&
          (term.startsWith(`${wanted} `) ||
            term.endsWith(` ${wanted}`) ||
            term.includes(` ${wanted} `)),
      ),
  );
  if (partial.length === 1) return partial[0].row;
  if (partial.length > 1)
    throw new AiToolError(
      code,
      `${kind} is ambiguous: ${query}.`,
      "Ask one short clarification question.",
      409,
    );
  const ranked = indexed
      .map((candidate) => ({
        ...candidate,
        score: Math.max(
          ...candidate.terms.map((term) => similarity(wanted, term)),
        ),
      }))
      .sort((a, b) => b.score - a.score),
    automatic =
      ranked[0] &&
      ranked[0].score >= 0.9 &&
      (!ranked[1] || ranked[0].score - ranked[1].score >= 0.08),
    suggestion =
      ranked[0] && ranked[0].score >= 0.72
        ? terms(ranked[0].row)[0]
        : undefined;
  if (automatic) return ranked[0].row;
  throw new AiToolError(
    code,
    code === "ITEM_NOT_ON_MENU"
      ? "Sorry, we don't have that on the menu."
      : code === "INVALID_MODIFIER"
        ? `Sorry, ${query} isn't an option on that.`
        : `Sorry, ${query} isn't an available size or option.`,
    suggestion
      ? `You may offer ${suggestion}, but do not add it without confirmation.`
      : "Do not add it.",
    404,
    suggestion ? { suggestion } : {},
  );
}
const spokenCatalogCache = new Map<
  OrderingBusiness,
  {
    expiresAt: number;
    value: Awaited<ReturnType<typeof orderingMenuWithVariants>>;
  }
>();
async function indexedSpokenCatalog(business: OrderingBusiness) {
  const cached = spokenCatalogCache.get(business);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const value = await orderingMenuWithVariants(business, "pos");
    spokenCatalogCache.set(business, { expiresAt: Date.now() + 30_000, value });
    return value;
  } catch {
    throw new AiToolError(
      "CATALOG_UNAVAILABLE",
      "I can't verify that item right now.",
      "Do not add or improvise any item until the catalog is available.",
      503,
    );
  }
}
async function validateAiCatalogIds(
  business: OrderingBusiness,
  items: AiItemInput[],
) {
  const catalog = await indexedSpokenCatalog(business),
    all = catalog.flatMap((category) => category.items);
  for (const requested of items) {
    if (
      !Number.isInteger(requested.quantity) ||
      requested.quantity < 1 ||
      requested.quantity > 99
    )
      throw new AiToolError(
        "INVALID_INPUT",
        "Item quantity must be between 1 and 99.",
        "Ask for a valid quantity.",
        409,
      );
    const item = all.find(
      (row) => row.id === requested.itemId && row.available,
    );
    if (!item)
      throw new AiToolError(
        "ITEM_NOT_ON_MENU",
        "The product ID is not on the active menu.",
        "Do not add it.",
        404,
      );
    if (
      requested.variantId &&
      !item.variants.some((row) => row.id === requested.variantId)
    )
      throw new AiToolError(
        "INVALID_VARIANT",
        "The size or variant is not valid for that item.",
        "Ask for a valid size.",
        409,
      );
    if (
      !requested.variantId &&
      item.variants.length > 1 &&
      !item.variants.some((row) => row.defaultVariant)
    )
      throw new AiToolError(
        "INVALID_VARIANT",
        "A required size or variant is missing.",
        "Ask for a valid size.",
        409,
      );
    const groups = new Map(item.modifiers.map((group) => [group.id, group])),
      options = new Map(
        item.modifiers.flatMap((group) =>
          group.options
            .filter((option) => option.available)
            .map((option) => [option.id, { group, option }] as const),
        ),
      );
    for (const [groupId, optionIds] of Object.entries(
      requested.modifierSelections || {},
    )) {
      const group = groups.get(groupId);
      if (
        !group ||
        optionIds.some((id) => options.get(id)?.group.id !== groupId)
      )
        throw new AiToolError(
          "INVALID_MODIFIER",
          "A modifier is not assigned to that product.",
          "Do not convert it to a note.",
          409,
        );
    }
    for (const group of item.modifiers) {
      const count = (requested.modifierSelections?.[group.id] || []).length;
      if (
        group.presentationContext === "ordinary" &&
        count < group.minSelections
      )
        throw new AiToolError(
          "INVALID_MODIFIER",
          `${group.name} is required for ${item.name}.`,
          `Ask for one of the configured ${group.name} options.`,
          409,
          {
            group: group.name,
            options: group.options
              .filter((option) => option.available)
              .map((option) => option.name),
          },
        );
    }
    for (const groupId of requested.modifierDeclines || [])
      if (!groups.has(groupId))
        throw new AiToolError(
          "INVALID_MODIFIER",
          "A declined modifier group is not assigned to that product.",
          "Use only configured groups.",
          409,
        );
    for (const topping of requested.pizzaToppings || []) {
      const match = options.get(topping.modifierOptionId);
      if (!match || match.group.presentationBehavior !== "pizza_topping")
        throw new AiToolError(
          "INVALID_MODIFIER",
          "A topping is not valid for that product.",
          "Do not convert it to a note.",
          409,
        );
    }
    for (const id of [
      ...Object.keys(requested.modifierQuantities || {}),
      ...Object.keys(requested.modifierAmounts || {}),
    ])
      if (!options.has(id))
        throw new AiToolError(
          "INVALID_MODIFIER",
          "A modifier ID is not valid for that product.",
          "Do not convert it to a note.",
          409,
        );
    const combo = requested.comboId
      ? item.combos.find((row) => row.id === requested.comboId)
      : undefined;
    if (requested.comboId && !combo)
      throw new AiToolError(
        "INVALID_MODIFIER",
        "A combo is not assigned to that product.",
        "Use only configured combos.",
        409,
      );
    for (const [groupId, optionIds] of Object.entries(
      requested.comboSelections || {},
    )) {
      const group = combo?.groups.find((row) => row.id === groupId);
      if (
        !group ||
        optionIds.some(
          (id) =>
            !group.options.some(
              (option) => option.id === id && option.available,
            ),
        )
      )
        throw new AiToolError(
          "INVALID_MODIFIER",
          "A combo option is not assigned to that product.",
          "Use only configured combo choices.",
          409,
        );
    }
    if (String(requested.specialInstructions || "").trim())
      throw new AiToolError(
        "INVALID_MODIFIER",
        "Free-text notes are not allowed for AI-added products or modifiers.",
        "Use only configured menu options.",
        409,
      );
  }
}
export async function priceSpokenOrder(input: {
  business: OrderingBusiness;
  actor: OrderingActor;
  service: ServiceType;
  items: SpokenOrderItem[];
  orderId?: string | null;
  customerId?: string | null;
  callerPhone?: string;
  firstName?: string;
  lastName?: string;
  resolvedPendingQuestions?: string[];
  customerText?: string;
}) {
  if (input.items.length && input.service === "undecided")
    throw new AiToolError(
      "FULFILLMENT_REQUIRED",
      "Pickup or delivery must be selected before ordering.",
      "Ask whether this is pickup or delivery and wait for the answer.",
      409,
    );
  let mashedGravyPending:
    | { itemId: string; itemName: string; sideOptionId: string }
    | undefined;
  const catalog = await indexedSpokenCatalog(input.business),
    allItems = catalog
      .flatMap((category) => category.items)
      .filter((item) => item.available),
    spokenItems = input.items.flatMap((requested) => {
      const itemName = spokenKey(requested.name),
        burger =
          itemName.includes("burger") &&
          !/hot hamburger|hamburger steak/.test(itemName),
        fryModifiers = burger
          ? (requested.modifiers || []).filter((modifier) =>
              /^(?:(?:small|large) )?(?:french )?(?:frie|fry)$/.test(
                spokenKey(modifier.name),
              ),
            )
          : [];
      if (!fryModifiers.length) return [requested];
      const burgerLine: SpokenOrderItem = {
          ...requested,
          modifiers: (requested.modifiers || []).filter(
            (modifier) => !fryModifiers.includes(modifier),
          ),
        },
        fryLines = fryModifiers.map((modifier): SpokenOrderItem => {
          const fryName = spokenKey(modifier.name);
          return {
            name: fryName.includes("large")
              ? "Large French Fries"
              : fryName.includes("small")
                ? "Small French Fries"
                : "French Fries",
            quantity: 1,
          };
        });
      return [burgerLine, ...fryLines];
    });
  const resolved: AiItemInput[] = consolidateQuantities(
    spokenItems.map((requested) => {
      const rawName = spokenKey(requested.name),
        rawInputVariant = spokenKey(requested.variant || "");
      if (
        /\b(?:tater\s+)?tot\b/.test(rawName) &&
        !/\b(?:small|large)\b/.test(rawName) &&
        !rawInputVariant &&
        !/\b(?:poutine|poutin|pountine|poutene|protein)\b/.test(rawName)
      )
        throw new AiToolError(
          "INVALID_VARIANT",
          "Tater tots require a size.",
          "Ask: Small or large?",
          409,
          {
            options: ["Small Tater Tots", "Large Tater Tots"],
            pendingItem: {
              category: "tater tots",
              customerRequest: requested.name,
              missingRequiredFields: ["size"],
            },
          },
        );
      if (
        /\b(?:frie|french frie)\b/.test(rawName) &&
        !/\b(?:sandwich|sub|wrap)\b/.test(rawName) &&
        !/\b(?:small|large)\b/.test(rawName) &&
        !rawInputVariant &&
        !/\b(?:poutine|poutin|pountine|poutene|protein)\b/.test(rawName)
      )
        throw new AiToolError(
          "INVALID_VARIANT",
          "Fries require a size.",
          "Ask: Small or large?",
          409,
          {
            options: ["Small French Fries", "Large French Fries"],
            pendingItem: {
              category: "french fries",
              customerRequest: requested.name,
              missingRequiredFields: ["size"],
            },
          },
        );
      if (
        ["frie", "french frie"].includes(rawName) &&
        /^(small|large)$/.test(rawInputVariant)
      )
        requested = {
          ...requested,
          name: `${rawInputVariant === "large" ? "Large" : "Small"} French Fries`,
          variant: undefined,
        };
      const wingSauceVariant =
        /^(mild|medium|hot|suicide|bbq|sweet and sassy|plain|sweet and sour|garlic parmesan|open pit bbq)$/i.exec(
          String(requested.variant || "").trim(),
        );
      if (spokenKey(requested.name).includes("wing") && wingSauceVariant)
        requested = {
          ...requested,
          variant: undefined,
          modifiers: [
            ...(requested.modifiers || []),
            { name: wingSauceVariant[1] },
          ],
        };
      const initialName = spokenKey(requested.name),
        initialVariant = spokenKey(requested.variant || ""),
        poutineRequested = /\b(poutine|poutin|pountine|poutene|protein)\b/.test(
          `${initialName} ${initialVariant}`,
        );
      if (poutineRequested) {
        const size =
            initialName.includes("large") || initialVariant.includes("large")
              ? "Large"
              : initialName.includes("small") ||
                  initialVariant.includes("small")
                ? "Small"
                : "",
          tots =
            initialName.includes("tater") ||
            initialName.includes("tot") ||
            initialVariant.includes("tater") ||
            initialVariant.includes("tot"),
          curly =
            initialName.includes("curly") || initialVariant.includes("curly"),
          waffle =
            initialName.includes("waffle") || initialVariant.includes("waffle"),
          base = tots
            ? "Tater Tots"
            : curly
              ? "Curly Fries"
              : waffle
                ? "Waffle Fries"
                : "French Fries";
        if (!size)
          throw new AiToolError(
            "INVALID_VARIANT",
            "Small or large?",
            "Ask the returned size question.",
            409,
            {
              options: [`Small ${base}`, `Large ${base}`],
              pendingItem: {
                category: `${spokenKey(base)} poutine`,
                customerRequest: requested.name,
                missingRequiredFields: ["size"],
              },
            },
          );
        requested = {
          ...requested,
          name: `${size} ${base}`,
          variant: undefined,
          modifiers: [...(requested.modifiers || []), { name: "poutine" }],
        };
      }
      const wingRequest =
          spokenKey(requested.name).includes("wing") ||
          (/\b(?:bone in|traditional|boneles)\b/.test(
            spokenKey(requested.name),
          ) &&
            /\b(10|12|15|20|24|25|30|40|50)\b/.test(spokenKey(requested.name))),
        explicitWingCount =
          /\b(10|12|15|20|24|25|30|40|50)\b/.test(
            `${spokenKey(requested.name)} ${spokenKey(requested.variant || "")}`,
          ) ||
          [10, 12, 15, 20, 24, 25, 30, 40, 50].includes(
            Number(requested.quantity),
          );
      if (wingRequest && !explicitWingCount)
        throw new AiToolError(
          "INVALID_VARIANT",
          "How many wings?",
          "Ask exactly: How many wings?",
          409,
          {
            options: [10, 12, 15, 20, 24, 25, 30, 40, 50],
            pendingItem: {
              category: "wings",
              customerRequest: requested.name,
              missingRequiredFields: ["quantity"],
            },
          },
        );
      if (spokenKey(requested.name) === "frie")
        throw new AiToolError(
          "INVALID_VARIANT",
          "Fries require a size.",
          "Ask: Small or large?",
          409,
          { options: ["Small French Fries", "Large French Fries"] },
        );
      const spokenName = spokenKey(requested.name),
        spokenVariant = spokenKey(requested.variant || ""),
        hotMealPhrase =
          /^(hot turkey|hot roast beef|hot hamburger|hamburger steak)\b/.exec(
            spokenName,
          )?.[1],
        wingPhrase =
          spokenName.includes("wing") ||
          (/\b(?:bone in|traditional|boneles)\b/.test(spokenName) &&
            /\b(10|12|15|20|24|25|30|40|50)\b/.test(spokenName)),
        bonelessRequested =
          wingPhrase &&
          (spokenName.includes("boneles") || spokenVariant.includes("boneles")),
        pizzaLogsPhrase = /\bpizza (?:log|roll)\b/.test(spokenName),
        pizzaPhrase =
          (!pizzaLogsPhrase && spokenName.includes("pizza")) ||
          ["jumbo", "large", "16 inch", "16 in", "16"].includes(spokenName),
        varietyPhrase =
          spokenName.includes("variety") ||
          spokenName.includes("sampler platter") ||
          spokenName.includes("appetizer sampler"),
        varietySize = /\b(?:4|four)\b/.test(spokenName)
          ? "four"
          : /\b(?:2|two)\b/.test(spokenName)
            ? "two"
            : "";
      if (varietyPhrase && !varietySize)
        throw new AiToolError(
          "INVALID_VARIANT",
          "The variety basket requires a size.",
          "Ask: Variety for two or four?",
          409,
          { options: ["Variety for TWO", "Variety for Four"] },
        );
      const regularMacSalad =
          /\b(?:mac|macaroni) salad\b/.test(spokenName) &&
          !/\b(?:party|bulk|pound|lb|feed|people)\b/.test(spokenName),
        itemQuery = regularMacSalad
          ? "Mac Salad"
          : pizzaLogsPhrase
            ? "Pizza Logs"
          : hotMealPhrase
          ? hotMealPhrase
          : wingPhrase
            ? bonelessRequested
              ? "Boneless Wings"
              : "Wings"
            : pizzaPhrase
              ? "Pizza"
              : varietyPhrase && varietySize === "four"
                ? "Variety for Four"
                : varietyPhrase && varietySize === "two"
                  ? "Variety for TWO"
                  : /\bmozz(?:arella)?\s+stick|\bcheese\s+stick/.test(
                        spokenName,
                      )
                    ? "Mozzarella Sticks"
                    : /\bsmall\s+(?:tossed\s+)?salad\b/.test(spokenName)
                      ? "SM Tossed Sal"
                      : requested.name,
        itemCandidates = regularMacSalad
          ? allItems.filter(
              (row) =>
                spokenKey(row.name) === "mac salad" &&
                row.variants.some((variant) =>
                  /^(?:small|medium|large)\b/i.test(variant.name),
                ),
            )
          : allItems,
        item = strictMatch(
          itemQuery,
          itemCandidates,
          (row) => [
            row.name,
            normalizedSpokenName(row.name),
            ...row.aliases,
            ...generatedItemAliases(row.name),
          ],
          "ITEM_NOT_ON_MENU",
          "Menu item",
        ),
        nameVariant =
          item.name === "Pizza" ? pizzaVariantAlias(spokenName) : undefined,
        subItem =
          item.variants.some((row) => spokenKey(row.name) === "full sub") &&
          item.variants.some((row) => spokenKey(row.name) === "1 2 sub"),
        subVariant = subItem
          ? subVariantAlias(
              spokenVariant || spokenName,
              spokenName.includes(" sub") || spokenName.includes("big bos"),
            )
          : undefined,
        wingCount =
          [
            ...spokenName.matchAll(/\b(10|12|15|20|24|25|30|40|50)\b/g),
            ...spokenVariant.matchAll(/\b(10|12|15|20|24|25|30|40|50)\b/g),
          ][0]?.[1] ||
          ((item.name === "Wings" || item.name === "Boneless Wings") &&
          Number.isInteger(requested.quantity) &&
          [10, 12, 15, 20, 24, 25, 30, 40, 50].includes(
            Number(requested.quantity),
          )
            ? String(requested.quantity)
            : ""),
        macSaladSize = regularMacSalad
          ? /\b(small|medium|large)\b/.exec(spokenName)?.[1] || ""
          : "",
        rawVariant = wingCount
          ? `${wingCount} Wings`
          : subVariant ||
            macSaladSize ||
            (spokenVariant &&
            !/^(bone in|boneles|boneless)$/.test(spokenVariant)
              ? spokenVariant
              : nameVariant || ""),
        pizzaVariantPrefix =
          item.name === "Pizza" ? pizzaVariantAlias(rawVariant) : undefined,
        variantWanted = rawVariant;
      if (
        !variantWanted &&
        item.variants.length > 1 &&
        !item.variants.some((row) => row.defaultVariant)
      ) {
        const options = item.variants
            .filter((row) => row.available !== false)
            .map((row) => row.name),
          category = spokenKey(item.name);
        throw new AiToolError(
          "INVALID_VARIANT",
          category === "pizza"
            ? "What size?"
            : `${item.name} requires a size or option.`,
          category === "pizza"
            ? "Ask exactly: What size?"
            : "Ask one short size clarification.",
          409,
          {
            options,
            pendingItem: {
              category,
              customerRequest: requested.name,
              missingRequiredFields: ["size"],
              actualMenuItemId: item.id,
            },
          },
        );
      }
      const variant = pizzaVariantPrefix
        ? item.variants.find((row) =>
            spokenKey(row.name).startsWith(pizzaVariantPrefix),
          )
        : variantWanted
          ? strictMatch(
              variantWanted,
              item.variants,
              (row) => [
                row.name,
                normalizedSpokenName(row.name),
                ...row.aliases,
                ...modifierAliases(row.name, "size"),
              ],
              "INVALID_VARIANT",
              "Menu variant",
            )
          : item.variants.find((row) => row.defaultVariant) || item.variants[0];
      if (pizzaVariantPrefix && !variant)
        throw new AiToolError(
          "INVALID_VARIANT",
          `Sorry, ${requested.variant} isn't an available size or option.`,
          "Ask for a valid pizza size.",
          409,
        );
      const mealIntentText = `${spokenName} ${(requested.modifiers || []).map((value) => spokenKey(value.name)).join(" ")} ${input.items.length === 1 ? spokenKey(input.customerText || "") : ""}`;
      if (
        /^(hot turkey|hot roast beef|hot hamburger|hamburger steak)/.test(
          spokenKey(item.name),
        ) &&
        /\b(?:mashed|mash)\b/.test(mealIntentText) &&
        !/\b(?:small|medium)\s+(?:mashed|mash)\b/.test(mealIntentText)
      )
        throw new AiToolError(
          "FOLLOW_UP_REQUIRED",
          "Small or medium?",
          "Ask exactly: Small or medium?",
          409,
          {
            options: ["Small Mashed", "Medium Mashed"],
            pendingItem: {
              category: spokenKey(item.name),
              customerRequest: requested.name,
              actualMenuItemId: item.id,
              missingRequiredFields: ["mashed size"],
            },
          },
        );
      const modifierSelections: Record<string, string[]> = Object.fromEntries(
          item.modifiers
            .filter((group) => group.presentationBehavior !== "pizza_topping")
            .map((group) => [
              group.id,
              group.options
                .filter((option) => option.available && option.defaultSelected)
                .map((option) => option.id),
            ]),
        ),
        pizzaToppings: NonNullable<AiItemInput["pizzaToppings"]> = [],
        spokenModifiers = [...(requested.modifiers || [])],
        coldSubEverything =
          subItem &&
          /(?:sub|wrap)/i.test(String(variant?.name || requested.variant || "")) &&
          !/big boss/i.test(item.name) &&
          /\b(?:everything|all of it|all the toppings)\b/.test(mealIntentText);
      if (coldSubEverything) {
        for (let index = spokenModifiers.length - 1; index >= 0; index--)
          if (/^(?:everything|all|all of it|all the toppings)$/.test(spokenKey(spokenModifiers[index].name)))
            spokenModifiers.splice(index, 1);
        for (const name of [
          "Mayonnaise",
          "Russian",
          "Oil",
          "Parm Shakers",
          "Oregano Shakers",
          "Lettuce",
          "Tomato",
          "Onion",
          "Hot Peppers",
        ])
          if (!spokenModifiers.some((modifier) => spokenKey(modifier.name) === spokenKey(name)))
            spokenModifiers.push({ name });
      }
      const spokenMashed = /\b(small|medium)\s+(?:mashed|mash)(?:\s+potatoes?)?\b/.exec(
        mealIntentText,
      );
      if (
        spokenMashed &&
        /^(hot turkey|hot roast beef|hot hamburger|hamburger steak)/.test(
          spokenKey(item.name),
        ) &&
        !spokenModifiers.some((modifier) => /\b(?:mashed|mash)\b/i.test(modifier.name))
      )
        spokenModifiers.push({ name: `${spokenMashed[1]} mashed` });
      if (
        /^hamburger steak/.test(spokenKey(item.name)) &&
        /\b(?:all|all of them|all three|everything)\b/.test(mealIntentText)
      )
        for (const name of ["Mushrooms", "Onions", "Peppers"])
          if (
            !spokenModifiers.some(
              (modifier) => spokenKey(modifier.name) === spokenKey(name),
            )
          )
            spokenModifiers.push({ name });
      for (let index = spokenModifiers.length - 1; index >= 0; index--) {
        const key = spokenKey(spokenModifiers[index].name),
          combined = /\b(small|medium)\s+(?:mashed|mash)(?:\s+potatoes?)?\s+(?:with\s+)?gravy\b/.exec(
            key,
          );
        if (combined)
          spokenModifiers.splice(
            index,
            1,
            { name: `${combined[1]} mashed` },
            { name: "gravy" },
          );
      }
      for (let index = spokenModifiers.length - 1; index >= 0; index--) {
        const effects = compositeModifierEffects(
          item.modifiers.flatMap((group) =>
            group.options
              .filter((option) => option.available)
              .map((option) => option.name),
          ),
          spokenModifiers[index].name,
        );
        if (effects.length)
          spokenModifiers.splice(
            index,
            1,
            ...effects.map((name) => ({ name })),
          );
      }
      const compositePoutine =
        /^(?:Small|Large) (?:French|Curly|Waffle) Fries$|^(?:Small|Large) Tater Tots$/.test(
          item.name,
        ) &&
        /\b(?:cheese|cheesy)\b/.test(spokenName) &&
        /\bgravy\b/.test(spokenName);
      if (
        compositePoutine &&
        !spokenModifiers.some((value) => /poutine/i.test(value.name))
      ) {
        const effects = compositeModifierEffects(
          item.modifiers.flatMap((group) =>
            group.options
              .filter((option) => option.available)
              .map((option) => option.name),
          ),
          "poutine",
        );
        spokenModifiers.push(...effects.map((name) => ({ name })));
      }
      const scratchSelections: Record<string, string[]> = Object.fromEntries(
        Object.entries(modifierSelections).map(([key, value]) => [
          key,
          [...value],
        ]),
      );
      for (const group of item.modifiers.filter(
        (group) => group.presentationContext !== "hidden",
      )) {
        const active =
          group.presentationContext === "ordinary" ||
          Boolean(
            group.parentGroupId &&
            (group.parentOptionIds || []).some((id: string) =>
              (scratchSelections[String(group.parentGroupId)] || []).includes(
                id,
              ),
            ),
          );
        if (!active) continue;
        const matches = group.options
          .filter((option) => option.available)
          .filter(
            (option) =>
              group.name !== "Wings Add Ons" ||
              !/^(?:Mild|Medium|Hot|Suicide|BBQ|Sweet|Garlic|Open Pit).*(?:4oz)/i.test(
                option.name,
              ) ||
              /\b(?:extra|saucy|on (?:the )?side|side of)\b/.test(spokenName),
          )
          .map((option) => ({
            option,
            aliases: modifierAliases(option.name, group.name),
          }))
          .map((candidate) => ({
            ...candidate,
            best: candidate.aliases
              .filter((alias) => {
                const key = spokenKey(alias);
                return (
                  key.length >= 3 && ` ${spokenName} `.includes(` ${key} `)
                );
              })
              .sort((a, b) => spokenKey(b).length - spokenKey(a).length)[0],
          }))
          .filter((candidate) => candidate.best);
        if (!matches.length) continue;
        const longest = Math.max(
            ...matches.map((candidate) => spokenKey(candidate.best!).length),
          ),
          best = matches.filter(
            (candidate) => spokenKey(candidate.best!).length === longest,
          ),
          exactCanonical = best.find(
            (candidate) =>
              spokenKey(candidate.option.name) === spokenKey(candidate.best!),
          ),
          chosen = exactCanonical || (best.length === 1 ? best[0] : undefined),
          selected =
            group.maxSelections === 1 ? (chosen ? [chosen] : []) : matches;
        if (!selected.length) continue;
        for (const match of selected)
          if (
            !spokenModifiers.some(
              (value) => spokenKey(value.name) === spokenKey(match.option.name),
            )
          )
            spokenModifiers.push({ name: match.option.name });
        scratchSelections[group.id] =
          group.maxSelections === 1
            ? [selected[0].option.id]
            : [
                ...new Set([
                  ...(scratchSelections[group.id] || []),
                  ...selected.map((match) => match.option.id),
                ]),
              ];
      }
      for (let index = spokenModifiers.length - 1; index >= 0; index--) {
        const key = spokenKey(spokenModifiers[index].name);
        if (
          key === "shaker" ||
          key === "shaker both" ||
          key === "both shaker"
        ) {
          spokenModifiers.splice(
            index,
            1,
            { name: "Parm Shakers" },
            { name: "Oregano Shakers" },
          );
        }
        if (
          key === "all" &&
          (item.name === "Wings" || item.name === "Boneless Wings")
        )
          spokenModifiers.splice(
            index,
            1,
            { name: "Blue Cheese" },
            { name: "Ranch" },
            { name: "Celery" },
          );
      }
      const extraWingSauce =
        (item.name === "Wings" || item.name === "Boneless Wings") &&
        (/\b(extra sauce|extra saucy|saucy)\b/.test(spokenName) ||
          spokenModifiers.some((value) =>
            /^(extra sauce|extra saucy|saucy)$/.test(spokenKey(value.name)),
          ));
      if (extraWingSauce) {
        for (let index = spokenModifiers.length - 1; index >= 0; index--)
          if (
            /^(extra sauce|extra saucy|saucy)$/.test(
              spokenKey(spokenModifiers[index].name),
            )
          )
            spokenModifiers.splice(index, 1);
        const explicitlyRequestedSideFlavor =
            /(?:extra|side(?: of)?)\s+(mild|medium|hot|suicide|bbq|sweet and sassy|sweet and sour|garlic parmesan|garlic parm|open pit bbq)(?:\s+sauce)?|\b(mild|medium|hot|suicide|bbq|sweet and sassy|sweet and sour|garlic parmesan|garlic parm|open pit bbq)(?:\s+sauce)?\s+on (?:the )?side\b/i.exec(
              spokenName,
            ),
          explicitFlavor =
            explicitlyRequestedSideFlavor?.[1] ||
            explicitlyRequestedSideFlavor?.[2] ||
            "",
          flavor =
            explicitFlavor.replace("garlic parm", "garlic parmesan") ||
            spokenModifiers
              .map((value) => spokenKey(value.name))
              .find((value) =>
                [
                  "mild",
                  "medium",
                  "hot",
                  "suicide",
                  "bbq",
                  "sweet and sassy",
                  "sweet and sour",
                  "garlic parmesan",
                  "open pit bbq",
                ].includes(value),
              ) ||
            [
              "garlic parmesan",
              "sweet and sassy",
              "sweet and sour",
              "open pit bbq",
              "suicide",
              "medium",
              "mild",
              "hot",
              "bbq",
            ].find((value) => spokenName.includes(value)),
          cup =
            flavor &&
            (
              {
                mild: "Mild Sauce (4oz)",
                medium: "Medium (4oz)",
                hot: "Hot Sauce (4oz)",
                suicide: "Suicide Sauce (4oz)",
                bbq: "BBQ Sauce (4oz)",
                "sweet and sassy": "Sweet & Sassy (4oz)",
                "sweet and sour": "Sweet & Sour (4oz)",
                "garlic parmesan": "Garlic Parmesan (4oz)",
                "open pit bbq": "BBQ Sauce (4oz)",
              } as Record<string, string>
            )[flavor];
        if (
          cup &&
          !spokenModifiers.some(
            (value) => spokenKey(value.name) === spokenKey(cup),
          )
        )
          spokenModifiers.push({ name: cup });
      }
      if (
        (item.name === "Wings" || item.name === "Boneless Wings") &&
        !spokenModifiers.length
      ) {
        const sauce = [
          "garlic parmesan",
          "sweet and sassy",
          "sweet and sour",
          "open pit bbq",
          "suicide",
          "medium",
          "mild",
          "hot",
          "bbq",
          "plain",
        ].find((value) => spokenName.includes(value));
        if (sauce) spokenModifiers.push({ name: sauce });
      }
      const dependencyPriority = (modifier: { name: string }) => {
        const key = spokenKey(modifier.name);
        if (
          /mashed|french frie|curly frie|waffle frie|tater tot|onion ring|tossed salad|coleslaw|mac and cheese/.test(
            key,
          )
        )
          return 0;
        if (/gravy|nacho/.test(key)) return 2;
        return 1;
      };
      spokenModifiers.sort(
        (left, right) => dependencyPriority(left) - dependencyPriority(right),
      );
      for (const requestedModifier of spokenModifiers) {
        const raw = spokenKey(requestedModifier.name),
          explicitOnItem = /\b(on (it|the|top)|over|melted)\b/i.test(
            requestedModifier.name,
          ),
          mealWithIncludedSalad = item.modifiers.some(
            (group) => group.name === "Choose a Salad (Dinner)",
          ),
          allChoices = item.modifiers
            .filter((group) => group.presentationContext !== "hidden")
            .flatMap((group) =>
              group.options.map((option) => ({ group, option })),
            )
            .filter(({ option }) => option.available),
          activeChoices = allChoices.filter(
            ({ group }) =>
              group.presentationContext === "ordinary" ||
              !group.parentGroupId ||
              (group.parentOptionIds || []).some((optionId: string) =>
                (
                  modifierSelections[String(group.parentGroupId)] || []
                ).includes(optionId),
              ),
          ),
          choices = activeChoices.some(({ group, option }) =>
            modifierAliases(option.name, group.name).some(
              (alias) => spokenKey(alias) === raw,
            ),
          )
            ? activeChoices
            : allChoices,
          requiredDressingChoices = mealWithIncludedSalad
            ? choices.filter(
                ({ group }) =>
                  /^Choose Dressing(?: \(On Salad\))?$/.test(group.name) &&
                  group.minSelections > 0 &&
                  (group.presentationContext === "ordinary" ||
                    !group.parentGroupId ||
                    (group.parentOptionIds || []).some((optionId: string) =>
                      (
                        modifierSelections[String(group.parentGroupId)] || []
                      ).includes(optionId),
                    )) &&
                  !(modifierSelections[group.id]?.length || 0),
              )
            : [],
          explicitSideSauce = /^(side of|side)\b|\b(cup|\d+\s*oz)\b/.test(raw),
          sideSauceKey = raw
            .replace(/^(side of|side)\s+/, "")
            .replace(/\s+(cup|\d+\s*oz)$/, ""),
          wingSauceChoices = choices.filter(
            ({ group }) => group.name === "Wing Sauce",
          ),
          burgerToppingChoices = choices.filter(
            ({ group }) => group.name === "Burger Toppings",
          ),
          portionedChoices = choices.filter(({ option }) =>
            /\(\s*\d+(?:\.\d+)?\s*oz\s*\)\s*$/i.test(option.name),
          ),
          matchingChoices =
            requiredDressingChoices.length &&
            requiredDressingChoices.some(({ option, group }) =>
              modifierAliases(option.name, group.name).some(
                (alias) => spokenKey(alias) === raw,
              ),
            )
              ? requiredDressingChoices
              : burgerToppingChoices.some(({ option, group }) =>
                    modifierAliases(option.name, group.name).some(
                      (alias) => spokenKey(alias) === raw,
                    ),
                  )
                ? burgerToppingChoices
                : explicitSideSauce && portionedChoices.length
                  ? portionedChoices
                  : wingSauceChoices.some(({ option, group }) =>
                        modifierAliases(option.name, group.name).some(
                          (alias) => spokenKey(alias) === raw,
                        ),
                      )
                    ? wingSauceChoices
                    : choices,
          hasSideNacho = choices.some(
            ({ option }) => spokenKey(option.name) === "nacho cheese on side",
          ),
          key =
            raw === "nacho cheese" && !explicitOnItem && hasSideNacho
              ? "nacho cheese on side"
              : explicitSideSauce
                ? sideSauceKey
                : raw,
          { group, option } = strictMatch(
            key,
            matchingChoices,
            (row) => [
              ...modifierAliases(row.option.name, row.group.name),
              /^russian$/i.test(row.option.name)
                ? "russian dressing"
                : row.option.name,
              /^blue cheese\s*\(4oz\)$/i.test(row.option.name)
                ? "blue cheese"
                : row.option.name,
              /^blue cheese\s*\(4oz\)$/i.test(row.option.name)
                ? "blue cheese cup"
                : row.option.name,
              row.option.name.replace(/\bon side\b/i, "side cup"),
              row.option.name.replace(/^xtra\b/i, "extra"),
              mealWithIncludedSalad
                ? row.option.name.replace(/\s*\(on salad\)\s*$/i, "")
                : row.option.name,
              row.option.name
                .replace(/^add\s+/i, "")
                .replace(/^mayonnaise$/i, "mayo"),
              row.group.name === "Burger Toppings" &&
              /^raw onions$/i.test(row.option.name)
                ? "onion"
                : row.option.name,
              row.group.name === "Burger Toppings" &&
              /^tomatoes$/i.test(row.option.name)
                ? "tomato"
                : row.option.name,
            ],
            "INVALID_MODIFIER",
            "Modifier",
          );
        if (group.presentationBehavior === "pizza_topping")
          pizzaToppings.push({
            modifierOptionId: option.id,
            portion: requestedModifier.portion || "whole",
            amount: requestedModifier.amount || "regular",
          });
        else
          modifierSelections[group.id] =
            group.maxSelections === 1
              ? [option.id]
              : [
                  ...new Set([
                    ...(modifierSelections[group.id] || []),
                    option.id,
                  ]),
                ];
      }
      const hotMeatMeal =
          /^(hot turkey|hot roast beef|hot hamburger|hamburger steak)/.test(
            spokenKey(item.name),
          ),
        mashedGroup = item.modifiers.find(
          (group) => group.name === "Choose a Side",
        ),
        mashedSelected = mashedGroup?.options.some(
          (option) =>
            /mashed/i.test(option.name) &&
            (modifierSelections[mashedGroup.id] || []).includes(option.id),
        ),
        gravySelected = item.modifiers.some(
          (group) =>
            group.name === "Mashed Mods" &&
            group.options.some(
              (option) =>
                /^Gravy$/i.test(option.name) &&
                (modifierSelections[group.id] || []).includes(option.id),
            ),
        );
      if (
        hotMeatMeal &&
        mashedSelected &&
        !gravySelected &&
        !input.resolvedPendingQuestions?.includes("mashed_gravy")
      ) {
        const selectedSide = mashedGroup?.options.find(
          (option) =>
            /mashed/i.test(option.name) &&
            (modifierSelections[mashedGroup.id] || []).includes(option.id),
        );
        if (selectedSide)
          mashedGravyPending = {
            itemId: item.id,
            itemName: item.name,
            sideOptionId: selectedSide.id,
          };
      }
      const subMods = item.modifiers.find(
          (group) => group.name === "Sub Mods",
        ),
        coldSub =
          Boolean(subMods) &&
          /(?:sub|wrap)/i.test(String(variant?.name || requested.variant || "")) &&
          !/big boss/i.test(item.name),
        selectedSubNames = new Set(
          (subMods?.options || [])
            .filter((option) =>
              (modifierSelections[subMods!.id] || []).includes(option.id),
            )
            .map((option) => spokenKey(option.name)),
        ),
        condimentsSelected = [...selectedSubNames].some((name) =>
          /^(?:mayonnaise|mayo|russian|oil|parm shakers|oregano shakers)$/.test(
            name,
          ),
        ),
        vegetablesSelected = [...selectedSubNames].some((name) =>
          /^(?:lettuce|tomato|onion|onions|hot peppers)$/.test(name),
        );
      if (
        coldSub &&
        !condimentsSelected &&
        !input.resolvedPendingQuestions?.includes("cold_sub_condiments")
      )
        throw new AiToolError(
          "FOLLOW_UP_REQUIRED",
          "Mayo, Russian, oil, or shakers?",
          "Ask exactly: Mayo, Russian, oil, or shakers?",
          409,
          {
            pendingItem: {
              category: spokenKey(item.name),
              customerRequest: requested.name,
              actualMenuItemId: item.id,
              actualVariantId: variant?.id || null,
              pendingQuestion: "cold_sub_condiments",
              missingRequiredFields: ["cold sub condiments"],
            },
          },
        );
      if (
        coldSub &&
        !vegetablesSelected &&
        !input.resolvedPendingQuestions?.includes("cold_sub_vegetables")
      )
        throw new AiToolError(
          "FOLLOW_UP_REQUIRED",
          "Lettuce, tomato, onions, or hot peppers?",
          "Ask exactly: Lettuce, tomato, onions, or hot peppers?",
          409,
          {
            pendingItem: {
              category: spokenKey(item.name),
              customerRequest: requested.name,
              actualMenuItemId: item.id,
              actualVariantId: variant?.id || null,
              pendingQuestion: "cold_sub_vegetables",
              missingRequiredFields: ["cold sub vegetables"],
            },
          },
        );
      if (
        item.name === "Pizza Logs" &&
        !item.modifiers.some((group) =>
          group.options.some(
            (option) =>
              (modifierSelections[group.id] || []).includes(option.id),
          ),
        ) &&
        !input.resolvedPendingQuestions?.includes("pizza_logs_dipping_sauce")
      )
        throw new AiToolError(
          "FOLLOW_UP_REQUIRED",
          "What dipping sauce would you like?",
          "Ask exactly: What dipping sauce would you like?",
          409,
          {
            pendingItem: {
              category: "pizza logs",
              customerRequest: requested.name,
              actualMenuItemId: item.id,
              actualVariantId: variant?.id || null,
              pendingQuestion: "pizza_logs_dipping_sauce",
              missingRequiredFields: ["dipping sauce"],
            },
          },
        );
      const missingRequired = item.modifiers.find(
        (group) =>
          (group.presentationContext === "ordinary" ||
            (group.presentationContext === "dependent" &&
              Boolean(group.parentGroupId) &&
              (group.parentOptionIds || []).some((optionId: string) =>
                (
                  modifierSelections[String(group.parentGroupId)] || []
                ).includes(optionId),
              ))) &&
          group.minSelections > 0 &&
          (modifierSelections[group.id]?.length || 0) < group.minSelections,
      );
      if (missingRequired) {
        const choices = missingRequired.options
            .filter((option) => option.available)
            .map((option) => option.name),
          question =
            coldSub && missingRequired.name === "Free Cheese"
              ? "American, Swiss, or Provolone?"
              : /^Choose Dressing(?: \(On Salad\))?$/.test(
                    missingRequired.name,
                  )
                ? "What kind of dressing do you want for your salad?"
                : spokenKey(missingRequired.name).includes("cheese")
                  ? `What cheese: ${choices.join(", ")}?`
                  : `Choose ${missingRequired.name}: ${choices.join(", ")}?`;
        throw new AiToolError("INVALID_MODIFIER", question, question, 409, {
          group: missingRequired.name,
          options: choices,
          pendingItem: {
            category: spokenKey(item.name),
            customerRequest: requested.name,
            actualMenuItemId: item.id,
            actualVariantId: variant?.id || null,
            missingRequiredFields: [missingRequired.name],
          },
        });
      }
      const wingCountWasQuantity =
        Boolean(wingCount) &&
        Number(requested.quantity) === Number(wingCount) &&
        (item.name === "Wings" || item.name === "Boneless Wings");
      return {
        itemId: item.id,
        variantId: variant?.id || null,
        quantity: wingCountWasQuantity
          ? 1
          : Math.max(1, Math.trunc(Number(requested.quantity || 1))),
        modifierSelections,
        pizzaToppings,
      };
    }),
    ({ quantity: _quantity, ...configuration }) => configuration,
  );
  const attachPendingFollowUp = <T extends Record<string, any>>(result: T) => {
    if (!mashedGravyPending) return result;
    Object.assign(result, {
      required_follow_up: "Gravy on the mashed potatoes?",
      pending_item: {
        activeItem: mashedGravyPending.itemName,
        actualMenuItemId: mashedGravyPending.itemId,
        selectedSideOptionId: mashedGravyPending.sideOptionId,
        pendingQuestion: "mashed_gravy",
        missingRequiredFields: ["mashed gravy preference"],
      },
    });
    return result;
  };
  if (input.orderId) {
    const current = (
      await getSql()`SELECT version FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business}`
    )[0];
    if (!current)
      throw new AiToolError(
        "NOT_FOUND",
        "The active draft was not found.",
        "Create a new priced draft.",
        404,
      );
    const result = await replaceAiDraft({
      business: input.business,
      actor: input.actor,
      orderId: input.orderId,
      expectedVersion: Number(current.version),
      service: input.service,
      items: resolved,
      customerId: input.customerId,
      callerPhone: input.callerPhone,
      firstName: input.firstName,
      lastName: input.lastName,
    });
    return attachPendingFollowUp(result);
  }
  const result = await createAiDraft({
    business: input.business,
    actor: input.actor,
    service: input.service,
    items: resolved,
    customerId: input.customerId,
    callerPhone: input.callerPhone,
    firstName: input.firstName,
    lastName: input.lastName,
  });
  return attachPendingFollowUp(result);
}

export async function replaceAiDraft(input: {
  business: OrderingBusiness;
  actor: OrderingActor;
  orderId: string;
  expectedVersion: number;
  service: ServiceType;
  items: AiItemInput[];
  customerId?: string | null;
  callerPhone?: string;
  firstName?: string;
  lastName?: string;
  scheduledFor?: Date | null;
}) {
  const current = (
    await getSql()`SELECT * FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business}`
  )[0];
  if (!current)
    throw new AiToolError(
      "NOT_FOUND",
      "The draft was not found.",
      "Refresh the live draft and use its stable ID.",
      404,
    );
  if (current.status !== "draft")
    throw new AiToolError(
      "VALIDATION_REQUIRED",
      "Only a draft order can be updated.",
      "Create a new draft; historical sent orders are immutable.",
    );
  if (Number(current.version) !== input.expectedVersion)
    throw new AiToolError(
      "VERSION_CONFLICT",
      "The draft changed since it was read.",
      "Fetch the draft again, merge the customer's changes, and retry with the new version.",
      409,
      { currentVersion: Number(current.version) },
    );
  const temporary = await createAiDraft({
    ...input,
    orderId: undefined,
  } as Parameters<typeof createAiDraft>[0]);
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const locked = (
        await sql`SELECT version,status FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE`
      )[0];
      if (
        !locked ||
        locked.status !== "draft" ||
        Number(locked.version) !== input.expectedVersion
      )
        throw new AiToolError(
          "VERSION_CONFLICT",
          "The draft changed while it was being priced.",
          "Fetch the draft and retry with its current version.",
          409,
          { currentVersion: Number(locked?.version || 0) },
        );
      await sql`DELETE FROM ordering_order_promotion_applications WHERE order_id=${input.orderId}`;
      await sql`DELETE FROM ordering_order_items WHERE order_id=${input.orderId}`;
      await sql`UPDATE ordering_order_items SET order_id=${input.orderId} WHERE order_id=${temporary.id}`;
      await sql`UPDATE ordering_order_promotion_applications SET order_id=${input.orderId} WHERE order_id=${temporary.id}`;
      await sql`UPDATE ordering_orders target SET service_type=source.service_type,timing_mode=source.timing_mode,scheduled_for=source.scheduled_for,timing_message_snapshot=source.timing_message_snapshot,customer_id=source.customer_id,customer_phone_id=source.customer_phone_id,first_name_snapshot=source.first_name_snapshot,last_name_snapshot=source.last_name_snapshot,phone_snapshot=source.phone_snapshot,subtotal_cents=source.subtotal_cents,discount_cents=source.discount_cents,tax_cents=source.tax_cents,tip_cents=source.tip_cents,delivery_fee_cents=0,total_cents=source.total_cents,amount_due_cents=source.amount_due_cents,version=target.version+1,updated_at=NOW() FROM ordering_orders source WHERE target.id=${input.orderId} AND source.id=${temporary.id}`;
      await sql`DELETE FROM ordering_orders WHERE id=${temporary.id}`;
    });
  } catch (error) {
    await getSql()`DELETE FROM ordering_orders WHERE id=${temporary.id}`;
    throw error;
  }
  return pricedOrder(input.orderId, input.business);
}

export async function holdDraft(orderId: string, business: OrderingBusiness) {
  const order = await pricedOrder(orderId, business);
  const missing: string[] = [];
  if (order.status !== "draft")
    throw new AiToolError(
      "VALIDATION_REQUIRED",
      "Only draft orders can be held.",
      "Use the current order state.",
    );
  if (order.service_type === "undecided") missing.push("serviceType");
  if (!(order.lines as unknown[]).length) missing.push("items");
  if (
    ["delivery", "no_contact_delivery"].includes(String(order.service_type))
  ) {
    const address = (
      await getSql()`SELECT order_id,validation_status,route_distance_miles FROM ordering_order_delivery_addresses WHERE order_id=${orderId}`
    )[0];
    if (!address) missing.push("deliveryAddress");
    else if (
      address.validation_status !== "validated" ||
      address.route_distance_miles == null
    )
      missing.push("deliveryValidation");
  }
  if (!String(order.first_name_snapshot || "").trim())
    missing.push("customer.firstName");
  if (
    !String(order.phone_snapshot || "").trim() &&
    ["pickup", "delivery", "no_contact_delivery", "curbside"].includes(
      String(order.service_type),
    )
  )
    missing.push("customer.phone");
  return {
    order,
    hold: {
      accepted: true,
      sendReady: missing.length === 0,
      missingFields: missing,
      remedy: missing.length
        ? "Collect the listed fields, update the same draft, then HOLD again."
        : "Read back the server total and obtain customer confirmation before SEND.",
    },
  };
}

export async function sendDraft(
  orderId: string,
  business: OrderingBusiness,
  actor: OrderingActor,
) {
  try {
    return await submitDraftOrder(orderId, business, actor);
  } catch (error) {
    if (error instanceof OrderConflictError)
      throw new AiToolError(
        "SEND_BLOCKED",
        error.message,
        "Resolve the validation issue on the draft, HOLD again, and retry SEND.",
      );
    throw error;
  }
}

export async function customerLookup(
  business: OrderingBusiness,
  query: string,
) {
  if (query.trim().length < 3)
    throw new AiToolError(
      "INVALID_INPUT",
      "Customer lookup needs at least three characters or digits.",
      "Ask for a full phone number or more of the customer's name.",
      400,
    );
  return findCustomers(business, query);
}
export async function promotions(business: OrderingBusiness) {
  await ensureOrderingPromotionSchema();
  return getSql()`SELECT id,name,customer_label,automatic,priority,starts_at,ends_at FROM ordering_promotions WHERE business=${business} AND active=TRUE AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>=NOW()) ORDER BY priority DESC,id`;
}
export async function deliveryQuote(
  business: OrderingBusiness,
  distanceMiles: number,
  subtotalCents: number,
) {
  if (
    !Number.isFinite(distanceMiles) ||
    !Number.isInteger(subtotalCents) ||
    subtotalCents < 0
  )
    throw new AiToolError(
      "INVALID_INPUT",
      "Distance and merchandise subtotal are invalid.",
      "Use routed distance and server-priced merchandise subtotal in integer cents.",
      400,
    );
  return quoteDelivery({
    business,
    distanceMiles,
    merchandiseSubtotalCents: subtotalCents,
  });
}

export async function auditAiTool(input: {
  business: OrderingBusiness;
  requestId: string;
  conversationId: string;
  tool: string;
  actor: OrderingActor;
  orderId?: string;
  customerId?: string;
  outcome: "success" | "blocked" | "error";
  errorCode?: string;
  inputSummary: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
  durationMs: number;
  model?: string;
}) {
  await ensureOrderingAiSchema();
  await getSql()`INSERT INTO ordering_ai_tool_events(id,business,request_id,conversation_id,tool_name,actor_id,order_id,customer_id,outcome,error_code,input_summary,result_summary,duration_ms,model) VALUES(${randomUUID()},${input.business},${input.requestId},${input.conversationId},${input.tool},${input.actor.id},${input.orderId || null},${input.customerId || null},${input.outcome},${input.errorCode || ""},${JSON.stringify(input.inputSummary)}::jsonb,${JSON.stringify(input.resultSummary)}::jsonb,${input.durationMs},${input.model || ""})`;
}
