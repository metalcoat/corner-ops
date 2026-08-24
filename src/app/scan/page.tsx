"use client";

import { canvasToJpegBlob, drawCanvasImage } from "@/app/client-image";
import { responseMessage } from "@/app/client-http";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, DocumentRecord } from "@/lib/types";
import "./scan.css";

type ScanDocumentType = "Invoice" | "Receipt" | "Insurance" | "Permit" | "Contract" | "Employee" | "Inventory" | "Other";
type AccessState = {
  mode: "owner" | "employee" | "guest";
  name: string;
  business?: Business;
  businesses: Business[];
  guestEnabled: boolean | Record<Business, boolean>;
  ocr: {
    configured: boolean;
    missing: string[];
    provider: string;
    location: string;
    pageLimit: number;
  };
};

type ScanResponse = {
  document: DocumentRecord;
  accessMode: "owner" | "employee" | "guest";
  documentType: ScanDocumentType;
  ocr: null | {
    provider: string;
    confidence: number;
    vendor: string;
    reference: string;
    total: number;
    warnings: string[];
  };
};

const documentTypes: Array<{ value: ScanDocumentType; description: string }> = [
  { value: "Invoice", description: "Vendor invoice, utility bill, or purchase invoice" },
  { value: "Receipt", description: "Store, restaurant, fuel, or purchase receipt" },
  { value: "Insurance", description: "Policy, certificate, binder, or insurance notice" },
  { value: "Permit", description: "License, permit, inspection, or government filing" },
  { value: "Contract", description: "Vendor agreement, service contract, or signed terms" },
  { value: "Employee", description: "Employee form, certification, or personnel document" },
  { value: "Inventory", description: "Packing slip, count sheet, or inventory record" },
  { value: "Other", description: "Any other document that belongs in the vault" },
];

function requestedBusiness(): Business {
  if (typeof window === "undefined") return "Corner Deli";
  const query = new URLSearchParams(window.location.search).get("business");
  if (query === "Tiki" || query === "Corner Deli") return query;
  const saved = window.localStorage.getItem("corner-ops-business-theme");
  return saved === "Tiki" ? "Tiki" : "Corner Deli";
}



