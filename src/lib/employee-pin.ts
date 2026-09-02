import type { Business } from "@/lib/types";

export function employeePinLength(_business: Business): 5 {
  return 5;
}

export function employeePinLabel(business: Business): string {
  return business === "Corner Deli" ? "Four- or five-digit PIN" : "Five-digit PIN";
}

export function employeePinPattern(business: Business): string {
  return business === "Corner Deli" ? "\\d{4,5}" : "\\d{5}";
}

export function validateEmployeePin(business: Business, value: unknown, employeeName = "Employee"): string {
  const pin = String(value ?? "").trim();
  const pattern = business === "Corner Deli" ? /^\d{4,5}$/ : /^\d{5}$/;
  if (!pattern.test(pin)) {
    throw new Error(
      business === "Corner Deli"
        ? `${employeeName} PIN must contain 4 or 5 digits.`
        : `${employeeName} PIN must contain exactly 5 digits.`,
    );
  }
  return pin;
}
