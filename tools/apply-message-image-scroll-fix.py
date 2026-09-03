from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old[:180]!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


def regex_once(path: str, pattern: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.DOTALL)
    if count != 1:
        raise SystemExit(f"Expected one regex match in {path}, found {count}: {pattern[:180]!r}")
    file.write_text(updated, encoding="utf-8")


client_image = "src/app/client-image.ts"
replace_once(
    client_image,
    "\nexport function loadImageFile(",
    r'''
export function clipboardImageFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  const candidates = [
    ...Array.from(data.items || [])
      .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file)),
    ...Array.from(data.files || []).filter((file) => file.type.toLowerCase().startsWith("image/")),
  ];
  const source = candidates[0] || null;
  if (!source) return null;
  const mime = source.type.toLowerCase();
  const extension = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  return new File([source], source.name || `pasted-image-${Date.now()}.${extension}`, {
    type: source.type || "image/png",
    lastModified: Date.now(),
  });
}

export function loadImageFile(''',
)

owner = "src/app/ops/messages/page.tsx"
replace_once(
    owner,
    'import { responseMessage } from "@/app/client-http";\n',
    'import { canvasToJpegBlob, clipboardImageFile, drawCanvasImage } from "@/app/client-image";\nimport { responseMessage } from "@/app/client-http";\n',
)
replace_once(
    owner,
    'import { ChangeEvent, CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";',
    'import { ChangeEvent, ClipboardEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";',
)
replace_once(
    owner,
    'function initials(value: string): string {',
    r'''const SAFE_FUNCTION_UPLOAD_BYTES = 3.5 * 1024 * 1024;
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

function initials(value: string): string {''',
)
replace_once(
    owner,
    '  const [notice, setNotice] = useState("");\n  const [busy, setBusy] = useState(false);\n',
    r'''  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<{ url: string; name: string; size: number } | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const pastedPhotoRef = useRef<File | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const clearPhotoAttachment = useCallback((resetInput = true) => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    photoPreviewUrlRef.current = null;
    pastedPhotoRef.current = null;
    setPhotoPreview(null);
    if (resetInput && photoInputRef.current) photoInputRef.current.value = "";
  }, []);

  function previewPhoto(file: File) {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    const url = URL.createObjectURL(file);
    photoPreviewUrlRef.current = url;
    setPhotoPreview({ url, name: file.name || "Photo", size: file.size });
  }

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] || null;
    if (!file) return;
    pastedPhotoRef.current = null;
    previewPhoto(file);
    setNotice("");
  }

  function pastePhoto(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = clipboardImageFile(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    if (photoInputRef.current) photoInputRef.current.value = "";
    pastedPhotoRef.current = file;
    previewPhoto(file);
    setNotice("Image attached. Add a message or send it as-is.");
  }

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    window.requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({ behavior, block: "end" });
    });
  }, []);
''',
)
replace_once(
    owner,
    '''  }, [business, session?.authenticated, viewAsEmployeeId]);

  const employeesById = useMemo(''',
    '''  }, [business, session?.authenticated, viewAsEmployeeId]);

  useEffect(() => () => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
  }, []);

  const employeesById = useMemo(''',
)
replace_once(
    owner,
    '''  useEffect(() => {
    if (selectedConversation && selectedConversation.key !== selectedKey) setSelectedKey(selectedConversation.key);
  }, [selectedConversation, selectedKey]);

  function senderName''',
    '''  useEffect(() => {
    if (selectedConversation && selectedConversation.key !== selectedKey) setSelectedKey(selectedConversation.key);
  }, [selectedConversation, selectedKey]);

  useEffect(() => {
    if (!selectedConversation) return;
    const frame = window.requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedConversation?.key, selectedMessages.length, threadOpen]);

  function senderName''',
)
regex_once(
    owner,
    r'''  async function sendMessage\(event: FormEvent<HTMLFormElement>\) \{.*?\n  \}\n\n  async function deleteMessage''',
    r'''  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedConversation || !canWrite) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = String(form.get("body") || "").trim();
    let photo = pastedPhotoRef.current;
    if (!photo) {
      const selected = form.get("photo");
      if (selected instanceof File && selected.size > 0) photo = selected;
    }
    if (!body && !photo) {
      setNotice("Type a message or attach an image.");
      return;
    }
    form.set("action", "send");
    form.set("business", business);
    form.set("conversationKey", selectedConversation.key);
    setBusy(true);
    setNotice("");
    try {
      if (photo) {
        const prepared = await prepareImageUpload(photo);
        form.set("photo", prepared, prepared.name);
      } else {
        form.delete("photo");
      }
      const response = await fetch("/api/message-conversations", {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      clearPhotoAttachment(false);
      await load();
      scrollToLatest("auto");
      setNotice(`Message sent to ${selectedConversation.label}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Message could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteMessage''',
)
replace_once(
    owner,
    '''            <span className={`messageHeaderAvatar ${selectedConversation.kind}`} aria-hidden="true">{selectedConversation.kind === "team" ? "🏪" : initials(selectedConversation.label)}</span>''',
    '''            <div className="messageThreadHeaderActions">
              <button type="button" className="messageLatestButton" onClick={() => scrollToLatest()}>Latest ↓</button>
              <span className={`messageHeaderAvatar ${selectedConversation.kind}`} aria-hidden="true">{selectedConversation.kind === "team" ? "🏪" : initials(selectedConversation.label)}</span>
            </div>''',
)
replace_once(
    owner,
    '''<img src={messagePhotoUrl(business, message.id)} alt={message.body || `Photo from ${displayName}`} loading="lazy" />''',
    '''<img src={messagePhotoUrl(business, message.id)} alt={message.body || `Photo from ${displayName}`} loading="lazy" onLoad={() => scrollToLatest("auto")} />''',
)
replace_once(
    owner,
    '''            {!selectedMessages.length && <div className="messageThreadEmpty"><strong>No messages here yet.</strong><span>{canWrite ? "Send the first message below." : "There is nothing to review in this conversation."}</span></div>}
          </div>''',
    '''            {!selectedMessages.length && <div className="messageThreadEmpty"><strong>No messages here yet.</strong><span>{canWrite ? "Send the first message below." : "There is nothing to review in this conversation."}</span></div>}
            <div ref={threadEndRef} className="messageThreadEnd" aria-hidden="true" />
          </div>''',
)
replace_once(
    owner,
    '''          {canWrite ? <form className="messageComposer" onSubmit={sendMessage}>
            <textarea name="body" rows={2} required placeholder="Send a message" aria-label={`Message ${selectedConversation.label}`} />
            <button type="submit" disabled={busy} aria-label="Send message">{busy ? "…" : "➤"}</button>
          </form> : <div className="messageReadOnlyComposer">''',
    '''          {canWrite ? <form className="messageComposer ownerMessageComposer" onSubmit={sendMessage}>
            <div className="messageAttachControls">
              <label aria-label="Upload an image" title="Upload an image">＋<input ref={photoInputRef} name="photo" type="file" accept="image/*" onChange={choosePhoto} /></label>
            </div>
            <textarea name="body" rows={2} onPaste={pastePhoto} placeholder="Send a message or paste an image" aria-label={`Message ${selectedConversation.label}`} />
            <button type="submit" disabled={busy} aria-label="Send message">{busy ? "…" : "➤"}</button>
            {photoPreview && <div className="messageAttachmentPreview"><img src={photoPreview.url} alt="Selected attachment" /><span><strong>{photoPreview.name}</strong><small>{(photoPreview.size / 1024 / 1024).toFixed(1)} MB before resizing</small></span><button type="button" onClick={() => clearPhotoAttachment()} disabled={busy}>Remove</button></div>}
          </form> : <div className="messageReadOnlyComposer">''',
)

