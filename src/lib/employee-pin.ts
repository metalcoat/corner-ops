import type { Business } from "@/lib/types";

export function employeePinLength(_business: Business): 5 {
  return 5;
}

export function employeePinLabel(_business: Business): string {
  return "Five-digit PIN";
}

export function employeePinPattern(business: Business): string {
  return `\\d{${employeePinLength(business)}}`;
}

export function validateEmployeePin(business: Business, value: unknown, employeeName = "Employee"): string {
  const pin = String(value ?? "").trim();
  const length = employeePinLength(business);
  const pattern = new RegExp(`^\\d{${length}}$`);
  if (!pattern.test(pin)) {
    throw new Error(`${employeeName} PIN must contain exactly ${length} digits.`);
  }
  return pin;
}
