"use client";

import { firstName } from "@/app/client-text";
import { responseMessage } from "@/app/client-http";
import { CSSProperties, FormEvent, useEffect, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./messages.css";

type Employee = { id: string; name: string; position: string; active: boolean; scheduleColor: string; avatarSet: boolean };
type SeenBy = { employeeId: string; name: string; readAt: string };
type Message = {
  id: string;
  sender_employee_id: string | null;
  sender_name: string;
  sender_chat_nickname: string;
  sender_schedule_color: string;
  sender_avatar_set: boolean;
  recipient_name: string | null;
  message_type: string;
  body: string;
  attachment_name?: string;
  attachment_type?: string;
  attachment_size?: number | string;
  expectedCount: number;
  seenCount: number;
  seenBy: SeenBy[];
  unseenNames: string[];
  created_at: string;
};
type MessagesPayload = { business: Business; employees: Employee[]; messages: Message[] };



function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
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

function avatarUrl(business: Business, employeeId: string) {
  return `/api/employee-directory/avatar?business=${encodeURIComponent(business)}&id=${encodeURIComponent(employeeId)}`;
}

export default function MessagesPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<MessagesPayload | null>(null);
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

  async function load(activeBusiness = business, markRead = document.visibilityState === "visible") {
    const query = new URLSearchParams({
      business: activeBusiness,
      markRead: markRead ? "1" : "0",
    });
    const response = await fetch(`/api/messages?${query.toString()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as MessagesPayload);
    window.dispatchEvent(new Event("corner-ops-notifications-refresh"));
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    void load(business, document.visibilityState === "visible").catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    const interval = window.setInterval(
      () => void load(business, document.visibilityState === "visible").catch(() => undefined),
      30_000,
    );
    function onVisibilityChange() {
      if (document.visibilityState === "visible") void load(business, true).catch(() => undefined);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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

  async function deleteMessage(message: Message) {
    const description = message.body.trim()
      ? `“${message.body.trim().slice(0, 80)}${message.body.trim().length > 80 ? "…" : ""}”`
      : message.attachment_name
        ? "this photo message"
        : "this message";
    if (!window.confirm(`Delete ${description} for everyone? This cannot be undone.`)) return;

    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/messages/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business, id: message.id }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setData((current) => current ? {
        ...current,
        messages: current.messages.filter((item) => item.id !== message.id),
      } : current);
      window.dispatchEvent(new Event("corner-ops-notifications-refresh"));
      setNotice("Message deleted for everyone.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="controlPage">Loading messages…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;
  const allowed = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);
  const employees = (data?.employees || []).filter((employee) => employee.active !== false);

  return <main className="controlPage">
    <header className="controlHeader">
      <div><p className="eyebrow">Team communication</p><h1>{business} messages</h1><p>Chat nicknames are shown conversationally while the employee’s actual name remains visible to management. Read receipts continue their noble work of documenting who ignored what.</p></div>
      <div className="controlActions"><div className="businessPills">{allowed.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div><button disabled={busy} onClick={() => void load()}>Refresh</button><a href="/ops/workforce">Workforce</a></div>
    </header>
    {notice && <div className="noticeBar">{notice}</div>}
    <div className="messageCenterGrid">
      <section className="controlCard messageComposerCard">
        <div><p className="eyebrow">Owner message</p><h2>Send a message</h2></div>
        <form className="messageComposer" onSubmit={sendMessage}>
          <label>Recipient<select name="recipientEmployeeId" defaultValue=""><option value="">Everyone at {business}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.position}</option>)}</select></label>
          <label>Message<textarea name="body" rows={7} required /></label>
          <button disabled={busy}>Send message</button>
        </form>
      </section>
      <section className="controlCard messageFeedCard">
        <div className="messageFeedHeader"><div><p className="eyebrow">Recent activity</p><h2>Message feed</h2></div><strong>{data?.messages.length || 0}</strong></div>
        <div className="ownerMessageFeed">{(data?.messages || []).map((message) => {
          const displayName = message.sender_chat_nickname || firstName(message.sender_name);
          return <article className="ownerMessageItem" key={message.id} style={{ "--employee-color": message.sender_schedule_color || "#64748B" } as CSSProperties}>
            <header>
              <span className="ownerMessageAvatar">{message.sender_employee_id && message.sender_avatar_set ? <img src={avatarUrl(business, message.sender_employee_id)} alt="" loading="lazy" /> : initials(displayName)}</span>
              <div><strong>{displayName}</strong>{message.sender_chat_nickname && <small className="ownerMessageLegalName">{message.sender_name}</small>}<span>{message.recipient_name ? `to ${firstName(message.recipient_name)}` : message.message_type}</span></div>
              <div className="ownerMessageHeaderActions"><small>{local(message.created_at)}</small><button type="button" disabled={busy} onClick={() => void deleteMessage(message)}>Delete</button></div>
            </header>
            {message.body && <p>{message.body}</p>}
            {message.attachment_name && <a className="ownerMessagePhoto" href={`/api/workforce/message-photo?business=${encodeURIComponent(business)}&id=${encodeURIComponent(message.id)}`} target="_blank" rel="noreferrer"><img src={`/api/workforce/message-photo?business=${encodeURIComponent(business)}&id=${encodeURIComponent(message.id)}`} alt={message.body || `Photo from ${displayName}`} loading="lazy" /><span>Open full photo</span></a>}
            <details className="messageReadReceipt"><summary>{message.expectedCount === 0 ? "No employee recipients" : `Seen by ${message.seenCount} of ${message.expectedCount}`}</summary><div>{message.seenBy.length > 0 && <section><strong>Seen</strong>{message.seenBy.map((read) => <span key={read.employeeId}>{read.name} · {local(read.readAt)}</span>)}</section>}{message.unseenNames.length > 0 && <section><strong>Not seen</strong>{message.unseenNames.map((name) => <span key={name}>{name}</span>)}</section>}{message.expectedCount > 0 && message.unseenNames.length === 0 && <p>Everyone has seen this message.</p>}</div></details>
          </article>;
        })}{!data?.messages.length && <p>No messages yet.</p>}</div>
      </section>
    </div>
  </main>;
}