employee = "src/app/employee/conversation-messages-dock.tsx"
replace_once(
    employee,
    'import { canvasToJpegBlob, drawCanvasImage } from "@/app/client-image";',
    'import { canvasToJpegBlob, clipboardImageFile, drawCanvasImage } from "@/app/client-image";',
)
replace_once(
    employee,
    'import { ChangeEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";',
    'import { ChangeEvent, ClipboardEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";',
)
replace_once(
    employee,
    '''  const cameraPhotoRef = useRef<HTMLInputElement | null>(null);
  const libraryPhotoRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
''',
    '''  const cameraPhotoRef = useRef<HTMLInputElement | null>(null);
  const libraryPhotoRef = useRef<HTMLInputElement | null>(null);
  const pastedPhotoRef = useRef<File | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
''',
)
replace_once(
    employee,
    '''    photoPreviewUrlRef.current = null;
    setPhotoPreview(null);''',
    '''    photoPreviewUrlRef.current = null;
    pastedPhotoRef.current = null;
    setPhotoPreview(null);''',
)
replace_once(
    employee,
    '''  function choosePhoto(event: ChangeEvent<HTMLInputElement>, source: "camera" | "library") {
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

  const loadMessages''',
    '''  function previewPhoto(file: File) {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    const url = URL.createObjectURL(file);
    photoPreviewUrlRef.current = url;
    setPhotoPreview({ url, name: file.name || "Photo", size: file.size });
  }

  function choosePhoto(event: ChangeEvent<HTMLInputElement>, source: "camera" | "library") {
    const file = event.currentTarget.files?.[0] || null;
    if (!file) return;
    pastedPhotoRef.current = null;
    if (source === "camera" && libraryPhotoRef.current) libraryPhotoRef.current.value = "";
    if (source === "library" && cameraPhotoRef.current) cameraPhotoRef.current.value = "";
    previewPhoto(file);
    setNotice("");
  }

  function pastePhoto(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = clipboardImageFile(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    if (cameraPhotoRef.current) cameraPhotoRef.current.value = "";
    if (libraryPhotoRef.current) libraryPhotoRef.current.value = "";
    pastedPhotoRef.current = file;
    previewPhoto(file);
    setNotice("Image attached. Add a message or send it as-is.");
  }

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    window.requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({ behavior, block: "end" });
    });
  }, []);

  const loadMessages''',
)
replace_once(
    employee,
    '''  useEffect(() => {
    if (selectedConversation && selectedConversation.key !== selectedKey) setSelectedKey(selectedConversation.key);
  }, [selectedConversation, selectedKey]);

  useEffect(() => {
    if (!session || !threadOpen || !selectedMessages.length) return;''',
    '''  useEffect(() => {
    if (selectedConversation && selectedConversation.key !== selectedKey) setSelectedKey(selectedConversation.key);
  }, [selectedConversation, selectedKey]);

  useEffect(() => {
    if (!selectedConversation) return;
    const frame = window.requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedConversation?.key, selectedMessages.length, threadOpen]);

  useEffect(() => {
    if (!session || !threadOpen || !selectedMessages.length) return;''',
)
replace_once(
    employee,
    '    let photo = selectedPhoto(form);',
    '    let photo = pastedPhotoRef.current || selectedPhoto(form);',
)
replace_once(
    employee,
    '''      if (photo) {
        const prepared = await prepareImageUpload(photo);
        const camera = form.get("cameraPhoto");
        if (camera instanceof File && camera.size > 0) form.set("cameraPhoto", prepared);
        else form.set("photo", prepared);
        photo = prepared;
      }''',
    '''      if (photo) {
        const prepared = await prepareImageUpload(photo);
        if (pastedPhotoRef.current) {
          form.delete("cameraPhoto");
          form.set("photo", prepared, prepared.name);
        } else {
          const camera = form.get("cameraPhoto");
          if (camera instanceof File && camera.size > 0) form.set("cameraPhoto", prepared, prepared.name);
          else form.set("photo", prepared, prepared.name);
        }
        photo = prepared;
      }''',
)
replace_once(
    employee,
    '''      clearPhotoAttachment(false);
      await loadMessages();
      setNotice(`Message sent to ${selectedConversation.label}.`);''',
    '''      clearPhotoAttachment(false);
      await loadMessages();
      scrollToLatest("auto");
      setNotice(`Message sent to ${selectedConversation.label}.`);''',
)
replace_once(
    employee,
    '''            <span className={`messageHeaderAvatar ${selectedConversation.kind}`} aria-hidden="true">{selectedConversation.kind === "team" ? "🏪" : selectedConversation.kind === "management" ? "👥" : initials(selectedConversation.label)}</span>''',
    '''            <div className="messageThreadHeaderActions">
              <button type="button" className="messageLatestButton" onClick={() => scrollToLatest()}>Latest ↓</button>
              <span className={`messageHeaderAvatar ${selectedConversation.kind}`} aria-hidden="true">{selectedConversation.kind === "team" ? "🏪" : selectedConversation.kind === "management" ? "👥" : initials(selectedConversation.label)}</span>
            </div>''',
)
replace_once(
    employee,
    '''<img src={photoUrl(message.id)} alt={message.body || `Photo from ${displayName}`} loading="lazy" />''',
    '''<img src={photoUrl(message.id)} alt={message.body || `Photo from ${displayName}`} loading="lazy" onLoad={() => scrollToLatest("auto")} />''',
)
replace_once(
    employee,
    '''            {!selectedMessages.length && <div className="messageThreadEmpty"><strong>No messages here yet.</strong><span>Send the first message below.</span></div>}
          </div>''',
    '''            {!selectedMessages.length && <div className="messageThreadEmpty"><strong>No messages here yet.</strong><span>Send the first message below.</span></div>}
            <div ref={threadEndRef} className="messageThreadEnd" aria-hidden="true" />
          </div>''',
)
replace_once(
    employee,
    '''            <textarea name="body" rows={2} placeholder="Send a message" aria-label={`Message ${selectedConversation.label}`} />''',
    '''            <textarea name="body" rows={2} onPaste={pastePhoto} placeholder="Send a message or paste an image" aria-label={`Message ${selectedConversation.label}`} />''',
)

