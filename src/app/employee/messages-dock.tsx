"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
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
};

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

type EmployeeData = {
  messages: Message[];
  directory: DirectoryEmployee[];
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

function selectedPhoto(form: FormData): File | null {
  const camera = form.get("cameraPhoto");
  if (camera instanceof File && camera.size > 0) return camera;
  const library = form.get("photo");
  return library instanceof File && library.size > 0 ? library : null;
}

export default function EmployeeMessagesDock() {
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [data, setData] = useState<EmployeeData | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const sessionResponse = await fetch("/api/employee/session", { cache: "no-store" });
    if (!sessionResponse.ok) return;
    const sessionPayload = await sessionResponse.json() as { session?: EmployeeSession | null };
    const activeSession = sessionPayload.session || null;
    setSession(activeSession);
    if (!activeSession) {
      setData(null);
      return;
    }

    const response = await fetch("/api/employee", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as EmployeeData;
    setData({
      messages: payload.messages || [],
      directory: payload.directory || [],
    });
  }, []);

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : "Messages could not be loaded."));
    const interval = window.setInterval(() => {
      void load().catch(() => undefined);
    }, session ? 30_000 : 5_000);
    return () => window.clearInterval(interval);
  }, [load, session]);

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

  if (!session) return null;

  const recipients = (data?.directory || []).filter((person) => person.id !== session.employeeId);

  return (
    <aside className="employeeMessagesDock" aria-label="Employee messages">
      <header className="employeeMessagesHeader">
        <div>
          <p className="employeeMessagesEyebrow">Always visible</p>
          <h2>Messages</h2>
        </div>
        <button type="button" onClick={() => void load()} disabled={busy} aria-label="Refresh messages">
          Refresh
        </button>
      </header>

      <form className="employeeMessagesComposer" onSubmit={sendMessage}>
        <input type="hidden" name="action" value="message-send" />
        <label>
          Send to
          <select name="recipientEmployeeId" defaultValue="">
            <option value="">Everyone at {session.business}</option>
            {recipients.map((person) => (
              <option key={person.id} value={person.id}>{firstName(person.name)}</option>
            ))}
          </select>
        </label>
        <label>
          Message
          <textarea name="body" rows={3} placeholder="Type a message, add a photo, or both" />
        </label>
        <div className="employeeMessagesPhotoControls">
          <label className="employeeMessagesPhotoButton">
            Take photo
            <input name="cameraPhoto" type="file" accept="image/*" capture="environment" />
          </label>
          <label className="employeeMessagesPhotoButton secondary">
            Choose photo
            <input name="photo" type="file" accept="image/*" />
          </label>
        </div>
        <small className="employeeMessagesPhotoHelp">One image per message, up to 12 MB.</small>
        <button className="employeeMessagesSend" disabled={busy}>Send message</button>
      </form>

      {notice && <div className="employeeMessagesNotice">{notice}</div>}

      <div className="employeeMessagesFeed" aria-live="polite">
        {(data?.messages || []).map((message) => (
          <article className="employeeMessagesItem" key={message.id}>
            <div>
              <strong>{firstName(message.sender_name)}</strong>
              <span>{message.recipient_name ? `to ${firstName(message.recipient_name)}` : message.message_type}</span>
            </div>
            {message.body && <p>{message.body}</p>}
            {message.attachment_name && (
              <a
                className="employeeMessagesPhoto"
                href={`/api/employee/message-photo?id=${encodeURIComponent(message.id)}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open photo from ${firstName(message.sender_name)}`}
              >
                <img
                  src={`/api/employee/message-photo?id=${encodeURIComponent(message.id)}`}
                  alt={message.body || `Photo from ${firstName(message.sender_name)}`}
                  loading="lazy"
                />
              </a>
            )}
            <small>{local(message.created_at)}</small>
          </article>
        ))}
        {!data?.messages.length && <p className="employeeMessagesEmpty">No messages yet.</p>}
      </div>
    </aside>
  );
}
