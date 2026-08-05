"use client";

import { CSSProperties, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import "./messages-dock.css";

type EmployeeSession = {
  employeeId: string;
  business: "Corner Deli" | "Tiki";
  name: string;
};

type DirectoryEmployee = {
  id: string;
  name: string;
  position: string;
  scheduleColor: string;
  avatarSet: boolean;
  chatNickname: string;
};

type Message = {
  id: string;
  sender_employee_id: string | null;
  sender_name: string;
  sender_chat_nickname?: string;
  sender_schedule_color?: string;
  sender_avatar_set?: boolean;
  recipient_name: string | null;
  message_type: string;
  body: string;
  attachment_name?: string;
  attachment_type?: string;
  attachment_size?: number | string;
  created_at: string;
};

type EmployeeData = {
  employee: DirectoryEmployee;
  messages: Message[];
  directory: DirectoryEmployee[];
  unreadMessageIds: string[];
};

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function local(value: string): string {
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function firstName(value: string | null): string {
  const text = String(value || "").trim();
  if (!text) return "Unknown";
  if (text.toLowerCase() === "crfrary@gmail.com") return "Chris";
  const candidate = text.includes("@")
    ? text.split("@")[0].split(/[._-]/)[0]
    : text.split(/\s+/)[0];
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function compact(value: string, max = 58): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function selectedPhoto(form: FormData): File | null {
  const camera = form.get("cameraPhoto");
  if (camera instanceof File && camera.size > 0) return camera;
  const library = form.get("photo");
  return library instanceof File && library.size > 0 ? library : null;
}

function avatarUrl(employeeId: string): string {
  return `/api/employee/avatar?id=${encodeURIComponent(employeeId)}`;
}

export default function EmployeeMessagesDock() {
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [data, setData] = useState<EmployeeData | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const reportedSeen = useRef(new Set<string>());

  const load = useCallback(async () => {
    const sessionResponse = await fetch("/api/employee/session", { cache: "no-store" });
    if (!sessionResponse.ok) return;
    const sessionPayload = await sessionResponse.json() as { session?: EmployeeSession | null };
    const activeSession = sessionPayload.session || null;
    setSession(activeSession);
    if (!activeSession) {
      setData(null);
      setExpanded(false);
      reportedSeen.current.clear();
      return;
    }

    const [response, unreadResponse] = await Promise.all([
      fetch("/api/employee", { cache: "no-store" }),
      fetch("/api/employee/messages/unread", { cache: "no-store" }),
    ]);
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as Omit<EmployeeData, "unreadMessageIds">;
    const unreadPayload = unreadResponse.ok
      ? await unreadResponse.json() as { unreadMessageIds?: string[] }
      : { unreadMessageIds: [] };
    setData({
      employee: payload.employee,
      messages: payload.messages || [],
      directory: payload.directory || [],
      unreadMessageIds: unreadPayload.unreadMessageIds || [],
    });
  }, []);

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : "Messages could not be loaded."));
    const interval = window.setInterval(() => void load().catch(() => undefined), session ? 30_000 : 5_000);
    return () => window.clearInterval(interval);
  }, [load, session]);

  useEffect(() => {
    if (!session || !data?.messages.length) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
        const messageId = (entry.target as HTMLElement).dataset.messageId || "";
        if (!messageId || reportedSeen.current.has(messageId)) continue;
        reportedSeen.current.add(messageId);
        void fetch("/api/employee", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "message-seen", messageId }),
        }).then(async (response) => {
          if (!response.ok) throw new Error(await responseMessage(response));
          setData((current) => current ? {
            ...current,
            unreadMessageIds: current.unreadMessageIds.filter((id) => id !== messageId),
          } : current);
        }).catch(() => reportedSeen.current.delete(messageId));
      }
    }, { threshold: [0.6] });
    document.querySelectorAll<HTMLElement>("[data-message-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [data?.messages, session]);

  async function updateNickname(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "nickname-update", nickname: form.get("nickname") }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(String(form.get("nickname") || "").trim() ? "Chat nickname updated." : "Chat nickname cleared.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Chat nickname could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = String(form.get("body") || "").trim();
    const photo = selectedPhoto(form);
    if (!body && !photo) {
      setNotice("Type a message or attach a photo.");
      return;
    }
    form.set("action", "message-send");
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      await load();
      setNotice(photo ? "Photo message sent." : "Message sent.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadProfilePhoto(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("action", "profile-photo");
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      await load();
      setNotice("Your schedule and message icon was updated.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Profile photo could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return null;

  const recipients = (data?.directory || []).filter((person) => person.id !== session.employeeId);
  const current = data?.employee;
  const currentDisplay = current?.chatNickname || firstName(session.name);
  const unreadIds = new Set(data?.unreadMessageIds || []);
  const unreadMessages = (data?.messages || []).filter((message) => unreadIds.has(message.id));
  const previewMessage = unreadMessages[0] || data?.messages[0];
  const previewSender = previewMessage
    ? previewMessage.sender_chat_nickname || firstName(previewMessage.sender_name)
    : "";
  const previewText = unreadMessages.length
    ? compact(`${previewSender}: ${previewMessage?.body || (previewMessage?.attachment_name ? "Photo message" : "New message")}`)
    : data?.messages.length
      ? "All caught up"
      : "No messages yet";

  return <aside className={`employeeMessagesDock ${expanded ? "isOpen" : "isCollapsed"} ${unreadMessages.length ? "hasUnread" : ""}`} aria-label="Employee messages">
    <header className="employeeMessagesMobileHeader">
      <button
        className="employeeMessagesToggle"
        type="button"
        aria-expanded={expanded}
        aria-controls="employee-messages-panel"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="employeeMessagesBell" aria-hidden="true">✉</span>
        <span className="employeeMessagesCompactCopy">
          <span className="employeeMessagesCompactTitle">
            Messages
            {unreadMessages.length ? <span className="employeeMessagesUnreadCount">{unreadMessages.length}</span> : null}
          </span>
          <span className="employeeMessagesPreview">{previewText}</span>
        </span>
        <span className="employeeMessagesChevron" aria-hidden="true">{expanded ? "Close" : "Open"}</span>
      </button>
    </header>

    <header className="employeeMessagesHeader">
      <div className="employeeMessagesIdentity" style={{ "--employee-color": current?.scheduleColor || "#64748B" } as CSSProperties}>
        <span className="employeeMessageAvatar large">{current?.avatarSet ? <img src={avatarUrl(session.employeeId)} alt="Your profile" /> : initials(currentDisplay)}</span>
        <div><p className="employeeMessagesEyebrow">Team chat</p><h2>Messages</h2><small>{current?.chatNickname ? `${current.chatNickname} · ${session.name}` : session.name}</small></div>
      </div>
      <button type="button" onClick={() => void load()} disabled={busy} aria-label="Refresh messages">Refresh</button>
    </header>

    <div className="employeeMessagesPanel" id="employee-messages-panel">
      <details className="employeeMessageOptions">
        <summary>Profile & chat options</summary>
        <div className="employeeMessageOptionsBody">
          <form className="employeeNicknameForm" key={current?.chatNickname || "no-nickname"} onSubmit={updateNickname}>
            <label>Chat nickname<input name="nickname" maxLength={32} defaultValue={current?.chatNickname || ""} placeholder={firstName(session.name)} /></label>
            <button disabled={busy}>Save nickname</button>
            <small>Used in messages only. Leave blank to use your regular name.</small>
          </form>

          <form className="employeeProfilePhotoForm" onSubmit={uploadProfilePhoto}>
            <label>Take icon photo<input name="cameraProfilePhoto" type="file" accept="image/*" capture="user" /></label>
            <label>Choose icon photo<input name="profilePhoto" type="file" accept="image/*" /></label>
            <button disabled={busy}>Update icon</button>
          </form>
        </div>
      </details>

      <form className="employeeMessagesComposer" onSubmit={sendMessage}>
        <input type="hidden" name="action" value="message-send" />
        <label>Send to<select name="recipientEmployeeId" defaultValue=""><option value="">Everyone at {session.business}</option>{recipients.map((person) => <option key={person.id} value={person.id}>{person.chatNickname || firstName(person.name)}</option>)}</select></label>
        <label>Message<textarea name="body" rows={3} placeholder="Type a message, add a photo, or both" /></label>
        <div className="employeeMessagesPhotoControls">
          <label className="employeeMessagesPhotoButton">Take photo<input name="cameraPhoto" type="file" accept="image/*" capture="environment" /></label>
          <label className="employeeMessagesPhotoButton secondary">Choose photo<input name="photo" type="file" accept="image/*" /></label>
        </div>
        <button className="employeeMessagesSend" disabled={busy}>Send message</button>
      </form>

      {notice && <div className="employeeMessagesNotice">{notice}</div>}

      <div className="employeeMessagesFeed" aria-live="polite">
        {(data?.messages || []).map((message) => {
          const senderColor = message.sender_schedule_color || "#64748B";
          const senderDisplay = message.sender_chat_nickname || firstName(message.sender_name);
          const unread = unreadIds.has(message.id);
          return <article className={`employeeMessagesItem ${unread ? "isUnread" : ""}`} key={message.id} data-message-id={message.id} style={{ "--employee-color": senderColor } as CSSProperties}>
            <header className="employeeMessageMeta">
              <span className="employeeMessageAvatar">{message.sender_employee_id && message.sender_avatar_set ? <img src={avatarUrl(message.sender_employee_id)} alt="" loading="lazy" /> : initials(senderDisplay)}</span>
              <div><strong>{senderDisplay}</strong><span>{message.recipient_name ? `to ${firstName(message.recipient_name)}` : message.message_type}</span></div>
              <div className="employeeMessageStatus">{unread ? <span className="employeeMessagesUnreadMark">New</span> : null}<small>{local(message.created_at)}</small></div>
            </header>
            {message.body && <p>{message.body}</p>}
            {message.attachment_name && <a className="employeeMessagesPhoto" href={`/api/employee/message-photo?id=${encodeURIComponent(message.id)}`} target="_blank" rel="noreferrer" aria-label={`Open photo from ${senderDisplay}`}><img src={`/api/employee/message-photo?id=${encodeURIComponent(message.id)}`} alt={message.body || `Photo from ${senderDisplay}`} loading="lazy" /></a>}
          </article>;
        })}
        {!data?.messages.length && <p className="employeeMessagesEmpty">No messages yet.</p>}
      </div>
    </div>
  </aside>;
}
