import type { Business } from "@/lib/types";

export function employeePinLength(business: Business): 4 | 5 {
  return business === "Corner Deli" ? 4 : 5;
}

export function employeePinLabel(business: Business): string {
  return business === "Corner Deli" ? "Four-digit PIN" : "Five-digit PIN";
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
