import { getSql } from "@/lib/db";
import type { OrderingBusiness, OrderSource, ServiceType } from "@/lib/ordering-core";
import { addConfiguredItem, createDraftOrder, recalculateOrder, type ConfiguredOrderItemInput } from "@/lib/ordering-orders";
import { resolveItemVariantPricing } from "@/lib/ordering-variant-pricing";

export type VariantConfiguredOrderItemInput = ConfiguredOrderItemInput & {
  variantId?: string | null;
};

export type CreateVariantDraftOrderInput = {
  orderStartedAt?: string | null;
  business: OrderingBusiness;
  source: OrderSource;
  serviceType: ServiceType;
  customerId?: string | null;
  customerPhoneId?: string | null;
  callerPhone?: string;
  customerFirstName?: string;
  customerLastName?: string;
  orderOrigin?: "pos"|"phone"|"web"|"ai";
  createdBy: string;
  createdByName?: string;
  items?: VariantConfiguredOrderItemInput[];
};

export async function appendConfiguredOrderItemsWithVariants(orderId: string, business: OrderingBusiness, items: VariantConfiguredOrderItemInput[]) {
  const ids: string[] = [];
  try {
    for (const item of items) {
      const variant = await resolveItemVariantPricing({ business, itemId: item.itemId, variantId: item.variantId || null });
      ids.push(await addConfiguredItem(orderId, business, item, variant));
    }
    await recalculateOrder(orderId);
    return ids;
  } catch (error) {
    if (ids.length) await getSql()`DELETE FROM ordering_order_items WHERE id=ANY(${ids})`;
    await recalculateOrder(orderId);
    throw error;
  }
}

/** Resolve size prices before applying included choices and quantity charges. */
export async function createDraftOrderWithVariants(input: CreateVariantDraftOrderInput) {
  const items = input.items || [];
  const variants = await Promise.all(items.map((item) => resolveItemVariantPricing({
    business: input.business, itemId: item.itemId, variantId: item.variantId || null,
  })));
  return createDraftOrder(input, variants);
}
