import type { OrderingBusiness, ServiceType } from "@/lib/ordering-core";

export type PosUtility =
  | "orders"
  | "cash_drawer"
  | "drivers"
  | "bar_tabs"
  | "inventory"
  | "reports"
  | "manager";

export type OrderingBusinessConfig = {
  business: OrderingBusiness;
  slug: "deli" | "tiki";
  posPath: string;
  reportsPath: string;
  serviceTypes: ServiceType[];
  utilities: PosUtility[];
  features: {
    delivery: boolean;
    deliveryPricing: boolean;
    drivers: boolean;
    barTabs: boolean;
    taxInclusivePricing: boolean;
  };
};

/**
 * Corner Deli and Tiki share ordering primitives and infrastructure, but they
 * are separate POS/reporting products. Business-specific behavior belongs in
 * this configuration rather than being hidden behind a runtime business
 * switch inside one POS screen.
 *
 * Actual tax rates, delivery minimums, mileage boundaries, and fees are stored
 * in editable database settings rather than hard-coded here.
 */
export const orderingBusinessConfigs: Record<OrderingBusiness, OrderingBusinessConfig> = {
  "Corner Deli": {
    business: "Corner Deli",
    slug: "deli",
    posPath: "/pos/deli",
    reportsPath: "/pos/deli/reports",
    serviceTypes: ["pickup", "delivery", "no_contact_delivery", "dine_in", "curbside"],
    utilities: ["orders", "cash_drawer", "drivers", "inventory", "reports", "manager"],
    features: {
      delivery: true,
      deliveryPricing: true,
      drivers: true,
      barTabs: false,
      taxInclusivePricing: true,
    },
  },
  Tiki: {
    business: "Tiki",
    slug: "tiki",
    posPath: "/pos/tiki",
    reportsPath: "/pos/tiki/reports",
    serviceTypes: ["bar", "pickup", "dine_in"],
    utilities: ["orders", "cash_drawer", "bar_tabs", "inventory", "reports", "manager"],
    features: {
      delivery: false,
      deliveryPricing: false,
      drivers: false,
      barTabs: true,
      taxInclusivePricing: true,
    },
  },
};

export function orderingBusinessConfig(business: OrderingBusiness): OrderingBusinessConfig {
  return orderingBusinessConfigs[business];
}
