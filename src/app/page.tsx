"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Business = "Corner Deli" | "Tiki";
type Status = "Active" | "Needs Review" | "Archived";

type DocumentRecord = {
  id: string;
  business: Business;
  title: string;
  category: string;
  documentDate: string;
  status: Status;
  notes: string;
  fileName: string;
  createdAt: string;
};

const starterDocuments: DocumentRecord[] = [
  {
    id: "starter-1",
    business: "Corner Deli",
    title: "Opening checklist",
    category: "Operations",
    documentDate: "2026-08-01",
    status: "Active",
    notes: "Daily opening and food-prep checklist.",
    fileName: "opening-checklist.pdf",
    createdAt: "2026-08-01T09:00:00.000Z",
  },
  {
    id: "starter-2",
    business: "Tiki",
    title: "Seasonal liquor inventory",
    category: "Inventory",
    documentDate: "2026-07-30",
    status: "Needs Review",
    notes: "Reconcile against current bar stock.",
    fileName: "tiki-inventory.xlsx",
    createdAt: "2026-07-30T15:30:00.000Z",
  },
];

const STORAGE_KEY = "corner-ops-documents-v1";

export default function Home() {
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [documents, setDocuments] = useState<DocumentRecord[]>(starterDocuments);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"All" | Status>("All");
  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) setDocuments(JSON.parse(saved) as DocumentRecord[]);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
  }, [documents]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return documents
      .filter((document) => document.business === business)
      .filter((document) => status === "All" || document.status === status)
      .filter((document) =>
        !needle ||
        [document.title, document.category, document.notes, document.fileName]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [business, documents, query, status]);

  function addDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file") as File;
    const record: DocumentRecord = {
      id: crypto.randomUUID(),
      business,
      title: String(form.get("title") || file?.name || "Untitled document"),
      category: String(form.get("category") || "General"),
      documentDate: String(form.get("documentDate") || new Date().toISOString().slice(0, 10)),
      status: String(form.get("status") || "Active") as Status,
      notes: String(form.get("notes") || ""),
      fileName: file?.name || "No file selected",
      createdAt: new Date().toISOString(),
    };
    setDocuments((current) => [record, ...current]);
    event.currentTarget.reset();
    setShowUpload(false);
  }

  const businessDocuments = documents.filter((document) => document.business === business);
  const needsReview = businessDocuments.filter((document) => document.status === "Needs Review").length;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Internal operations</p>
          <h1>Corner Ops</h1>
        </div>
        <nav>
          <button className="navItem active">Dashboard</button>
          <button className="navItem">Documents</button>
          <button className="navItem">Tasks</button>
          <button className="navItem">Reports</button>
        </nav>
        <p className="sidebarNote">Built for the deli and the bar, because apparently one business was not enough paperwork.</p>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Sunday, August 2, 2026</p>
            <h2>{business} dashboard</h2>
          </div>
          <div className="businessSwitch" aria-label="Choose business">
            {(["Corner Deli", "Tiki"] as Business[]).map((name) => (
              <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>
                {name}
              </button>
            ))}
          </div>
        </header>

        <section className="stats">
          <article><span>Total documents</span><strong>{businessDocuments.length}</strong></article>
          <article><span>Needs review</span><strong>{needsReview}</strong></article>
          <article><span>Active records</span><strong>{businessDocuments.filter((d) => d.status === "Active").length}</strong></article>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Document vault</p>
              <h3>Files and records</h3>
            </div>
            <button className="primary" onClick={() => setShowUpload((value) => !value)}>
              {showUpload ? "Close" : "+ Add document"}
            </button>
          </div>

          {showUpload && (
            <form className="uploadForm" onSubmit={addDocument}>
              <label>Title<input name="title" required /></label>
              <label>Category<select name="category"><option>Operations</option><option>Inventory</option><option>Financial</option><option>Compliance</option><option>Employee</option><option>General</option></select></label>
              <label>Document date<input name="documentDate" type="date" required /></label>
              <label>Status<select name="status"><option>Active</option><option>Needs Review</option><option>Archived</option></select></label>
              <label className="wide">Original file<input name="file" type="file" required /></label>
              <label className="wide">Notes<textarea name="notes" rows={3} /></label>
              <button className="primary" type="submit">Save record</button>
            </form>
          )}

          <div className="filters">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, category, filename, or notes" />
            <select value={status} onChange={(event) => setStatus(event.target.value as "All" | Status)}>
              <option>All</option><option>Active</option><option>Needs Review</option><option>Archived</option>
            </select>
          </div>

          <div className="documentList">
            {filtered.length === 0 ? (
              <div className="empty">No documents match those filters. Humanity survives another search box.</div>
            ) : filtered.map((document) => (
              <article className="documentRow" key={document.id}>
                <div className="fileIcon">{document.fileName.split(".").pop()?.toUpperCase() || "FILE"}</div>
                <div className="documentMain">
                  <div className="documentTitle"><strong>{document.title}</strong><span className={`badge ${document.status.replaceAll(" ", "").toLowerCase()}`}>{document.status}</span></div>
                  <p>{document.fileName}</p>
                  <small>{document.category} · {document.documentDate}{document.notes ? ` · ${document.notes}` : ""}</small>
                </div>
                <button className="textButton" onClick={() => setDocuments((current) => current.filter((item) => item.id !== document.id))}>Remove</button>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
