function text(payload: Record<string, unknown>, key: string): string {
  return String(payload[key] ?? "").trim();
}

function requireFields(payload: Record<string, unknown>, fields: Array<[string, string]>, errors: string[]) {
  for (const [key, label] of fields) {
    if (!text(payload, key)) errors.push(`${label} is required.`);
  }
}

export function employeeI9ValidationErrors(payload: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const status = text(payload, "citizenshipStatus");
  if (status === "permanent-resident") {
    if (!text(payload, "uscisOrAlienNumber")) {
      errors.push("USCIS or A-Number is required for a lawful permanent resident.");
    }
  }
  if (status === "authorized-alien") {
    if (!text(payload, "workAuthorizationExpires")) {
      errors.push("Work authorization expiration is required when work authorization has an expiration date.");
    }
    const uscis = text(payload, "uscisOrAlienNumber");
    const i94 = text(payload, "i94Number");
    const passport = text(payload, "foreignPassportNumber");
    if (!uscis && !i94 && !passport) {
      errors.push("Provide the USCIS/A-Number, Form I-94 number, or foreign passport information for work authorization.");
    }
    if (passport && !text(payload, "foreignPassportCountry")) {
      errors.push("Country of issuance is required with a foreign passport number.");
    }
  }
  return errors;
}

export function employerI9ValidationErrors(payload: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireFields(payload, [
    ["documentMethod", "Document method"],
    ["firstDayOfEmployment", "First day of employment"],
    ["employerTitle", "Employer representative title"],
  ], errors);

  const method = text(payload, "documentMethod");
  if (method === "List A") {
    requireFields(payload, [
      ["listATitle", "List A document title"],
      ["listAIssuer", "List A issuing authority"],
      ["listANumber", "List A document number"],
    ], errors);
  } else if (method === "List B and C") {
    requireFields(payload, [
      ["listBTitle", "List B document title"],
      ["listBIssuer", "List B issuing authority"],
      ["listBNumber", "List B document number"],
      ["listCTitle", "List C document title"],
      ["listCIssuer", "List C issuing authority"],
      ["listCNumber", "List C document number"],
    ], errors);
  } else if (method === "Acceptable receipt") {
    const hasReceiptDetails = ["listATitle", "listBTitle", "listCTitle"].some((key) => text(payload, key));
    if (!hasReceiptDetails) errors.push("Record the acceptable receipt or document presented before completing Section 2.");
  }
  return errors;
}
