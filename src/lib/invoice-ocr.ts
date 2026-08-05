import { createPrivateKey, sign } from "node:crypto";

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_PREVIEW_TEXT = 2_000;

let cachedToken: { value: string; expiresAt: number } | null = null;

type MoneyValue = {
  currencyCode?: string;
  units?: string | number;
  nanos?: number;
};

type DateValue = {
  year?: number;
  month?: number;
  day?: number;
};

type NormalizedValue = {
  text?: string;
  moneyValue?: MoneyValue;
  dateValue?: DateValue;
  integerValue?: string | number;
  floatValue?: number;
};

type DocumentEntity = {
  type?: string;
  mentionText?: string;
  confidence?: number;
  normalizedValue?: NormalizedValue;
  textAnchor?: { content?: string };
  properties?: DocumentEntity[];
};

type DocumentAiResponse = {
  document?: {
    text?: string;
    pages?: unknown[];
    entities?: DocumentEntity[];
  };
  error?: { message?: string; status?: string };
};

export type InvoiceOcrField<T> = {
  value: T;
  confidence: number;
  sourceText: string;
};

export type InvoiceOcrLine = {
  description: string;
  productCode: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  confidence: number;
};

export type InvoiceOcrResult = {
  provider: "Google Document AI Invoice Parser";
  pageCount: number;
  overallConfidence: number;
  fields: {
    vendor: InvoiceOcrField<string>;
    invoiceNumber: InvoiceOcrField<string>;
    invoiceDate: InvoiceOcrField<string>;
    dueDate: InvoiceOcrField<string>;
    subtotal: InvoiceOcrField<number>;
    taxAmount: InvoiceOcrField<number>;
    totalAmount: InvoiceOcrField<number>;
    currency: InvoiceOcrField<string>;
  };
  lines: InvoiceOcrLine[];
  warnings: string[];
  textPreview: string;
};

function clean(value: unknown, max = 1_000): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function configuredValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured before invoice OCR can be used.`);
  return value;
}

export function invoiceOcrConfiguration() {
  const required = [
    "GOOGLE_CLOUD_PROJECT_ID",
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
    "GOOGLE_DOCUMENT_AI_INVOICE_PROCESSOR_ID",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  return {
    configured: missing.length === 0,
    missing,
    provider: "Google Document AI Invoice Parser" as const,
    location: process.env.GOOGLE_DOCUMENT_AI_LOCATION?.trim() || "us",
  };
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const email = configuredValue("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKeyText = configuredValue("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: email,
    scope: GOOGLE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3_600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(privateKeyText));
  const assertion = `${unsigned}.${base64url(signature)}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || `Google authentication failed (${response.status}).`);
  }
  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(300, Number(payload.expires_in || 3_600)) * 1_000,
  };
  return cachedToken.value;
}

function entityText(entity: DocumentEntity | undefined): string {
  if (!entity) return "";
  return clean(entity.normalizedValue?.text || entity.mentionText || entity.textAnchor?.content, 2_000);
}

