"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  businesses,
  documentStatuses,
  type Business,
  type DocumentRecord,
  type DocumentStatus,
  type SessionView,
} from "@/lib/types";

const categories = ["Operations", "Inventory", "Financial", "Compliance", "Employee", "Vendor", "General"];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function responseMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function Home() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"All" | DocumentStatus>("All");
  const [showUpload, setShowUpload] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: SessionView) => setSession(data))
      .catch(() => setSession({ authenticated: false, configured: false, missing: ["Unable to reach the server"] }));
  }, []);

  async function loadDocuments(activeBusiness = business) {
    setLoadingDocuments(true);
    setMessage("");
    try {
      const response = await fetch(`/api/documents?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = (await response.json()) as { documents: DocumentRecord[] };
      setDocuments(payload.documents);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Documents could not be loaded.");
    } finally {
      setLoadingDocuments(false);
    }
  }

  useEffect(() => {
    if (session?.authenticated && session.configured) void loadDocuments(business);
    // loadDocuments intentionally stays outside the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated, session?.configured]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return documents.filter((document) => {
      const matchesStatus = status === "All" || document.status === status;
      const matchesQuery = !needle || [document.title, document.category, document.notes, document.fileName]
        .join(" ")
        .toLowerCase()
        .includes(needle);
      return matchesStatus && matchesQuery;
    });
  }, [documents, query, status]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: String(form.get("password") || "") }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const data = (await response.json()) as SessionView;
      setSession({ ...data, configured: true, missing: [] });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/session", { method: "DELETE" });
    setDocuments([]);
    setSession((current) => ({ authenticated: false, configured: current?.configured ?? true, missing: current?.missing ?? [] }));
  }

  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    form.set("business", business);
    try {
      const response = await fetch("/api/documents", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      event.currentTarget.reset();
      setShowUpload(false);
      await loadDocuments();
      setMessage("Document uploaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteDocument(document: DocumentRecord) {
    if (!window.confirm(`Delete “${document.title}” and its stored file?`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/documents/${document.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseMessage(response));
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setMessage("Document deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return <main className="centered"><div className="loginCard"><p className="eyebrow">Corner Ops</p><h1>Loading</h1><p className="muted">Checking the filing cabinet for signs of life.</p></div></main>;
  }

  if (!session.configured) {
    return (
      <main className="centered">
        <section className="loginCard setupCard">
          <p className="eyebrow">Setup required</p>
          <h1>Connect storage and secrets</h1>
          <p className="muted">The app is built, but these environment variables are still missing:</p>
          <div className="missingList">{session.missing.map((name) => <code key={name}>{name}</code>)}</div>
          <p className="muted">Add them in Vercel or <code>.env.local</code>, then reload.</p>
        </section>
      </main>
    );
  }

  if (!session.authenticated) {
    return (
      <main className="centered">
        <form className="loginCard" onSubmit={login}>
          <p className="eyebrow">Internal operations</p>
          <h1>Corner Ops</h1>
          <p className="muted">One password between you and the paperwork. Civilization remains fragile.</p>
          <label>Password<input name="password" type="password" autoComplete="current-password" required autoFocus /></label>
          {message && <p className="formMessage errorMessage">{message}</p>}
          <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
      </main>
    );
  }

  const needsReview = documents.filter((document) => document.status === "Needs Review").length;
  const currentDate = new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(new Date());

  return (
    <main className="shell">
      <aside className="sidebar">
        <div><p className="eyebrow">Internal operations</p><h1>Corner Ops</h1></div>
        <nav>
          <button className="navItem active">Documents</button>
          <button className="navItem" disabled>Tasks <span>Soon</span></button>
          <button className="navItem" disabled>Reports <span>Soon</span></button>
        </nav>
        <div className="sidebarFooter">
          <p>{session.email}</p>
          <button className="textButton neutral" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div><p className="eyebrow">{currentDate}</p><h2>{business} documents</h2></div>
          <div className="businessSwitch" aria-label="Choose business">
            {businesses.map((name) => (
              <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>{name}</button>
            ))}
          </div>
        </header>

        <section className="stats">
          <article><span>Total documents</span><strong>{documents.length}</strong></article>
          <article><span>Needs review</span><strong>{needsReview}</strong></article>
          <article><span>Active records</span><strong>{documents.filter((d) => d.status === "Active").length}</strong></article>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div><p className="eyebrow">Private document vault</p><h3>Files and records</h3></div>
            <button className="primary" onClick={() => setShowUpload((value) => !value)} disabled={busy}>
              {showUpload ? "Close" : "+ Upload document"}
            </button>
          </div>

          {showUpload && (
            <form className="uploadForm" onSubmit={uploadDocument}>
              <label>Title<input name="title" maxLength={180} required /></label>
              <label>Category<select name="category">{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
              <label>Document date<input name="documentDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
              <label>Status<select name="status">{documentStatuses.map((name) => <option key={name}>{name}</option>)}</select></label>
              <label className="wide">Original file<input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.txt,.doc,.docx,.xls,.xlsx" required /></label>
              <label className="wide">Notes<textarea name="notes" rows={3} maxLength={2000} /></label>
              <button className="primary" type="submit" disabled={busy}>{busy ? "Uploading…" : "Upload and save"}</button>
            </form>
          )}

          <div className="filters">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, category, filename, or notes" />
            <select value={status} onChange={(event) => setStatus(event.target.value as "All" | DocumentStatus)}>
              <option>All</option>{documentStatuses.map((name) => <option key={name}>{name}</option>)}
            </select>
          </div>

          {message && <div className="notice">{message}</div>}

          <div className="documentList" aria-busy={loadingDocuments}>
            {loadingDocuments ? (
              <div className="empty">Loading documents…</div>
            ) : filtered.length === 0 ? (
              <div className="empty">No documents match those filters. The filing cabinet has achieved temporary peace.</div>
            ) : filtered.map((document) => (
              <article className="documentRow" key={document.id}>
                <div className="fileIcon">{document.fileName.split(".").pop()?.toUpperCase() || "FILE"}</div>
                <div className="documentMain">
                  <div className="documentTitle"><strong>{document.title}</strong><span className={`badge ${document.status.replaceAll(" ", "").toLowerCase()}`}>{document.status}</span></div>
                  <p>{document.fileName} · {formatBytes(document.sizeBytes)}</p>
                  <small>{document.category} · {document.documentDate}{document.notes ? ` · ${document.notes}` : ""}</small>
                </div>
                <div className="rowActions">
                  <a className="secondary" href={`/api/documents/${document.id}/download`}>Download</a>
                  <button className="textButton" onClick={() => deleteDocument(document)} disabled={busy}>Delete</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
