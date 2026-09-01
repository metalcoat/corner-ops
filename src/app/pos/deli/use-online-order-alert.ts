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
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    compressor.connect(context.destination);

    // A loud, two-burst kitchen bell. The paired tones cut through kitchen noise
    // better than the previous short sine-wave chime without clipping speakers.
    [0, 0.72].forEach((delay) => {
      [640, 880].forEach((frequency, toneIndex) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const begins = start + delay;
        const ends = begins + 0.52;
        oscillator.type = toneIndex === 0 ? "square" : "triangle";
        oscillator.frequency.setValueAtTime(frequency, begins);
        oscillator.frequency.linearRampToValueAtTime(frequency + 35, ends);
        gain.gain.setValueAtTime(0.0001, begins);
        gain.gain.exponentialRampToValueAtTime(toneIndex === 0 ? 0.48 : 0.62, begins + 0.018);
        gain.gain.setValueAtTime(toneIndex === 0 ? 0.48 : 0.62, ends - 0.08);
        gain.gain.exponentialRampToValueAtTime(0.0001, ends);
        oscillator.connect(gain).connect(compressor);
        oscillator.start(begins);
        oscillator.stop(ends + 0.01);
      });
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
