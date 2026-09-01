"use client";

import { useCallback, useEffect, useRef } from "react";

type AlertOrder = {
  id: string;
  source: string;
  status: string;
  submitted_at: string;
};

const ONLINE_SOURCES = new Set(["web", "online", "customer_web", "kiosk", "ai_phone"]);

export function useOnlineOrderAlert(authenticated: boolean) {
  const initialized = useRef(false);
  const seen = useRef(new Set<string>());
  const audio = useRef<AudioContext | null>(null);

  const unlockAudio = useCallback(() => {
    const Context = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audio.current ||= new Context();
    if (audio.current.state === "suspended") void audio.current.resume();
  }, []);

  const ring = useCallback(() => {
    unlockAudio();
    const context = audio.current;
    if (!context || context.state !== "running") return;
    const start = context.currentTime;
    [0, 0.24, 0.48].forEach((delay, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = index === 1 ? 988 : 784;
      gain.gain.setValueAtTime(0.0001, start + delay);
      gain.gain.exponentialRampToValueAtTime(0.34, start + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + delay);
      oscillator.stop(start + delay + 0.2);
    });
  }, [unlockAudio]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [unlockAudio]);

  useEffect(() => {
    if (!authenticated) {
      initialized.current = false;
      seen.current.clear();
      return;
    }
    let stopped = false;
    async function poll() {
      try {
        const response = await fetch("/api/ordering/kitchen?business=Corner%20Deli", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { orders?: AlertOrder[] };
        const online = (payload.orders || []).filter((order) =>
          order.status === "sent_to_kitchen" && ONLINE_SOURCES.has(String(order.source || "").toLowerCase()),
        );
        if (!initialized.current) {
          online.forEach((order) => seen.current.add(order.id));
          initialized.current = true;
          return;
        }
        const fresh = online.filter((order) => !seen.current.has(order.id));
        online.forEach((order) => seen.current.add(order.id));
        if (fresh.length && !stopped) ring();
      } catch {
        // The regular status indicator reports connectivity; alerts retry silently.
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [authenticated, ring]);
}
