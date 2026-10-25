import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import type { OrderingBusiness, ServiceType } from "@/lib/ordering-core";
import type { VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import { createTimedDraftOrder } from "@/lib/ordering-timed-orders";
import { orderingMenuWithVariants } from "@/lib/ordering-menu-variants";
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
import {
  redactCallerCustomer,
  tenDigitPhone,
  type CallerCustomerRow,
} from "@/lib/ordering-ai-phone-guard";
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
  lineId?: string;
};
export type SpokenOrderItem = {
  lineId?: string;
  name: string;
  variant?: string;
  quantity?: number;
  modifiers?: Array<{
    name: string;
    group?: string;
    remove?: boolean;
    placement?: "side" | "topping";
    portion?: "whole" | "left_half" | "right_half";
    amount?: "regular" | "extra" | "double_extra" | "triple_extra";
  }>;
};

type RemovalGroup = {
  id: string;
  name: string;
  presentationContext?: string;
  options: Array<{ id: string; name: string; available: boolean }>;
};

/** Recipe omissions are real catalog selections (e.g. No Tomato), not missing toppings. */
export function resolveSpokenModifierRemoval(
  groups: RemovalGroup[],
  edit: NonNullable<SpokenOrderItem["modifiers"]>[number],
) {
  const negative =
    /^(?:no|without|remove|hold|skip|leave off|take off)\s+(.+)$/i.exec(
      edit.name.trim(),
    );
  if (!negative && !edit.remove) return null;
  const key = (value: string) =>
    spokenKey(value).replace(/\btomatoe\b/g, "tomato");
  const choices = groups
    .filter(
      (group) =>
        group.presentationContext !== "hidden" &&
        (!edit.group || edit.group === group.name),
    )
    .flatMap((group) =>
      group.options
        .filter((option) => option.available)
        .map((option) => ({ group, option })),
    );
  const matches = (name: string) =>
    choices.filter(({ group, option }) =>
      modifierAliases(option.name, group.name).some(
        (alias) => key(alias) === key(name),
      ),
    );
  const choose = (candidates: typeof choices, remove: boolean) => {
    if (candidates.length !== 1)
      throw new AiToolError(
        "INVALID_MODIFIER",
        "That removal is invalid or ambiguous.",
        "Ask which ingredient and modifier group the caller means.",
        409,
      );
    return { ...candidates[0], remove };
  };
  const literal = matches(edit.name);
  if (literal.length) return choose(literal, Boolean(edit.remove));
  const subject = (negative?.[1] || edit.name).replace(/^the\s+/i, "");
  const omission = matches(`no ${subject}`);
  if (omission.length) return choose(omission, false);
  return choose(matches(subject), true);
}
/** "tomato" / "add the tomato back" when the recipe has it: the default, i.e. undo "No Tomato" (never add it). */
export function resolveSpokenRecipeRestore(
  groups: RemovalGroup[],
  edit: NonNullable<SpokenOrderItem["modifiers"]>[number],
) {
  if (edit.remove || /^(?:no|without|remove|hold|skip|leave off|take off)\s/i.test(edit.name.trim())) return null;
  const subject = edit.name
    .trim()
    .replace(/^(?:add|with|put|regular)\s+(?:the\s+)?/i, "")
    .replace(/\s+(?:back(?:\s+on)?|on it)$/i, "");
  const key = (value: string) =>
    spokenKey(value).replace(/\btomatoe\b/g, "tomato");
  const choices = groups
    .filter(
      (group) =>
        group.presentationContext !== "hidden" &&
        (!edit.group || edit.group === group.name),
    )
    .flatMap((group) =>
      group.options
        .filter((option) => option.available)
        .map((option) => ({ group, option })),
    );
  const matches = (name: string) =>
    choices.filter(({ group, option }) =>
      modifierAliases(option.name, group.name).some(
        (alias) => key(alias) === key(name),
      ),
    );
  if (matches(subject).length || matches(edit.name).length) return null;
  const omission = matches(`no ${subject}`);
  return omission.length === 1 ? omission[0] : null;
}
/** No X and Xtra/Add X for the same ingredient can't both be on a line; the newer one wins. */
export const ingredientRoot = (name: string) => {
  const match = /^(no|xtra|extra|add|light|lite)\s+(.+)$/i.exec(name.trim());
  return match ? { prefix: match[1].toLowerCase(), root: spokenKey(match[2]).replace(/\btomatoe\b/g, "tomato") } : null;
};
export const conflictingIngredient = (chosen: string, other: string) => {
  const a = ingredientRoot(chosen), b = ingredientRoot(other);
  return Boolean(a && b && a.root === b.root && (a.prefix === "no") !== (b.prefix === "no"));
};
/**
 * Model-supplied modifiers in the item's own terms: a group name that isn't on the item ("Dipping Sauce"
 * for "Dipping Sauces dinner (4oz)") maps to the item's matching group; "bbq sauce" is "BBQ"
 * when only the shorter name is an option. Dev test call 2026-10-25: a Chicken Tender Dinner's sauce was
 * refused twice and the dinner dropped.
 */