owner_api = r'''import { del, put } from "@vercel/blob";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  ownerConversationDashboard,
  sendConversationMessage,
  TEAM_CONVERSATION_KEY,
} from "@/lib/message-conversations";
import { deleteOwnerMessage } from "@/lib/message-deletion";
import { markAdminMessagesRead } from "@/lib/message-reads";
import { notifyEmployeesOfOwnerMessage } from "@/lib/push-notifications";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGE_PHOTO = 4 * 1024 * 1024;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "photo.jpg";
}

function ownerMessagePath(business: Business, fileName: string): string {
  const location = business === "Corner Deli" ? "corner-deli" : "tiki";
  return `employee-messages/${location}/management/${Date.now()}-${safeFileName(fileName)}`;
}

function mergePush(results: Array<{ attempted: number; delivered: number; failed: number }>) {
  return results.reduce((total, result) => ({
    attempted: total.attempted + Number(result.attempted || 0),
    delivered: total.delivered + Number(result.delivered || 0),
    failed: total.failed + Number(result.failed || 0),
  }), { attempted: 0, delivered: 0, failed: 0 });
}

async function sendPush(input: {
  business: Business;
  actor: string;
  body: string;
  hasPhoto: boolean;
  result: {
    conversationKey: string;
    pushRecipientEmployeeIds: string[];
  };
}) {
  const messageBody = input.body.trim() || (input.hasPhoto ? "Sent a photo." : "Sent a new message.");
  const pushResults = input.result.conversationKey === TEAM_CONVERSATION_KEY
    ? [await notifyEmployeesOfOwnerMessage({
        business: input.business,
        recipientEmployeeId: null,
        body: messageBody,
        actor: input.actor,
      }).catch((error: unknown) => {
        console.error("[api/message-conversations] team push failed", error);
        return { attempted: 0, delivered: 0, failed: 0 };
      })]
    : await Promise.all(input.result.pushRecipientEmployeeIds.map((employeeId: string) =>
        notifyEmployeesOfOwnerMessage({
          business: input.business,
          recipientEmployeeId: employeeId,
          body: messageBody,
          actor: input.actor,
        }).catch((error: unknown) => {
          console.error("[api/message-conversations] employee push failed", error);
          return { attempted: 0, delivered: 0, failed: 0 };
        }),
      ));
  return mergePush(pushResults);
}

function managementCanWrite(conversationKey: string): Response | null {
  if (!conversationKey.toLowerCase().startsWith("direct:")) return null;
  return Response.json({
    error: "Employee-to-employee conversations are view-only for management. Use an employee conversation or the entire team.",
  }, { status: 400 });
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.read");
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business") || "Corner Deli");
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    const viewAsEmployeeId = url.searchParams.get("viewAsEmployeeId") || "";
    if (!viewAsEmployeeId) await markAdminMessagesRead(session.email, business);
    return Response.json(await ownerConversationDashboard(business, viewAsEmployeeId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let uploadedUrl = "";
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.write");
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const business = businessFrom(form.get("business"));
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      const action = String(form.get("action") || "send");
      if (action !== "send" && action !== "message-send") {
        return Response.json({ error: "Unknown conversation upload action." }, { status: 400 });
      }
      const conversationKey = String(form.get("conversationKey") || TEAM_CONVERSATION_KEY);
      const blocked = managementCanWrite(conversationKey);
      if (blocked) return blocked;
      const body = String(form.get("body") || "");
      const selected = form.get("photo");
      const photo = selected instanceof File && selected.size > 0 ? selected : null;

      let attachment: {
        url: string;
        pathname: string;
        name: string;
        type: string;
        size: number;
      } | null = null;
      if (photo) {
        if (!photo.type.toLowerCase().startsWith("image/")) {
          return Response.json({ error: "Message attachments must be image files." }, { status: 415 });
        }
        if (photo.size > MAX_MESSAGE_PHOTO) {
          return Response.json({ error: "Message photos are limited to 4 MB after resizing." }, { status: 413 });
        }
        const blob = await put(ownerMessagePath(business, photo.name), photo, {
          access: "private",
          addRandomSuffix: true,
        });
        uploadedUrl = blob.url;
        attachment = {
          url: blob.url,
          pathname: blob.pathname,
          name: photo.name,
          type: photo.type || "application/octet-stream",
          size: photo.size,
        };
      }

      const result = await sendConversationMessage({
        business,
        conversationKey,
        senderName: session.email,
        body,
        attachment,
      });
      uploadedUrl = "";
      const push = await sendPush({
        business,
        actor: session.email,
        body,
        hasPhoto: Boolean(photo),
        result,
      });
      return Response.json({ ...result, push }, { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    const action = String(body.action || "send");
    if (action === "delete") {
      return Response.json(await deleteOwnerMessage({
        id: String(body.id || ""),
        business,
        actor: session.email,
        reason: "Owner removed conversation message",
      }));
    }
    if (action !== "send") {
      return Response.json({ error: "Unknown conversation action." }, { status: 400 });
    }

    const conversationKey = String(body.conversationKey || TEAM_CONVERSATION_KEY);
    const blocked = managementCanWrite(conversationKey);
    if (blocked) return blocked;
    const messageBody = String(body.body || "");
    const result = await sendConversationMessage({
      business,
      conversationKey,
      senderName: session.email,
      body: messageBody,
    });
    const push = await sendPush({
      business,
      actor: session.email,
      body: messageBody,
      hasPhoto: false,
      result,
    });
    return Response.json({ ...result, push }, { status: 201 });
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}
'''
Path("src/app/api/message-conversations/route.ts").write_text(owner_api, encoding="utf-8")

