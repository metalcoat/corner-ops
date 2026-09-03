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
