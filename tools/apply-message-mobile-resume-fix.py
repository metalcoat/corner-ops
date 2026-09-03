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


def write_file(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content, encoding="utf-8")


write_file(
    "src/app/use-message-thread-behavior.ts",
    r'''"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";

type StoredThreadPosition = {
  messageId: string;
  offset: number;
  atBottom: boolean;
};

type MessageThreadBehaviorOptions = {
  appRef: RefObject<HTMLElement | null>;
  threadRef: RefObject<HTMLDivElement | null>;
  selectedKey: string;
  messageIds: string[];
  unreadMessageIds: string[];
  threadOpen: boolean;
  ready: boolean;
  storageScope: string;
  onUnreadVisible?: (messageIds: string[]) => void;
};

const BOTTOM_DISTANCE = 120;
const KEYBOARD_DELTA = 80;
const STORAGE_PREFIX = "corner-ops-message-position";

function storageKey(scope: string, conversationKey: string): string {
  return `${STORAGE_PREFIX}:${scope}:${conversationKey}`;
}

function messageElements(thread: HTMLElement): HTMLElement[] {
  return Array.from(thread.querySelectorAll<HTMLElement>("[data-message-id]"));
}

function messageElement(thread: HTMLElement, messageId: string): HTMLElement | null {
  return messageElements(thread).find((element) => element.dataset.messageId === messageId) || null;
}

function elementTopInsideThread(thread: HTMLElement, element: HTMLElement): number {
  return element.getBoundingClientRect().top - thread.getBoundingClientRect().top + thread.scrollTop;
}

function readPosition(scope: string, conversationKey: string): StoredThreadPosition | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(scope, conversationKey)) || "null") as Partial<StoredThreadPosition> | null;
    if (!parsed || typeof parsed.messageId !== "string") return null;
    return {
      messageId: parsed.messageId,
      offset: Number.isFinite(Number(parsed.offset)) ? Number(parsed.offset) : 0,
      atBottom: Boolean(parsed.atBottom),
    };
  } catch {
    return null;
  }
}

function writePosition(scope: string, conversationKey: string, position: StoredThreadPosition): void {
  try {
    window.localStorage.setItem(storageKey(scope, conversationKey), JSON.stringify(position));
  } catch {
    // Storage may be unavailable in private browsing. Scrolling still works for this visit.
  }
}

function currentlyVisibleUnread(thread: HTMLElement, unreadIds: Set<string>): string[] {
  const root = thread.getBoundingClientRect();
  return messageElements(thread).flatMap((element) => {
    const id = element.dataset.messageId || "";
    if (!id || !unreadIds.has(id)) return [];
    const rect = element.getBoundingClientRect();
    const visibleHeight = Math.min(rect.bottom, root.bottom) - Math.max(rect.top, root.top);
    const minimumVisible = Math.min(24, Math.max(8, rect.height * 0.2));
    return visibleHeight >= minimumVisible ? [id] : [];
  });
}

export function useMessageThreadBehavior({
  appRef,
  threadRef,
  selectedKey,
  messageIds,
  unreadMessageIds,
  threadOpen,
  ready,
  storageScope,
  onUnreadVisible,
}: MessageThreadBehaviorOptions) {
  const stickToBottomRef = useRef(true);
  const positionedKeyRef = useRef("");
  const saveFrameRef = useRef<number | null>(null);
  const baselineViewportHeightRef = useRef(0);
  const [openingUnread, setOpeningUnread] = useState<{ key: string; messageId: string | null } | null>(null);
  const messageSignature = messageIds.join(":");
  const unreadSignature = unreadMessageIds.join(":");
  const firstUnreadId = unreadMessageIds[0] || null;
  const openingUnreadId = openingUnread?.key === selectedKey
    ? openingUnread.messageId
    : firstUnreadId;

  const scrollThreadToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const thread = threadRef.current;
    if (!thread) return;
    window.requestAnimationFrame(() => {
      if (behavior === "smooth") thread.scrollTo({ top: thread.scrollHeight, behavior });
      else thread.scrollTop = thread.scrollHeight;
    });
  }, [threadRef]);

  const saveThreadPosition = useCallback(() => {
    const thread = threadRef.current;
    if (!thread || !ready || !selectedKey || typeof window === "undefined") return;
    const elements = messageElements(thread);
    if (!elements.length) return;
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < BOTTOM_DISTANCE;
    const threadTop = thread.getBoundingClientRect().top;
    const firstVisible = elements.find((element) => element.getBoundingClientRect().bottom > threadTop + 4)
      || elements[elements.length - 1];
    const messageId = firstVisible.dataset.messageId;
    if (!messageId) return;
    writePosition(storageScope, selectedKey, {
      messageId,
      offset: firstVisible.getBoundingClientRect().top - threadTop,
      atBottom,
    });
  }, [ready, selectedKey, storageScope, threadRef]);

  const trackThreadScroll = useCallback(() => {
    const thread = threadRef.current;
    if (!thread) return;
    stickToBottomRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < BOTTOM_DISTANCE;
    if (saveFrameRef.current !== null) return;
    saveFrameRef.current = window.requestAnimationFrame(() => {
      saveFrameRef.current = null;
      saveThreadPosition();
    });
  }, [saveThreadPosition, threadRef]);

  useEffect(() => {
    const root = appRef.current;
    if (!root) return;
    let frame = 0;
    const viewport = window.visualViewport;

    const updateViewport = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const currentHeight = Math.max(1, Math.round(viewport?.height || window.innerHeight));
        const viewportTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
        const active = document.activeElement;
        const composerFocused = active instanceof HTMLElement
          && root.contains(active)
          && Boolean(active.closest(".messageComposer"));
        if (!composerFocused) {
          baselineViewportHeightRef.current = Math.max(
            baselineViewportHeightRef.current,
            currentHeight,
            window.innerHeight,
          );
        }
        if (!baselineViewportHeightRef.current) baselineViewportHeightRef.current = currentHeight;
        const keyboardOpen = composerFocused
          && baselineViewportHeightRef.current - currentHeight > KEYBOARD_DELTA;
        const visibleBottom = viewportTop + currentHeight;
        const rootTop = root.getBoundingClientRect().top;
        const availableHeight = keyboardOpen
          ? currentHeight
          : Math.max(320, Math.round(visibleBottom - Math.max(rootTop, viewportTop)));
        root.style.setProperty("--message-viewport-height", `${availableHeight}px`);
        root.style.setProperty("--message-viewport-top", `${viewportTop}px`);
        root.toggleAttribute("data-keyboard-open", keyboardOpen);
      });
    };

    const delayedUpdate = () => {
      updateViewport();
      window.setTimeout(updateViewport, 80);
      window.setTimeout(updateViewport, 320);
    };

    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    document.addEventListener("focusin", delayedUpdate);
    document.addEventListener("focusout", delayedUpdate);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      document.removeEventListener("focusin", delayedUpdate);
      document.removeEventListener("focusout", delayedUpdate);
      root.removeAttribute("data-keyboard-open");
      root.style.removeProperty("--message-viewport-height");
      root.style.removeProperty("--message-viewport-top");
    };
  }, [appRef]);

  useEffect(() => {
    if (!ready) return;
    if (!threadOpen) {
      positionedKeyRef.current = "";
      setOpeningUnread(null);
      return;
    }
    const thread = threadRef.current;
    if (!thread) return;

    if (positionedKeyRef.current !== selectedKey) {
      positionedKeyRef.current = selectedKey;
      setOpeningUnread({ key: selectedKey, messageId: firstUnreadId });
      const frame = window.requestAnimationFrame(() => {
        const currentThread = threadRef.current;
        if (!currentThread) return;
        if (firstUnreadId) {
          const unreadTarget = messageElement(currentThread, firstUnreadId);
          if (unreadTarget) {
            currentThread.scrollTop = Math.max(0, elementTopInsideThread(currentThread, unreadTarget) - 10);
            stickToBottomRef.current = false;
            saveThreadPosition();
            return;
          }
        }
        const saved = readPosition(storageScope, selectedKey);
        if (saved && !saved.atBottom) {
          const savedTarget = messageElement(currentThread, saved.messageId);
          if (savedTarget) {
            currentThread.scrollTop = Math.max(
              0,
              elementTopInsideThread(currentThread, savedTarget) - saved.offset,
            );
            stickToBottomRef.current = currentThread.scrollHeight
              - currentThread.scrollTop
              - currentThread.clientHeight < BOTTOM_DISTANCE;
            saveThreadPosition();
            return;
          }
        }
        currentThread.scrollTop = currentThread.scrollHeight;
        stickToBottomRef.current = true;
        saveThreadPosition();
      });
      return () => window.cancelAnimationFrame(frame);
    }

    if (stickToBottomRef.current) scrollThreadToBottom();
  }, [
    firstUnreadId,
    messageSignature,
    ready,
    saveThreadPosition,
    scrollThreadToBottom,
    selectedKey,
    storageScope,
    threadOpen,
    threadRef,
  ]);

  useEffect(() => {
    if (!ready || !threadOpen || !onUnreadVisible || !unreadMessageIds.length) return;
    const thread = threadRef.current;
    if (!thread) return;
    const unread = new Set(unreadMessageIds);
    let observer: IntersectionObserver | null = null;
    const frame = window.requestAnimationFrame(() => {
      const currentThread = threadRef.current;
      if (!currentThread) return;
      const targets = messageElements(currentThread).filter((element) => unread.has(element.dataset.messageId || ""));
      if (!targets.length) return;
      const initiallyVisible = currentlyVisibleUnread(currentThread, unread);
      if (initiallyVisible.length) onUnreadVisible(initiallyVisible);
      if (!("IntersectionObserver" in window)) return;
      observer = new IntersectionObserver((entries) => {
        const visible = entries.flatMap((entry) => {
          const element = entry.target as HTMLElement;
          const id = element.dataset.messageId || "";
          const enoughVisible = entry.isIntersecting
            && entry.intersectionRect.height >= Math.min(24, Math.max(8, entry.boundingClientRect.height * 0.2));
          return id && unread.has(id) && enoughVisible ? [id] : [];
        });
        if (visible.length) onUnreadVisible(Array.from(new Set(visible)));
      }, {
        root: currentThread,
        rootMargin: "0px 0px -8% 0px",
        threshold: [0, 0.15, 0.5],
      });
      targets.forEach((target) => observer?.observe(target));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [
    messageSignature,
    onUnreadVisible,
    ready,
    selectedKey,
    threadOpen,
    threadRef,
    unreadSignature,
  ]);

  useEffect(() => {
    const persist = () => saveThreadPosition();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") persist();
    };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [saveThreadPosition]);

  useEffect(() => () => {
    if (saveFrameRef.current !== null) window.cancelAnimationFrame(saveFrameRef.current);
  }, []);

  return {
    openingUnreadId,
    saveThreadPosition,
    scrollThreadToBottom,
    stickToBottomRef,
    trackThreadScroll,
  };
}
''',
)

