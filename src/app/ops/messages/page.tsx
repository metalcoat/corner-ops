"use client";

import { responseMessage } from "@/app/client-http";
import { firstName } from "@/app/client-text";
import { CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./conversations.css";

type Employee = {
  id: string;
  name: string;
  position: string;
  active: boolean;
  scheduleColor: string;
  avatarSet: boolean;
  chatNickname?: string;
};

type SeenBy = { employeeId: string; name: string; readAt: string };
type Message = {
  id: string;
  conversationKey: string;
  sender_employee_id: string | null;
  sender_name: string;
  sender_chat_nickname: string;
  sender_schedule_color: string;
  sender_avatar_set: boolean;
  recipient_name: string | null;
  body: string;
  attachment_name?: string;
  expectedCount: number;
  seenCount: number;
  seenBy: SeenBy[];
  unseenNames: string[];
  created_at: string;
};

type Payload = { business: Business; employees: Employee[]; messages: Message[] };
type ConversationOption = { key: string; label: string; detail: string };

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

function ownerKey(employeeId: string) {
  return `owner:${employeeId.toLowerCase()}`;
}

function avatarUrl(business: Business, employeeId: string) {
  return `/api/employee-directory/avatar?business=${encodeURIComponent(business)}&id=${encodeURIComponent(employeeId)}`;
}

function directIds(key: string) {
  return key.startsWith("direct:") ? key.split(":").slice(1) : [];
}

export default function MessagesPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<Payload | null>(null);
  const [selectedKey, setSelectedKey] = useState("team");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((value: SessionView) => {
        setSession(value);
        const requested = new URLSearchParams(window.location.search).get("business");
        const allowed = value.businesses || [];
        if ((requested === "Corner Deli" || requested === "Tiki") && allowed.includes(requested)) {
          setBusiness(requested);
        } else if (allowed.length && !allowed.includes(business)) {
          setBusiness(allowed[0]);
        }
      })
      .catch(() => setNotice("Unable to load the current account."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(
      `/api/message-conversations?business=${encodeURIComponent(activeBusiness)}`,
      { cache: "no-store", headers: { "Cache-Control": "no-cache" } },
    );
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as Payload);
    window.dispatchEvent(new Event("corner-ops-notifications-refresh"));
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setSelectedKey("team");
    setNotice("");
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(business).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  const employeesById = useMemo(
    () => new Map((data?.employees || []).map((employee) => [employee.id.toLowerCase(), employee])),
    [data?.employees],
  );

  function conversationLabel(key: string): ConversationOption {
    if (key === "team") {
      return { key, label: "Whole team", detail: `Everyone active at ${business} when each message is sent` };
    }
    if (key.startsWith("owner:")) {
      const employee = employeesById.get(key.slice(6).toLowerCase());
      return {
        key,
        label: employee?.name || "Employee conversation",
        detail: employee?.position || "Management and employee",
      };
    }
    const names = directIds(key).map((id) => employeesById.get(id.toLowerCase())?.name).filter(Boolean) as string[];
    return {
      key,
      label: names.length ? names.join(" ↔ ") : "Employee direct conversation",
      detail: "Direct employee conversation visible to management",
    };
  }

  const conversationOptions = useMemo(() => {
    const keys = new Set<string>(["team"]);
    for (const employee of data?.employees || []) keys.add(ownerKey(employee.id));
    for (const message of data?.messages || []) keys.add(message.conversationKey || "team");
    const options = Array.from(keys).map(conversationLabel);
    return options.sort((a, b) => {
      if (a.key === "team") return -1;
      if (b.key === "team") return 1;
      return a.label.localeCompare(b.label);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.employees, data?.messages, employeesById, business]);

  const selectedMessages = useMemo(
    () => (data?.messages || [])
      .filter((message) => (message.conversationKey || "team") === selectedKey)
      .slice()
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [data?.messages, selectedKey],
  );
  const selectedConversation = conversationOptions.find((option) => option.key === selectedKey)
    || conversationLabel(selectedKey);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/message-conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send",
          business,
          conversationKey: selectedKey,
          body: form.get("body"),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      await load();
      setNotice(`Message added to ${selectedConversation.label}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteMessage(message: Message) {
    const description = message.body.trim()
      ? `“${message.body.trim().slice(0, 80)}${message.body.trim().length > 80 ? "…" : ""}”`
      : "this message";
    if (!window.confirm(`Delete ${description} for everyone? This cannot be undone.`)) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/message-conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", business, id: message.id }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setData((current) => current ? {
        ...current,
        messages: current.messages.filter((item) => item.id !== message.id),
      } : current);
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

  return <main className="controlPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Team communication</p>
        <h1>{business} conversations</h1>
        <p>Choose one employee or the whole team. Replies stay together, and each message keeps the exact recipient list from the moment it was sent.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills">{allowed.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div>
        <button disabled={busy} onClick={() => void load()}>Refresh</button>
        <a href="/ops/workforce">Workforce</a>
      </div>
    </header>
    {notice && <div className="noticeBar">{notice}</div>}

    <div className="conversationWorkspace">
      <aside className="controlCard conversationChooser">
        <p className="eyebrow">Conversation</p>
        <label>Person or group
          <select value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
            {conversationOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </label>
        <div className="conversationSelectionSummary">
          <strong>{selectedConversation.label}</strong>
          <span>{selectedConversation.detail}</span>
          <small>{selectedMessages.length} message{selectedMessages.length === 1 ? "" : "s"}</small>
        </div>
        <p className="conversationSnapshotNote">Team recipients are snapshotted separately on every message. Someone added tomorrow sees tomorrow’s team messages, not yesterday’s.</p>
      </aside>

      <section className="controlCard conversationThreadCard">
        <header className="conversationThreadHeader">
          <div><p className="eyebrow">Inline replies</p><h2>{selectedConversation.label}</h2><span>{selectedConversation.detail}</span></div>
        </header>

        <div className="conversationThread" aria-live="polite">
          {selectedMessages.map((message) => {
            const employeeSender = message.sender_employee_id
              ? employeesById.get(message.sender_employee_id.toLowerCase())
              : null;
            const displayName = message.sender_employee_id
              ? message.sender_chat_nickname || employeeSender?.chatNickname || firstName(message.sender_name)
              : "Management";
            const senderColor = message.sender_schedule_color || employeeSender?.scheduleColor || "#64748B";
            return <article className={`conversationPost ${message.sender_employee_id ? "fromEmployee" : "fromManagement"}`} key={message.id} style={{ "--employee-color": senderColor } as CSSProperties}>
              <header>
                <span className="conversationAvatar">{message.sender_employee_id && message.sender_avatar_set ? <img src={avatarUrl(business, message.sender_employee_id)} alt="" loading="lazy" /> : initials(displayName)}</span>
                <div><strong>{displayName}</strong>{message.sender_employee_id && message.sender_chat_nickname && <small>{message.sender_name}</small>}<span>{local(message.created_at)}</span></div>
                <button type="button" disabled={busy} onClick={() => void deleteMessage(message)}>Delete</button>
              </header>
              {message.body && <p>{message.body}</p>}
              {message.attachment_name && <a className="conversationPhoto" href={`/api/workforce/message-photo?business=${encodeURIComponent(business)}&id=${encodeURIComponent(message.id)}`} target="_blank" rel="noreferrer"><img src={`/api/workforce/message-photo?business=${encodeURIComponent(business)}&id=${encodeURIComponent(message.id)}`} alt={message.body || `Photo from ${displayName}`} loading="lazy" /></a>}
              <details className="conversationReceipt">
                <summary>{message.expectedCount === 0 ? "No employee recipients" : `Seen by ${message.seenCount} of ${message.expectedCount}`}</summary>
                <div>{message.seenBy.length > 0 && <section><strong>Seen</strong>{message.seenBy.map((read) => <span key={read.employeeId}>{read.name} · {local(read.readAt)}</span>)}</section>}{message.unseenNames.length > 0 && <section><strong>Not seen</strong>{message.unseenNames.map((name) => <span key={name}>{name}</span>)}</section>}{message.expectedCount > 0 && message.unseenNames.length === 0 && <p>Everyone included on this message has seen it.</p>}</div>
              </details>
            </article>;
          })}
          {!selectedMessages.length && <div className="conversationEmpty"><strong>No messages here yet.</strong><span>Your first message starts this conversation without creating another administrative scavenger hunt.</span></div>}
        </div>

        <form className="conversationReply" onSubmit={sendMessage}>
          <label>Reply in {selectedConversation.label}<textarea name="body" rows={4} required placeholder="Type the next message in this conversation" /></label>
          <button className="primary" disabled={busy}>{busy ? "Sending…" : "Send reply"}</button>
        </form>
      </section>
    </div>
  </main>;
}