css = "src/app/message-inbox.css"
replace_once(
    css,
    '.messageApp{--message-purple:var(--color-7c3aed);--message-ink:var(--color-0f172a);--message-muted:var(--color-64748b);--message-line:var(--color-e2e8f0);--message-paper:var(--color-ffffff);--message-soft:var(--color-f8fafc);min-height:100vh;background:var(--message-soft);color:var(--message-ink);font-family:inherit;text-shadow:none}',
    '.messageApp{--message-purple:var(--color-7c3aed);--message-ink:var(--color-0f172a);--message-muted:var(--color-64748b);--message-line:var(--color-e2e8f0);--message-paper:var(--color-ffffff);--message-soft:var(--color-f8fafc);height:100dvh;min-height:0;display:flex;flex-direction:column;overflow:hidden;position:relative;background:var(--message-soft);color:var(--message-ink);font-family:inherit;text-shadow:none}',
)
replace_once(
    css,
    '.messageControlBar{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;padding:.8rem clamp(1rem,3vw,2rem);background:var(--message-paper);border-bottom:1px solid var(--message-line)}',
    '.messageControlBar{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;flex:0 0 auto;padding:.8rem clamp(1rem,3vw,2rem);background:var(--message-paper);border-bottom:1px solid var(--message-line)}',
)
replace_once(
    css,
    '.messageImpersonationBanner,.messageNotice{max-width:1500px;margin:.75rem auto 0;padding:.8rem 1rem;border-radius:12px}',
    '.messageImpersonationBanner,.messageNotice{width:min(1500px,calc(100% - 1.5rem));max-width:1500px;flex:0 0 auto;margin:.75rem auto 0;padding:.8rem 1rem;border-radius:12px}',
)
replace_once(
    css,
    '.messageShell{max-width:1500px;height:calc(100vh - 154px);min-height:620px;margin:0 auto;display:grid;grid-template-columns:minmax(310px,410px) minmax(0,1fr);background:var(--message-paper);border-left:1px solid var(--message-line);border-right:1px solid var(--message-line);overflow:hidden}',
    '.messageShell{width:100%;max-width:1500px;flex:1 1 auto;height:auto;min-height:0;margin:0 auto;display:grid;grid-template-columns:minmax(310px,410px) minmax(0,1fr);background:var(--message-paper);border-left:1px solid var(--message-line);border-right:1px solid var(--message-line);overflow:hidden}',
)
replace_once(
    css,
    '.messageThreadPane{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--message-paper)}',
    '.messageThreadPane{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--message-paper)}',
)
replace_once(
    css,
    '.messageThread{flex:1;min-height:0;overflow:auto;padding:1rem clamp(.8rem,3vw,2rem) 1.5rem;background:linear-gradient(180deg,var(--message-paper),var(--message-soft))}',
    '.messageThread{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:1rem clamp(.8rem,3vw,2rem) 1.5rem;background:linear-gradient(180deg,var(--message-paper),var(--message-soft))}',
)
replace_once(
    css,
    '.messageThreadHeader h2{margin:0;font-size:1.2rem}.messageThreadHeader p{margin:.18rem 0 0;color:var(--message-muted);font-size:.78rem}.messageBack{display:none;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:var(--message-purple);font-size:1.5rem}.messageHeaderAvatar{width:48px;height:48px;border:0;font-size:.8rem}.messageHeaderAvatar.team{font-size:1.3rem}',
    '.messageThreadHeader h2{margin:0;font-size:1.2rem}.messageThreadHeader p{margin:.18rem 0 0;color:var(--message-muted);font-size:.78rem}.messageBack{display:none;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:var(--message-purple);font-size:1.5rem}.messageThreadHeaderActions{display:flex;align-items:center;gap:.55rem}.messageLatestButton{border:1px solid var(--message-line);border-radius:999px;background:var(--message-soft);color:var(--message-purple);padding:.48rem .7rem;font-weight:850;font-size:.74rem}.messageLatestButton:hover{border-color:var(--message-purple)}.messageHeaderAvatar{width:48px;height:48px;border:0;font-size:.8rem}.messageHeaderAvatar.team{font-size:1.3rem}',
)
replace_once(
    css,
    '.messageThreadEmpty{min-height:240px;display:grid;place-content:center;gap:.35rem;text-align:center;color:var(--message-muted)}.messageThreadEmpty strong{color:var(--message-ink)}',
    '.messageThreadEmpty{min-height:240px;display:grid;place-content:center;gap:.35rem;text-align:center;color:var(--message-muted)}.messageThreadEmpty strong{color:var(--message-ink)}.messageThreadEnd{height:1px;scroll-margin-bottom:.4rem}',
)
replace_once(
    css,
    '.messageComposer{position:sticky;bottom:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.55rem;align-items:end;padding:.8rem 1rem calc(.8rem + env(safe-area-inset-bottom));border-top:1px solid var(--message-line);background:var(--message-paper)}',
    '.messageComposer{position:relative;flex:0 0 auto;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.55rem;align-items:end;padding:.8rem 1rem calc(.8rem + env(safe-area-inset-bottom));border-top:1px solid var(--message-line);background:var(--message-paper)}',
)
replace_once(
    css,
    '.employeeMessageComposer{grid-template-columns:auto minmax(0,1fr) auto}',
    '.employeeMessageComposer,.ownerMessageComposer{grid-template-columns:auto minmax(0,1fr) auto}',
)
replace_once(
    css,
    '.messageShell{height:calc(100vh - 150px);min-height:520px;display:block;border:0}',
    '.messageShell{height:auto;min-height:0;flex:1 1 auto;display:block;border:0}',
)
replace_once(
    css,
    '.messageShell{height:calc(100vh - 174px)}.employeeMessageApp .messageShell{height:calc(100vh - 76px)}',
    '.messageShell,.employeeMessageApp .messageShell{height:auto;min-height:0}',
)
replace_once(
    css,
    '.employeeMessageComposer{grid-template-columns:auto minmax(0,1fr) auto}.messageAttachControls{gap:.1rem}',
    '.employeeMessageComposer,.ownerMessageComposer{grid-template-columns:auto minmax(0,1fr) auto}.messageAttachControls{gap:.1rem}',
)