employee = "src/app/employee/conversation-messages-dock.tsx"
replace_once(
    employee,
    'import { firstName } from "@/app/client-text";\n',
    'import { firstName } from "@/app/client-text";\nimport { useMessageThreadBehavior } from "@/app/use-message-thread-behavior";\n',
)
replace_once(
    employee,
    '  const [threadOpen, setThreadOpen] = useState(false);\n  const [search, setSearch] = useState("");',
    '  const [threadOpen, setThreadOpen] = useState(false);\n  const [wideLayout, setWideLayout] = useState(false);\n  const [search, setSearch] = useState("");',
)
replace_once(
    employee,
    '''  const reportedSeen = useRef(new Set<string>());
  const cameraPhotoRef = useRef<HTMLInputElement | null>(null);
  const libraryPhotoRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
''',
    '''  const reportedSeen = useRef(new Set<string>());
  const messageAppRef = useRef<HTMLElement | null>(null);
  const cameraPhotoRef = useRef<HTMLInputElement | null>(null);
  const libraryPhotoRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);
''',
)
regex_once(
    employee,
    r'''  const scrollThreadToBottom = useCallback\(\(\) => \{.*?\n  \}\n\n  function choosePhoto''',
    '''  function choosePhoto''',
)
replace_once(
    employee,
    '''  useEffect(() => {
    if (window.matchMedia("(min-width: 901px)").matches) setThreadOpen(true);
  }, []);
''',
    '''  useEffect(() => {
    const media = window.matchMedia("(min-width: 901px)");
    const syncLayout = () => setWideLayout(media.matches);
    syncLayout();
    media.addEventListener("change", syncLayout);
    return () => media.removeEventListener("change", syncLayout);
  }, []);
''',
)
regex_once(
    employee,
    r'''  useEffect\(\(\) => \{\n    if \(stickToBottomRef\.current\) scrollThreadToBottom\(\);\n  \}, \[selectedKey, selectedMessages\.length, scrollThreadToBottom\]\);\n\n  useEffect\(\(\) => \{\n    if \(selectedConversation && selectedConversation\.key !== selectedKey\) setSelectedKey\(selectedConversation\.key\);\n  \}, \[selectedConversation, selectedKey\]\);\n\n  useEffect\(\(\) => \{\n    if \(!session \|\| !threadOpen \|\| !selectedMessages\.length\) return;.*?\n  \}, \[selectedMessages, session, threadOpen, unreadIds\]\);\n''',
    r'''  useEffect(() => {
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
''',
)
replace_once(
    employee,
    '''  function chooseConversation(key: string) {
    stickToBottomRef.current = true;
    setSelectedKey(key);''',
    '''  function chooseConversation(key: string) {
    saveThreadPosition();
    setSelectedKey(key);''',
)
replace_once(
    employee,
    '  return <main className="messageApp employeeMessageApp">',
    '  return <main ref={messageAppRef} className="messageApp employeeMessageApp">',
)
replace_once(
    employee,
    'onClick={() => setThreadOpen(false)}>←</button>',
    'onClick={() => { saveThreadPosition(); setThreadOpen(false); }}>←</button>',
)
replace_once(
    employee,
    '              return <div key={message.id}>\n                {showDay && <div className="messageDay"><span>{dayLabel(message.created_at)}</span></div>}\n                <article',
    '              return <div key={message.id} data-message-id={message.id}>\n                {showDay && <div className="messageDay"><span>{dayLabel(message.created_at)}</span></div>}\n                {openingUnreadId === message.id && <div className="messageUnreadMarker"><span>New messages</span></div>}\n                <article',
)