async function blackAndWhiteFile(source: File, threshold: number, rotation: number): Promise<{ file: File; url: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(source);
  try {
    const maxDimension = 2400;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const sourceWidth = Math.max(1, Math.round(bitmap.width * scale));
    const sourceHeight = Math.max(1, Math.round(bitmap.height * scale));
    const sideways = rotation % 180 !== 0;
    const canvas = document.createElement("canvas");
    canvas.width = sideways ? sourceHeight : sourceWidth;
    canvas.height = sideways ? sourceWidth : sourceHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot process document images.");

    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(rotation * Math.PI / 180);
    drawCanvasImage(context, bitmap, null, { x: -sourceWidth / 2, y: -sourceHeight / 2, width: sourceWidth, height: sourceHeight });
    context.restore();

    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = image.data;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
      const value = luminance >= threshold ? 255 : 0;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await canvasToJpegBlob(canvas, 0.92, "The processed image could not be created.");
    return {
      file: new File([blob], "corner-ops-scan.jpg", { type: "image/jpeg", lastModified: Date.now() }),
      url: URL.createObjectURL(blob),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    bitmap.close();
  }
}

function guestEnabledFor(access: AccessState | null, business: Business): boolean {
  if (!access) return false;
  if (typeof access.guestEnabled === "boolean") return access.guestEnabled;
  return Boolean(access.guestEnabled[business]);
}

export default function DocumentScannerPage() {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [business, setBusiness] = useState<Business>(requestedBusiness);
  const [documentType, setDocumentType] = useState<ScanDocumentType>("Invoice");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [processedFile, setProcessedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewSize, setPreviewSize] = useState("");
  const [threshold, setThreshold] = useState(172);
  const [rotation, setRotation] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<ScanResponse | null>(null);

  useEffect(() => {
    fetch("/api/document-scan", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseMessage(response));
        return response.json() as Promise<AccessState>;
      })
      .then((state) => {
        setAccess(state);
        if (state.business) setBusiness(state.business);
        else if (state.businesses.length && !state.businesses.includes(business)) setBusiness(state.businesses[0]);
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : "Scanner access could not be checked."));
    // business is intentionally initialized once from the URL or saved theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.dataset.businessTheme = business;
    window.localStorage.setItem("corner-ops-business-theme", business);
    const url = new URL(window.location.href);
    url.searchParams.set("business", business);
    window.history.replaceState(null, "", url);
  }, [business]);

  useEffect(() => {
    if (!sourceFile) {
      setProcessedFile(null);
      setPreviewSize("");
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setProcessing(true);
      void blackAndWhiteFile(sourceFile, threshold, rotation)
        .then((result) => {
          if (cancelled) {
            URL.revokeObjectURL(result.url);
            return;
          }
          setProcessedFile(result.file);
          setPreviewSize(`${result.width} × ${result.height}`);
          setPreviewUrl((current) => {
            if (current) URL.revokeObjectURL(current);
            return result.url;
          });
        })
        .catch((error) => {
          if (!cancelled) setNotice(error instanceof Error ? error.message : "The photo could not be processed.");
        })
        .finally(() => {
          if (!cancelled) setProcessing(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rotation, sourceFile, threshold]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const accessLabel = useMemo(() => {
    if (!access) return "Checking access";
    if (access.mode === "owner") return `Owner: ${access.name}`;
    if (access.mode === "employee") return `Employee: ${access.name}`;
    return "Upload-only access";
  }, [access]);

  function choosePhoto(file: File | null) {
    setNotice("");
    setSaved(null);
    setSourceFile(file);
  }

  function reset() {
    setSourceFile(null);
    setProcessedFile(null);
    setSaved(null);
    setNotice("");
    setRotation(0);
    setThreshold(172);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!processedFile) {
      setNotice("Take a photo and wait for the black-and-white preview before submitting.");
      return;
    }
    setUploading(true);
    setNotice("");
    setSaved(null);
    const formElement = event.currentTarget;
    const values = new FormData(formElement);
    const payload = new FormData();
    payload.set("business", business);
    payload.set("documentType", documentType);
    payload.set("file", processedFile);
    payload.set("uploadPin", String(values.get("uploadPin") || ""));
    payload.set("title", String(values.get("title") || ""));
    payload.set("vendor", String(values.get("vendor") || ""));
    payload.set("reference", String(values.get("reference") || ""));
    payload.set("documentDate", String(values.get("documentDate") || ""));
    payload.set("notes", String(values.get("notes") || ""));
    try {
      const response = await fetch("/api/document-scan", { method: "POST", body: payload });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as ScanResponse;
      setSaved(result);
      setNotice(result.accessMode === "owner"
        ? `Saved as ${result.document.fileName}.`
        : `Submitted as ${result.document.fileName} for owner review.`);
      formElement.reset();
      setSourceFile(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The scanned document could not be saved.");
    } finally {
      setUploading(false);
    }
  }

  const employeeLocked = access?.mode === "employee";
  const guestUnavailable = access?.mode === "guest" && !guestEnabledFor(access, business);
  const ocrType = documentType === "Invoice" || documentType === "Receipt";

  return <main className="scanPage" data-business={business}>
    <header className="scanHero">
      <div>
        <p className="scanEyebrow">Corner Ops mobile scanner</p>
        <h1>Scan a document</h1>
        <p>Take a photo, convert it to clean black and white, classify it, and file it under the correct business. Employees and outside uploaders cannot browse stored documents.</p>
      </div>
      <div className="scanAccess">
        <span>{accessLabel}</span>
        {access?.mode === "employee" && <a href="/employee">Back to Employee Hub</a>}
        {access?.mode === "owner" && <a href="/">Open Documents</a>}
      </div>
    </header>

    {notice && <div className={`scanNotice ${saved ? "success" : ""}`}>{notice}</div>}

    <form className="scanWorkspace" onSubmit={submit}>
      <section className="scanCard scanCaptureCard">
        <div className="scanSectionHeading"><div><p className="scanEyebrow">Step 1</p><h2>Take or choose a photo</h2></div></div>
        <label className={`scanCameraButton ${processing ? "busy" : ""}`}>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={processing || uploading}
            onChange={(event) => choosePhoto(event.target.files?.[0] || null)}
          />
          <strong>{sourceFile ? "Retake or choose another photo" : "Open camera"}</strong>
          <span>Photograph one clear page at a time</span>
        </label>

        {sourceFile && <div className="scanControls">
          <label>
            Black-and-white threshold
            <input type="range" min="95" max="225" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
            <span>{threshold}</span>
          </label>
          <div className="scanRotation">
            <button type="button" onClick={() => setRotation((value) => (value + 270) % 360)}>Rotate left</button>
            <button type="button" onClick={() => setRotation((value) => (value + 90) % 360)}>Rotate right</button>
            <button type="button" onClick={reset}>Start over</button>
          </div>
        </div>}

        <div className={`scanPreview ${processedFile ? "ready" : ""}`}>
          {processing && <div className="scanProcessing"><i /><span>Converting to black and white…</span></div>}
          {!processing && previewUrl && <img src={previewUrl} alt="Processed black-and-white document preview" />}
          {!processing && !previewUrl && <div className="scanPreviewEmpty"><strong>No page captured</strong><span>The black-and-white preview appears here.</span></div>}
        </div>
        {previewSize && <small className="scanDimensions">Processed image: {previewSize} · JPEG</small>}
      </section>

      <section className="scanCard scanDetailsCard">
        <div className="scanSectionHeading"><div><p className="scanEyebrow">Step 2</p><h2>Classify and name it</h2></div><span>{ocrType ? "Azure OCR will run when submitted" : "No paid OCR needed"}</span></div>

        <div className="scanBusinessSwitch" aria-label="Business">
          {(access?.businesses || ["Corner Deli", "Tiki"]).map((name) => <button
            type="button"
            key={name}
            className={business === name ? "active" : ""}
            disabled={employeeLocked}
            onClick={() => setBusiness(name)}
          >{name}</button>)}
        </div>

        <label>
          Document type
          <select value={documentType} onChange={(event) => setDocumentType(event.target.value as ScanDocumentType)}>
            {documentTypes.map((option) => <option key={option.value} value={option.value}>{option.value} · {option.description}</option>)}
          </select>
        </label>

        {access?.mode === "guest" && <label>
          Upload PIN for {business}
          <input name="uploadPin" type="password" inputMode="numeric" autoComplete="off" required />
          {guestUnavailable && <small>No outside-upload PIN is configured for this business.</small>}
        </label>}

        <div className="scanFieldGrid">
          <label>
            Vendor, person, or organization
            <input name="vendor" maxLength={180} placeholder={documentType === "Receipt" ? "Merchant name" : "Optional"} />
          </label>
          <label>
            Invoice, receipt, policy, or reference number
            <input name="reference" maxLength={100} placeholder="Optional" />
          </label>
          <label>
            Document date
            <input name="documentDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
          </label>
          <label>
            Custom title
            <input name="title" maxLength={180} placeholder="Leave blank for automatic naming" />
          </label>
        </div>

        <label>
          Notes
          <textarea name="notes" rows={4} maxLength={1000} placeholder="What this is, who requested it, or anything the owner should know" />
        </label>

        {ocrType && <div className={`scanOcrStatus ${access?.ocr.configured ? "ready" : "missing"}`}>
          <strong>{access?.ocr.configured ? `${access.ocr.provider} ready` : "Invoice/receipt OCR not configured"}</strong>
          <span>{access?.ocr.configured
            ? `Invoice scans analyze up to ${access.ocr.pageLimit} pages; receipt scans analyze the first page.`
            : `The image can still be stored, but fields will not be extracted. ${access?.ocr.missing.join(", ") || ""}`}</span>
        </div>}

        <button className="scanSubmit" disabled={!processedFile || processing || uploading || guestUnavailable}>
          {uploading ? (ocrType ? "Reading and filing…" : "Filing document…") : access?.mode === "owner" ? "Save to Documents" : "Submit for review"}
        </button>
      </section>
    </form>

    {saved && <section className="scanCard scanResultCard">
      <div><p className="scanEyebrow">Filed</p><h2>{saved.document.title}</h2><p>{saved.document.fileName}</p></div>
      <div className="scanResultMeta">
        <span>{saved.document.category}</span>
        <span>{saved.document.status}</span>
        {saved.ocr && <span>{Math.round(saved.ocr.confidence * 100)}% OCR confidence</span>}
      </div>
      {saved.ocr?.warnings.length ? <details><summary>OCR warnings</summary><ul>{saved.ocr.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : null}
    </section>}
  </main>;
}