Path("tests/message-image-paste-scroll.test.ts").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("management messages accept uploaded and pasted images through multipart form data", () => {
  const page = source("src/app/ops/messages/page.tsx");
  const route = source("src/app/api/message-conversations/route.ts");
  assert.equal(page.includes('type="file" accept="image/*"'), true);
  assert.equal(page.includes("onPaste={pastePhoto}"), true);
  assert.equal(page.includes('body: form'), true);
  assert.equal(route.includes('multipart/form-data'), true);
  assert.equal(route.includes('Message photos are limited to 4 MB after resizing.'), true);
  assert.equal(route.includes('attachment,'), true);
});

test("employee messages also accept clipboard images", () => {
  const page = source("src/app/employee/conversation-messages-dock.tsx");
  assert.equal(page.includes("clipboardImageFile"), true);
  assert.equal(page.includes("onPaste={pastePhoto}"), true);
  assert.equal(page.includes("pastedPhotoRef"), true);
});

test("message viewport keeps the composer visible and provides a reliable latest-message target", () => {
  const owner = source("src/app/ops/messages/page.tsx");
  const employee = source("src/app/employee/conversation-messages-dock.tsx");
  const css = source("src/app/message-inbox.css");
  for (const page of [owner, employee]) {
    assert.equal(page.includes("messageLatestButton"), true);
    assert.equal(page.includes("threadEndRef"), true);
    assert.equal(page.includes("scrollIntoView"), true);
  }
  assert.equal(css.includes("height:100dvh"), true);
  assert.equal(css.includes("flex:1 1 auto;height:auto;min-height:0"), true);
  assert.equal(css.includes("overscroll-behavior:contain"), true);
  assert.equal(css.includes("position:relative;flex:0 0 auto"), true);
});
''', encoding="utf-8")
