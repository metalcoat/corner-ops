import type { Business } from "@/lib/types";

export function employeePinLength(business: Business): 4 | 5 {
  return business === "Corner Deli" ? 4 : 5;
}

export function employeePinLabel(business: Business): string {
  return business === "Corner Deli" ? "Four-digit PIN" : "Five-digit PIN";
}

export function employeePinPattern(business: Business): string {
  return business === "Corner Deli" ? "\\d{4}" : "\\d{5}";
}

export function validateEmployeePin(business: Business, value: unknown, employeeName = "Employee"): string {
  const pin = String(value ?? "").trim();
  // Keep accepting legacy 5-digit Corner Deli PINs at sign-in/reset so existing staff are not locked out.
  // New Deli PINs are constrained to four digits by employeePinLength/employeePinPattern in management UI.
  const pattern = business === "Corner Deli" ? /^\d{4,5}$/ : /^\d{5}$/;
  if (!pattern.test(pin)) {
    throw new Error(
      business === "Corner Deli"
        ? `${employeeName} PIN must contain 4 digits (legacy 5-digit PINs remain accepted).`
        : `${employeeName} PIN must contain exactly 5 digits.`,
    );
  }
  return pin;
}
