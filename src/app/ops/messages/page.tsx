"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./messages.css";

type Employee = { id: string; name: string; active: boolean };
type Message = {
  id: string;
  sender_name: string;
  recipient_name: string | null;
  message_type: string;
  body: string;
  attachment_name?: string;
  attachment_type?: string;
  attachment_size?: number | string;
  created_at: string;
};
type WorkforcePayload = { business: Business; employees: Employee[]; messages: Message[] };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function firstName(value: string | null) {
  const text = String(value || "").trim();
  if (!text) return "Unknown";
  if (text.toLowerCase() === "crfrary@gmail.com") return "Chris";
  const candidate = text.includes("@") ? text.split("@")[0].split(/[._-]/)[0] : text.split(/\s+/)[0];
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}

function local(value: string) {
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function MessagesPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<WorkforcePayload | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((value: SessionView) => {
        setSession(value);
        const allowed = value.businesses || [];
        if (allowed.length && !allowed.includes(business)) setBusiness(allowed[0]);
      })
      .catch(() => setNotice("Unable to load the current account."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/workforce?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as WorkforcePayload);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/workforce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "message-send",
          business,
          recipientEmployeeId: form.get("recipientEmployeeId") || null,
          body: form.get("body"),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      await load();
      setNotice("Message sent.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="controlPage">Loading messages…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;
  const allowed = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);
  const employees = (data?.employees || []).filter((employee) => employee.active);

  return <main className="controlPage">
    <header className="controlHeader">
      <div><p className="eyebrow">Team communication</p><h1>{business} messages</h1><p>Send announcements or direct messages and review photos uploaded by employees from their phones.</p></div>
      <div className="controlActions"><div className="businessPills">{allowed.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div><button disabled={busy} onClick={() => void load()}>Refresh</button><a href="/ops/workforce">Workforce</a></div>
    </header>
    {notice && <div className="noticeBar">{notice}</div>}
    <div className="messageCenterGrid">
      <section className="controlCard messageComposerCard">
        <div><p className="eyebrow">Owner message</p><h2>Send a message</h2></div>
        <form className="messageComposer" onSubmit={sendMessage}>
          <label>Recipient<select name="recipientEmployeeId" defaultValue=""><option value="">Everyone at {business}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
          <label>Message<textarea name="body" rows={7} required /></label>
          <button disabled={busy}>Send message</button>
        </form>
      </section>
      <section className="controlCard messageFeedCard">
        <div className="messageFeedHeader"><div><p className="eyebrow">Recent activity</p><h2>Message feed</h2></div><strong>{data?.messages.length || 0}</strong></div>
        <div className="ownerMessageFeed">{(data?.messages || []).map((message) => <article className="ownerMessageItem" key={message.id}><header><div><strong>{firstName(message.sender_name)}</strong><span>{message.recipient_name ? `to ${firstName(message.recipient_name)}` : message.message_type}</span></div><small>{local(message.created_at)}</small></header>{message.body && <p>{message.body}</p>}{message.attachment_name && <a className="ownerMessagePhoto" href={`/api/workforce/message-photo?business=${encodeURIComponent(business)}&id=${encodeURIComponent(message.id)}`} target="_blank" rel="noreferrer"><img src={`/api/workforce/message-photo?business=${encodeURIComponent(business)}&id=${encodeURIComponent(message.id)}`} alt={message.body || `Photo from ${firstName(message.sender_name)}`} loading="lazy" /><span>Open full photo</span></a>}</article>)}{!data?.messages.length && <p>No messages yet.</p>}</div>
      </section>
    </div>
  </main>;
}
