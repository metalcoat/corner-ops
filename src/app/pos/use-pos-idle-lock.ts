"use client";

import { useCallback, useEffect, useRef } from "react";

const CHANNEL_NAME = "corner-deli-pos-lock";

export function usePosIdleLock(input: {
  authenticated: boolean;
  seconds: number;
  onLock: () => void;
}) {
  const timer = useRef<number | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const onLockRef = useRef(input.onLock);
  onLockRef.current = input.onLock;

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const lock = useCallback((broadcast = true) => {
    clearTimer();
    onLockRef.current();
    if (broadcast) channel.current?.postMessage({ type: "lock" });
    void fetch("/api/pos/session", { method: "DELETE", keepalive: true }).catch(() => undefined);
  }, [clearTimer]);

  useEffect(() => {
    if (!("BroadcastChannel" in window)) return;
    const next = new BroadcastChannel(CHANNEL_NAME);
    channel.current = next;
    next.onmessage = (event) => { if (event.data?.type === "lock") lock(false); };
    return () => { next.close(); channel.current = null; };
  }, [lock]);

  useEffect(() => {
    clearTimer();
    if (!input.authenticated) return;
    const reset = (event?: Event) => {
      if (event && !event.isTrusted) return;
      clearTimer();
      timer.current = window.setTimeout(() => lock(), Math.max(1, input.seconds) * 1000);
    };
    const events: Array<keyof WindowEventMap> = ["pointerdown", "pointermove", "touchstart", "keydown", "wheel", "scroll"];
    for (const event of events) window.addEventListener(event, reset, { capture: true, passive: true });
    reset();
    return () => {
      clearTimer();
      for (const event of events) window.removeEventListener(event, reset, { capture: true });
    };
  }, [clearTimer, input.authenticated, input.seconds, lock]);

  return { lock };
}