owner = "src/app/ops/messages/page.tsx"
replace_once(
    owner,
    'import { firstName } from "@/app/client-text";\n',
    'import { firstName } from "@/app/client-text";\nimport { useMessageThreadBehavior } from "@/app/use-message-thread-behavior";\n',
)
replace_once(
    owner,
    '  const [threadOpen, setThreadOpen] = useState(false);\n  const [search, setSearch] = useState("");',
    '  const [threadOpen, setThreadOpen] = useState(false);\n  const [wideLayout, setWideLayout] = useState(false);\n  const [search, setSearch] = useState("");',
)
replace_once(
    owner,
    '''  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
''',
    '''  const reportedSeen = useRef(new Set<string>());
  const messageAppRef = useRef<HTMLElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);
''',
)
regex_once(
    owner,
    r'''  const scrollThreadToBottom = useCallback\(\(\) => \{.*?\n  \}\n\n  useEffect\(\(\) => \{\n    fetch\("/api/auth/session"''',
    r'''  useEffect(() => {
    const media = window.matchMedia("(min-width: 901px)");
    const syncLayout = () => setWideLayout(media.matches);
    syncLayout();
    media.addEventListener("change", syncLayout);
    return () => media.removeEventListener("change", syncLayout);
  }, []);

  useEffect(() => {
    fetch("/api/auth/session"''',
)
regex_once(
    owner,
    r'''  useEffect\(\(\) => \{\n    if \(stickToBottomRef\.current\) scrollThreadToBottom\(\);\n  \}, \[selectedKey, selectedMessages\.length, scrollThreadToBottom\]\);\n\n  useEffect\(\(\) => \{\n    if \(selectedConversation && selectedConversation\.key !== selectedKey\) setSelectedKey\(selectedConversation\.key\);\n  \}, \[selectedConversation, selectedKey\]\);\n''',
    r'''  useEffect(() => {
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
''',
)
replace_once(
    owner,
    '''  function chooseConversation(key: string) {
    stickToBottomRef.current = true;
    setSelectedKey(key);''',
    '''  function chooseConversation(key: string) {
    saveThreadPosition();
    setSelectedKey(key);''',
)
replace_once(
    owner,
    '  return <main className="messageApp">',
    '  return <main ref={messageAppRef} className="messageApp">',
)
replace_once(
    owner,
    'onClick={() => setThreadOpen(false)}>←</button>',
    'onClick={() => { saveThreadPosition(); setThreadOpen(false); }}>←</button>',
)
replace_once(
    owner,
    '              return <div key={message.id}>\n                {showDay && <div className="messageDay"><span>{dayLabel(message.created_at)}</span></div>}\n                <article',
    '              return <div key={message.id} data-message-id={message.id}>\n                {showDay && <div className="messageDay"><span>{dayLabel(message.created_at)}</span></div>}\n                {openingUnreadId === message.id && <div className="messageUnreadMarker"><span>New messages</span></div>}\n                <article',
)

