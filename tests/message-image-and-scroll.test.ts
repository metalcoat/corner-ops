import test from "node:test";
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

test("message threads own the scrolling area and support unread or saved resume positions", () => {
  const owner = source("src/app/ops/messages/page.tsx");
  const employee = source("src/app/employee/conversation-messages-dock.tsx");
  const css = source("src/app/message-inbox.css");
  for (const page of [owner, employee]) {
    assert.equal(page.includes("messageThreadRef"), true);
    assert.equal(page.includes("scrollThreadToBottom"), true);
    assert.equal(page.includes("onScroll={trackThreadScroll}"), true);
  }
  assert.equal(css.includes("height:var(--message-viewport-height,100dvh)"), true);
  assert.equal(css.includes(".messageComposer{position:relative;bottom:auto}"), true);
  assert.equal(css.includes(".messageInboxPane,.messageThreadPane{min-height:0;overflow:hidden}"), true);
});


test("message threads resume at unread messages and only mark visible messages read", () => {
  const owner = source("src/app/ops/messages/page.tsx");
  const employee = source("src/app/employee/conversation-messages-dock.tsx");
  const behavior = source("src/app/use-message-thread-behavior.ts");
  for (const page of [owner, employee]) {
    assert.equal(page.includes("useMessageThreadBehavior"), true);
    assert.equal(page.includes("data-message-id={message.id}"), true);
    assert.equal(page.includes("openingUnreadId === message.id"), true);
  }
  assert.equal(behavior.includes("corner-ops-message-position"), true);
  assert.equal(behavior.includes("window.localStorage.setItem"), true);
  assert.equal(behavior.includes("IntersectionObserver"), true);
  assert.equal(behavior.includes("currentlyVisibleUnread"), true);
});

test("mobile message composer follows the visual viewport and install prompt stays off messages", () => {
  const behavior = source("src/app/use-message-thread-behavior.ts");
  const css = source("src/app/message-inbox.css");
  const installPrompt = source("src/app/employee/install-prompt.tsx");
  assert.equal(behavior.includes("window.visualViewport"), true);
  assert.equal(behavior.includes("data-keyboard-open"), true);
  assert.equal(css.includes('.messageApp[data-keyboard-open="true"]'), true);
  assert.equal(css.includes("font-size:16px"), true);
  assert.equal(installPrompt.includes('pathname !== "/employee/messages"'), true);
  assert.equal(installPrompt.includes("useModalFocus<HTMLDivElement>(shouldShow"), true);
});

test("management read state is per visible message rather than marking the whole inbox", () => {
  const route = source("src/app/api/message-conversations/route.ts");
  const reads = source("src/lib/message-reads.ts");
  const owner = source("src/app/ops/messages/page.tsx");
  assert.equal(route.includes("adminUnreadMessageIds"), true);
  assert.equal(route.includes("markAdminConversationMessageSeen"), true);
  assert.equal(route.includes("await markAdminMessagesRead"), false);
  assert.equal(reads.includes("export async function markAdminConversationMessageSeen"), true);
  assert.equal(owner.includes('action: "message-seen"'), true);
});
