import type { OrderStatus, PaymentStatus, ServiceType } from "@/lib/ordering-core";

export type PosTenderType =
  | "cash"
  | "card"
  | "house_account"
  | "employee_meal"
  | "manager_comp"
  | "store_credit"
  | "gift_card"
  | "other";

export type OrderEditDecision = {
  editable: boolean;
  mode: "direct" | "delta_ticket" | "supplemental_order" | "blocked";
  reason: string;
};

export type CapacityWindowState = {
  maxOrders?: number | null;
  currentOrders: number;
  maxPoints?: number | null;
  currentPoints: number;
  requestedPoints?: number;
  status?: "open" | "limited" | "closed";
};

export type CapacityDecision = {
  available: boolean;
  orderSlotsRemaining: number | null;
  pointsRemaining: number | null;
  reason: string;
};

export function decideOrderEditMode(input: {
  status: OrderStatus;
  locked: boolean;
}): OrderEditDecision {
  if (!input.locked && (input.status === "draft" || input.status === "confirmed")) {
    return { editable: true, mode: "direct", reason: "Order is still editable." };
  }

  if (!input.locked && (input.status === "sent_to_kitchen" || input.status === "in_progress")) {
    return {
      editable: true,
      mode: "delta_ticket",
      reason: "Changes must create an add-on/delta kitchen ticket.",
    };
  }

  if (input.status === "ready" || input.status === "completed") {
    return {
      editable: false,
      mode: "supplemental_order",
      reason: "Create a linked supplemental order instead of rewriting the original.",
    };
  }

  return { editable: false, mode: "blocked", reason: "This order cannot be edited." };
}

export function evaluateCapacity(input: CapacityWindowState): CapacityDecision {
  const requestedPoints = Math.max(0, Math.trunc(input.requestedPoints ?? 1));
  if (input.status === "closed") {
    return {
      available: false,
      orderSlotsRemaining: 0,
      pointsRemaining: 0,
      reason: "This fulfillment window is closed.",
    };
  }

  const orderSlotsRemaining =
    input.maxOrders == null ? null : Math.max(0, Math.trunc(input.maxOrders) - Math.max(0, Math.trunc(input.currentOrders)));
  const pointsRemaining =
    input.maxPoints == null ? null : Math.max(0, Math.trunc(input.maxPoints) - Math.max(0, Math.trunc(input.currentPoints)));

  const orderCapacityOk = orderSlotsRemaining == null || orderSlotsRemaining >= 1;
  const pointCapacityOk = pointsRemaining == null || pointsRemaining >= requestedPoints;
  const available = orderCapacityOk && pointCapacityOk;

  return {
    available,
    orderSlotsRemaining,
    pointsRemaining,
    reason: available ? "Capacity is available." : "This fulfillment window is at capacity.",
  };
}

export function calculateRegisterExpectedCash(input: {
  openingCashCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
  paidInCents?: number;
  paidOutCents?: number;
  cashDropsCents?: number;
  driverTurnInsCents?: number;
}): number {
  const values = [
    input.openingCashCents,
    input.cashSalesCents,
    input.cashRefundsCents,
    input.paidInCents ?? 0,
    input.paidOutCents ?? 0,
    input.cashDropsCents ?? 0,
    input.driverTurnInsCents ?? 0,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Cash reconciliation values must be non-negative integer cents.");
  }

  return (
    input.openingCashCents +
    input.cashSalesCents -
    input.cashRefundsCents +
    (input.paidInCents ?? 0) -
    (input.paidOutCents ?? 0) -
    (input.cashDropsCents ?? 0) +
    (input.driverTurnInsCents ?? 0)
  );
}

export function calculateOverShortCents(expectedCashCents: number, countedCashCents: number): number {
  if (![expectedCashCents, countedCashCents].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Expected and counted cash must be non-negative integer cents.");
  }
  return countedCashCents - expectedCashCents;
}

export function sumTenderCents(
  tenders: Array<{ type: PosTenderType; amountCents: number; status?: "pending" | "approved" | "voided" | "refunded" }>,
): number {
  return tenders.reduce((sum, tender) => {
    if (!Number.isSafeInteger(tender.amountCents) || tender.amountCents < 0) {
      throw new Error("Tender amounts must be non-negative integer cents.");
    }
    if (tender.status && tender.status !== "approved") return sum;
    return sum + tender.amountCents;
  }, 0);
}

export function paymentStatusFromAmounts(totalCents: number, paidCents: number): PaymentStatus {
  if (![totalCents, paidCents].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Payment amounts must be non-negative integer cents.");
  }
  if (paidCents <= 0) return "unpaid";
  if (paidCents < totalCents) return "partially_paid";
  return "paid";
}

export function serviceTypeRequiresAddress(serviceType: ServiceType): boolean {
  return serviceType === "delivery" || serviceType === "no_contact_delivery";
}

export function serviceTypeSupportsArrivalCheckIn(serviceType: ServiceType): boolean {
  return serviceType === "curbside";
}

export function calculateDriverSettlement(input: {
  orders: Array<{ orderId: string; amountDueCents: number; include?: boolean }>;
  turnedInCashCents: number;
}): {
  includedOrderIds: string[];
  orderCount: number;
  expectedCashCents: number;
  turnedInCashCents: number;
  overShortCents: number;
} {
  if (!Number.isSafeInteger(input.turnedInCashCents) || input.turnedInCashCents < 0) {
    throw new Error("turnedInCashCents must be non-negative integer cents.");
  }

  const included = input.orders.filter((order) => order.include !== false);
  for (const order of included) {
    if (!Number.isSafeInteger(order.amountDueCents) || order.amountDueCents < 0) {
      throw new Error(`Invalid amount due for order ${order.orderId}.`);
    }
  }

  const expectedCashCents = included.reduce((sum, order) => sum + order.amountDueCents, 0);
  return {
    includedOrderIds: included.map((order) => order.orderId),
    orderCount: included.length,
    expectedCashCents,
    turnedInCashCents: input.turnedInCashCents,
    overShortCents: input.turnedInCashCents - expectedCashCents,
  };
}

export function calculatePercentDiscountCents(subtotalCents: number, percent: number): number {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) {
    throw new Error("subtotalCents must be non-negative integer cents.");
  }
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("percent must be between 0 and 100.");
  }
  return Math.round((subtotalCents * percent) / 100);
}