message_reads = "src/lib/message-reads.ts"
replace_once(
    message_reads,
    'let readSchemaPromise: Promise<void> | null = null;\n',
    'let readSchemaPromise: Promise<void> | null = null;\nconst MESSAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;\n',
)
replace_once(
    message_reads,
    '''export async function markAdminMessagesRead(readerEmail: string, business: Business) {''',
    r'''export async function adminUnreadMessageIds(readerEmail: string, business: Business): Promise<string[]> {
  await ensureMessageReadSchema();
  const email = normalizedReaderEmail(readerEmail);
  const startedAt = await notificationStart(email);
  const rows = await getSql()`
    SELECT m.id::text AS id
    FROM employee_messages m
    WHERE m.business = ${business}
      AND m.sender_employee_id IS NOT NULL
      AND m.deleted_at IS NULL
      AND m.created_at >= ${startedAt}
      AND NOT EXISTS (
        SELECT 1
        FROM owner_message_reads r
        WHERE r.message_id = m.id AND r.reader_email = ${email}
      )
    ORDER BY m.created_at, m.id
    LIMIT 1000
  ` as unknown as Array<{ id: string }>;
  return rows.map((row) => String(row.id));
}

export async function markAdminConversationMessageSeen(
  readerEmail: string,
  business: Business,
  messageId: unknown,
) {
  await ensureMessageReadSchema();
  const email = normalizedReaderEmail(readerEmail);
  const id = String(messageId || "").trim().toLowerCase();
  if (!MESSAGE_UUID_PATTERN.test(id)) throw new Error("Message selection is invalid.");
  const startedAt = await notificationStart(email);
  const visible = await getSql()`
    SELECT id
    FROM employee_messages
    WHERE id = ${id}::uuid
      AND business = ${business}
      AND sender_employee_id IS NOT NULL
      AND deleted_at IS NULL
      AND created_at >= ${startedAt}
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!visible[0]) throw new Error("Message was not found or is not visible to management.");
  const inserted = await getSql()`
    INSERT INTO owner_message_reads (message_id, reader_email)
    VALUES (${id}::uuid, ${email})
    ON CONFLICT (message_id, reader_email) DO NOTHING
    RETURNING read_at
  ` as unknown as Array<{ read_at: string }>;
  return { seen: true, firstSeen: inserted[0]?.read_at || null };
}

export async function markAdminMessagesRead(readerEmail: string, business: Business) {''',
)

