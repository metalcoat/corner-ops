export const EMPLOYMENT_FORM_SENSITIVE_PERMISSION = "employment_forms.sensitive.read";

export function canViewCompletedEmploymentForms(permissions?: readonly string[]): boolean {
  return Boolean(permissions?.includes("*") || permissions?.includes(EMPLOYMENT_FORM_SENSITIVE_PERMISSION));
}

export type SubmittedField = { key: string; label: string; value: string };
export type SubmittedSection = { key: string; title: string; fields: SubmittedField[] };

const fieldNames: Record<string, string> = {
  ssn: "Social Security number (SSN)",
  socialsecuritynumber: "Social Security number (SSN)",
  dob: "Date of birth",
  dateofbirth: "Date of birth",
  ein: "Employer identification number (EIN)",
  zip: "ZIP code",
  nyc: "New York City",
  nysallowances: "New York State allowances",
  nycallowances: "New York City allowances",
  anumber: "Alien registration number",
  uscisnumber: "USCIS number",
  i94number: "Form I-94 admission number",
  signatureName: "Electronic signature",
};

function fieldLabel(key: string): string {
  return fieldNames[key] || fieldNames[key.toLowerCase().replace(/[^a-z0-9]/g, "")]
    || key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

/** Preserve strings exactly, including leading zeros in tax and identity fields. */
export function submittedFields(value: unknown, path = "", label = ""): SubmittedField[] {
  if (Array.isArray(value)) {
    if (!value.length) return [{ key: path, label, value: "Not provided" }];
    return value.flatMap((child, index) => submittedFields(child, `${path}.${index}`, `${label} ${index + 1}`));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.flatMap(([key, child]) => submittedFields(child, path ? `${path}.${key}` : key,
      label ? `${label} · ${fieldLabel(key)}` : fieldLabel(key)));
  }
  const text = value === null || value === undefined || value === "" ? "Not provided"
    : value === true ? "Yes" : value === false ? "No" : String(value);
  return [{ key: path, label, value: text }];
}

export function completedEmploymentSections(payload: Record<string, unknown>): SubmittedSection[] {
  const sectionNames: Record<string, string> = {
    employeeSubmission: "Employee answers",
    employeeAttestation: "Employee signature and attestation",
    employerReview: "Employer completed section",
    employerAttestation: "Employer signature and attestation",
  };
  const assigned = Object.fromEntries(Object.entries(payload).filter(([key]) => !Object.hasOwn(sectionNames, key)));
  const sections: SubmittedSection[] = [
    { key: "employeeSubmission", title: sectionNames.employeeSubmission, fields: submittedFields(payload.employeeSubmission || {}) },
    { key: "assigned", title: "Assigned form and employer details", fields: submittedFields(assigned) },
  ];
  for (const key of ["employeeAttestation", "employerReview", "employerAttestation"]) {
    if (payload[key] && typeof payload[key] === "object") {
      sections.push({ key, title: sectionNames[key], fields: submittedFields(payload[key]) });
    }
  }
  return sections;
}
