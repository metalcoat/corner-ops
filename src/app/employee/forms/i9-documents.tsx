"use client";

import { responseMessage } from "@/app/client-http";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { I9_DOCUMENT_CHOICES, type I9DocumentList } from "@/lib/i9-document-rules";

type Doc = { id: string; list: I9DocumentList; title: string; fileName: string; uploadedAt: string };

/** After Section 1: the employee adds copies of the documents they chose (List A, or List B + List C). */
export default function I9Documents({ formId, locked }: { formId: string; locked: boolean }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [complete, setComplete] = useState(false);
  const [choice, setChoice] = useState<"A" | "BC">("A");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(`/api/employee/forms/documents?formId=${encodeURIComponent(formId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as { documents: Doc[]; complete: boolean };
    setDocs(payload.documents);
    setComplete(payload.complete);
    if (payload.documents.some((doc) => doc.list !== "A")) setChoice("BC");
  }, [formId]);

  useEffect(() => { void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error))); }, [load]);

  async function upload(event: FormEvent<HTMLFormElement>, list: I9DocumentList) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("formId", formId);
    form.set("list", list);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee/forms/documents", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      await load();
      setNotice("Copy uploaded.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/employee/forms/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove it.");
    } finally {
      setBusy(false);
    }
  }

  const uploader = (list: I9DocumentList, heading: string) => <form className="employmentSection" onSubmit={(event) => void upload(event, list)}>
    <h3>{heading}</h3>
    <div className="employmentFieldGrid">
      <label>Which document<select name="title" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...I9_DOCUMENT_CHOICES[list].map((title) => <option key={title}>{title}</option>)]}</select></label>
      <label>Photo or PDF (front; add the back as a second upload if it has information)<input name="file" type="file" accept="image/*,application/pdf" capture="environment" required /></label>
    </div>
    <button className="employmentPrimary" disabled={busy}>{busy ? "Uploading…" : "Upload copy"}</button>
  </form>;

  return <div className="employmentSection i9Documents">
    <h3>Copies of your I-9 documents</h3>
    <p>Add photos of the documents you will show your manager. <strong>You choose which documents to use</strong>: either one document from List A, or one from List B and one from List C. Bring the originals on your first day; your manager has to look at them in person.</p>
    {complete ? <p className="i9DocsDone">✓ Your copies are uploaded. Bring the originals to work.</p> : <p className="i9DocsTodo">Not finished: {choice === "A" ? "one List A document" : "one List B and one List C document"}.</p>}
    {docs.length > 0 && <ul>{docs.map((doc) => <li key={doc.id}>List {doc.list}: {doc.title} <a href={`/api/employee/forms/documents?id=${encodeURIComponent(doc.id)}`} target="_blank" rel="noreferrer">view</a>{!locked && <button type="button" disabled={busy} onClick={() => void remove(doc.id)}>Remove</button>}</li>)}</ul>}
    {!locked && <>
      <div className="i9DocsChoice">
        <label><input type="radio" name="i9choice" checked={choice === "A"} onChange={() => setChoice("A")} /> One List A document (for example a U.S. passport or Permanent Resident Card)</label>
        <label><input type="radio" name="i9choice" checked={choice === "BC"} onChange={() => setChoice("BC")} /> One List B document (for example a driver&apos;s license) and one List C document (for example a Social Security card)</label>
      </div>
      {choice === "A" ? uploader("A", "List A document") : <>{uploader("B", "List B document (identity)")}{uploader("C", "List C document (work authorization)")}</>}
    </>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