export function normalizeSpokenModifier(
  groups: RemovalGroup[],
  modifier: NonNullable<SpokenOrderItem["modifiers"]>[number],
) {
  let next = { ...modifier };
  if (next.group && !groups.some((group) => group.name === next.group)) {
    const wanted = spokenKey(next.group);
    const related = groups.filter((group) => {
      const key = spokenKey(group.name);
      return key.includes(wanted) || wanted.includes(key);
    });
    const preferred = related.filter((group) => !/\b(?:extra|add)\b/i.test(group.name));
    const required = related.filter((group) => (group as { minSelections?: number }).minSelections);
    const pick = related.length === 1 ? related[0] : required.length === 1 ? required[0] : preferred.length === 1 ? preferred[0] : undefined;
    // Several look-alike groups: let the required one below decide. No look-alike group at all keeps the
    // caller's group, so "Mild" in "Dressing" stays an error.
    if (pick) next = { ...next, group: pick.name };
    else if (related.length) delete next.group;
  }
  const options = groups
    .filter((group) => !next.group || group.name === next.group)
    .flatMap((group) => group.options.map((option) => ({ group, option })));
  const known = (name: string) =>
    options.some(({ group, option }) => modifierAliases(option.name, group.name).some((alias) => spokenKey(alias) === spokenKey(name)));
  const shorter = next.name.replace(/\s+(?:sauce|dip|dipping sauce)$/i, "");
  if (shorter !== next.name && !known(next.name) && known(shorter)) next = { ...next, name: shorter };
  if (!next.group && !next.remove) {
    // "BBQ" fits several groups on a dinner (included cup, extra cups, sauced tenders): the required one wins.
    const holders = groups.filter(
      (group) =>
        (group as { minSelections?: number }).minSelections &&
        group.presentationContext !== "hidden" &&
        group.options.some((option) => option.available && modifierAliases(option.name, group.name).some((alias) => spokenKey(alias) === spokenKey(next.name))),
    );
    const anywhere = groups.filter((group) =>
      group.options.some((option) => modifierAliases(option.name, group.name).some((alias) => spokenKey(alias) === spokenKey(next.name))),
    );
    if (holders.length === 1 && anywhere.length > 1) next = { ...next, group: holders[0].name };
  }
  return next;
}
/** The 4oz cup menu item a spoken side names ("side of ranch", "ranch"), if there is one. */
export async function sideCupItemName(name: string) {
  const cleaned = name
    .replace(/^(?:an?\s+)?(?:extra\s+|side\s+(?:of\s+)?|cup\s+of\s+)/i, "")
    .replace(/\s+(?:sauce|dip|cup|on the side)$/i, "")
    .trim();
  if (!cleaned || /^(?:no|without|hold)\b/i.test(cleaned)) return null;
  const items = (await menuCatalog("Corner Deli", new Date())).flatMap((category: any) => category.items || []);
  return (
    items
      .map((item: any) => String(item.name))
      .filter((itemName) => /\b4\s*oz\b|\(\s*4\s*oz\s*\)/i.test(itemName) && spokenKey(normalizedSpokenName(itemName)) === spokenKey(cleaned))
      .sort()[0] || null
  );
}
/** "Feeds 3 · 1.00 lb" can be asked for as "a pound", "1 lb", "one pound" or "feeds 3". */
export function weightVariantAliases(name: string) {
  const match = /^feeds\s+(\d+)\s*\S*\s*(\d+(?:\.\d+)?)\s*lb/i.exec(name.trim());
  if (!match) return [];
  const feeds = match[1], pounds = Number(match[2]);
  const plain = Number.isInteger(pounds) ? String(pounds) : String(pounds);
  const words: Record<string, string[]> = {
    "0.5": ["half pound", "half a pound", "half lb"],
    "0.75": ["three quarter pound", "three quarters of a pound", "3 quarter pound"],
    "1": ["pound", "a pound", "one pound"],
    "1.5": ["pound and a half", "a pound and a half", "one and a half pound"],
    "2": ["two pound", "two pounds"],
    "3": ["three pound", "three pounds"],
  };
  return [`feeds ${feeds}`, `${plain} lb`, `${plain} pound`, `${plain} pounds`, ...(words[String(pounds)] || [])];
}
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
    await sql`SELECT id,cart_line_id,cart_line_id AS "lineId",item_id,item_name_snapshot,variant_id,variant_name_snapshot,quantity,unit_price_cents,modifier_total_cents,combo_total_cents,line_total_cents,special_instructions FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`;
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
  const ids=input.items.map(item=>item.lineId).filter((id): id is string=>Boolean(id));
  if(new Set(ids).size!==ids.length || ids.some(id=>! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))) throw new AiToolError("INVALID_INPUT","Cart line IDs must be unique UUIDs.","Read the current cart IDs.",409);
  return withTransaction(async()=>{
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
  const lines = await getSql()`SELECT id FROM ordering_order_items WHERE order_id=${String(order.id)} ORDER BY sort_order,created_at,id`;
  for (let index = 0; index < lines.length; index++) {
    if (input.items[index]?.lineId) await getSql()`UPDATE ordering_order_items SET cart_line_id=${input.items[index].lineId} WHERE id=${lines[index].id}`;
  }
  return pricedOrder(String(order.id), input.business);
  });
}

