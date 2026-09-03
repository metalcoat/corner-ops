"use client";

import { responseMessage } from "@/app/client-http";
import { canvasToJpegBlob, drawCanvasImage } from "@/app/client-image";
import { firstName } from "@/app/client-text";
import { useMessageThreadBehavior } from "@/app/use-message-thread-behavior";
import { ChangeEvent, ClipboardEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../../message-inbox.css";

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

type Payload = {
  business: Business;
  employees: Employee[];
  messages: Message[];
  unreadMessageIds: string[];
  viewAsEmployee: Employee | null;
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

function pastedImageFile(event: ClipboardEvent<HTMLTextAreaElement>): File | null {
  const item = Array.from(event.clipboardData.items).find((candidate) =>
    candidate.kind === "file" && candidate.type.toLowerCase().startsWith("image/"),
  );
  const original = item?.getAsFile()
    || Array.from(event.clipboardData.files).find((candidate) => candidate.type.toLowerCase().startsWith("image/"))
    || null;
  if (!original) return null;
  const extension = original.type.toLowerCase().includes("jpeg") ? "jpg"
    : original.type.toLowerCase().includes("png") ? "png"
      : original.type.toLowerCase().includes("webp") ? "webp"
        : "jpg";
  return new File([original], `pasted-image-${Date.now()}.${extension}`, {
    type: original.type || "image/png",
    lastModified: Date.now(),
  });
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function ownerKey(employeeId: string): string {
  return `owner:${employeeId.toLowerCase()}`;
}

function directIds(key: string): string[] {
  return key.startsWith("direct:") ? key.split(":").slice(1) : [];
}

function avatarUrl(business: Business, employeeId: string): string {
  return `/api/employee-directory/avatar?business=${encodeURIComponent(business)}&id=${encodeURIComponent(employeeId)}`;
}

function messagePhotoUrl(business: Business, messageId: string): string {
  return `/api/workforce/message-photo?business=${encodeURIComponent(business)}&id=${encodeURIComponent(messageId)}`;
}

function messageTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function listDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
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

export default function MessagesPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [viewAsEmployeeId, setViewAsEmployeeId] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [selectedKey, setSelectedKey] = useState("team");
  const [threadOpen, setThreadOpen] = useState(false);
  const [wideLayout, setWideLayout] = useState(false);
  const [search, setSearch] = useState("");
  const [startOpen, setStartOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<{ file: File; url: string; name: string; size: number } | null>(null);
  const reportedSeen = useRef(new Set<string>());
  const messageAppRef = useRef<HTMLElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);

  const clearPhotoAttachment = useCallback((resetInput = true) => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    photoPreviewUrlRef.current = null;
    setPhotoPreview(null);
    if (resetInput && photoInputRef.current) photoInputRef.current.value = "";
  }, []);

  const attachPhoto = useCallback((file: File) => {
    if (!file.type.toLowerCase().startsWith("image/")) {
      setNotice("Message attachments must be image files.");
      return;
    }
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    const url = URL.createObjectURL(file);
    photoPreviewUrlRef.current = url;
    setPhotoPreview({ file, url, name: file.name || "Photo", size: file.size });
    setNotice("");
  }, []);

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] || null;
    if (file) attachPhoto(file);
  }

  function pastePhoto(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = pastedImageFile(event);
    if (!file) return;
    event.preventDefault();
    if (photoInputRef.current) photoInputRef.current.value = "";
    attachPhoto(file);
  }

  useEffect(() => {
    const media = window.matchMedia("(min-width: 901px)");
    const syncLayout = () => setWideLayout(media.matches);
    syncLayout();
    media.addEventListener("change", syncLayout);
    return () => media.removeEventListener("change", syncLayout);
  }, []);

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

  useEffect(() => () => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
  }, []);

  async function load(activeBusiness = business, activeViewAs = viewAsEmployeeId) {
    const params = new URLSearchParams({ business: activeBusiness });
    if (activeViewAs) params.set("viewAsEmployeeId", activeViewAs);
    const response = await fetch(`/api/message-conversations?${params.toString()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as Payload);
    window.dispatchEvent(new Event("corner-ops-notifications-refresh"));
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setSelectedKey("team");
    setThreadOpen(false);
    setStartOpen(false);
    setNotice("");
    void load(business, viewAsEmployeeId).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(business, viewAsEmployeeId).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated, viewAsEmployeeId]);

  const employeesById = useMemo(
    () => new Map((data?.employees || []).map((employee) => [employee.id.toLowerCase(), employee])),
    [data?.employees],
  );
  const unreadIds = useMemo(() => new Set(data?.unreadMessageIds || []), [data?.unreadMessageIds]);

  const conversations = useMemo(() => {
    const keys = new Set<string>(["team"]);
    if (viewAsEmployeeId) {
      keys.add(ownerKey(viewAsEmployeeId));
    } else {
      for (const employee of data?.employees || []) keys.add(ownerKey(employee.id));
    }
    for (const message of data?.messages || []) keys.add(message.conversationKey || "team");

    const items = Array.from(keys).map((key): Conversation | null => {
      let kind: ConversationKind = "team";
      let label = "Entire team";
      let detail = `${data?.employees.length || 0} active employees`;
      if (key.startsWith("owner:")) {
        kind = "management";
        const employee = employeesById.get(key.slice(6).toLowerCase());
        if (!employee) return null;
        label = viewAsEmployeeId ? "Management" : employee.name;
        detail = viewAsEmployeeId ? "Private conversation with management" : `${employee.position || "Employee"} · Management conversation`;
      } else if (key.startsWith("direct:")) {
        kind = "direct";
        const ids = directIds(key);
        const people = ids.map((id) => employeesById.get(id.toLowerCase())).filter(Boolean) as Employee[];
        if (people.length !== ids.length) return null;
        if (viewAsEmployeeId && !ids.includes(viewAsEmployeeId.toLowerCase())) return null;
        const otherPeople = viewAsEmployeeId
          ? people.filter((person) => person.id.toLowerCase() !== viewAsEmployeeId.toLowerCase())
          : people;
        label = otherPeople.map((person) => person.chatNickname || person.name).join(" ↔ ") || "Employee conversation";
        detail = viewAsEmployeeId ? "Employee conversation" : "Employee-to-employee · View only";
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
      const aTime = a.latest ? new Date(a.latest.created_at).getTime() : 0;
      const bTime = b.latest ? new Date(b.latest.created_at).getTime() : 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.label.localeCompare(b.label);
    });
  }, [data?.employees, data?.messages, employeesById, unreadIds, viewAsEmployeeId]);

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
  const canWrite = Boolean(selectedConversation)
    && !viewAsEmployeeId
    && selectedConversation?.kind !== "direct";

  useEffect(() => {
    if (selectedConversation && selectedConversation.key !== selectedKey) setSelectedKey(selectedConversation.key);
  }, [selectedConversation, selectedKey]);

  const selectedUnreadMessageIds = useMemo(() => selectedMessages
    .filter((message) => unreadIds.has(message.id))
    .filter((message) => viewAsEmployeeId
      ? message.sender_employee_id?.toLowerCase() !== viewAsEmployeeId.toLowerCase()
      : Boolean(message.sender_employee_id))
    .map((message) => message.id), [selectedMessages, unreadIds, viewAsEmployeeId]);

  const reportVisibleMessagesSeen = useCallback((messageIds: string[]) => {
    if (!session?.authenticated || viewAsEmployeeId || !messageIds.length) return;
    const ids = messageIds.filter((id) => !reportedSeen.current.has(id));
    if (!ids.length) return;
    ids.forEach((id) => reportedSeen.current.add(id));
    void Promise.all(ids.map(async (messageId) => {
      const response = await fetch("/api/message-conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "message-seen", business, messageId }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      return messageId;
    })).then((seenIds) => {
      const seen = new Set(seenIds);
      setData((current) => current ? {
        ...current,
        unreadMessageIds: current.unreadMessageIds.filter((id) => !seen.has(id)),
      } : current);
      window.dispatchEvent(new Event("corner-ops-notifications-refresh"));
    }).catch(() => {
      ids.forEach((id) => reportedSeen.current.delete(id));
    });
  }, [business, session?.authenticated, viewAsEmployeeId]);

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
    unreadMessageIds: selectedUnreadMessageIds,
    threadOpen: threadOpen || wideLayout,
    ready: Boolean(data && data.business === business),
    storageScope: `management:${session?.email || "signed-in"}:${business}:${viewAsEmployeeId || "management"}`,
    onUnreadVisible: viewAsEmployeeId ? undefined : reportVisibleMessagesSeen,
  });

  function senderName(message: Message, useYou = false): string {
    if (!message.sender_employee_id) return useYou && !viewAsEmployeeId ? "You" : "Management";
    const employee = employeesById.get(message.sender_employee_id.toLowerCase());
    const display = message.sender_chat_nickname || employee?.chatNickname || employee?.name || firstName(message.sender_name);
    if (useYou && viewAsEmployeeId && message.sender_employee_id.toLowerCase() === viewAsEmployeeId.toLowerCase()) return "You";
    return display;
  }

  function chooseConversation(key: string) {
    saveThreadPosition();
    setSelectedKey(key);
    setThreadOpen(true);
    setStartOpen(false);
    setNotice("");
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedConversation || !canWrite) return;
    const formElement = event.currentTarget;
    const formValues = new FormData(formElement);
    const body = String(formValues.get("body") || "").trim();
    const photo = photoPreview?.file || null;
    if (!body && !photo) {
      setNotice("Type a message or attach an image.");
      return;
    }
    const form = new FormData();
    form.set("action", "send");
    form.set("business", business);
    form.set("conversationKey", selectedConversation.key);
    form.set("body", body);
    setBusy(true);
    setNotice("");
    try {
      if (photo) form.set("photo", await prepareImageUpload(photo));
      const response = await fetch("/api/message-conversations", {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      clearPhotoAttachment(false);
      stickToBottomRef.current = true;
      await load();
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
      const response = await fetch("/api/message-conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", business, id: message.id }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice("Message deleted for everyone.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="messageApp"><div className="messageLoading">Loading messages…</div></main>;
  if (!session.authenticated) return <main className="messageApp"><div className="messageLoading"><a href="/signin">Sign in to Corner Ops</a></div></main>;
  const allowed = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);

  return <main ref={messageAppRef} className="messageApp">
    <header className="messageTopBar">
      <div className="messageTopTitle">
        <a className="messageTopIcon" href="/ops/people" aria-label="Open Corner Ops">☰</a>
        <div><h1>Messages</h1><p>{business}</p></div>
      </div>
      <div className="messageTopActions">
        <button type="button" aria-label="Search conversations" onClick={() => document.getElementById("message-search")?.focus()}>⌕</button>
        {!viewAsEmployeeId && <button type="button" aria-label="Start a conversation" onClick={() => setStartOpen((value) => !value)}>＋</button>}
      </div>
    </header>

    <div className="messageControlBar">
      <div className="messageBusinessTabs">{allowed.map((name) => <button key={name} type="button" className={business === name ? "active" : ""} onClick={() => { setViewAsEmployeeId(""); setBusiness(name); }}>{name}</button>)}</div>
      <label className="messageImpersonation">View as
        <select value={viewAsEmployeeId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setViewAsEmployeeId(event.target.value)}>
          <option value="">Management</option>
          {(data?.employees || []).map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </select>
      </label>
      <button type="button" className="messageRefresh" disabled={busy} onClick={() => void load()}>Refresh</button>
    </div>

    {data?.viewAsEmployee && <div className="messageImpersonationBanner"><strong>Viewing as {data.viewAsEmployee.name}</strong><span>Read-only impersonation. Opening messages here does not mark them seen for the employee.</span></div>}
    {notice && <div className="messageNotice" role="status">{notice}</div>}

    {startOpen && !viewAsEmployeeId && <section className="messageStartMenu" aria-label="Start a conversation">
      <strong>New message</strong>
      <button type="button" onClick={() => chooseConversation("team")}>🏪 Entire team</button>
      {(data?.employees || []).map((employee) => <button type="button" key={employee.id} onClick={() => chooseConversation(ownerKey(employee.id))}>{initials(employee.name)} {employee.name}</button>)}
    </section>}

    <div className={`messageShell ${threadOpen ? "threadOpen" : ""}`}>
      <section className="messageInboxPane" aria-label="Conversation list">
        <div className="messageInboxToolbar">
          <label><span className="srOnly">Search messages</span><input id="message-search" value={search} onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)} placeholder="Search conversations" /></label>
          <small>{filteredConversations.length} conversation{filteredConversations.length === 1 ? "" : "s"}</small>
        </div>
        <div className="messageConversationList">
          {filteredConversations.map((conversation) => {
            const latest = conversation.latest;
            const previewSender = latest ? senderName(latest, true) : "";
            const preview = latest
              ? `${previewSender}: ${latest.body || (latest.attachment_name ? "Photo" : "Message")}`
              : conversation.kind === "management" ? "Start a private employee message" : "No messages yet";
            const avatarEmployee = conversation.kind === "management"
              ? employeesById.get(conversation.key.slice(6).toLowerCase())
              : null;
            return <button type="button" key={conversation.key} className={`messageConversationRow ${selectedKey === conversation.key ? "selected" : ""}`} onClick={() => chooseConversation(conversation.key)}>
              <span className={`messageListAvatar ${conversation.kind}`} style={{ "--employee-color": avatarEmployee?.scheduleColor || "#7C3AED" } as CSSProperties}>
                {conversation.kind === "team" ? "🏪" : avatarEmployee?.avatarSet ? <img src={avatarUrl(business, avatarEmployee.id)} alt="" loading="lazy" /> : initials(conversation.label)}
              </span>
              <span className="messageListText"><strong>{conversation.label}</strong><span>{compact(preview)}</span>{conversation.kind === "direct" && <small>Employee chat</small>}</span>
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
            <span className={`messageHeaderAvatar ${selectedConversation.kind}`} aria-hidden="true">{selectedConversation.kind === "team" ? "🏪" : initials(selectedConversation.label)}</span>
          </header>

          <div ref={messageThreadRef} className="messageThread" aria-live="polite" onScroll={trackThreadScroll}>
            {selectedMessages.map((message, index) => {
              const prior = selectedMessages[index - 1];
              const showDay = !prior || new Date(prior.created_at).toDateString() !== new Date(message.created_at).toDateString();
              const isOwn = viewAsEmployeeId
                ? message.sender_employee_id?.toLowerCase() === viewAsEmployeeId.toLowerCase()
                : !message.sender_employee_id;
              const displayName = senderName(message);
              const employeeSender = message.sender_employee_id ? employeesById.get(message.sender_employee_id.toLowerCase()) : null;
              return <div key={message.id} data-message-id={message.id}>
                {showDay && <div className="messageDay"><span>{dayLabel(message.created_at)}</span></div>}
                {openingUnreadId === message.id && <div className="messageUnreadMarker"><span>New messages</span></div>}
                <article className={`messageBubbleRow ${isOwn ? "own" : "other"}`}>
                  {!isOwn && <span className="messageTinyAvatar" style={{ "--employee-color": message.sender_schedule_color || employeeSender?.scheduleColor || "#7C3AED" } as CSSProperties}>{message.sender_employee_id && message.sender_avatar_set ? <img src={avatarUrl(business, message.sender_employee_id)} alt="" loading="lazy" /> : initials(displayName)}</span>}
                  <div className="messageBubbleWrap">
                    <div className="messageBubble">
                      {message.attachment_name && <a className="messagePhoto" href={messagePhotoUrl(business, message.id)} target="_blank" rel="noreferrer"><img src={messagePhotoUrl(business, message.id)} alt={message.body || `Photo from ${displayName}`} loading="lazy" onLoad={() => { if (stickToBottomRef.current) scrollThreadToBottom(); }} /></a>}
                      {message.body && <p>{message.body}</p>}
                    </div>
                    <div className="messageBubbleMeta"><span>{isOwn ? "You" : displayName}</span><time>{messageTime(message.created_at)}</time>{!viewAsEmployeeId && <button type="button" disabled={busy} onClick={() => void deleteMessage(message)}>Delete</button>}</div>
                    <details className="messageReceipt">
                      <summary>{message.expectedCount === 0 ? "Sent to management" : `Seen by ${message.seenCount} of ${message.expectedCount}`}</summary>
                      <div>{message.seenBy.length > 0 && <section><strong>Seen</strong>{message.seenBy.map((read) => <span key={read.employeeId}>{read.name} · {new Date(read.readAt).toLocaleString()}</span>)}</section>}{message.unseenNames.length > 0 && <section><strong>Not seen</strong>{message.unseenNames.map((name) => <span key={name}>{name}</span>)}</section>}{message.expectedCount > 0 && !message.unseenNames.length && <p>Everyone still active on this message has seen it.</p>}</div>
                    </details>
                  </div>
                </article>
              </div>;
            })}
            {!selectedMessages.length && <div className="messageThreadEmpty"><strong>No messages here yet.</strong><span>{canWrite ? "Send the first message below." : "There is nothing to review in this conversation."}</span></div>}
          </div>

          {canWrite ? <form className="messageComposer messageComposerWithAttachments" onSubmit={sendMessage}>
            <div className="messageAttachControls">
              <label aria-label="Upload an image" title="Upload an image">🖼<input ref={photoInputRef} name="photo" type="file" accept="image/*" onChange={choosePhoto} /></label>
            </div>
            <textarea name="body" rows={2} placeholder="Send a message or paste an image" aria-label={`Message ${selectedConversation.label}`} onPaste={pastePhoto} />
            <button type="submit" disabled={busy} aria-label="Send message">{busy ? "…" : "➤"}</button>
            {photoPreview && <div className="messageAttachmentPreview"><img src={photoPreview.url} alt="Selected attachment" /><span><strong>{photoPreview.name}</strong><small>{(photoPreview.size / 1024 / 1024).toFixed(1)} MB before resizing · paste or upload</small></span><button type="button" onClick={() => clearPhotoAttachment()} disabled={busy}>Remove</button></div>}
          </form> : <div className="messageReadOnlyComposer"><strong>View only</strong><span>{viewAsEmployeeId ? "Impersonation never sends or marks messages as read." : "Management can review employee-to-employee conversations but cannot post into them."}</span></div>}
        </> : <div className="messageThreadEmpty"><strong>Select a conversation.</strong></div>}
      </section>
    </div>
  </main>;
}
