from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old[:180]!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


def insert_before(path: str, marker: str, addition: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(marker)
    if count != 1:
        raise SystemExit(f"Expected one marker in {path}, found {count}: {marker[:180]!r}")
    file.write_text(text.replace(marker, addition + marker, 1), encoding="utf-8")


def regex_once(path: str, pattern: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, lambda _: replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"Expected one regex match in {path}, found {count}: {pattern[:180]!r}")
    file.write_text(updated, encoding="utf-8")


# Management attachment API.
route = "src/app/api/message-conversations/route.ts"
replace_once(
    route,
    'import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";',
    'import { del, put } from "@vercel/blob";\nimport { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";',
)
replace_once(
    route,
    'export const runtime = "nodejs";\n',
    'export const runtime = "nodejs";\nexport const maxDuration = 60;\n\nconst MAX_MESSAGE_PHOTO = 4 * 1024 * 1024;\n',
)
insert_before(
    route,
    "export async function GET(request: Request)",
    '''function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "photo.jpg";
}

function ownerMessagePath(business: Business, fileName: string): string {
  const location = business === "Corner Deli" ? "corner-deli" : "tiki";
  return `owner-messages/${location}/${Date.now()}-${safeFileName(fileName)}`;
}

async function sendOwnerPush(input: {
  business: Business;
  result: { conversationKey: string; pushRecipientEmployeeIds: string[] };
  body: string;
  hasPhoto: boolean;
  actor: string;
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

''',
)
regex_once(
    route,
    r"export async function POST\(request: Request\) \{[\s\S]*\Z",
    '''export async function POST(request: Request) {
  let uploadedUrl = "";
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.write");
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const action = String(form.get("action") || "send");
      if (action !== "send") {
        return Response.json({ error: "Unknown conversation upload action." }, { status: 400 });
      }
      const business = businessFrom(form.get("business"));
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      const conversationKey = String(form.get("conversationKey") || TEAM_CONVERSATION_KEY);
      if (conversationKey.toLowerCase().startsWith("direct:")) {
        return Response.json({
          error: "Employee-to-employee conversations are view-only for management. Use an employee conversation or the entire team.",
        }, { status: 400 });
      }
      const body = String(form.get("body") || "");
      const cameraPhoto = form.get("cameraPhoto");
      const libraryPhoto = form.get("photo");
      const photo = cameraPhoto instanceof File && cameraPhoto.size > 0
        ? cameraPhoto
        : libraryPhoto instanceof File && libraryPhoto.size > 0
          ? libraryPhoto
          : null;

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
      const push = await sendOwnerPush({
        business,
        result,
        body,
        hasPhoto: Boolean(photo),
        actor: session.email,
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
    if (conversationKey.toLowerCase().startsWith("direct:")) {
      return Response.json({
        error: "Employee-to-employee conversations are view-only for management. Use an employee conversation or the entire team.",
      }, { status: 400 });
    }

    const messageBody = String(body.body || "");
    const result = await sendConversationMessage({
      business,
      conversationKey,
      senderName: session.email,
      body: messageBody,
    });
    const push = await sendOwnerPush({
      business,
      result,
      body: messageBody,
      hasPhoto: false,
      actor: session.email,
    });
    return Response.json({ ...result, push }, { status: 201 });
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}
''',
)


# Management inbox attachment selection, clipboard paste, and bottom anchoring.
owner = "src/app/ops/messages/page.tsx"
replace_once(
    owner,
    'import { responseMessage } from "@/app/client-http";\nimport { firstName } from "@/app/client-text";',
    'import { responseMessage } from "@/app/client-http";\nimport { canvasToJpegBlob, drawCanvasImage } from "@/app/client-image";\nimport { firstName } from "@/app/client-text";',
)
replace_once(
    owner,
    'import { ChangeEvent, CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";',
    'import { ChangeEvent, ClipboardEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";',
)
insert_before(
    owner,
    "function initials(value: string): string",
    '''const SAFE_FUNCTION_UPLOAD_BYTES = 3.5 * 1024 * 1024;
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

''',
)
replace_once(
    owner,
    '  const [busy, setBusy] = useState(false);\n',
    '''  const [busy, setBusy] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<{ file: File; url: string; name: string; size: number } | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

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

  const scrollThreadToBottom = useCallback(() => {
    const node = messageThreadRef.current;
    if (!node) return;
    window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, []);

  function trackThreadScroll() {
    const node = messageThreadRef.current;
    if (!node) return;
    stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }
''',
)
insert_before(
    owner,
    "  async function load(activeBusiness = business, activeViewAs = viewAsEmployeeId)",
    '''  useEffect(() => () => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
  }, []);

''',
)
insert_before(
    owner,
    '''  useEffect(() => {
    if (selectedConversation && selectedConversation.key !== selectedKey) setSelectedKey(selectedConversation.key);
  }, [selectedConversation, selectedKey]);''',
    '''  useEffect(() => {
    if (stickToBottomRef.current) scrollThreadToBottom();
  }, [selectedKey, selectedMessages.length, scrollThreadToBottom]);

''',
)
replace_once(
    owner,
    '''  function chooseConversation(key: string) {
    setSelectedKey(key);''',
    '''  function chooseConversation(key: string) {
    stickToBottomRef.current = true;
    setSelectedKey(key);''',
)
regex_once(
    owner,
    r"  async function sendMessage\(event: FormEvent<HTMLFormElement>\) \{[\s\S]*?(?=  async function deleteMessage)",
    '''  async function sendMessage(event: FormEvent<HTMLFormElement>) {
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

''',
)
replace_once(
    owner,
    '<div className="messageThread" aria-live="polite">',
    '<div ref={messageThreadRef} className="messageThread" aria-live="polite" onScroll={trackThreadScroll}>',
)
replace_once(
    owner,
    'loading="lazy" /></a>}',
    'loading="lazy" onLoad={() => { if (stickToBottomRef.current) scrollThreadToBottom(); }} /></a>}',
)
regex_once(
    owner,
    r'''          \{canWrite \? <form className="messageComposer" onSubmit=\{sendMessage\}>[\s\S]*?</form> : <div className="messageReadOnlyComposer">''',
    '''          {canWrite ? <form className="messageComposer messageComposerWithAttachments" onSubmit={sendMessage}>
            <div className="messageAttachControls">
              <label aria-label="Upload an image" title="Upload an image">🖼<input ref={photoInputRef} name="photo" type="file" accept="image/*" onChange={choosePhoto} /></label>
            </div>
            <textarea name="body" rows={2} placeholder="Send a message or paste an image" aria-label={`Message ${selectedConversation.label}`} onPaste={pastePhoto} />
            <button type="submit" disabled={busy} aria-label="Send message">{busy ? "…" : "➤"}</button>
            {photoPreview && <div className="messageAttachmentPreview"><img src={photoPreview.url} alt="Selected attachment" /><span><strong>{photoPreview.name}</strong><small>{(photoPreview.size / 1024 / 1024).toFixed(1)} MB before resizing · paste or upload</small></span><button type="button" onClick={() => clearPhotoAttachment()} disabled={busy}>Remove</button></div>}
          </form> : <div className="messageReadOnlyComposer">''',
)


# Employee inbox: clipboard image paste plus reliable bottom anchoring.
employee = "src/app/employee/conversation-messages-dock.tsx"
replace_once(
    employee,
    'import { ChangeEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";',
    'import { ChangeEvent, ClipboardEvent, CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";',
)
replace_once(
    employee,
    '  const [photoPreview, setPhotoPreview] = useState<{ url: string; name: string; size: number } | null>(null);',
    '  const [photoPreview, setPhotoPreview] = useState<{ file: File; url: string; name: string; size: number } | null>(null);',
)
replace_once(
    employee,
    '  const photoPreviewUrlRef = useRef<string | null>(null);\n',
    '''  const photoPreviewUrlRef = useRef<string | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
''',
)
insert_before(
    employee,
    "  function choosePhoto(event: ChangeEvent<HTMLInputElement>, source: \"camera\" | \"library\")",
    '''  const scrollThreadToBottom = useCallback(() => {
    const node = messageThreadRef.current;
    if (!node) return;
    window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, []);

  function trackThreadScroll() {
    const node = messageThreadRef.current;
    if (!node) return;
    stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

''',
)
replace_once(
    employee,
    '    setPhotoPreview({ url, name: file.name || "Photo", size: file.size });',
    '    setPhotoPreview({ file, url, name: file.name || "Photo", size: file.size });',
)
insert_before(
    employee,
    "  const loadMessages = useCallback(async () => {",
    '''  function pastePhoto(event: ClipboardEvent<HTMLTextAreaElement>) {
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

''',
)
insert_before(
    employee,
    '''  useEffect(() => {
    if (selectedConversation && selectedConversation.key !== selectedKey) setSelectedKey(selectedConversation.key);
  }, [selectedConversation, selectedKey]);''',
    '''  useEffect(() => {
    if (stickToBottomRef.current) scrollThreadToBottom();
  }, [selectedKey, selectedMessages.length, scrollThreadToBottom]);

''',
)
replace_once(
    employee,
    '''  function chooseConversation(key: string) {
    setSelectedKey(key);''',
    '''  function chooseConversation(key: string) {
    stickToBottomRef.current = true;
    setSelectedKey(key);''',
)
replace_once(
    employee,
    '    let photo = selectedPhoto(form);',
    '    let photo = photoPreview?.file || selectedPhoto(form);',
)
replace_once(
    employee,
    '''      clearPhotoAttachment(false);
      await loadMessages();''',
    '''      clearPhotoAttachment(false);
      stickToBottomRef.current = true;
      await loadMessages();
      scrollThreadToBottom();''',
)
replace_once(
    employee,
    '<div className="messageThread" aria-live="polite">',
    '<div ref={messageThreadRef} className="messageThread" aria-live="polite" onScroll={trackThreadScroll}>',
)
replace_once(
    employee,
    'loading="lazy" /></a>}',
    'loading="lazy" onLoad={() => { if (stickToBottomRef.current) scrollThreadToBottom(); }} /></a>}',
)
replace_once(
    employee,
    '<textarea name="body" rows={2} placeholder="Send a message" aria-label={`Message ${selectedConversation.label}`} />',
    '<textarea name="body" rows={2} placeholder="Send a message or paste an image" aria-label={`Message ${selectedConversation.label}`} onPaste={pastePhoto} />',
)


# Make the inbox consume the dynamic viewport and keep only the thread itself scrollable.
css = Path("src/app/message-inbox.css")
css_text = css.read_text(encoding="utf-8")
marker = "/* Message attachment and viewport scrolling repair. */"
if marker in css_text:
    raise SystemExit("Message attachment and viewport CSS repair already exists.")
css.write_text(css_text + '''

/* Message attachment and viewport scrolling repair. */
.messageApp{position:relative;height:100dvh;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.messageTopBar,.messageControlBar,.messageImpersonationBanner,.messageNotice,.messageProfilePanel{flex:0 0 auto}
.messageImpersonationBanner,.messageNotice{width:min(1500px,calc(100% - 1.5rem))}
.messageShell,.employeeMessageApp .messageShell{width:100%;height:auto;min-height:0;flex:1 1 auto}
.messageInboxPane,.messageThreadPane{min-height:0;overflow:hidden}
.messageThreadHeader,.messageComposer,.messageReadOnlyComposer{flex:0 0 auto}
.messageThread{scrollbar-gutter:stable;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.messageComposer{position:relative;bottom:auto}
.messageComposerWithAttachments{grid-template-columns:auto minmax(0,1fr) auto}
@media(max-width:560px){.messageShell,.employeeMessageApp .messageShell{height:auto;min-height:0}.messageComposerWithAttachments{grid-template-columns:auto minmax(0,1fr) auto}}
''', encoding="utf-8")


Path("tests/message-image-and-scroll.test.ts").write_text('''import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("management messages accept uploaded and pasted images", () => {
  const page = source("src/app/ops/messages/page.tsx");
  const route = source("src/app/api/message-conversations/route.ts");
  assert.equal(page.includes('accept="image/*"'), true);
  assert.equal(page.includes("onPaste={pastePhoto}"), true);
  assert.equal(page.includes("prepareImageUpload(photo)"), true);
  assert.equal(route.includes('contentType.includes("multipart/form-data")'), true);
  assert.equal(route.includes("await put(ownerMessagePath"), true);
  assert.equal(route.includes("attachment,"), true);
});

test("employee messages accept clipboard images as well as camera and library uploads", () => {
  const page = source("src/app/employee/conversation-messages-dock.tsx");
  assert.equal(page.includes("ClipboardEvent"), true);
  assert.equal(page.includes("onPaste={pastePhoto}"), true);
  assert.equal(page.includes("photoPreview?.file || selectedPhoto(form)"), true);
  assert.equal(page.includes('capture="environment"'), true);
});

test("message threads own the scrolling area and stay anchored at the newest message", () => {
  const owner = source("src/app/ops/messages/page.tsx");
  const employee = source("src/app/employee/conversation-messages-dock.tsx");
  const css = source("src/app/message-inbox.css");
  for (const page of [owner, employee]) {
    assert.equal(page.includes("messageThreadRef"), true);
    assert.equal(page.includes("scrollThreadToBottom"), true);
    assert.equal(page.includes("onScroll={trackThreadScroll}"), true);
  }
  assert.equal(css.includes("height:100dvh"), true);
  assert.equal(css.includes(".messageComposer{position:relative;bottom:auto}"), true);
  assert.equal(css.includes(".messageInboxPane,.messageThreadPane{min-height:0;overflow:hidden}"), true);
});
''', encoding="utf-8")