export const spokenKey = (value: string) =>
  value
    .toLocaleLowerCase()
    // The menu says BBQ; callers (and the model) say barbecue (dev test call 2026-10-25).
    .replace(/\bbarbe(?:c|q)ue\b|\bbar[\s-]*b[\s-]*q(?:ue)?\b/g, "bbq")
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
  "mac and cheese bite 6": [
    "mac bites",
    "mac and cheese bites",
    "mac n cheese bites",
    "macaroni and cheese bites",
  ],
  "deep fried cheese curd": [
    "fried cheese curd",
    "fried cheese curds",
    "cheese curd",
    "cheese curds",
  ],
  ogdensburger: ["ogdens burger", "ogden burger", "ogdens"],
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
    aliases.push(
      "mozz sticks",
      "mozz stick",
      "mop sticks",
      "mop stick",
      "cheese sticks",
      "cheese stick",
    );
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
  if (/russian.*thousand island|thousand island.*russian/.test(simple))
    aliases.push("russian", "russian dressing", "thousand island", "thousand islands");
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
  if (/^un cooked$/.test(simple))
    aliases.push("uncooked", "uncooked pizza", "not cooked", "take and bake");
  if (/sweet and sassy/.test(simple))
    aliases.push("sexy sweet", "sassy sweet", "sweet sassy");
  if (/^light sauce$/.test(simple))
    aliases.push("light red sauce", "light pizza sauce", "easy sauce");
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
  // Several menu items match ("mashed potatoes": Small and Medium): that's a question for the caller,
  // not "we don't have it" (dev test call 2026-10-25).
  const ambiguous = (candidates: Array<{ row: T; terms: string[] }>) => {
    if (code !== "ITEM_NOT_ON_MENU")
      return new AiToolError(code, `${kind} is ambiguous: ${query}.`, "Ask one short clarification question.", 409);
    const names = [...new Set(candidates.map((candidate) => terms(candidate.row)[0]))].slice(0, 4);
    const question = `Which one would you like: ${names.slice(0, -1).join(", ")}${names.length > 1 ? " or " : ""}${names[names.length - 1]}?`;
    return new AiToolError("FOLLOW_UP_REQUIRED", question, `Ask: ${question}`, 409, {
      options: names,
      pendingItem: { category: spokenKey(query), customerRequest: query, missingRequiredFields: ["menu item"] },
    });
  };
  // Duplicate menu rows that say the same thing ("Ranch (4oz)" and "4 oz Ranch") aren't a question for the caller.
  const sameItem = (candidates: Array<{ row: T; terms: string[] }>) =>
    code === "ITEM_NOT_ON_MENU" && new Set(candidates.map((candidate) => spokenKey(String(terms(candidate.row)[1] ?? "")).replace(/\s+/g, ""))).size === 1
      ? [...candidates].sort((a, b) => String(terms(a.row)[0]).localeCompare(String(terms(b.row)[0])))[0].row
      : undefined;
  const wanted = spokenKey(query),
    all = rows.map((row) => ({ row, terms: terms(row).map(spokenKey) })),
    exact = all.filter((candidate) => candidate.terms.includes(wanted)),
    // "tomato" must never fuzzy-match "No Tomato" (or "no onions" match "Onions").
    negated = (term: string) => /^(?:no|without|hold|skip|remove|minus)\b/.test(term),
    indexed = all.map((candidate) => ({
      ...candidate,
      terms: candidate.terms.filter((term) => negated(term) === negated(wanted)),
    }));
  if (exact.length === 1) return exact[0].row;
  if (exact.length > 1)
    { const same = sameItem(exact); if (same) return same; throw ambiguous(exact); }
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
    { const same = sameItem(bestContained); if (same) return same; throw ambiguous(bestContained); }
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
    { const same = sameItem(partial); if (same) return same; throw ambiguous(partial); }
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
      : code === "INVALID_MODIFIER"
        ? "Do not add it as an option. If it is a dipping sauce or side cup (ranch, blue cheese, nacho), add it as its own item with operation add, e.g. name \"side of ranch\"."
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
        "FOLLOW_UP_REQUIRED",
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
  // "Large fries, and can I get a ranch with that": ranch isn't a fry option, so it becomes its own 4oz cup
  // (owner request 2026-10-25) instead of an error the caller has to work around.
  const extraCups: SpokenOrderItem[] = [];
  const sideCupFor = (
    groups: RemovalGroup[],
    modifier: NonNullable<SpokenOrderItem["modifiers"]>[number],
  ) => {
    // An explicit group means the caller (or model) meant an option of this item: a wrong one stays an error.
    if (modifier.group || modifier.remove || /^(?:no|without|hold)\b/i.test(modifier.name.trim())) return null;
    const cleaned = modifier.name
      .replace(/^(?:an?\s+)?(?:extra\s+|side\s+(?:of\s+)?|cup\s+of\s+)/i, "")
      .replace(/\s+(?:sauce|dip|cup|on the side)$/i, "")
      .trim();
    const keys = new Set([spokenKey(modifier.name), spokenKey(cleaned)]);
    const isOption = groups.some((group) =>
      group.options.some((option) => modifierAliases(option.name, group.name).some((alias) => keys.has(spokenKey(alias)))),
    );
    if (isOption) return null;
    return (
      allItems
        .filter((row) => /\b4\s*oz\b|\(\s*4\s*oz\s*\)/i.test(row.name) && spokenKey(normalizedSpokenName(row.name)) === spokenKey(cleaned))
        .map((row) => row.name)
        .sort()[0] || null
    );
  };
  const resolveOne = (requested: SpokenOrderItem): AiItemInput => {
      // "side of ranch", "ranch sauce", "a cup of blue cheese": the 4oz cup item when that's what it names.
      const cupName = requested.name
        .replace(/^(?:an?\s+)?(?:extra\s+)?(?:side|cup|container)\s+of\s+/i, "")
        .replace(/\s+(?:sauce|dip|cup|on the side)$/i, "")
        .trim();
      if (cupName !== requested.name.trim() && allItems.some((row) => spokenKey(normalizedSpokenName(row.name)) === spokenKey(cupName)))
        requested = { ...requested, name: cupName, variant: undefined };
      const mashedPhrase = /^(?:(small|sm|medium|med)\s+)?mashed(?:\s+potato(?:e)?s?)?(?:\s+(?:and|with|w\/?)\s+(?:some\s+)?(gravy))?$/i.exec(requested.name.trim());
      if (mashedPhrase && (mashedPhrase[1] || mashedPhrase[2])) {
        // "mashed potatoes and gravy" is the mashed side plus its Gravy option, not a dish called that.
        const size = mashedPhrase[1] ? (/^s/i.test(mashedPhrase[1]) ? "Small" : "Medium") : "";
        requested = {
          ...requested,
          name: size ? `${size} Mashed Potatoes` : "mashed potatoes",
          modifiers: [...(requested.modifiers || []), ...(mashedPhrase[2] ? [{ name: "Gravy" }] : [])],
        };
      }
      const fryPhrase = /^(small|large) (?:french )?fries?\s+(?:with\s+)?(nacho(?: cheese)?|cheese sauce|gravy)(.*)$/i.exec(requested.name);
      if(fryPhrase && !/cheese and gravy/i.test(requested.name)) requested = {...requested, name: fryPhrase[1]+" French Fries", modifiers:[...(requested.modifiers || []),{name: /^gravy$/i.test(fryPhrase[2]) ? "Gravy" : "Nacho Cheese", placement: /\b(?:on (?:the )?(?:fries|them|top)|over)\b/i.test(fryPhrase[3]) ? "topping" : "side"}]};
      const rawName = spokenKey(requested.name),
        rawInputVariant = spokenKey(requested.variant || "");
      if (
        /\b(?:tater\s+)?tot\b/.test(rawName) &&
        !/\b(?:small|large)\b/.test(rawName) &&
        !rawInputVariant &&
        !/\b(?:poutine|poutin|pountine|poutene|protein)\b/.test(rawName)
      )
        throw new AiToolError(
          "FOLLOW_UP_REQUIRED",
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
          "FOLLOW_UP_REQUIRED",
          "Small or large?",
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
      const wingSauceVariant = allItems.filter(entry => /wings?$/i.test(entry.name)).flatMap(entry => entry.modifiers.filter(group => group.name === "Wing Sauce").flatMap(group => group.options.map(option => ({group, option})))).find(({group, option}) => modifierAliases(option.name, group.name).some(alias => spokenKey(alias) === spokenKey(requested.variant || "")));
      if (spokenKey(requested.name).includes("wing") && wingSauceVariant)
        requested = {...requested, variant: undefined, modifiers: [...(requested.modifiers || []), {name: wingSauceVariant.option.name, group: "Wing Sauce"}]};
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
            "FOLLOW_UP_REQUIRED",
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
      const wingSpeech = `${spokenKey(requested.name)} ${spokenKey(requested.variant || "")}`
          .replace(/\btwo dozen\b/g, "24")
          .replace(/\b(?:a |one )?dozen\b/g, "12"),
        wingRequest =
          wingSpeech.includes("wing") ||
          (/\b(?:bone in|traditional|boneles)\b/.test(
            wingSpeech,
          ) &&
            /\b(10|12|15|20|24|25|30|40|50)\b/.test(wingSpeech)),
        explicitWingCount =
          /\b(10|12|15|20|24|25|30|40|50)\b/.test(wingSpeech) ||
          [10, 12, 15, 20, 24, 25, 30, 40, 50].includes(
            Number(requested.quantity),
          );
      if (wingRequest && !explicitWingCount)
        throw new AiToolError(
          "FOLLOW_UP_REQUIRED",
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
          "FOLLOW_UP_REQUIRED",
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
          // "Pizza Sub" / "pizza sub" is the sub, not a pizza.
          (!pizzaLogsPhrase && spokenName.includes("pizza") && !/\bpizza (?:sub|wrap|hero|hoagie)\b/.test(spokenName) && !/\bsub\b/.test(spokenVariant)) ||
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
      if (/\bgarden salad\b/.test(spokenName))
        throw new AiToolError(
          "FOLLOW_UP_REQUIRED",
          "Would you like a Julienne salad, a fried or grilled chicken salad, or a large tossed salad?",
          "Ask exactly: Would you like a Julienne salad, a fried or grilled chicken salad, or a large tossed salad?",
          409,
          {
            options: [
              "Julienne Sal",
              "Fried Chicken Sal",
              "Grilled Chicken Sal",
              "LG Tossed Sal",
            ],
          },
        );
      if (varietyPhrase && !varietySize)
        throw new AiToolError(
          "FOLLOW_UP_REQUIRED",
          "The variety basket requires a size.",
          "Ask: Variety for two or four?",
          409,
          { options: ["Variety for TWO", "Variety for Four"] },
        );
      const regularMacSalad =
          /\b(?:mac|macaroni) salad\b/.test(spokenName) &&
          !/\b(?:party|bulk|pound|lb|feed|people)\b/.test(`${spokenName} ${spokenKey(requested.variant || "")}`),
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
        byWeight = /\b(?:feeds?|lbs?|pounds?|pound)\b/i.test(`${requested.name} ${requested.variant || ""}`),
        weightPhrase = byWeight && !requested.variant
          ? /\b(half (?:a )?pound|(?:a )?pound and a half|three quarters? (?:of a )?pound|(?:a|one|two|three) pounds?|\d+(?:\.\d+)?\s*(?:lbs?|pounds?)|feeds \d+)\b/i.exec(requested.name)?.[1]
          : undefined,
        itemCandidates = regularMacSalad
          ? allItems.filter(
              (row) =>
                spokenKey(row.name) === "mac salad" &&
                row.variants.some((variant) =>
                  /^(?:small|medium|large)\b/i.test(variant.name),
                ),
            )
          : // Deli salads exist twice: the counter item (Small/Medium/Large) and a by-the-pound catering item
            // ("Feeds 3 · 1.00 lb"). A weight or "feeds" picks the catering one; otherwise the counter one.
            allItems.filter((row) => {
              const catering = row.variants.length > 0 && row.variants.every((variant) => /^feeds\s+\d+/i.test(variant.name));
              if (!catering) return !byWeight || !allItems.some((twin) => twin !== row && spokenKey(normalizedSpokenName(twin.name)) === spokenKey(normalizedSpokenName(row.name)) && twin.variants.length > 0 && twin.variants.every((variant) => /^feeds\s+\d+/i.test(variant.name)));
              return byWeight || !allItems.some((twin) => twin !== row && spokenKey(normalizedSpokenName(twin.name)) === spokenKey(normalizedSpokenName(row.name)));
            }).filter((row) => {
              // Same-sounding items ("Popcorn Chicken" sub, "Pop Corn Chicken"): the one that has the asked-for size.
              const wanted = spokenKey(requested.variant || "");
              const nameKey = (value: string) => spokenKey(normalizedSpokenName(value)).replace(/\s+/g, "");
              const twins = allItems.filter((twin) => twin !== row && nameKey(twin.name) === nameKey(row.name));
              if (!twins.length) return true;
              const sized = (candidate: typeof row) => candidate.variants.some((variant) => spokenKey(variant.name) !== "");
              if (!wanted) {
                // "Hamburger" is the burger, "hamburger sub" the sub: a sized twin needs sub/wrap words.
                const subWords = /\b(?:sub|wrap|hero|hoagie|half|full)\b/.test(spokenName);
                return subWords ? sized(row) || !twins.some(sized) : !sized(row) || twins.every(sized);
              }
              const hasSize = (candidate: typeof row) =>
                candidate.variants.some((variant) => {
                  const key = spokenKey(variant.name);
                  return key !== "" && (key.includes(wanted) || wanted.includes(key));
                });
              return hasSize(row) || !twins.some(hasSize);
            }),
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
          // Only wings: "Feeds 50" on a deli salad is not 50 wings.
          ((item.name === "Wings" || item.name === "Boneless Wings")
            ? [...wingSpeech.matchAll(/\b(10|12|15|20|24|25|30|40|50)\b/g)][0]?.[1]
            : "") ||
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
        sizeWord = /\b(small|sm|medium|med|large|lg)\b/.exec(spokenName)?.[1],
        sizeWordVariant = sizeWord
          ? item.variants.find((row) => spokenKey(row.name).startsWith(spokenKey(sizeWord.replace(/^sm$/, "small").replace(/^med$/, "medium").replace(/^lg$/, "large"))))?.name
          : undefined,
        variantWanted = rawVariant || (weightPhrase ? spokenKey(weightPhrase.replace(/^a /i, "")) : "") || (sizeWordVariant ? spokenKey(sizeWordVariant) : "");
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
          "FOLLOW_UP_REQUIRED",
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
                ...weightVariantAliases(row.name),
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
        spokenModifiers = (requested.modifiers || []).map((modifier) => normalizeSpokenModifier(item.modifiers, modifier)),
        coldSubEverything =
          subItem &&
          /(?:sub|wrap)/i.test(String(variant?.name || requested.variant || "")) &&
          !/big boss/i.test(item.name) &&
          /\b(?:everything|all of it|all the toppings)\b/.test(mealIntentText);
      if (item.name === "Nacho Supreme") {
        const standardIngredients = /^(?:salsa|cheese|lettuce|tomato(?:es)?|onions?|black olives?|jalapenos?)$/;
        for (let index = spokenModifiers.length - 1; index >= 0; index--)
          if (standardIngredients.test(spokenKey(spokenModifiers[index].name)))
            spokenModifiers.splice(index, 1);
      }
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
      if (item.name === "Wings" || item.name === "Boneless Wings") {
        const flavorOptions = item.modifiers.find(group => group.name === "Wing Sauce")?.options.filter(option => option.available) || [];
        const aliases = flavorOptions.flatMap(option => modifierAliases(option.name,"Wing Sauce").map(alias => ({option,key:spokenKey(alias)}))).sort((a,b) => b.key.length-a.key.length);
        const extra = /\b(extra sauce|extra saucy|saucy)\b/.test(spokenName) || spokenModifiers.some(mod => /^(extra sauce|extra saucy|saucy)$/.test(spokenKey(mod.name)));
        if (extra) {
          const texts = [spokenName, ...spokenModifiers.map(mod => spokenKey(mod.name))];
          const flavor = aliases.find(({key}) => texts.some(text => (" "+text+" ").includes(" "+key+" ")));
          const cup = flavor && item.modifiers.filter(group => group.name !== "Wing Sauce").flatMap(group => group.options.map(option => ({group,option}))).find(({option}) => option.available && /\(\s*\d+(?:\.\d+)?\s*oz\s*\)/i.test(option.name) && modifierAliases(option.name, "Extra Sauce").some(alias => spokenKey(alias).replace(/\s+sauce$/, "") === flavor.key.replace(/\s+sauce$/, "")));
          for(let index=spokenModifiers.length-1; index>=0; index--) if (/^(extra sauce|extra saucy|saucy)$/.test(spokenKey(spokenModifiers[index].name))) spokenModifiers.splice(index,1);
          if(cup && !spokenModifiers.some(mod => mod.name===cup.option.name)) spokenModifiers.push({name:cup.option.name,group:cup.group.name});
        }
      }
      if (item.name === "Wings" || item.name === "Boneless Wings") {
        const group = item.modifiers.find(group => group.name === "Wing Sauce");
        const sauces = (group?.options || []).filter(option => option.available);
        const hasFlavor = spokenModifiers.some(mod => !mod.remove && mod.group !== "Extra Sauce" && sauces.some(option => modifierAliases(option.name, "Wing Sauce").some(alias => spokenKey(alias) === spokenKey(mod.name))));
        if (!hasFlavor) {
          const candidates = sauces.flatMap(option => modifierAliases(option.name, "Wing Sauce").map(alias => ({option, key: spokenKey(alias)}))).sort((a,b) => b.key.length-a.key.length);
          const sauce = candidates.find(({key}) => (" " + spokenName + " ").includes(" " + key + " "));
          if (sauce) spokenModifiers.push({name: sauce.option.name, group: "Wing Sauce"});
        }
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
      for (const originalModifier of spokenModifiers) {
        const sideCup = sideCupFor(item.modifiers, originalModifier);
        if (sideCup) {
          extraCups.push({ name: sideCup, quantity: 1 });
          continue;
        }
        const removal = resolveSpokenModifierRemoval(item.modifiers, originalModifier);
        if (removal?.remove) {
          modifierSelections[removal.group.id] = (modifierSelections[removal.group.id] || []).filter(id => id !== removal.option.id);
          continue;
        }
        const restore = removal ? null : resolveSpokenRecipeRestore(item.modifiers, originalModifier);
        if (restore) {
          modifierSelections[restore.group.id] = (modifierSelections[restore.group.id] || []).filter(id => id !== restore.option.id);
          continue;
        }
        const requestedModifier = removal ? {...originalModifier, name: removal.option.name, group: removal.group.name, remove: false} : originalModifier;
        const placementMatch = /^(?:(?:put|add|with) (?:the )?)?(nacho cheese|gravy)\b/i.exec(requestedModifier.name.replace(/chesse/gi,"cheese")),
          friesPlacement = /(?:French|Curly|Waffle) Fries$|Tater Tots$/i.test(item.name) && placementMatch,
          raw = friesPlacement ? spokenKey(placementMatch[1]) : spokenKey(requestedModifier.name),
          explicitOnItem = requestedModifier.placement === "topping" || (requestedModifier.placement !== "side" && !/on (?:the )?side/i.test(requestedModifier.name) && /\b(on (?:it|them|the|top|fries)|over|melted)\b/i.test(requestedModifier.name)),
          mealWithIncludedSalad = item.modifiers.some(
            (group) => group.name === "Choose a Salad (Dinner)",
          ),
          allChoices = item.modifiers
            .filter((group) => group.presentationContext !== "hidden" && (!requestedModifier.group || group.name === requestedModifier.group))
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
          saladDressingChoices = /salad/i.test(item.name)
            ? choices.filter(({ group }) =>
                /^(?:Choose Dressing(?: \(On Salad\))?|Dressing\/Options)$/.test(
                  group.name,
                ),
              )
            : [],
          freeSubCheeseChoices = item.variants.some(
            (candidate) => spokenKey(candidate.name) === "full sub",
          )
            ? choices.filter(({ group }) => group.name === "Free Cheese")
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
          steakToppingChoices = ["Steak", "Chicken Fajita", "Hot Sausage"].includes(item.name)
            ? choices.filter(({ group }) => group.name === "Stk Sub mod (3 for free)")
            : [],
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
              : steakToppingChoices.some(({ option, group }) =>
                    modifierAliases(option.name, group.name).some(
                      (alias) => spokenKey(alias) === raw,
                    ),
                  )
                ? steakToppingChoices
              : saladDressingChoices.some(({ option, group }) =>
                    modifierAliases(option.name, group.name).some(
                      (alias) => spokenKey(alias) === raw,
                    ),
                  )
                ? saladDressingChoices
                : freeSubCheeseChoices.some(({ option, group }) =>
                      modifierAliases(option.name, group.name).some(
                        (alias) => spokenKey(alias) === raw,
                      ),
                    )
                  ? freeSubCheeseChoices
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
          placementChoice = friesPlacement ? choices.find(({option}) => new RegExp(`^${raw}(?: on (?:the )?(?:side|frie))?$`, "i").test(spokenKey(option.name)) && (/on (?:the )?side/i.test(option.name) === !(requestedModifier.placement === "topping" || explicitOnItem)) ) : undefined,
          // An item with its own plain topping (Hot Dog Choices: Nacho Cheese) keeps it; the $1.75 fry cup is for fry items.
          ownTopping = friesPlacement ? [] : matchingChoices.filter(
            ({ option, group }) => spokenKey(option.name) === raw && !/fry|side/i.test(group.name),
          ),
          ownToppingChoice = ownTopping.find(({ group }) => /^hot dog choices$/i.test(group.name)) || (ownTopping.length === 1 ? ownTopping[0] : undefined),
          hasSideNacho = !ownToppingChoice && choices.some(
            ({ option }) => spokenKey(option.name) === "nacho cheese on side",
          ),
          key = placementChoice ? spokenKey(placementChoice.option.name) :
            raw === "nacho cheese" && !explicitOnItem && hasSideNacho
              ? "nacho cheese on side"
              : explicitSideSauce
                ? sideSauceKey
                : raw,
          { group, option } = strictMatch(
            key,
            placementChoice ? [placementChoice] : ownToppingChoice ? [ownToppingChoice] : matchingChoices,
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
                    ...(modifierSelections[group.id] || []).filter(
                      (id) =>
                        !conflictingIngredient(
                          option.name,
                          group.options.find((entry) => entry.id === id)?.name || "",
                        ),
                    ),
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
          !/big boss/i.test(item.name) &&
          !["Steak", "Chicken Fajita", "Hot Sausage"].includes(item.name),
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
      if (["Steak", "Chicken Fajita", "Hot Sausage"].includes(item.name)) {
        const selected = new Set(spokenModifiers.map((modifier) => spokenKey(modifier.name)));
        if (!input.resolvedPendingQuestions?.includes("steak_style_condiment") && !["mayonnaise", "mayo", "russian"].some((name) => selected.has(name)))
          throw new AiToolError("FOLLOW_UP_REQUIRED", "Mayo or Russian?", "Ask exactly: Mayo or Russian?", 409, { pendingItem: { category: spokenKey(item.name), customerRequest: requested.name, actualMenuItemId: item.id, actualVariantId: variant?.id || null, pendingQuestion: "steak_style_condiment", missingRequiredFields: ["steak-style condiment"] } });
        if (!input.resolvedPendingQuestions?.includes("steak_style_toppings") && !["mushrooms", "onions", "peppers"].some((name) => selected.has(name)))
          throw new AiToolError("FOLLOW_UP_REQUIRED", "Mushrooms, onions, or peppers?", "Ask exactly: Mushrooms, onions, or peppers?", 409, { pendingItem: { category: spokenKey(item.name), customerRequest: requested.name, actualMenuItemId: item.id, actualVariantId: variant?.id || null, pendingQuestion: "steak_style_toppings", missingRequiredFields: ["steak-style toppings"] } });
        if (!input.resolvedPendingQuestions?.includes("steak_style_cheese") && !["american", "swiss", "provolone"].some((name) => selected.has(name)))
          throw new AiToolError("FOLLOW_UP_REQUIRED", "American, Swiss, or Provolone?", "Ask exactly: American, Swiss, or Provolone?", 409, { pendingItem: { category: spokenKey(item.name), customerRequest: requested.name, actualMenuItemId: item.id, actualVariantId: variant?.id || null, pendingQuestion: "steak_style_cheese", missingRequiredFields: ["steak-style cheese"] } });
        if (!input.resolvedPendingQuestions?.includes("steak_style_double_meat") && !selected.has("double meat"))
          throw new AiToolError("FOLLOW_UP_REQUIRED", "Do you want double meat?", "Ask exactly: Do you want double meat?", 409, { pendingItem: { category: spokenKey(item.name), customerRequest: requested.name, actualMenuItemId: item.id, actualVariantId: variant?.id || null, pendingQuestion: "steak_style_double_meat", missingRequiredFields: ["steak-style double meat"] } });
      }
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
        throw new AiToolError("FOLLOW_UP_REQUIRED", question, question, 409, {
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
        lineId: requested.lineId || randomUUID(),
        itemId: item.id,
        variantId: variant?.id || null,
        quantity: wingCountWasQuantity
          ? 1
          : Math.max(1, Math.trunc(Number(requested.quantity || 1))),
        modifierSelections,
        pizzaToppings,
      };
    };
  const resolved: AiItemInput[] = spokenItems.map(resolveOne);
  for (let index = 0; index < extraCups.length && index < 10; index++) resolved.push(resolveOne(extraCups[index]));
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
/**
 * Phone-line lookup: only an exact match on the call's own caller ID, redacted
 * to an opaque id, first name, and last four phone digits. Spoken names or
 * numbers are never searched, so callers cannot enumerate other customers.
 */
export async function callerCustomerLookup(
  business: OrderingBusiness,
  callerPhone: string,
) {
  const local = tenDigitPhone(callerPhone);
  if (!local) return [];
  const rows = await getSql()`SELECT DISTINCT ON (customer.id) customer.id,customer.first_name,phone.normalized_phone FROM ordering_customer_phones phone JOIN ordering_customers customer ON customer.id=phone.customer_id WHERE customer.business=${business} AND customer.active=TRUE AND customer.merged_into_customer_id IS NULL AND phone.normalized_phone=${`+1${local}`} ORDER BY customer.id LIMIT 3`;
  return rows.map((row) => redactCallerCustomer(row as CallerCustomerRow));
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
