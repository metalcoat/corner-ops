"use client";

import { canvasToJpegBlob, drawCanvasImage } from "@/app/client-image";
import { responseMessage } from "@/app/client-http";
import { firstName } from "@/app/client-text";
import { useMessageThreadBehavior } from "@/app/use-message-thread-behavior";
import { ChangeEvent, ClipboardEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../message-inbox.css";

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

type ConversationKind = "team" | "management" | "direct";
type Conversation = {
  key: string;
  kind: ConversationKind;
  label: string;
  detail: string;
  messages: Message[];
  latest: Message | null;
  unreadCount: number;
};

const SAFE_FUNCTION_UPLOAD_BYTES = 3.5 * 1024 * 1024;
const MESSAGE_IMAGE_MAX_DIMENSION = 1920;

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function directKey(first: string, second: string): string {
  return `direct:${[first.toLowerCase(), second.toLowerCase()].sort().join(":")}`;
}

function directIds(key: string): string[] {
  return key.startsWith("direct:") ? key.split(":").slice(1) : [];
}

function avatarUrl(employeeId: string): string {
  return `/api/employee/avatar?id=${encodeURIComponent(employeeId)}`;
}

function photoUrl(messageId: string): string {
  return `/api/employee/message-conversations/photo?id=${encodeURIComponent(messageId)}`;
}

function messageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function listDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
}

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { month: "long", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function compact(value: string, max = 72): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "No messages yet";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

export default function EmployeeMessagesApp() {
  const [session, setSession] = useState<EmployeeSession | null>(null);
  const [data, setData] = useState<EmployeeData | null>(null);
  const [selectedKey, setSelectedKey] = useState("team");
  const [threadOpen, setThreadOpen] = useState(false);
  const [wideLayout, setWideLayout] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<{ file: File; url: string; name: string; size: number } | null>(null);
  const reportedSeen = useRef(new Set<string>());
  const messageAppRef = useRef<HTMLElement | null>(null);
  const cameraPhotoRef = useRef<HTMLInputElement | null>(null);
  const libraryPhotoRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);

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
    setPhotoPreview({ file, url, name: file.name || "Photo", size: file.size });
    setNotice("");
  }

  function pastePhoto(event: ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(event.clipboardData.items).find((candidate) =>
      candidate.kind === "file" && candidate.type.toLowerCase().startsWith("image/"),
    );
    const original = item?.getAsFile()
      || Array.from(event.clipboardData.files).find((candidate) => candidate.type.toLowerCase().startsWith("image/"))
      || null;
    if (!original) return;
    event.preventDefault();
    if (cameraPhotoRef.current) cameraPhotoRef.current.value = "";
    if (libraryPhotoRef.current) libraryPhotoRef.current.value = "";
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    const extension = original.type.toLowerCase().includes("jpeg") ? "jpg"
      : original.type.toLowerCase().includes("png") ? "png"
        : original.type.toLowerCase().includes("webp") ? "webp"
          : "jpg";
    const file = new File([original], `pasted-image-${Date.now()}.${extension}`, {
      type: original.type || "image/png",
      lastModified: Date.now(),
    });
    const url = URL.createObjectURL(file);
    photoPreviewUrlRef.current = url;
    setPhotoPreview({ file, url, name: file.name, size: file.size });
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
    setData(await response.json() as EmployeeData);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 901px)");
    const syncLayout = () => setWideLayout(media.matches);
    syncLayout();
    media.addEventListener("change", syncLayout);
    return () => media.removeEventListener("change", syncLayout);
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
  const unreadIds = useMemo(() => new Set(data?.unreadMessageIds || []), [data?.unreadMessageIds]);

  const conversations = useMemo(() => {
    if (!session) return [] as Conversation[];
    const ownId = session.employeeId.toLowerCase();
    const keys = new Set<string>(["team", `owner:${ownId}`]);
    for (const employee of data?.directory || []) {
      if (employee.id.toLowerCase() !== ownId) keys.add(directKey(ownId, employee.id));
    }
    for (const message of data?.messages || []) keys.add(message.conversationKey || "team");

    const items = Array.from(keys).map((key): Conversation | null => {
      let kind: ConversationKind = "team";
      let label = "Entire team";
      let detail = `${data?.directory.length || 0} active employees`;
      if (key === `owner:${ownId}`) {
        kind = "management";
        label = "Management";
        detail = "Private conversation with management";
      } else if (key.startsWith("direct:")) {
        kind = "direct";
        const ids = directIds(key);
        if (!ids.includes(ownId)) return null;
        const otherId = ids.find((id) => id !== ownId);
        const employee = otherId ? employeesById.get(otherId) : null;
        if (!employee) return null;
        label = employee.chatNickname || employee.name;
        detail = employee.position || "Employee conversation";
      }
      const messages = (data?.messages || [])
        .filter((message) => (message.conversationKey || "team") === key)
        .slice()
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const latest = messages.length ? messages[messages.length - 1] : null;
      return {
        key,
        kind,
        label,
        detail,
        messages,
        latest,
        unreadCount: messages.filter((message) => unreadIds.has(message.id)).length,
      };
    }).filter(Boolean) as Conversation[];

    return items.sort((a, b) => {
      if (a.key === "team") return -1;
      if (b.key === "team") return 1;
      if (a.kind === "management" && b.kind !== "management") return -1;
      if (b.kind === "management" && a.kind !== "management") return 1;
      const aTime = a.latest ? new Date(a.latest.created_at).getTime() : 0;
      const bTime = b.latest ? new Date(b.latest.created_at).getTime() : 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.label.localeCompare(b.label);
    });
  }, [data?.directory, data?.messages, employeesById, session, unreadIds]);

  const filteredConversations = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((conversation) => {
      const latest = conversation.latest?.body || conversation.latest?.attachment_name || "";
      return `${conversation.label} ${conversation.detail} ${latest}`.toLowerCase().includes(needle);
    });
  }, [conversations, search]);

  const selectedConversation = conversations.find((conversation) => conversation.key === selectedKey)
    || conversations[0]
    || null;
  const selectedMessages = selectedConversation?.messages || [];

  useEffect(() => {
    if (selectedConversation && selectedConversation.key !== selectedKey) setSelectedKey(selectedConversation.key);
  }, [selectedConversation, selectedKey]);

  const incomingUnreadMessageIds = useMemo(() => selectedMessages
    .filter((message) => unreadIds.has(message.id))
    .filter((message) => !session || message.sender_employee_id?.toLowerCase() !== session.employeeId.toLowerCase())
    .map((message) => message.id), [selectedMessages, session, unreadIds]);

  const reportVisibleMessagesSeen = useCallback((messageIds: string[]) => {
    if (!session || !messageIds.length) return;
    const ids = messageIds.filter((id) => !reportedSeen.current.has(id));
    if (!ids.length) return;
    ids.forEach((id) => reportedSeen.current.add(id));
    void Promise.all(ids.map(async (messageId) => {
      const response = await fetch("/api/employee/message-conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "message-seen", messageId }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      return messageId;
    })).then((seenIds) => {
      const seen = new Set(seenIds);
      setData((current) => current ? {
        ...current,
        unreadMessageIds: current.unreadMessageIds.filter((id) => !seen.has(id)),
      } : current);
    }).catch(() => {
      ids.forEach((id) => reportedSeen.current.delete(id));
    });
  }, [session]);

  const {
    openingUnreadId,
    saveThreadPosition,
    scrollThreadToBottom,
    stickToBottomRef,
    trackThreadScroll,
  } = useMessageThreadBehavior({
    appRef: messageAppRef,
    threadRef: messageThreadRef,
    selectedKey: selectedConversation?.key || selectedKey,
    messageIds: selectedMessages.map((message) => message.id),
    unreadMessageIds: incomingUnreadMessageIds,
    threadOpen: threadOpen || wideLayout,
    ready: Boolean(data && session),
    storageScope: session ? `employee:${session.business}:${session.employeeId}` : "employee:unknown",
    onUnreadVisible: reportVisibleMessagesSeen,
  });

  function senderName(message: Message, useYou = false): string {
    if (!message.sender_employee_id) return "Management";
    if (useYou && session && message.sender_employee_id.toLowerCase() === session.employeeId.toLowerCase()) return "You";
    const employee = employeesById.get(message.sender_employee_id.toLowerCase());
    return message.sender_chat_nickname || employee?.chatNickname || employee?.name || firstName(message.sender_name);
  }

  function chooseConversation(key: string) {
    saveThreadPosition();
    setSelectedKey(key);
    setThreadOpen(true);
    setNotice("");
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedConversation) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = String(form.get("body") || "").trim();
    let photo = photoPreview?.file || selectedPhoto(form);
    if (!body && !photo) {
      setNotice("Type a message or attach a photo.");
      return;
    }
    form.set("action", "message-send");
    form.set("conversationKey", selectedConversation.key);
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
      stickToBottomRef.current = true;
      await loadMessages();
      scrollThreadToBottom();
      setNotice(`Message sent to ${selectedConversation.label}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteMessage(message: Message) {
    if (!window.confirm("Delete this message for everyone? This cannot be undone.")) return;
    setBusy(true);
    setNotice("");
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
    setNotice("");
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
    if (!profilePhoto) {
      setNotice("Choose a profile photo first.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const prepared = await prepareImageUpload(profilePhoto);
      const camera = form.get("cameraProfilePhoto");
      if (camera instanceof File && camera.size > 0) form.set("cameraProfilePhoto", prepared);
      else form.set("profilePhoto", prepared);
      const response = await fetch("/api/employee", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      await loadMessages();
      setNotice("Your message photo was updated.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Profile photo could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="messageApp"><div className="messageLoading">Sign in with your employee PIN to view messages.</div></main>;
  const current = data?.employee;
  const currentDisplay = current?.chatNickname || firstName(session.name);

  return <main ref={messageAppRef} className="messageApp employeeMessageApp">
    <header className="messageTopBar">
      <div className="messageTopTitle">
        <a className="messageTopIcon" href="/employee" aria-label="Back to Employee Hub">←</a>
        <div><h1>Messages</h1><p>{session.business}</p></div>
      </div>
      <div className="messageTopActions">
        <button type="button" aria-label="Search conversations" onClick={() => document.getElementById("employee-message-search")?.focus()}>⌕</button>
        <button type="button" aria-label="Message profile settings" onClick={() => setProfileOpen((value) => !value)}>⚙</button>
      </div>
    </header>

    {profileOpen && <section className="messageProfilePanel">
      <div className="messageProfileIdentity" style={{ "--employee-color": current?.scheduleColor || "#7C3AED" } as CSSProperties}>
        <span>{current?.avatarSet ? <img src={avatarUrl(session.employeeId)} alt="Your profile" /> : initials(currentDisplay)}</span>
        <div><strong>{currentDisplay}</strong><small>{session.name}</small></div>
      </div>
      <form onSubmit={updateNickname}><label>Chat nickname<input name="nickname" maxLength={32} defaultValue={current?.chatNickname || ""} placeholder={firstName(session.name)} /></label><button disabled={busy}>Save</button></form>
      <form onSubmit={uploadProfilePhoto}><label>Take photo<input name="cameraProfilePhoto" type="file" accept="image/*" capture="user" /></label><label>Choose photo<input name="profilePhoto" type="file" accept="image/*" /></label><button disabled={busy}>Update photo</button></form>
    </section>}
    {notice && <div className="messageNotice" role="status">{notice}</div>}

    <div className={`messageShell ${threadOpen ? "threadOpen" : ""}`}>
      <section className="messageInboxPane" aria-label="Conversation list">
        <div className="messageInboxToolbar">
          <label><span className="srOnly">Search messages</span><input id="employee-message-search" value={search} onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)} placeholder="Search conversations" /></label>
          <small>{filteredConversations.length} conversation{filteredConversations.length === 1 ? "" : "s"}</small>
        </div>
        <div className="messageConversationList">
          {filteredConversations.map((conversation) => {
            const latest = conversation.latest;
            const preview = latest
              ? `${senderName(latest, true)}: ${latest.body || (latest.attachment_name ? "Photo" : "Message")}`
              : conversation.kind === "management" ? "Send a private message to management" : "No messages yet";
            const directId = conversation.kind === "direct"
              ? directIds(conversation.key).find((id) => id !== session.employeeId.toLowerCase())
              : null;
            const avatarEmployee = directId ? employeesById.get(directId) : null;
            return <button type="button" key={conversation.key} className={`messageConversationRow ${selectedKey === conversation.key ? "selected" : ""}`} onClick={() => chooseConversation(conversation.key)}>
              <span className={`messageListAvatar ${conversation.kind}`} style={{ "--employee-color": avatarEmployee?.scheduleColor || current?.scheduleColor || "#7C3AED" } as CSSProperties}>
                {conversation.kind === "team" ? "🏪" : conversation.kind === "management" ? "👥" : avatarEmployee?.avatarSet ? <img src={avatarUrl(avatarEmployee.id)} alt="" loading="lazy" /> : initials(conversation.label)}
              </span>
              <span className="messageListText"><strong>{conversation.label}</strong><span>{compact(preview)}</span></span>
              <span className="messageListStatus">{conversation.unreadCount > 0 && <b>{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</b>}{latest && <time>{listDate(latest.created_at)}</time>}</span>
            </button>;
          })}
          {!filteredConversations.length && <div className="messageEmptyList">No active employee conversations match that search.</div>}
        </div>
      </section>

      <section className="messageThreadPane" aria-label="Selected conversation">
        {selectedConversation ? <>
          <header className="messageThreadHeader">
            <button type="button" className="messageBack" aria-label="Back to conversations" onClick={() => { saveThreadPosition(); setThreadOpen(false); }}>←</button>
            <div><h2>{selectedConversation.label}</h2><p>{selectedConversation.detail}</p></div>
            <span className={`messageHeaderAvatar ${selectedConversation.kind}`} aria-hidden="true">{selectedConversation.kind === "team" ? "🏪" : selectedConversation.kind === "management" ? "👥" : initials(selectedConversation.label)}</span>
          </header>

          <div ref={messageThreadRef} className="messageThread" aria-live="polite" onScroll={trackThreadScroll}>
            {selectedMessages.map((message, index) => {
              const prior = selectedMessages[index - 1];
              const showDay = !prior || new Date(prior.created_at).toDateString() !== new Date(message.created_at).toDateString();
              const isOwn = message.sender_employee_id?.toLowerCase() === session.employeeId.toLowerCase();
              const displayName = senderName(message);
              return <div key={message.id} data-message-id={message.id}>
                {showDay && <div className="messageDay"><span>{dayLabel(message.created_at)}</span></div>}
                {openingUnreadId === message.id && <div className="messageUnreadMarker"><span>New messages</span></div>}
                <article className={`messageBubbleRow ${isOwn ? "own" : "other"}`}>
                  {!isOwn && <span className="messageTinyAvatar" style={{ "--employee-color": message.sender_schedule_color || "#7C3AED" } as CSSProperties}>{message.sender_employee_id && message.sender_avatar_set ? <img src={avatarUrl(message.sender_employee_id)} alt="" loading="lazy" /> : initials(displayName)}</span>}
                  <div className="messageBubbleWrap">
                    <div className="messageBubble">
                      {message.attachment_name && <a className="messagePhoto" href={photoUrl(message.id)} target="_blank" rel="noreferrer"><img src={photoUrl(message.id)} alt={message.body || `Photo from ${displayName}`} loading="lazy" onLoad={() => { if (stickToBottomRef.current) scrollThreadToBottom(); }} /></a>}
                      {message.body && <p>{message.body}</p>}
                    </div>
                    <div className="messageBubbleMeta"><span>{isOwn ? "You" : displayName}</span><time>{messageTime(message.created_at)}</time>{isOwn && <button type="button" disabled={busy} onClick={() => void deleteMessage(message)}>Delete</button>}</div>
                    <details className="messageReceipt"><summary>{message.expectedCount === 0 ? "Sent to management" : `Seen by ${message.seenCount} of ${message.expectedCount}`}</summary><div>{message.seenBy.length > 0 && <section><strong>Seen</strong>{message.seenBy.map((read) => <span key={read.employeeId}>{read.name} · {new Date(read.readAt).toLocaleString()}</span>)}</section>}{message.unseenNames.length > 0 && <section><strong>Not seen</strong>{message.unseenNames.map((name) => <span key={name}>{name}</span>)}</section>}{message.expectedCount > 0 && !message.unseenNames.length && <p>Everyone still active on this message has seen it.</p>}</div></details>
                  </div>
                </article>
              </div>;
            })}
            {!selectedMessages.length && <div className="messageThreadEmpty"><strong>No messages here yet.</strong><span>Send the first message below.</span></div>}
          </div>

          <form className="messageComposer employeeMessageComposer" onSubmit={sendMessage}>
            <div className="messageAttachControls">
              <label aria-label="Take a photo">📷<input ref={cameraPhotoRef} name="cameraPhoto" type="file" accept="image/*" capture="environment" onChange={(event: ChangeEvent<HTMLInputElement>) => choosePhoto(event, "camera")} /></label>
              <label aria-label="Choose a photo">＋<input ref={libraryPhotoRef} name="photo" type="file" accept="image/*" onChange={(event: ChangeEvent<HTMLInputElement>) => choosePhoto(event, "library")} /></label>
            </div>
            <textarea name="body" rows={2} placeholder="Send a message or paste an image" aria-label={`Message ${selectedConversation.label}`} onPaste={pastePhoto} />
            <button type="submit" disabled={busy} aria-label="Send message">{busy ? "…" : "➤"}</button>
            {photoPreview && <div className="messageAttachmentPreview"><img src={photoPreview.url} alt="Selected attachment" /><span><strong>{photoPreview.name}</strong><small>{(photoPreview.size / 1024 / 1024).toFixed(1)} MB before resizing</small></span><button type="button" onClick={() => clearPhotoAttachment()} disabled={busy}>Remove</button></div>}
          </form>
        </> : <div className="messageThreadEmpty"><strong>Select a conversation.</strong></div>}
      </section>
    </div>
  </main>;
}
