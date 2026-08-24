"use client";

import { ChangeEvent, CSSProperties, FormEvent, useCallback, useEffect, useRef, useState } from "react";
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

type MessageStatus = {
  unreadCount: number;
  latestMessageId: string | null;
  preview: {
    senderName: string;
    body: string;
    hasPhoto: boolean;
    createdAt: string;
  } | null;
};

const emptyStatus: MessageStatus = {
  unreadCount: 0,
  latestMessageId: null,
  preview: null,
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

const SAFE_FUNCTION_UPLOAD_BYTES = 3.5 * 1024 * 1024;
const MESSAGE_IMAGE_MAX_DIMENSION = 1920;

function selectedPhoto(form: FormData): File | null {
  const camera = form.get("cameraPhoto");
  if (camera instanceof File && camera.size > 0) return camera;
  const library = form.get("photo");
  return library instanceof File && library.size > 0 ? library : null;
}

function selectedProfilePhoto(form: FormData): File | null {
  const camera = form.get("cameraProfilePhoto");
  if (camera instanceof File && camera.size > 0) return camera;
  const library = form.get("profilePhoto");
  return library instanceof File && library.size > 0 ? library : null;
}

function jpegName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").trim() || "photo";
  return `${base}.jpg`;
}

async function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("This photo could not be prepared for upload."));
    }, "image/jpeg", quality);
  });
}

