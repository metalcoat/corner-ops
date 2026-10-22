"use client";

import { useEffect, useRef, useState } from "react";
import { GREETER_WELCOME_MS, greeterNext } from "@/lib/door-chime-policy";
import SeasonFx from "../../menu-board/season-fx";

const POLL_MS = 2_000;
const SLIDE_MS = 15_000;
const WEATHER_MS = 20 * 60_000;
const MUSIC_VOLUME = 0.35;
const MUSIC_REFRESH_MS = 30 * 60_000;
const HOLIDAY_HELLO: Record<string, string> = { halloween: "Happy Halloween!", thanksgiving: "Happy Thanksgiving!", christmas: "Merry Christmas!" };

type Props = { qrSvg: string; orderUrl: string; season: string; ribbon: string; factCount: number };

export default function GreeterTv({ qrSvg, orderUrl, season, ribbon, factCount }: Props) {
  const [slide, setSlide] = useState(0); // 0 logo + QR, 1 weather, 2 fun fact, 3 hours
  const [fact, setFact] = useState(0);
  const [weatherStamp, setWeatherStamp] = useState(() => Math.floor(Date.now() / WEATHER_MS));
  const [welcome, setWelcome] = useState(false);
  const [offline, setOffline] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const state = useRef({ initialized: false, lastId: 0 });
  const audio = useRef<HTMLAudioElement | null>(null);
  const music = useRef<HTMLAudioElement | null>(null);

  // Scale the 1920x1080 stage to the screen.
  useEffect(() => {
    const fit = () => {
      if (!stage.current) return;
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      stage.current.style.transform = `translate(${(window.innerWidth - 1920 * scale) / 2}px, ${(window.innerHeight - 1080 * scale) / 2}px) scale(${scale})`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Slides take turns; each time round shows the next fun fact. Weather is re-fetched every 20 minutes.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSlide((s) => {
        const next = (s + 1) % 4;
        // Move to the next fact once this one is off screen, so the picture loads while hidden.
        if (next === 3) setFact((f) => (f + 1) % Math.max(1, factCount));
        return next;
      });
      setWeatherStamp(Math.floor(Date.now() / WEATHER_MS));
    }, SLIDE_MS);
    return () => window.clearInterval(timer);
  }, [factCount]);

  // Background music for the season (everyday music when the season has none), shuffled.
  useEffect(() => {
    const player = new Audio();
    player.volume = MUSIC_VOLUME;
    music.current = player;
    let tracks: string[] = [];
    let queue: string[] = [];
    const playNext = () => {
      if (!tracks.length) return;
      if (!queue.length) queue = [...tracks].sort(() => Math.random() - 0.5);
      player.src = queue.shift()!;
      void player.play().catch(() => undefined);
    };
    const load = async () => {
      try {
        const response = await fetch(`/api/pos/greeter/music?season=${season}`, { cache: "no-store" });
        const next = ((await response.json()) as { tracks: string[] }).tracks;
        const changed = next.join() !== tracks.join();
        tracks = next;
        if (changed) { queue = []; if (player.paused || !tracks.length) playNext(); }
      } catch {
        // keep whatever is playing
      }
    };
    player.addEventListener("ended", playNext);
    player.addEventListener("error", () => window.setTimeout(playNext, 2_000));
    void load();
    const timer = window.setInterval(() => void load(), MUSIC_REFRESH_MS);
    return () => { window.clearInterval(timer); player.pause(); player.removeEventListener("ended", playNext); };
  }, [season]);

  // Walk-ins: same rules as the Pi greeter (never greet one older than 20 s or the first one seen).
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
        music.current?.pause(); // the welcome is spoken over silence, then the music carries on
        if (audio.current) {
          audio.current.currentTime = 0;
          void audio.current.play().catch(() => undefined); // Fully Kiosk allows autoplay
        }
        window.clearTimeout(hide);
        hide = window.setTimeout(() => {
          setWelcome(false);
          if (music.current?.src) void music.current.play().catch(() => undefined);
        }, GREETER_WELCOME_MS);
      } catch {
        setOffline(true);
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    // Reload once a day (4 AM): new versions, the day's season, and fresh memory.
    const reload = window.setInterval(() => {
      if (new Date().getHours() === 4 && performance.now() > 3_600_000) window.location.reload();
    }, 600_000);
    return () => { stopped = true; window.clearInterval(timer); window.clearInterval(reload); window.clearTimeout(hide); };
  }, []);

  const pictures = [
    null,
    `/api/pos/greeter/weather?t=${weatherStamp}`,
    `/api/pos/greeter/fact?n=${fact}`,
    `/api/pos/greeter/hours?t=${weatherStamp}`,
  ];

  return (
    <main className="greeterTv">
      <div ref={stage} className="gtStage" data-season={season}>
        <section className={`gtSlide gtIdle${slide === 0 && !welcome ? " on" : ""}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="gtLogo" src="/corner-deli-logo.png" alt="Corner Deli" />
          <div className="gtOrder">
            <div className="gtQr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            <div><strong>Scan to order online</strong><span>{orderUrl}</span></div>
          </div>
        </section>
        {pictures.map((src, i) => src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} className={`gtSlide gtPicture${slide === i && !welcome ? " on" : ""}`} src={src} alt="" />
        ))}
        <SeasonFx season={season} />
        {ribbon && <div className="mbRibbon gtRibbon">{ribbon}</div>}
        <section className={`gtSlide gtHello${welcome ? " on" : ""}`} aria-live="polite">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/corner-deli-logo.png" alt="" />
          {HOLIDAY_HELLO[season] && <p className="gtHoliday">{HOLIDAY_HELLO[season]}</p>}
          <h1>Welcome to Corner Deli!</h1>
          <p>Someone will be right with you.</p>
        </section>
        {offline && <i className="gtOffline" title="Can't reach the store server" />}
      </div>
    </main>
  );
}