route = "src/app/api/message-conversations/route.ts"
replace_once(
    route,
    'import { markAdminMessagesRead } from "@/lib/message-reads";',
    'import { adminUnreadMessageIds, markAdminConversationMessageSeen } from "@/lib/message-reads";',
)
replace_once(
    route,
    '''    const viewAsEmployeeId = url.searchParams.get("viewAsEmployeeId") || "";
    if (!viewAsEmployeeId) await markAdminMessagesRead(session.email, business);
    return Response.json(await ownerConversationDashboard(business, viewAsEmployeeId), {
      headers: { "Cache-Control": "private, no-store" },
    });''',
    '''    const viewAsEmployeeId = url.searchParams.get("viewAsEmployeeId") || "";
    const dashboard = await ownerConversationDashboard(business, viewAsEmployeeId);
    const unreadMessageIds = viewAsEmployeeId
      ? dashboard.unreadMessageIds
      : await adminUnreadMessageIds(session.email, business);
    return Response.json({ ...dashboard, unreadMessageIds }, {
      headers: { "Cache-Control": "private, no-store" },
    });''',
)
replace_once(
    route,
    '''    requirePermission(session, "workforce.write");
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();''',
    '''    requirePermission(session, "workforce.read");
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      requirePermission(session, "workforce.write");
      const form = await request.formData();''',
)
replace_once(
    route,
    '''    const action = String(body.action || "send");
    if (action === "delete") {''',
    '''    const action = String(body.action || "send");
    if (action === "message-seen") {
      return Response.json(await markAdminConversationMessageSeen(session.email, business, body.messageId));
    }
    requirePermission(session, "workforce.write");
    if (action === "delete") {''',
)

