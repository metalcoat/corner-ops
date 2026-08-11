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
    drivers: boolean;
    barTabs: boolean;
  };
};

/**
 * Corner Deli and Tiki share ordering primitives and infrastructure, but they
 * are separate POS/reporting products. Business-specific behavior belongs in
 * this configuration rather than being hidden behind a runtime business
 * switch inside one POS screen.
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
      drivers: true,
      barTabs: false,
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
      drivers: false,
      barTabs: true,
    },
  },
};

export function orderingBusinessConfig(business: OrderingBusiness): OrderingBusinessConfig {
  return orderingBusinessConfigs[business];
}
