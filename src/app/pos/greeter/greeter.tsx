"use client";

import { useEffect, useRef, useState } from "react";
import { GREETER_WELCOME_MS, greeterNext } from "@/lib/door-chime-policy";

const POLL_MS = 2_000;

export default function Greeter({ qrSvg, orderUrl }: { qrSvg: string; orderUrl: string }) {
  const [welcome, setWelcome] = useState(false);
  const [offline, setOffline] = useState(false);
  const state = useRef({ initialized: false, lastId: 0 });
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    audio.current = new Audio("/greeter/welcome.mp3");
    audio.current.preload = "auto";
    let hide: number | undefined;
    let stopped = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch("/api/pos/greeter", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const { latest } = (await response.json()) as { latest: { id: number; ageSeconds: number } | null };
        if (stopped) return;
        setOffline(false);
        if (greeterNext(state.current, latest) === null) return;
        setWelcome(true);
        if (audio.current) {
          audio.current.currentTime = 0;
          // The kiosk starts Chromium with autoplay allowed; elsewhere a blocked play is fine.
          void audio.current.play().catch(() => undefined);
        }
        window.clearTimeout(hide);
        hide = window.setTimeout(() => setWelcome(false), GREETER_WELCOME_MS);
      } catch {
        setOffline(true);
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    // Reload once a day (4 AM) so a long-running kiosk picks up new versions and frees memory.
    const reload = window.setInterval(() => {
      if (new Date().getHours() === 4 && performance.now() > 3_600_000) window.location.reload();
    }, 600_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(reload);
      window.clearTimeout(hide);
    };
  }, []);

  return (
    <main className={`greeter ${welcome ? "greeterWelcome" : ""}`}>
      <section className="greeterIdle" aria-hidden={welcome}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="greeterLogo" src="/corner-deli-logo.png" alt="Corner Deli" />
        <div className="greeterOrder">
          <div className="greeterQr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <div>
            <strong>Scan to order online</strong>
            <span>{orderUrl}</span>
          </div>
        </div>
      </section>
      <section className="greeterHello" aria-live="polite" aria-hidden={!welcome}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/corner-deli-logo.png" alt="" />
        <h1>Welcome to Corner Deli!</h1>
        <p>Someone will be right with you.</p>
      </section>
      {offline && <i className="greeterOffline" title="Can't reach the store server" />}
    </main>
  );
}