install_prompt = "src/app/employee/install-prompt.tsx"
replace_once(
    install_prompt,
    'import { useEffect, useState } from "react";\n',
    'import { usePathname } from "next/navigation";\nimport { useEffect, useState } from "react";\n',
)
replace_once(
    install_prompt,
    '''export default function EmployeeInstallPrompt() {
  const [authenticated, setAuthenticated] = useState(false);''',
    '''export default function EmployeeInstallPrompt() {
  const pathname = usePathname();
  const [authenticated, setAuthenticated] = useState(false);''',
)
replace_once(
    install_prompt,
    '''  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const installModalRef = useModalFocus<HTMLDivElement>(visible, () => dismiss());''',
    '''  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const shouldShow = visible && pathname !== "/employee/messages";
  const installModalRef = useModalFocus<HTMLDivElement>(shouldShow, () => dismiss());''',
)
replace_once(
    install_prompt,
    '  if (!visible) return null;',
    '  if (!shouldShow) return null;',
)

css = "src/app/message-inbox.css"
replace_once(
    css,
    '.messageApp{position:relative;height:100dvh;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
    '.messageApp{position:relative;height:var(--message-viewport-height,100dvh);min-height:0;display:flex;flex-direction:column;overflow:hidden}',
)
with Path(css).open("a", encoding="utf-8") as file:
    file.write(r'''

/* Resume/read marker and mobile keyboard viewport behavior. */
.messageUnreadMarker{display:flex;align-items:center;gap:.65rem;margin:.8rem 0;color:var(--message-purple);font-size:.72rem;font-weight:900;text-transform:uppercase;letter-spacing:.06em}.messageUnreadMarker::before,.messageUnreadMarker::after{content:"";height:1px;flex:1;background:color-mix(in srgb,var(--message-purple) 42%,var(--message-line))}.messageUnreadMarker span{white-space:nowrap}.messageThread{overflow-anchor:auto}.messageComposer{z-index:5}
@media(max-width:900px){.messageApp[data-keyboard-open="true"]{position:fixed;inset-inline:0;top:var(--message-viewport-top,0px);z-index:1500;width:100%;height:var(--message-viewport-height,100dvh);min-height:0;margin:0;overscroll-behavior:none}.messageApp[data-keyboard-open="true"] .messageShell{min-height:0}.messageApp[data-keyboard-open="true"] .messageComposer{padding-bottom:max(.55rem,env(safe-area-inset-bottom))}}
@media(max-width:560px){.messageComposer textarea{font-size:16px}}
''')

test_file = "tests/message-image-and-scroll.test.ts"
replace_once(
    test_file,
    'test("message threads own the scrolling area and stay anchored at the newest message", () => {',
    'test("message threads own the scrolling area and support unread or saved resume positions", () => {',
)
replace_once(
    test_file,
    '  assert.equal(css.includes("height:100dvh"), true);',
    '  assert.equal(css.includes("height:var(--message-viewport-height,100dvh)"), true);',
)
with Path(test_file).open("a", encoding="utf-8") as file:
    file.write(r'''

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
''')
