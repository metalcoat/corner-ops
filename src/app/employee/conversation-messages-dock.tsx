"use client";

import { canvasToJpegBlob, drawCanvasImage } from "@/app/client-image";
import { responseMessage } from "@/app/client-http";
import { firstName } from "@/app/client-text";
import { ChangeEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./messages-dock.css";
import "./conversation-messages-dock.css";

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

type SeenBy = { employeeId: string; name: string; readAt: string };
type Message = {
  id: string;
  conversationKey: string;
  sender_employee_id: string | null;
  sender_name: string;
  sender_chat_nickname?: string;
  sender_schedule_color?: string;
  sender_avatar_set?: boolean;
  body: string;
  attachment_name?: string;
  expectedCount: number;
  seenCount: number;
  seenBy: SeenBy[];
  unseenNames: string[];
  created_at: string;
};

type EmployeeData = {
  employee: DirectoryEmployee;
  messages: Message[];
  directory: DirectoryEmployee[];
  unreadMessageIds: string[];
};

type ConversationOption = { key: string; label: string; detail: string };

const SAFE_FUNCTION_UPLOAD_BYTES = 3.5 * 1024 * 1024;
const MESSAGE_IMAGE_MAX_DIMENSION = 1920;

function local(value: string): string {
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function compact(value: string, max = 58): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function directKey(first: string, second: string): string {
  return `direct:${[first.toLowerCase(), second.toLowerCase()].sort().join(":")}`;
}

function avatarUrl(employeeId: string): string {
  return `/api/employee/avatar?id=${encodeURIComponent(employeeId)}`;
}

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
      drawCanvasImage(context, image, null, { x: 0, y: 0, width, height });
      for (const quality of [0.84, 0.74, 0.64, 0.54]) {
        const blob = await canvasToJpegBlob(canvas, quality, "This photo could not be prepared for upload.");
        if (blob.size <= SAFE_FUNCTION_UPLOAD_BYTES) {
          return new File([blob], jpegName(file.name), {
            type: "image/jpeg",
            lastModified: Date.now(),
          });
        }
      }
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  throw new Error("The photo is still too large after resizing. Choose a smaller photo and try again.");
}

export default function ConversationMessagesDock() {
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [data, setData] = useState<EmployeeData | null>(null);
  const [selectedKey, setSelectedKey] = useState("team");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<{ url: string; name: string; size: number } | null>(null);
  const reportedSeen = useRef(new Set<string>());
  const firstLoad = useRef(true);
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
    const response = await fetch("/api/employee/message-conversations", { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401) {
        setSession(null);
        setData(null);
        return;
      }
      throw new Error(await responseMessage(response));
    }
    const payload = await response.json() as EmployeeData;
    setData(payload);
    if (firstLoad.current) {
      const unread = new Set(payload.unreadMessageIds || []);
      const newestUnread = (payload.messages || []).find((message) => unread.has(message.id));
      if (newestUnread?.conversationKey) setSelectedKey(newestUnread.conversationKey);
      firstLoad.current = false;
    }
  }, []);

  useEffect(() => {
    void fetch("/api/employee/session", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as { session?: EmployeeSession | null };
        setSession(payload.session || null);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!session) return;
    void loadMessages().catch((error) => setNotice(error instanceof Error ? error.message : "Messages could not be loaded."));
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadMessages().catch(() => undefined);
    }, 45_000);
    return () => window.clearInterval(interval);
  }, [loadMessages, session]);

  useEffect(() => () => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
  }, []);

  const employeesById = useMemo(
    () => new Map((data?.directory || []).map((employee) => [employee.id.toLowerCase(), employee])),
    [data?.directory],
  );

  function conversationLabel(key: string): ConversationOption {
    if (!session || key === "team") {
      return { key: "team", label: "Whole team", detail: "Everyone active when each message is sent" };
    }
    if (key === `owner:${session.employeeId.toLowerCase()}`) {
      return { key, label: "Management", detail: "Private conversation with management" };
    }
    if (key.startsWith("direct:")) {
      const ids = key.split(":").slice(1);
      const otherId = ids.find((id) => id !== session.employeeId.toLowerCase());
      const other = otherId ? employeesById.get(otherId) : null;
      return { key, label: other?.chatNickname || firstName(other?.name || "Direct message"), detail: other?.position || "Direct conversation" };
    }
    return { key, label: "Conversation", detail: "Message conversation" };
  }

  const conversationOptions = useMemo(() => {
    if (!session) return [] as ConversationOption[];
    const keys = new Set<string>(["team", `owner:${session.employeeId.toLowerCase()}`]);
    for (const employee of data?.directory || []) {
      if (employee.id !== session.employeeId) keys.add(directKey(session.employeeId, employee.id));
    }
    for (const message of data?.messages || []) keys.add(message.conversationKey || "team");
    const options = Array.from(keys).map(conversationLabel);
    return options.sort((a, b) => {
      const order = (key: string) => key === "team" ? 0 : key.startsWith("owner:") ? 1 : 2;
      return order(a.key) - order(b.key) || a.label.localeCompare(b.label);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.directory, data?.messages, employeesById, session]);

  const unreadIds = useMemo(() => new Set(data?.unreadMessageIds || []), [data?.unreadMessageIds]);
  const selectedMessages = useMemo(
    () => (data?.messages || [])
      .filter((message) => (message.conversationKey || "team") === selectedKey)
      .slice()
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [data?.messages, selectedKey],
  );
  const selectedConversation = conversationOptions.find((option) => option.key === selectedKey)
    || conversationLabel(selectedKey);

  useEffect(() => {
    if (!session || !selectedMessages.length) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
        const messageId = (entry.target as HTMLElement).dataset.messageId || "";
        const message = selectedMessages.find((item) => item.id === messageId);
        if (!message || !unreadIds.has(messageId) || message.sender_employee_id === session.employeeId || reportedSeen.current.has(messageId)) continue;
        reportedSeen.current.add(messageId);
        void fetch("/api/employee/message-conversations", {
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
    document.querySelectorAll<HTMLElement>("[data-conversation-message-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [selectedMessages, session, unreadIds]);

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
    form.set("conversationKey", selectedKey);
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
      const response = await fetch("/api/employee/message-conversations", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      clearPhotoAttachment(false);
      await loadMessages();
      setNotice(`Reply sent in ${selectedConversation.label}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteMessage(message: Message) {
    if (!window.confirm("Delete this message for everyone? This cannot be undone.")) return;
    setBusy(true);
    try {
      const response = await fetch("/api/employee/message-conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: message.id }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await loadMessages();
      setNotice("Message deleted for everyone.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  async function updateNickname(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const response = await fetch("/api/employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "nickname-update", nickname: form.get("nickname") }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await loadMessages();
      setNotice("Chat nickname updated.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Chat nickname could not be updated.");
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
      setNotice("Your message icon was updated.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Profile photo could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return null;
  const current = data?.employee;
  const currentDisplay = current?.chatNickname || firstName(session.name);
  const unreadMessages = (data?.messages || []).filter((message) => unreadIds.has(message.id));
  const previewMessage = unreadMessages[0] || data?.messages[0];
  const previewSender = previewMessage
    ? previewMessage.sender_employee_id
      ? previewMessage.sender_chat_nickname || firstName(previewMessage.sender_name)
      : "Management"
    : "";
  const previewBody = previewMessage?.body || (previewMessage?.attachment_name ? "Photo message" : "");
  const previewText = unreadMessages.length
    ? compact(`${previewSender}: ${previewBody || "New message"}`)
    : data?.messages.length ? "All caught up" : "No messages yet";

  return <aside className={`employeeMessagesDock ${expanded ? "isOpen" : "isCollapsed"} ${unreadMessages.length ? "hasUnread" : ""}`} aria-label="Employee messages">
    <header className="employeeMessagesMobileHeader">
      <button className="employeeMessagesToggle" type="button" aria-expanded={expanded} aria-controls="employee-messages-panel" onClick={() => setExpanded((value) => !value)}>
        <span className="employeeMessagesBell" aria-hidden="true">✉</span>
        <span className="employeeMessagesCompactCopy"><span className="employeeMessagesCompactTitle">Messages{unreadMessages.length ? <span className="employeeMessagesUnreadCount">{unreadMessages.length}</span> : null}</span><span className="employeeMessagesPreview">{previewText}</span></span>
        <span className="employeeMessagesChevron" aria-hidden="true">{expanded ? "Close" : "Open"}</span>
      </button>
    </header>

    <header className="employeeMessagesHeader">
      <div className="employeeMessagesIdentity" style={{ "--employee-color": current?.scheduleColor || "#64748B" } as CSSProperties}>
        <span className="employeeMessageAvatar large">{current?.avatarSet ? <img src={avatarUrl(session.employeeId)} alt="Your profile" /> : initials(currentDisplay)}</span>
        <div><p className="employeeMessagesEyebrow">Conversations</p><h2>Messages</h2><small>{current?.chatNickname ? `${current.chatNickname} · ${session.name}` : session.name}</small></div>
      </div>
      <button type="button" onClick={() => void loadMessages()} disabled={busy}>Refresh</button>
    </header>

    <div className="employeeMessagesPanel" id="employee-messages-panel">
      <details className="employeeMessageOptions">
        <summary>Profile & chat options</summary>
        <div className="employeeMessageOptionsBody">
          <form className="employeeNicknameForm" key={current?.chatNickname || "no-nickname"} onSubmit={updateNickname}>
            <label>Chat nickname<input name="nickname" maxLength={32} defaultValue={current?.chatNickname || ""} placeholder={firstName(session.name)} /></label>
            <button disabled={busy}>Save nickname</button><small>Used in messages only.</small>
          </form>
          <form className="employeeProfilePhotoForm" onSubmit={uploadProfilePhoto}>
            <label>Take icon photo<input name="cameraProfilePhoto" type="file" accept="image/*" capture="user" /></label>
            <label>Choose icon photo<input name="profilePhoto" type="file" accept="image/*" /></label>
            <button disabled={busy}>Update icon</button>
          </form>
        </div>
      </details>

      <label className="employeeConversationPicker">Conversation<select value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>{conversationOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select><small>{selectedConversation.detail}</small></label>

      <div className="employeeMessagesFeed employeeConversationThread" aria-live="polite">
        {selectedMessages.map((message) => {
          const senderDisplay = message.sender_employee_id
            ? message.sender_chat_nickname || firstName(message.sender_name)
            : "Management";
          const unread = unreadIds.has(message.id);
          const canDelete = message.sender_employee_id === session.employeeId;
          return <article className={`employeeMessagesItem ${unread ? "isUnread" : ""}`} key={message.id} data-conversation-message-id={message.id} data-message-id={message.id} style={{ "--employee-color": message.sender_schedule_color || "#64748B" } as CSSProperties}>
            <header className="employeeMessageMeta">
              <span className="employeeMessageAvatar">{message.sender_employee_id && message.sender_avatar_set ? <img src={avatarUrl(message.sender_employee_id)} alt="" loading="lazy" /> : initials(senderDisplay)}</span>
              <div><strong>{senderDisplay}</strong><span>{local(message.created_at)}</span></div>
              <div className="employeeMessageStatus">{unread ? <span className="employeeMessagesUnreadMark">New</span> : null}{canDelete && <button type="button" className="employeeMessageDelete" disabled={busy} onClick={() => void deleteMessage(message)}>Delete</button>}</div>
            </header>
            {message.body && <p>{message.body}</p>}
            {message.attachment_name && <a className="employeeMessagesPhoto" href={`/api/employee/message-conversations/photo?id=${encodeURIComponent(message.id)}`} target="_blank" rel="noreferrer"><img src={`/api/employee/message-conversations/photo?id=${encodeURIComponent(message.id)}`} alt={message.body || `Photo from ${senderDisplay}`} loading="lazy" /></a>}
            <details className="employeeConversationReceipt"><summary>{message.expectedCount === 0 ? "No employee recipients" : `Seen by ${message.seenCount} of ${message.expectedCount}`}</summary><div>{message.seenBy.length > 0 && <section><strong>Seen</strong>{message.seenBy.map((read) => <span key={read.employeeId}>{read.name} · {local(read.readAt)}</span>)}</section>}{message.unseenNames.length > 0 && <section><strong>Not seen</strong>{message.unseenNames.map((name) => <span key={name}>{name}</span>)}</section>}</div></details>
          </article>;
        })}
        {!selectedMessages.length && <div className="employeeMessagesEmpty">No messages in {selectedConversation.label} yet.</div>}
      </div>

      <form className="employeeMessagesComposer employeeConversationReply" onSubmit={sendMessage}>
        <input type="hidden" name="action" value="message-send" />
        <label>Reply in {selectedConversation.label}<textarea name="body" rows={3} placeholder="Type a message, add a photo, or both" /></label>
        <div className="employeeMessagesPhotoControls"><label className="employeeMessagesPhotoButton">Take photo<input ref={cameraPhotoRef} name="cameraPhoto" type="file" accept="image/*" capture="environment" onChange={(event) => choosePhoto(event, "camera")} /></label><label className="employeeMessagesPhotoButton secondary">Choose photo<input ref={libraryPhotoRef} name="photo" type="file" accept="image/*" onChange={(event) => choosePhoto(event, "library")} /></label></div>
        {photoPreview && <div className="employeeMessagesAttachmentPreview"><div className="employeeMessagesAttachmentThumb"><img src={photoPreview.url} alt="Selected attachment preview" /></div><div className="employeeMessagesAttachmentInfo"><strong>Photo attached</strong><span>{photoPreview.name}</span><small>{(photoPreview.size / 1024 / 1024).toFixed(1)} MB before resizing</small></div><button type="button" disabled={busy} onClick={() => clearPhotoAttachment()}>Remove photo</button></div>}
        <button className="employeeMessagesSend" disabled={busy}>{busy ? "Sending…" : "Send reply"}</button>
      </form>
      {notice && <div className="employeeMessagesNotice">{notice}</div>}
    </div>
  </aside>;
}
