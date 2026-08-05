"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../../control-center.css";
import "./invoice-ocr.css";

type OcrField<T> = {
  value: T;
  confidence: number;
  sourceText: string;
};

type OcrLine = {
  description: string;
  productCode: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  confidence: number;
};

type OcrResult = {
  business: Business;
  fileName: string;
  provider: string;
  pageCount: number;
  overallConfidence: number;
  fields: {
    vendor: OcrField<string>;
    invoiceNumber: OcrField<string>;
    invoiceDate: OcrField<string>;
    dueDate: OcrField<string>;
    subtotal: OcrField<number>;
    taxAmount: OcrField<number>;
    totalAmount: OcrField<number>;
    currency: OcrField<string>;
  };
  lines: OcrLine[];
  warnings: string[];
  textPreview: string;
};

type Configuration = {
  configured: boolean;
  missing: string[];
  provider: string;
  location: string;
};

type Draft = {
  vendor: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  category: string;
  accountCode: string;
  notes: string;
};

const emptyDraft: Draft = {
  vendor: "",
  invoiceNumber: "",
  invoiceDate: "",
  dueDate: "",
  subtotal: 0,
  taxAmount: 0,
  totalAmount: 0,
  category: "Other Expense",
  accountCode: "5900",
  notes: "",
};

const accountOptions = [
  ["5000", "Cost of Goods Sold"],
  ["5100", "Payroll"],
  ["5200", "Rent and Occupancy"],
  ["5300", "Utilities"],
  ["5400", "Supplies"],
  ["5500", "Repairs and Maintenance"],
  ["5600", "Merchant and Bank Fees"],
  ["5900", "Other Expense"],
] as const;

function requestedBusiness(): Business {
  if (typeof window === "undefined") return "Corner Deli";
  return new URLSearchParams(window.location.search).get("business") === "Tiki" ? "Tiki" : "Corner Deli";
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
}

function confidencePercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value || 0)) * 100)}%`;
}

function confidenceClass(value: number) {
  if (value >= 0.85) return "high";
  if (value >= 0.65) return "medium";
  return "low";
}

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function dateAfter(dateText: string, days: number) {
  if (!dateText) return "";
  const date = new Date(`${dateText}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function InvoiceOcrPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>(requestedBusiness);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [lines, setLines] = useState<OcrLine[]>([]);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false } as SessionView));
    fetch("/api/finance-operations/invoice-ocr", { cache: "no-store" })
      .then((response) => response.json())
      .then((value: Configuration) => setConfiguration(value))
      .catch(() => setConfiguration({ configured: false, missing: ["Unable to read OCR configuration"], provider: "Google Document AI Invoice Parser", location: "us" }));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.businessTheme = business;
    window.localStorage.setItem("corner-ops-business-theme", business);
    const url = new URL(window.location.href);
    url.searchParams.set("business", business);
    window.history.replaceState(null, "", url);
  }, [business]);

  const fieldConfidence = useMemo(() => ({
    vendor: result?.fields.vendor.confidence || 0,
    invoiceNumber: result?.fields.invoiceNumber.confidence || 0,
    invoiceDate: result?.fields.invoiceDate.confidence || 0,
    dueDate: result?.fields.dueDate.confidence || 0,
    subtotal: result?.fields.subtotal.confidence || 0,
    taxAmount: result?.fields.taxAmount.confidence || 0,
    totalAmount: result?.fields.totalAmount.confidence || 0,
  }), [result]);

  function resetDraft() {
    setFile(null);
    setResult(null);
    setDraft(emptyDraft);
    setLines([]);
  }

  async function scanInvoice(nextFile: File) {
    setScanning(true);
    setNotice("");
    setResult(null);
    try {
      const form = new FormData();
      form.set("business", business);
      form.set("file", nextFile);
      const response = await fetch("/api/finance-operations/invoice-ocr", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as OcrResult;
      setResult(payload);
      setLines(payload.lines);
      const detectedInvoiceDate = payload.fields.invoiceDate.value;
      setDraft({
        vendor: payload.fields.vendor.value,
        invoiceNumber: payload.fields.invoiceNumber.value,
        invoiceDate: detectedInvoiceDate,
        dueDate: payload.fields.dueDate.value || dateAfter(detectedInvoiceDate, 30),
        subtotal: payload.fields.subtotal.value,
        taxAmount: payload.fields.taxAmount.value,
        totalAmount: payload.fields.totalAmount.value,
        category: "Other Expense",
        accountCode: "5900",
        notes: `Extracted by ${payload.provider} at ${confidencePercent(payload.overallConfidence)} overall confidence. Review completed before posting.`,
      });
      setNotice(`OCR completed for ${payload.fileName}. Review every highlighted field before saving.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invoice OCR failed.");
    } finally {
      setScanning(false);
    }
  }

  function chooseFile(nextFile: File | null) {
    resetDraft();
    if (!nextFile) return;
    setFile(nextFile);
    void scanInvoice(nextFile);
  }

  function updateLine(index: number, values: Partial<OcrLine>) {
    setLines((current) => current.map((line, lineIndex) => {
      if (lineIndex !== index) return line;
      const updated = { ...line, ...values };
      if (values.quantity !== undefined || values.unitPrice !== undefined) {
        updated.amount = Math.round(updated.quantity * updated.unitPrice * 100) / 100;
      }
      return updated;
    }));
  }

  function removeLine(index: number) {
    setLines((current) => current.filter((_, lineIndex) => lineIndex !== index));
  }

  function addLine() {
    setLines((current) => [...current, {
      description: "",
      productCode: "",
      quantity: 1,
      unit: "each",
      unitPrice: 0,
      amount: 0,
      confidence: 1,
    }]);
  }

  async function saveBill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setNotice("Choose and scan an invoice before saving.");
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      const form = new FormData();
      form.set("action", "create-bill");
      form.set("business", business);
      form.set("file", file);
      form.set("vendor", draft.vendor);
      form.set("invoiceNumber", draft.invoiceNumber);
      form.set("invoiceDate", draft.invoiceDate);
      form.set("dueDate", draft.dueDate);
      form.set("subtotal", String(draft.subtotal));
      form.set("taxAmount", String(draft.taxAmount));
      form.set("totalAmount", String(draft.totalAmount));
      form.set("category", draft.category);
      form.set("accountCode", draft.accountCode);
      form.set("notes", draft.notes);
      form.set("lines", JSON.stringify(lines.map((line) => ({
        inventoryItemId: null,
        description: line.productCode ? `${line.productCode} · ${line.description}` : line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
      }))));
      const response = await fetch("/api/finance-operations", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { id: string; lines: number; totalAmount: number };
      resetDraft();
      setNotice(`Bill saved for ${money(payload.totalAmount)} with ${payload.lines} extracted line item${payload.lines === 1 ? "" : "s"}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The reviewed invoice could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!session) return <main className="controlPage invoiceOcrPage">Loading invoice OCR…</main>;
  if (!session.authenticated) return <main className="controlPage invoiceOcrPage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage invoiceOcrPage">
    <header className="controlHeader invoiceOcrHeader">
      <div>
        <p className="eyebrow">Accounts payable automation</p>
        <h1>{business} invoice OCR</h1>
        <p>Select a PDF or invoice image. Google Document AI extracts the invoice fields and line items, then you review and correct the draft before it enters accounts payable.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills" aria-label="Business">
          {(["Corner Deli", "Tiki"] as Business[]).map((name) => <button type="button" key={name} className={business === name ? "active" : ""} onClick={() => { setBusiness(name); resetDraft(); }}>{name}</button>)}
        </div>
        <a href={`/ops/finance-operations?business=${encodeURIComponent(business)}`}>Back to Finance</a>
      </div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    {configuration && !configuration.configured && <section className="controlCard invoiceConfigError">
      <div><p className="eyebrow">Configuration required</p><h2>Invoice OCR is not ready</h2><p>Add the missing Google Document AI variables to Vercel before attempting a scan.</p></div>
      <code>{configuration.missing.join("\n")}</code>
    </section>}

    <section className="controlCard invoiceUploadCard">
      <div>
        <p className="eyebrow">Step 1</p>
        <h2>Choose an invoice</h2>
        <p>Supported files: PDF, JPG, PNG, and WebP, up to 25 MB. OCR begins immediately after selection.</p>
      </div>
      <label className={`invoiceDrop ${scanning ? "busy" : ""}`}>
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" disabled={scanning || !configuration?.configured} onChange={(event) => chooseFile(event.target.files?.[0] || null)} />
        <strong>{scanning ? "Reading invoice…" : file ? file.name : "Select PDF or invoice image"}</strong>
        <span>{scanning ? "Extracting invoice fields and line items" : "The source file is not stored until the reviewed bill is saved"}</span>
      </label>
      {scanning && <div className="invoiceProgress" aria-label="OCR in progress"><i /></div>}
    </section>

    {result && <form className="invoiceReview" onSubmit={saveBill}>
      <section className="controlCard invoiceReviewSummary">
        <div><p className="eyebrow">Step 2</p><h2>Review extracted invoice</h2><p>{result.pageCount} page{result.pageCount === 1 ? "" : "s"} · {result.provider}</p></div>
        <div className={`invoiceOverall ${confidenceClass(result.overallConfidence)}`}><span>Overall confidence</span><strong>{confidencePercent(result.overallConfidence)}</strong></div>
      </section>

      {result.warnings.length > 0 && <section className="invoiceWarnings" aria-label="OCR review warnings">
        {result.warnings.map((warning) => <div key={warning}>{warning}</div>)}
      </section>}

      <section className="controlCard invoiceHeaderFields">
        <div className="invoiceSectionTitle"><div><p className="eyebrow">Invoice header</p><h2>Vendor, dates, and totals</h2></div><span>Low-confidence fields require extra review.</span></div>
        <div className="invoiceFieldGrid">
          <label><span>Vendor <Confidence value={fieldConfidence.vendor} /></span><input value={draft.vendor} onChange={(event) => setDraft((current) => ({ ...current, vendor: event.target.value }))} required /></label>
          <label><span>Invoice number <Confidence value={fieldConfidence.invoiceNumber} /></span><input value={draft.invoiceNumber} onChange={(event) => setDraft((current) => ({ ...current, invoiceNumber: event.target.value }))} /></label>
          <label><span>Invoice date <Confidence value={fieldConfidence.invoiceDate} /></span><input type="date" value={draft.invoiceDate} onChange={(event) => setDraft((current) => ({ ...current, invoiceDate: event.target.value }))} required /></label>
          <label><span>Due date <Confidence value={fieldConfidence.dueDate} /></span><input type="date" value={draft.dueDate} min={draft.invoiceDate} onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value }))} required /></label>
          <label><span>Subtotal <Confidence value={fieldConfidence.subtotal} /></span><input type="number" step="0.01" min="0" value={draft.subtotal} onChange={(event) => setDraft((current) => ({ ...current, subtotal: Number(event.target.value) }))} /></label>
          <label><span>Tax <Confidence value={fieldConfidence.taxAmount} /></span><input type="number" step="0.01" min="0" value={draft.taxAmount} onChange={(event) => setDraft((current) => ({ ...current, taxAmount: Number(event.target.value) }))} /></label>
          <label><span>Total <Confidence value={fieldConfidence.totalAmount} /></span><input type="number" step="0.01" min="0.01" value={draft.totalAmount} onChange={(event) => setDraft((current) => ({ ...current, totalAmount: Number(event.target.value) }))} required /></label>
          <label><span>Accounting category</span><input value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} required /></label>
          <label><span>Account</span><select value={draft.accountCode} onChange={(event) => {
            const code = event.target.value;
            const category = accountOptions.find(([value]) => value === code)?.[1] || draft.category;
            setDraft((current) => ({ ...current, accountCode: code, category }));
          }}>{accountOptions.map(([code, label]) => <option key={code} value={code}>{code} · {label}</option>)}</select></label>
          <label className="invoiceNotes"><span>Review notes</span><textarea rows={3} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} /></label>
        </div>
      </section>

      <section className="controlCard invoiceLinesCard">
        <div className="invoiceSectionTitle"><div><p className="eyebrow">Line-item extraction</p><h2>Invoice lines</h2></div><button type="button" onClick={addLine}>Add line</button></div>
        <div className="invoiceLineList">
          {lines.map((line, index) => <article className={`invoiceLine ${confidenceClass(line.confidence)}`} key={`${index}-${line.productCode}`}>
            <div className="invoiceLineTop"><strong>Line {index + 1}</strong><Confidence value={line.confidence} /><button type="button" onClick={() => removeLine(index)}>Remove</button></div>
            <label className="lineDescription"><span>Description</span><input value={line.description} onChange={(event) => updateLine(index, { description: event.target.value })} required /></label>
            <label><span>Product code</span><input value={line.productCode} onChange={(event) => updateLine(index, { productCode: event.target.value })} /></label>
            <label><span>Quantity</span><input type="number" step="0.0001" min="0" value={line.quantity} onChange={(event) => updateLine(index, { quantity: Number(event.target.value) })} /></label>
            <label><span>Unit</span><input value={line.unit} onChange={(event) => updateLine(index, { unit: event.target.value })} /></label>
            <label><span>Unit price</span><input type="number" step="0.0001" min="0" value={line.unitPrice} onChange={(event) => updateLine(index, { unitPrice: Number(event.target.value) })} /></label>
            <div className="invoiceLineAmount"><span>Line total</span><strong>{money(line.amount)}</strong></div>
          </article>)}
          {!lines.length && <div className="invoiceEmptyLines">No line items were extracted. Add lines manually or save the invoice header only.</div>}
        </div>
      </section>

      <section className="controlCard invoiceSaveBar">
        <div><p className="eyebrow">Step 3</p><h2>Save reviewed bill</h2><p>The original invoice will be stored privately with the AP record. Extracted lines are not linked to inventory until they are deliberately mapped to inventory items.</p></div>
        <div><strong>{money(draft.totalAmount)}</strong><button className="primary" disabled={saving || scanning}>{saving ? "Saving…" : "Save reviewed bill"}</button></div>
      </section>

      {result.textPreview && <details className="controlCard invoiceTextPreview"><summary>Show OCR text preview</summary><pre>{result.textPreview}</pre></details>}
    </form>}
  </main>;
}

function Confidence({ value }: { value: number }) {
  if (!value) return <small className="ocrConfidence none">Not detected</small>;
  return <small className={`ocrConfidence ${confidenceClass(value)}`}>{confidencePercent(value)}</small>;
}