function confidence(entity: DocumentEntity | undefined): number {
  const value = Number(entity?.confidence || 0);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function moneyFrom(entity: DocumentEntity | undefined): number {
  if (!entity) return 0;
  const normalized = entity.normalizedValue;
  if (normalized?.moneyValue) {
    const units = Number(normalized.moneyValue.units || 0);
    const nanos = Number(normalized.moneyValue.nanos || 0) / 1_000_000_000;
    return Math.round((units + nanos) * 100) / 100;
  }
  const parsed = Number(entityText(entity).replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function numberFrom(entity: DocumentEntity | undefined): number {
  if (!entity) return 0;
  const normalized = entity.normalizedValue;
  const normalizedNumber = normalized?.floatValue ?? normalized?.integerValue;
  if (normalizedNumber !== undefined) {
    const parsed = Number(normalizedNumber);
    if (Number.isFinite(parsed)) return parsed;
  }
  const parsed = Number(entityText(entity).replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateFrom(entity: DocumentEntity | undefined): string {
  const date = entity?.normalizedValue?.dateValue;
  if (date?.year && date.month && date.day) {
    return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  }
  const text = entityText(entity);
  if (!text) return "";
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const us = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(text);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  return "";
}

function bestEntity(entities: DocumentEntity[], type: string): DocumentEntity | undefined {
  return entities
    .filter((entity) => entity.type === type)
    .sort((left, right) => confidence(right) - confidence(left))[0];
}

function textField(entity: DocumentEntity | undefined): InvoiceOcrField<string> {
  return { value: entityText(entity), confidence: confidence(entity), sourceText: entityText(entity) };
}

function dateField(entity: DocumentEntity | undefined): InvoiceOcrField<string> {
  return { value: dateFrom(entity), confidence: confidence(entity), sourceText: entityText(entity) };
}

function moneyField(entity: DocumentEntity | undefined): InvoiceOcrField<number> {
  return { value: moneyFrom(entity), confidence: confidence(entity), sourceText: entityText(entity) };
}

function lineProperty(line: DocumentEntity, name: string): DocumentEntity | undefined {
  return (line.properties || [])
    .filter((property) => property.type === `line_item/${name}` || property.type === name)
    .sort((left, right) => confidence(right) - confidence(left))[0];
}

function parseLines(entities: DocumentEntity[]): InvoiceOcrLine[] {
  return entities
    .filter((entity) => entity.type === "line_item")
    .map((line) => {
      const description = lineProperty(line, "description");
      const productCode = lineProperty(line, "product_code");
      const quantityEntity = lineProperty(line, "quantity");
      const unit = lineProperty(line, "unit");
      const unitPriceEntity = lineProperty(line, "unit_price");
      const amountEntity = lineProperty(line, "amount");
      const lineQuantity = numberFrom(quantityEntity) || 1;
      const amount = moneyFrom(amountEntity);
      const explicitUnitPrice = moneyFrom(unitPriceEntity);
      const unitPrice = explicitUnitPrice || (amount && lineQuantity ? amount / lineQuantity : 0);
      const scores = [description, quantityEntity, unitPriceEntity, amountEntity]
        .filter(Boolean)
        .map((entity) => confidence(entity));
      return {
        description: entityText(description) || entityText(line),
        productCode: entityText(productCode),
        quantity: Math.round(lineQuantity * 10_000) / 10_000,
        unit: entityText(unit) || "each",
        unitPrice: Math.round(unitPrice * 10_000) / 10_000,
        amount: Math.round((amount || lineQuantity * unitPrice) * 100) / 100,
        confidence: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : confidence(line),
      };
    })
    .filter((line) => line.description || line.amount > 0);
}

function approximateEqual(left: number, right: number, tolerance = 0.05): boolean {
  return Math.abs(left - right) <= tolerance;
}

export async function processInvoiceDocument(input: {
  bytes: ArrayBuffer;
  mimeType: string;
  displayName: string;
}): Promise<InvoiceOcrResult> {
  const projectId = configuredValue("GOOGLE_CLOUD_PROJECT_ID");
  const location = process.env.GOOGLE_DOCUMENT_AI_LOCATION?.trim() || "us";
  const processorId = configuredValue("GOOGLE_DOCUMENT_AI_INVOICE_PROCESSOR_ID");
  const processorVersion = process.env.GOOGLE_DOCUMENT_AI_INVOICE_PROCESSOR_VERSION?.trim();
  const resource = `projects/${projectId}/locations/${location}/processors/${processorId}${processorVersion ? `/processorVersions/${processorVersion}` : ""}`;
  const endpoint = `https://${location}-documentai.googleapis.com/v1/${resource}:process`;
  const token = await accessToken();

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      rawDocument: {
        content: Buffer.from(input.bytes).toString("base64"),
        mimeType: input.mimeType,
        displayName: clean(input.displayName, 200),
      },
      fieldMask: "text,entities,pages.pageNumber",
      imagelessMode: true,
      labels: { source: "corner-ops", document_type: "vendor-invoice" },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => ({})) as DocumentAiResponse;
  if (!response.ok || !payload.document) {
    throw new Error(payload.error?.message || `Google Document AI failed (${response.status}).`);
  }

  const entities = payload.document.entities || [];
  const vendor = bestEntity(entities, "supplier_name");
  const invoiceNumber = bestEntity(entities, "invoice_id");
  const invoiceDate = bestEntity(entities, "invoice_date");
  const dueDate = bestEntity(entities, "due_date");
  const subtotalEntity = bestEntity(entities, "net_amount");
  const taxEntity = bestEntity(entities, "total_tax_amount");
  const totalEntity = bestEntity(entities, "total_amount");
  const currencyEntity = bestEntity(entities, "currency");
  const lines = parseLines(entities);

  const totalAmount = moneyFrom(totalEntity);
  const taxAmount = moneyFrom(taxEntity);
  const lineTotal = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  const extractedSubtotal = moneyFrom(subtotalEntity);
  const subtotal = extractedSubtotal || Math.max(0, Math.round((totalAmount - taxAmount) * 100) / 100) || lineTotal;
  const fields = {
    vendor: textField(vendor),
    invoiceNumber: textField(invoiceNumber),
    invoiceDate: dateField(invoiceDate),
    dueDate: dateField(dueDate),
    subtotal: { ...moneyField(subtotalEntity), value: subtotal },
    taxAmount: moneyField(taxEntity),
    totalAmount: moneyField(totalEntity),
    currency: textField(currencyEntity),
  };

  const confidenceValues = [
    fields.vendor.confidence,
    fields.invoiceNumber.confidence,
    fields.invoiceDate.confidence,
    fields.totalAmount.confidence,
    ...lines.map((line) => line.confidence),
  ].filter((value) => value > 0);
  const overallConfidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : 0;
  const warnings: string[] = [];
  if (!fields.vendor.value) warnings.push("Vendor was not detected.");
  if (!fields.invoiceNumber.value) warnings.push("Invoice number was not detected; duplicate protection will be weaker.");
  if (!fields.invoiceDate.value) warnings.push("Invoice date was not detected.");
  if (!fields.dueDate.value) warnings.push("Due date was not detected and must be entered before saving.");
  if (!fields.totalAmount.value) warnings.push("Invoice total was not detected.");
  if (fields.totalAmount.value && lineTotal && !approximateEqual(fields.totalAmount.value, lineTotal + fields.taxAmount.value, 0.5)) {
    warnings.push(`Extracted line items plus tax total $${(lineTotal + fields.taxAmount.value).toFixed(2)}, which differs from the invoice total.`);
  }
  if (overallConfidence > 0 && overallConfidence < 0.7) warnings.push("Overall OCR confidence is low; compare every field with the source document.");
  for (const [label, field] of Object.entries(fields)) {
    if (field.value && field.confidence > 0 && field.confidence < 0.6) warnings.push(`${label} was extracted with low confidence.`);
  }

  return {
    provider: "Google Document AI Invoice Parser",
    pageCount: payload.document.pages?.length || 0,
    overallConfidence: Math.round(overallConfidence * 10_000) / 10_000,
    fields,
    lines,
    warnings: [...new Set(warnings)],
    textPreview: clean(payload.document.text, MAX_PREVIEW_TEXT),
  };
}
