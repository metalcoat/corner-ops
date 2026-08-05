const DEFAULT_API_VERSION = "2024-11-30";
const MAX_PREVIEW_TEXT = 2_000;
const POLL_INTERVAL_MS = 750;
const MAX_POLL_ATTEMPTS = 120;

export type InvoiceDocumentType = "Invoice" | "Receipt";

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
  provider: "Azure Document Intelligence";
  model: "prebuilt-invoice" | "prebuilt-receipt";
  documentType: InvoiceDocumentType;
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

type AzureCurrency = {
  amount?: number;
  currencyCode?: string;
};

type AzureField = {
  type?: string;
  content?: string;
  confidence?: number;
  value?: unknown;
  valueString?: string;
  valueDate?: string;
  valueNumber?: number;
  valueInteger?: number;
  valueCurrency?: AzureCurrency;
  valueArray?: AzureField[];
  valueObject?: Record<string, AzureField>;
};

type AzureDocument = {
  docType?: string;
  confidence?: number;
  fields?: Record<string, AzureField>;
};

type AzureAnalyzeOperation = {
  status?: "notStarted" | "running" | "succeeded" | "failed" | "canceled";
  error?: { code?: string; message?: string };
  analyzeResult?: {
    apiVersion?: string;
    modelId?: string;
    content?: string;
    pages?: unknown[];
    documents?: AzureDocument[];
  };
};

type OcrProviderConfiguration = {
  configured: boolean;
  missing: string[];
  provider: "Azure Document Intelligence";
  location: string;
  apiVersion: string;
  pageLimit: number;
};

type OcrProvider = {
  configuration(): OcrProviderConfiguration;
  analyze(input: {
    bytes: ArrayBuffer;
    mimeType: string;
    displayName: string;
    documentType: InvoiceDocumentType;
  }): Promise<InvoiceOcrResult>;
};

