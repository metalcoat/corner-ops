"use client";

import { responseMessage } from "@/app/client-http";
import { useEffect, useState } from "react";
import { I9_COPY_NOTE, type I9DocumentList } from "@/lib/i9-document-rules";
import type { Business } from "@/lib/types";

type Doc = { id: string; list: I9DocumentList; title: string; fileName: string; uploadedAt: string };

/** The employee's document copies next to Section 2. Copies help, but the originals are examined in person. */
export default function I9DocumentReview({ business, formId, canView }: { business: Business; formId: string; canView: boolean }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!canView) return;
    fetch(`/api/employment-forms/documents?business=${encodeURIComponent(business)}&formId=${encodeURIComponent(formId)}`, { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(await responseMessage(response)); return response.json(); })
      .then((payload: { documents: Doc[]; complete: boolean }) => { setDocs(payload.documents); setComplete(payload.complete); })
      .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, [business, formId, canView]);
  return <div className="employmentSection i9DocumentReview">
    <h3>Document copies the employee uploaded</h3>
    <p className="reportNote">{I9_COPY_NOTE}</p>
    {!canView && <p>Viewing the copies needs the sensitive employment forms permission (owners have it).</p>}
    {error && <p role="alert">{error}</p>}
    {docs && !docs.length && <p>No copies uploaded yet. The employee adds them in the app after signing Section 1.</p>}
    {docs && docs.length > 0 && <>
      <p>{complete ? "Covers List A, or List B + List C." : "Not a complete set yet (needs one List A, or one List B and one List C)."}</p>
      <ul>{docs.map((doc) => <li key={doc.id}><strong>List {doc.list}</strong>: {doc.title} · <a href={`/api/employment-forms/documents?business=${encodeURIComponent(business)}&id=${encodeURIComponent(doc.id)}`} target="_blank" rel="noreferrer">open copy</a> <small>uploaded {new Date(doc.uploadedAt).toLocaleString("en-US", { timeZone: "America/New_York" })}</small></li>)}</ul>
    </>}
  </div>;
}
