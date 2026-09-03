"use client";

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
