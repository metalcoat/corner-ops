export type OrderingBusiness = "Corner Deli" | "Tiki";

export type OrderSource = "pos" | "web" | "ai_phone" | "kiosk" | "import";

export type OrderStatus =
  | "draft"
  | "confirmed"
  | "sent_to_kitchen"
  | "in_progress"
  | "ready"
  | "completed"
  | "cancelled";

export type PaymentStatus =
  | "unpaid"
  | "pending"
  | "partially_paid"
  | "paid"
  | "partially_refunded"
  | "refunded"
  | "failed";

export type ServiceType =
  | "pickup"
  | "delivery"
  | "no_contact_delivery"
  | "dine_in"
  | "curbside"
  | "bar";

export type ModifierRequirement = {
  groupId: string;
  groupName: string;
  minSelections: number;
  maxSelections: number;
  selectedCount: number;
};

export type ModifierValidationIssue = {
  groupId: string;
  groupName: string;
  code: "too_few" | "too_many";
  required: number;
  actual: number;
};

export type FulfillmentValidationIssue = {
  code: "curbside_payment_required" | "sms_verification_required";
  message: string;
};

/**
 * Normalizes common US/Canada caller-ID formats to E.164-style +1XXXXXXXXXX.
 * Unknown/blocked/non-NANP values are returned in a conservative normalized
 * form instead of being treated as a verified customer identity.
 */
export function normalizeCallerPhone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }

  return digits;
}

/**
 * Required modifier validation is deterministic and channel-independent.
 * A POS button, web cart, or AI tool call cannot confirm an order item until
 * every attached modifier group satisfies these constraints.
 */
export function validateModifierRequirements(
  requirements: ModifierRequirement[],
): ModifierValidationIssue[] {
  const issues: ModifierValidationIssue[] = [];

  for (const requirement of requirements) {
    const min = Math.max(0, Math.trunc(requirement.minSelections));
    const max = Math.max(min, Math.trunc(requirement.maxSelections));
    const actual = Math.max(0, Math.trunc(requirement.selectedCount));

    if (actual < min) {
      issues.push({
        groupId: requirement.groupId,
        groupName: requirement.groupName,
        code: "too_few",
        required: min,
        actual,
      });
      continue;
    }

    if (actual > max) {
      issues.push({
        groupId: requirement.groupId,
        groupName: requirement.groupName,
        code: "too_many",
        required: max,
        actual,
      });
    }
  }

  return issues;
}

/**
 * Web orders that are not fully paid must prove control of the supplied phone
 * number before they can be confirmed or sent to the kitchen. This includes
 * delivery orders that select cash payment.
 */
export function requiresSmsVerification(input: {
  source: OrderSource;
  paymentStatus: PaymentStatus;
}): boolean {
  return input.source === "web" && input.paymentStatus !== "paid";
}

/**
 * Curbside web orders must be fully paid online before confirmation.
 */
export function requiresOnlinePrepayment(input: {
  source: OrderSource;
  serviceType: ServiceType;
}): boolean {
  return input.source === "web" && input.serviceType === "curbside";
}

export function validateFulfillmentForConfirmation(input: {
  source: OrderSource;
  serviceType: ServiceType;
  paymentStatus: PaymentStatus;
  smsVerified: boolean;
}): FulfillmentValidationIssue[] {
  const issues: FulfillmentValidationIssue[] = [];

  if (requiresOnlinePrepayment(input) && input.paymentStatus !== "paid") {
    issues.push({
      code: "curbside_payment_required",
      message: "Curbside web orders must be paid online before confirmation.",
    });
  }

  if (requiresSmsVerification(input) && !input.smsVerified) {
    issues.push({
      code: "sms_verification_required",
      message: "Unpaid web orders require SMS verification before confirmation.",
    });
  }

  return issues;
}

export function assertMoneyCents(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer number of cents.`);
  }
  return value;
}

export function calculateLineTotalCents(input: {
  quantity: number;
  unitPriceCents: number;
  modifierUnitDeltaCents?: number;
  comboUnitDeltaCents?: number;
}): number {
  const quantity = Math.trunc(input.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("quantity must be a positive integer.");
  }

  const unitPrice = assertMoneyCents(input.unitPriceCents, "unitPriceCents");
  const modifierDelta = input.modifierUnitDeltaCents ?? 0;
  const comboDelta = input.comboUnitDeltaCents ?? 0;
  if (!Number.isSafeInteger(modifierDelta)) {
    throw new Error("modifierUnitDeltaCents must be an integer number of cents.");
  }
  if (!Number.isSafeInteger(comboDelta)) {
    throw new Error("comboUnitDeltaCents must be an integer number of cents.");
  }

  const perUnit = unitPrice + modifierDelta + comboDelta;
  if (perUnit < 0) {
    throw new Error("The item price after modifiers and combo adjustments cannot be negative.");
  }

  const total = perUnit * quantity;
  if (!Number.isSafeInteger(total)) {
    throw new Error("Calculated line total exceeds the safe integer range.");
  }

  return total;
}

export function calculateAmountDueCents(totalCents: number, paidCents: number): number {
  const total = assertMoneyCents(totalCents, "totalCents");
  const paid = assertMoneyCents(paidCents, "paidCents");
  return Math.max(0, total - paid);
}