function clean(value: unknown, max = 1_000): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function configuredValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured before invoice OCR can be used.`);
  return value;
}

function providerSetting(): string {
  return (process.env.INVOICE_OCR_PROVIDER || "azure").trim().toLowerCase();
}

function azureConfiguration(): OcrProviderConfiguration {
  const required = ["AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", "AZURE_DOCUMENT_INTELLIGENCE_KEY"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (providerSetting() !== "azure") missing.unshift("INVOICE_OCR_PROVIDER must currently be set to azure");
  let location = "Azure";
  try {
    const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?.trim();
    if (endpoint) location = new URL(endpoint).hostname;
  } catch {
    location = "Invalid endpoint";
  }
  return {
    configured: missing.length === 0,
    missing,
    provider: "Azure Document Intelligence",
    location,
    apiVersion: process.env.AZURE_DOCUMENT_INTELLIGENCE_API_VERSION?.trim() || DEFAULT_API_VERSION,
    pageLimit: 2,
  };
}

export function invoiceOcrConfiguration(): OcrProviderConfiguration {
  return activeProvider().configuration();
}

function activeProvider(): OcrProvider {
  const provider = providerSetting();
  if (provider === "azure") return azureProvider;
  throw new Error(`Unsupported invoice OCR provider: ${provider}. Use azure.`);
}

function fieldConfidence(field: AzureField | undefined): number {
  const value = Number(field?.confidence || 0);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function fieldText(field: AzureField | undefined): string {
  if (!field) return "";
  const direct = field.valueString ?? (typeof field.value === "string" ? field.value : "");
  return clean(direct || field.content, 2_000);
}

function fieldNumber(field: AzureField | undefined): number {
  if (!field) return 0;
  const direct = field.valueCurrency?.amount
    ?? field.valueNumber
    ?? field.valueInteger
    ?? (typeof field.value === "number" ? field.value : undefined);
  if (direct !== undefined && Number.isFinite(Number(direct))) return Math.round(Number(direct) * 10_000) / 10_000;
  const parsed = Number(fieldText(field).replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 10_000) / 10_000 : 0;
}

function fieldDate(field: AzureField | undefined): string {
  const value = clean(field?.valueDate || (typeof field?.value === "string" ? field.value : ""), 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const text = fieldText(field);
  if (!text) return "";
  const iso = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const us = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(text);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  return "";
}

function textResult(field: AzureField | undefined): InvoiceOcrField<string> {
  const value = fieldText(field);
  return { value, confidence: fieldConfidence(field), sourceText: clean(field?.content || value, 2_000) };
}

function dateResult(field: AzureField | undefined): InvoiceOcrField<string> {
  return { value: fieldDate(field), confidence: fieldConfidence(field), sourceText: fieldText(field) };
}

function moneyResult(field: AzureField | undefined): InvoiceOcrField<number> {
  return { value: Math.round(fieldNumber(field) * 100) / 100, confidence: fieldConfidence(field), sourceText: fieldText(field) };
}

function objectField(value: Record<string, AzureField> | undefined, ...names: string[]): AzureField | undefined {
  if (!value) return undefined;
  for (const name of names) {
    if (value[name]) return value[name];
  }
  const normalized = new Map(Object.entries(value).map(([key, field]) => [key.toLowerCase(), field]));
  for (const name of names) {
    const match = normalized.get(name.toLowerCase());
    if (match) return match;
  }
  return undefined;
}

function itemObject(field: AzureField): Record<string, AzureField> {
  if (field.valueObject) return field.valueObject;
  if (field.value && typeof field.value === "object" && !Array.isArray(field.value)) {
    return field.value as Record<string, AzureField>;
  }
  return {};
}

function parseLines(fields: Record<string, AzureField>, documentType: InvoiceDocumentType): InvoiceOcrLine[] {
  const items = objectField(fields, "Items")?.valueArray || [];
  return items.map((item) => {
    const value = itemObject(item);
    const description = objectField(value, "Description", "Name");
    const productCode = objectField(value, "ProductCode", "SKU");
    const quantityField = objectField(value, "Quantity");
    const unitField = objectField(value, "Unit");
    const unitPriceField = objectField(value, "UnitPrice", "Price");
    const amountField = objectField(value, "Amount", "TotalPrice");
    const quantity = fieldNumber(quantityField) || 1;
    const amount = fieldNumber(amountField);
    const explicitUnitPrice = fieldNumber(unitPriceField);
    const unitPrice = explicitUnitPrice || (amount && quantity ? amount / quantity : 0);
    const scores = [description, quantityField, unitPriceField, amountField]
      .filter((field): field is AzureField => Boolean(field))
      .map(fieldConfidence)
      .filter((score) => score > 0);
    return {
      description: fieldText(description) || fieldText(item),
      productCode: fieldText(productCode),
      quantity: Math.round(quantity * 10_000) / 10_000,
      unit: fieldText(unitField) || (documentType === "Receipt" ? "each" : "each"),
      unitPrice: Math.round(unitPrice * 10_000) / 10_000,
      amount: Math.round((amount || quantity * unitPrice) * 100) / 100,
      confidence: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : fieldConfidence(item),
    };
  }).filter((line) => line.description || line.amount > 0);
}

function approximateEqual(left: number, right: number, tolerance = 0.05): boolean {
  return Math.abs(left - right) <= tolerance;
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function azureAnalyze(input: {
  bytes: ArrayBuffer;
  documentType: InvoiceDocumentType;
}): Promise<AzureAnalyzeOperation> {
  const endpoint = configuredValue("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT").replace(/\/+$/, "");
  const key = configuredValue("AZURE_DOCUMENT_INTELLIGENCE_KEY");
  const apiVersion = process.env.AZURE_DOCUMENT_INTELLIGENCE_API_VERSION?.trim() || DEFAULT_API_VERSION;
  const model = input.documentType === "Receipt" ? "prebuilt-receipt" : "prebuilt-invoice";
  const pages = input.documentType === "Receipt" ? "1" : "1-2";
  const url = `${endpoint}/documentintelligence/documentModels/${model}:analyze?_overload=analyzeDocument&api-version=${encodeURIComponent(apiVersion)}&pages=${pages}&locale=en-US&stringIndexType=utf16CodeUnit`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": key,
    },
    body: JSON.stringify({ base64Source: Buffer.from(input.bytes).toString("base64") }),
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  const errorPayload = await response.clone().json().catch(() => ({})) as { error?: { message?: string } };
  if (response.status !== 202) {
    throw new Error(errorPayload.error?.message || `Azure Document Intelligence rejected the document (${response.status}).`);
  }
  const operationLocation = response.headers.get("operation-location");
  if (!operationLocation) throw new Error("Azure Document Intelligence did not return an operation location.");

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (attempt) await pause(POLL_INTERVAL_MS);
    const resultResponse = await fetch(operationLocation, {
      headers: { "Ocp-Apim-Subscription-Key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const operation = await resultResponse.json().catch(() => ({})) as AzureAnalyzeOperation;
    if (!resultResponse.ok) {
      throw new Error(operation.error?.message || `Azure Document Intelligence result lookup failed (${resultResponse.status}).`);
    }
    if (operation.status === "succeeded") return operation;
    if (operation.status === "failed" || operation.status === "canceled") {
      throw new Error(operation.error?.message || `Azure Document Intelligence analysis ${operation.status}.`);
    }
  }
  throw new Error("Azure Document Intelligence did not finish within 90 seconds.");
}

function normalizedFields(document: AzureDocument | undefined): Record<string, AzureField> {
  return document?.fields || {};
}

function currencyCode(field: AzureField | undefined): string {
  return clean(field?.valueCurrency?.currencyCode || fieldText(field), 12);
}

function resultFromAzure(operation: AzureAnalyzeOperation, documentType: InvoiceDocumentType): InvoiceOcrResult {
  const analyzeResult = operation.analyzeResult || {};
  const document = analyzeResult.documents?.[0];
  const fieldsMap = normalizedFields(document);
  const receipt = documentType === "Receipt";
  const vendorField = objectField(fieldsMap, receipt ? "MerchantName" : "VendorName");
  const invoiceNumberField = receipt ? undefined : objectField(fieldsMap, "InvoiceId", "InvoiceNumber");
  const invoiceDateField = objectField(fieldsMap, receipt ? "TransactionDate" : "InvoiceDate");
  const dueDateField = receipt ? undefined : objectField(fieldsMap, "DueDate");
  const subtotalField = objectField(fieldsMap, "SubTotal", "Subtotal");
  const taxField = objectField(fieldsMap, "TotalTax", "Tax");
  const totalField = objectField(fieldsMap, receipt ? "Total" : "InvoiceTotal", "Total");
  const amountDueField = objectField(fieldsMap, "AmountDue");
  const lines = parseLines(fieldsMap, documentType);
  const lineTotal = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  const totalAmount = fieldNumber(totalField) || fieldNumber(amountDueField);
  const taxAmount = fieldNumber(taxField);
  const extractedSubtotal = fieldNumber(subtotalField);
  const subtotal = extractedSubtotal || Math.max(0, Math.round((totalAmount - taxAmount) * 100) / 100) || lineTotal;
  const currencySource = totalField || amountDueField || subtotalField;
  const fields = {
    vendor: textResult(vendorField),
    invoiceNumber: textResult(invoiceNumberField),
    invoiceDate: dateResult(invoiceDateField),
    dueDate: dateResult(dueDateField),
    subtotal: { ...moneyResult(subtotalField), value: Math.round(subtotal * 100) / 100 },
    taxAmount: moneyResult(taxField),
    totalAmount: { ...moneyResult(totalField || amountDueField), value: Math.round(totalAmount * 100) / 100 },
    currency: {
      value: currencyCode(currencySource),
      confidence: fieldConfidence(currencySource),
      sourceText: fieldText(currencySource),
    },
  };

  const confidenceValues = [
    Number(document?.confidence || 0),
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
  if (!fields.vendor.value) warnings.push(`${receipt ? "Merchant" : "Vendor"} was not detected.`);
  if (!receipt && !fields.invoiceNumber.value) warnings.push("Invoice number was not detected; duplicate protection will be weaker.");
  if (!fields.invoiceDate.value) warnings.push(`${receipt ? "Transaction" : "Invoice"} date was not detected.`);
  if (!receipt && !fields.dueDate.value) warnings.push("Due date was not detected and must be entered before saving to accounts payable.");
  if (!fields.totalAmount.value) warnings.push(`${receipt ? "Receipt" : "Invoice"} total was not detected.`);
  if (fields.totalAmount.value && lineTotal && !approximateEqual(fields.totalAmount.value, lineTotal + fields.taxAmount.value, 0.5)) {
    warnings.push(`Extracted line items plus tax total $${(lineTotal + fields.taxAmount.value).toFixed(2)}, which differs from the document total.`);
  }
  if ((analyzeResult.pages?.length || 0) >= (receipt ? 1 : 2)) {
    warnings.push(`Only the first ${receipt ? "page" : "two pages"} were analyzed to stay within the Azure free-tier document limits.`);
  }
  if (overallConfidence > 0 && overallConfidence < 0.7) warnings.push("Overall OCR confidence is low; compare every field with the source document.");
  for (const [label, field] of Object.entries(fields)) {
    if (field.value && field.confidence > 0 && field.confidence < 0.6) warnings.push(`${label} was extracted with low confidence.`);
  }

  return {
    provider: "Azure Document Intelligence",
    model: receipt ? "prebuilt-receipt" : "prebuilt-invoice",
    documentType,
    pageCount: analyzeResult.pages?.length || 0,
    overallConfidence: Math.round(overallConfidence * 10_000) / 10_000,
    fields,
    lines,
    warnings: [...new Set(warnings)],
    textPreview: clean(analyzeResult.content, MAX_PREVIEW_TEXT),
  };
}

const azureProvider: OcrProvider = {
  configuration: azureConfiguration,
  async analyze(input) {
    const operation = await azureAnalyze({ bytes: input.bytes, documentType: input.documentType });
    return resultFromAzure(operation, input.documentType);
  },
};

export async function processInvoiceDocument(input: {
  bytes: ArrayBuffer;
  mimeType: string;
  displayName: string;
  documentType?: InvoiceDocumentType;
}): Promise<InvoiceOcrResult> {
  const configuration = invoiceOcrConfiguration();
  if (!configuration.configured) {
    throw new Error(`Invoice OCR is not configured. Missing: ${configuration.missing.join(", ")}.`);
  }
  if (!input.bytes.byteLength) throw new Error("The invoice file is empty.");
  const mimeType = clean(input.mimeType, 100);
  if (!/^(application\/pdf|image\/(jpeg|png|webp))$/i.test(mimeType)) {
    throw new Error(`Unsupported OCR file type: ${mimeType || "unknown"}.`);
  }
  return activeProvider().analyze({
    bytes: input.bytes,
    mimeType,
    displayName: clean(input.displayName, 200),
    documentType: input.documentType === "Receipt" ? "Receipt" : "Invoice",
  });
}