async function prepareImageUpload(file: File): Promise<File> {
  if (file.size <= SAFE_FUNCTION_UPLOAD_BYTES) return file;
  if (!file.type.toLowerCase().startsWith("image/")) return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();

    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    if (!longest) throw new Error("This photo could not be read.");

    for (const maxDimension of [MESSAGE_IMAGE_MAX_DIMENSION, 1600, 1280]) {
      const scale = Math.min(1, maxDimension / longest);
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare the photo.");
      context.drawImage(image, 0, 0, width, height);

      for (const quality of [0.84, 0.74, 0.64, 0.54]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size <= SAFE_FUNCTION_UPLOAD_BYTES) {
          return new File([blob], jpegName(file.name), {
            type: "image/jpeg",
            lastModified: Date.now(),
          });
        }
      }
    }
  } catch (error) {
    if (file.size <= SAFE_FUNCTION_UPLOAD_BYTES) return file;
    throw new Error(error instanceof Error
      ? `${error.message} Choose a smaller photo and try again.`
      : "Choose a smaller photo and try again.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  throw new Error("The photo is still too large after resizing. Choose a smaller photo and try again.");
}

function avatarUrl(employeeId: string): string {
  return `/api/employee/avatar?id=${encodeURIComponent(employeeId)}`;
}

export default function EmployeeMessagesDock() {
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [data, setData] = useState<EmployeeData | null>(null);
  const [status, setStatus] = useState<MessageStatus>(emptyStatus);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<{ url: string; name: string; size: number } | null>(null);
  const reportedSeen = useRef(new Set<string>());
  const sessionRef = useRef<EmployeeSession | null>(null);
  const expandedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const loadedLatestIdRef = useRef<string | null>(null);
  const cameraPhotoRef = useRef<HTMLInputElement | null>(null);
  const libraryPhotoRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);

  const clearPhotoAttachment = useCallback((resetInputs = true) => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    photoPreviewUrlRef.current = null;
    setPhotoPreview(null);
    if (resetInputs) {
      if (cameraPhotoRef.current) cameraPhotoRef.current.value = "";
      if (libraryPhotoRef.current) libraryPhotoRef.current.value = "";
    }
  }, []);

  function choosePhoto(event: ChangeEvent<HTMLInputElement>, source: "camera" | "library") {
    const file = event.currentTarget.files?.[0] || null;
    if (!file) return;
    if (source === "camera" && libraryPhotoRef.current) libraryPhotoRef.current.value = "";
    if (source === "library" && cameraPhotoRef.current) cameraPhotoRef.current.value = "";
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    const url = URL.createObjectURL(file);
    photoPreviewUrlRef.current = url;
    setPhotoPreview({ url, name: file.name || "Photo", size: file.size });
    setNotice("");
  }

  const loadMessages = useCallback(async () => {
    const response = await fetch("/api/employee/messages?limit=80", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as EmployeeData;
    const next: EmployeeData = {
      employee: payload.employee,
      messages: payload.messages || [],
      directory: payload.directory || [],
      unreadMessageIds: payload.unreadMessageIds || [],
    };
    hasLoadedRef.current = true;
    loadedLatestIdRef.current = next.messages[0]?.id || null;
    setData(next);
    setStatus((current) => ({
      unreadCount: Math.max(current.unreadCount, next.unreadMessageIds.length),
      latestMessageId: next.messages[0]?.id || null,
      preview: next.messages[0] ? {
        senderName: next.messages[0].sender_chat_nickname || firstName(next.messages[0].sender_name),
        body: next.messages[0].body || "",
        hasPhoto: Boolean(next.messages[0].attachment_name),
        createdAt: next.messages[0].created_at,
      } : null,
    }));
  }, []);

  const loadStatus = useCallback(async () => {
    const response = await fetch("/api/employee/messages/status", { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401) {
        sessionRef.current = null;
        setSession(null);
        setData(null);
        setStatus(emptyStatus);
        hasLoadedRef.current = false;
        loadedLatestIdRef.current = null;
        return;
      }
      throw new Error(await responseMessage(response));
    }
    const next = await response.json() as MessageStatus;
    setStatus({
      unreadCount: Math.max(0, Number(next.unreadCount || 0)),
      latestMessageId: next.latestMessageId || null,
      preview: next.preview || null,
    });
    if (
      expandedRef.current
      && hasLoadedRef.current
      && next.latestMessageId !== loadedLatestIdRef.current
    ) {
      await loadMessages();
    }
  }, [loadMessages]);

  const checkSession = useCallback(async () => {
    const sessionResponse = await fetch("/api/employee/session", { cache: "no-store" });
    if (!sessionResponse.ok) return;
    const sessionPayload = await sessionResponse.json() as { session?: EmployeeSession | null };
    const activeSession = sessionPayload.session || null;
    sessionRef.current = activeSession;
    setSession(activeSession);
    if (!activeSession) {
      setData(null);
      setStatus(emptyStatus);
      setExpanded(false);
      expandedRef.current = false;
      hasLoadedRef.current = false;
      loadedLatestIdRef.current = null;
      reportedSeen.current.clear();
      return;
    }

    await loadStatus();
    if (window.matchMedia("(min-width: 1101px)").matches && !hasLoadedRef.current) {
      await loadMessages();
    }
  }, [loadMessages, loadStatus]);

  useEffect(() => () => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
  }, []);

  useEffect(() => {
    void checkSession().catch((error) => setNotice(error instanceof Error ? error.message : "Messages could not be loaded."));
    const onSessionCheck = () => void checkSession().catch(() => undefined);
    window.addEventListener("pageshow", onSessionCheck);
    window.addEventListener("focus", onSessionCheck);
    const interval = window.setInterval(() => {
      if (!sessionRef.current) void checkSession().catch(() => undefined);
    }, 15_000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pageshow", onSessionCheck);
      window.removeEventListener("focus", onSessionCheck);
    };
  }, [checkSession]);

  useEffect(() => {
    if (!session) return;
    const poll = () => {
      if (document.visibilityState === "visible") void loadStatus().catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const interval = window.setInterval(poll, 90_000);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadStatus, session]);

  useEffect(() => {
    if (!session) return;
    const media = window.matchMedia("(min-width: 1101px)");
    const onChange = () => {
      if (media.matches && !hasLoadedRef.current) {
        void loadMessages().catch((error) => setNotice(error instanceof Error ? error.message : "Messages could not be loaded."));
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [loadMessages, session]);

  useEffect(() => {
    if (!session || !data?.messages.length || !data.unreadMessageIds.length) return;
    const unreadIds = new Set(data.unreadMessageIds);
    const messageById = new Map(data.messages.map((message) => [message.id, message]));
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
        const messageId = (entry.target as HTMLElement).dataset.messageId || "";
        const message = messageById.get(messageId);
        if (
          !messageId
          || !message
          || message.sender_employee_id === session.employeeId
          || !unreadIds.has(messageId)
          || reportedSeen.current.has(messageId)
        ) continue;
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
          setStatus((current) => ({ ...current, unreadCount: Math.max(0, current.unreadCount - 1) }));
        }).catch(() => reportedSeen.current.delete(messageId));
      }
    }, { threshold: [0.6] });
    document.querySelectorAll<HTMLElement>("[data-message-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [data?.messages, data?.unreadMessageIds, session]);

  async function toggleExpanded() {
    const next = !expandedRef.current;
    expandedRef.current = next;
    setExpanded(next);
    if (!next) return;
    try {
      if (!hasLoadedRef.current) await loadMessages();
      else await loadStatus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Messages could not be loaded.");
    }
  }

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
      await loadMessages();
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
    let photo = selectedPhoto(form);
    if (!body && !photo) {
      setNotice("Type a message or attach a photo.");
      return;
    }
    form.set("action", "message-send");
    setBusy(true);
    setNotice("");
    try {
      if (photo) {
        const prepared = await prepareImageUpload(photo);
        const camera = form.get("cameraPhoto");
        if (camera instanceof File && camera.size > 0) form.set("cameraPhoto", prepared);
        else form.set("photo", prepared);
        photo = prepared;
      }
      const response = await fetch("/api/employee", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      clearPhotoAttachment(false);
      await loadMessages();
      await loadStatus();
      setNotice(photo ? "Photo message sent." : "Message sent.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteMessage(message: Message) {
    const description = message.body.trim()
      ? `“${message.body.trim().slice(0, 60)}${message.body.trim().length > 60 ? "…" : ""}”`
      : message.attachment_name
        ? "this photo message"
        : "this message";
    if (!window.confirm(`Delete ${description} for everyone? This cannot be undone.`)) return;

    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee/messages/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: message.id }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      reportedSeen.current.delete(message.id);
      setData((current) => current ? {
        ...current,
        messages: current.messages.filter((item) => item.id !== message.id),
        unreadMessageIds: current.unreadMessageIds.filter((id) => id !== message.id),
      } : current);
      await loadStatus();
      if (message.id === loadedLatestIdRef.current) await loadMessages();
      setNotice("Message deleted for everyone.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadProfilePhoto(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("action", "profile-photo");
    const profilePhoto = selectedProfilePhoto(form);
    setBusy(true);
    setNotice("");
    try {
      if (profilePhoto) {
        const prepared = await prepareImageUpload(profilePhoto);
        const camera = form.get("cameraProfilePhoto");
        if (camera instanceof File && camera.size > 0) form.set("cameraProfilePhoto", prepared);
        else form.set("profilePhoto", prepared);
      }
      const response = await fetch("/api/employee", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      await loadMessages();
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
  const displayedUnreadCount = data ? unreadMessages.length : status.unreadCount;
  const previewMessage = unreadMessages[0] || data?.messages[0];
  const previewSender = previewMessage
    ? previewMessage.sender_chat_nickname || firstName(previewMessage.sender_name)
    : status.preview?.senderName || "";
  const previewBody = previewMessage?.body
    || (previewMessage?.attachment_name ? "Photo message" : "")
    || status.preview?.body
    || (status.preview?.hasPhoto ? "Photo message" : "");
  const previewText = displayedUnreadCount
    ? compact(`${previewSender}: ${previewBody || "New message"}`)
    : status.latestMessageId
      ? "All caught up"
      : "No messages yet";

  return <aside className={`employeeMessagesDock ${expanded ? "isOpen" : "isCollapsed"} ${displayedUnreadCount ? "hasUnread" : ""}`} aria-label="Employee messages">
    <header className="employeeMessagesMobileHeader">
      <button
        className="employeeMessagesToggle"
        type="button"
        aria-expanded={expanded}
        aria-controls="employee-messages-panel"
        onClick={() => void toggleExpanded()}
      >
        <span className="employeeMessagesBell" aria-hidden="true">✉</span>
        <span className="employeeMessagesCompactCopy">
          <span className="employeeMessagesCompactTitle">
            Messages
            {displayedUnreadCount ? <span className="employeeMessagesUnreadCount">{displayedUnreadCount}</span> : null}
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
      <button type="button" onClick={() => void loadMessages()} disabled={busy} aria-label="Refresh messages">Refresh</button>
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
          <label className="employeeMessagesPhotoButton">Take photo<input ref={cameraPhotoRef} name="cameraPhoto" type="file" accept="image/*" capture="environment" onChange={(event) => choosePhoto(event, "camera")} /></label>
          <label className="employeeMessagesPhotoButton secondary">Choose photo<input ref={libraryPhotoRef} name="photo" type="file" accept="image/*" onChange={(event) => choosePhoto(event, "library")} /></label>
        </div>
        {photoPreview && <div className="employeeMessagesAttachmentPreview">
          <div className="employeeMessagesAttachmentThumb"><img src={photoPreview.url} alt="Selected attachment preview" /></div>
          <div className="employeeMessagesAttachmentInfo"><strong>Photo attached</strong><span>{photoPreview.name}</span><small>{(photoPreview.size / 1024 / 1024).toFixed(1)} MB before upload resizing</small></div>
          <button type="button" disabled={busy} onClick={() => clearPhotoAttachment()}>Remove photo</button>
        </div>}
        <button className="employeeMessagesSend" disabled={busy}>Send message</button>
      </form>

      {notice && <div className="employeeMessagesNotice">{notice}</div>}

      <div className="employeeMessagesFeed" aria-live="polite">
        {(data?.messages || []).map((message) => {
          const senderColor = message.sender_schedule_color || "#64748B";
          const senderDisplay = message.sender_chat_nickname || firstName(message.sender_name);
          const unread = unreadIds.has(message.id);
          const canDelete = message.sender_employee_id === session.employeeId;
          return <article className={`employeeMessagesItem ${unread ? "isUnread" : ""}`} key={message.id} data-message-id={message.id} style={{ "--employee-color": senderColor } as CSSProperties}>
            <header className="employeeMessageMeta">
              <span className="employeeMessageAvatar">{message.sender_employee_id && message.sender_avatar_set ? <img src={avatarUrl(message.sender_employee_id)} alt="" loading="lazy" /> : initials(senderDisplay)}</span>
              <div><strong>{senderDisplay}</strong><span>{message.recipient_name ? `to ${firstName(message.recipient_name)}` : message.message_type}</span></div>
              <div className="employeeMessageStatus">
                {unread ? <span className="employeeMessagesUnreadMark">New</span> : null}
                <small>{local(message.created_at)}</small>
                {canDelete && <button type="button" className="employeeMessageDelete" disabled={busy} onClick={() => void deleteMessage(message)}>Delete</button>}
              </div>
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
