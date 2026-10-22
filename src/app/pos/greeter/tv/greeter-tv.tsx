"use client";

import { useEffect, useRef, useState } from "react";
import { GREETER_WELCOME_MS, greeterNext } from "@/lib/door-chime-policy";
import type { NflGame } from "@/lib/greeter-nfl";
import SeasonFx from "../../menu-board/season-fx";

const POLL_MS = 2_000;
const SLIDE_MS = 15_000;
const WEATHER_MS = 20 * 60_000;
const MUSIC_VOLUME = 0.2;
const MUSIC_REFRESH_MS = 30 * 60_000;
const HOLIDAY_HELLO: Record<string, string> = { halloween: "Happy Halloween!", thanksgiving: "Happy Thanksgiving!", christmas: "Merry Christmas!" };

type Props = { qrSvg: string; orderUrl: string; season: string; ribbon: string; factCount: number; playlist: string | null; nflDate: string | null };
type SlideKey = "idle" | "nfl" | "weather" | "fact" | "hours";
// On NFL game days the scores come round twice per turn.
const EVERYDAY_ORDER: SlideKey[] = ["idle", "weather", "fact", "hours"];
const GAME_DAY_ORDER: SlideKey[] = ["idle", "nfl", "weather", "fact", "nfl", "hours"];
const NFL_POLL_MS = 60_000;
type Music = { pause: () => void; resume: () => void };

type YtPlayer = { pauseVideo(): void; playVideo(): void; setVolume(v: number): void; setShuffle(on: boolean): void; playVideoAt(i: number): void; getPlaylist(): string[] | null };
/** The Corner Deli display app's YouTube player (signed in to the store's account, so no ads). */
type TvBridge = { playMusic(list: string, volume: number): void; pauseMusic(): void; resumeMusic(): void };
const tvBridge = () => (typeof window === "undefined" ? undefined : (window as Window & { CornerDeliTv?: TvBridge }).CornerDeliTv);

type YtWindow = Window & { YT?: { Player: new (el: HTMLElement, opts: object) => YtPlayer }; onYouTubeIframeAPIReady?: () => void };

/** Loads the YouTube IFrame API once. */
function loadYouTube(): Promise<NonNullable<YtWindow["YT"]>> {
  const w = window as YtWindow;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  return new Promise((resolve) => {
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => { previous?.(); resolve(w.YT!); };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
  });
}

export default function GreeterTv({ qrSvg, orderUrl, season, ribbon, factCount, playlist, nflDate }: Props) {
  const [slide, setSlide] = useState(0); // position in the slide order
  const [games, setGames] = useState<NflGame[]>([]);
  const order = games.length ? GAME_DAY_ORDER : EVERYDAY_ORDER;
  const orderRef = useRef(order);
  orderRef.current = order;
  const showing: SlideKey = order[slide % order.length];
  const [fact, setFact] = useState(0);
  const [weatherStamp, setWeatherStamp] = useState(() => Math.floor(Date.now() / WEATHER_MS));
  const [welcome, setWelcome] = useState(false);
  const [offline, setOffline] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const state = useRef({ initialized: false, lastId: 0 });
  const audio = useRef<HTMLAudioElement | null>(null);
  const music = useRef<Music | null>(null);
  // In the Corner Deli display app the app plays the music, so the page shows no player.
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(Boolean(tvBridge())), []);
  const youTube = useRef<HTMLDivElement>(null);

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
        const list = orderRef.current;
        const next = (s + 1) % list.length;
        // Move to the next fact once this one is off screen, so the picture loads while hidden.
        if (list[s % list.length] === "fact") setFact((f) => (f + 1) % Math.max(1, factCount));
        return next;
      });
      setWeatherStamp(Math.floor(Date.now() / WEATHER_MS));
    }, SLIDE_MS);
    return () => window.clearInterval(timer);
  }, [factCount]);

  // Today's NFL games and live scores (empty on days without games, so the screen drops out).
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/pos/greeter/nfl${nflDate ? `?date=${encodeURIComponent(nflDate)}` : ""}`, { cache: "no-store" });
        const next = ((await response.json()) as { games: NflGame[] }).games;
        if (!stopped) setGames(next);
      } catch {
        // keep the last scores
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), NFL_POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [nflDate]);

  // Background music from the season's YouTube playlist (shuffled, looping). YouTube requires
  // its player to stay visible, so it sits in the "Now playing" card.
  useEffect(() => {
    const app = tvBridge();
    if (playlist && app) {
      app.playMusic(playlist, MUSIC_VOLUME);
      music.current = { pause: () => app.pauseMusic(), resume: () => app.resumeMusic() };
      return () => { app.pauseMusic(); music.current = null; };
    }
    if (!playlist || !youTube.current) return;
    let player: YtPlayer | null = null;
    let stopped = false;
    void loadYouTube().then((YT) => {
      if (stopped || !youTube.current) return;
      player = new YT.Player(youTube.current, {
        width: 356, height: 200,
        playerVars: { listType: "playlist", list: playlist, autoplay: 1, loop: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, origin: window.location.origin },
        events: {
          onReady: () => {
            player?.setVolume(MUSIC_VOLUME * 100);
            player?.setShuffle(true);
            player?.playVideoAt(Math.floor(Math.random() * Math.max(1, player?.getPlaylist()?.length ?? 1)));
          },
          onError: () => window.setTimeout(() => player?.playVideo(), 3_000),
        },
      });
      music.current = { pause: () => player?.pauseVideo(), resume: () => player?.playVideo() };
    });
    return () => { stopped = true; music.current = null; };
  }, [playlist]);

  // Without a playlist: music files for the season (everyday music when the season has none), shuffled.
  useEffect(() => {
    if (playlist) return;
    const player = new Audio();
    player.volume = MUSIC_VOLUME;
    music.current = { pause: () => player.pause(), resume: () => { if (player.src) void player.play().catch(() => undefined); } };
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
  }, [season, playlist]);

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
          music.current?.resume();
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

  const pictures: [SlideKey, string][] = [
    ["weather", `/api/pos/greeter/weather?season=${season}&t=${weatherStamp}`],
    ["fact", `/api/pos/greeter/fact?season=${season}&n=${fact}`],
    ["hours", `/api/pos/greeter/hours?season=${season}&t=${weatherStamp}`],
  ];

  return (
    <main className="greeterTv">
      <div ref={stage} className="gtStage" data-season={season}>
        <section className={`gtSlide gtIdle${showing === "idle" && !welcome ? " on" : ""}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="gtLogo" src="/corner-deli-logo.png" alt="Corner Deli" />
          <div className="gtOrder">
            <div className="gtQr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            <div><strong>Scan to order online</strong><span>{orderUrl}</span></div>
          </div>
        </section>
        {pictures.map(([key, src]) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={key} className={`gtSlide gtPicture${showing === key && !welcome ? " on" : ""}`} src={src} alt="" />
        ))}
        <WeatherArt on={showing === "weather" && !welcome} stamp={weatherStamp} />
        {games.length > 0 && <NflSlide games={games} on={showing === "nfl" && !welcome} />}
        <SeasonFx season={season} />
        {ribbon && <div className="mbRibbon gtRibbon">{ribbon}</div>}
        <section className={`gtSlide gtHello${welcome ? " on" : ""}`} aria-live="polite">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/corner-deli-logo.png" alt="" />
          {HOLIDAY_HELLO[season] && <p className="gtHoliday">{HOLIDAY_HELLO[season]}</p>}
          <h1>Welcome to Corner Deli!</h1>
          <p>Someone will be right with you.</p>
        </section>
        {playlist && !inApp && (
          <div className="gtNowPlaying">
            <span>Now playing</span>
            <div className="gtYt"><div ref={youTube} /></div>
          </div>
        )}
        {offline && <i className="gtOffline" title="Can't reach the store server" />}
      </div>
    </main>
  );
}

const kickoff = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

/** Today's NFL games: kickoff times and channels before, live scores during, finals after. */
function NflSlide({ games, on }: { games: NflGame[]; on: boolean }) {
  const sunday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(new Date(games[0].start));
  const live = games.some((g) => g.state === "in");
  return (
    <section className={`gtSlide gtNfl${on ? " on" : ""}`}>
      <header>
        <h2>{sunday === "Sunday" ? "NFL Sunday" : `${sunday} Night Football`}</h2>
        <span>{live ? "Live scores" : games.every((g) => g.state === "post") ? "Final scores" : "Today's games"}</span>
      </header>
      <div className={`gtGames${games.length > 8 ? " many" : games.length <= 2 ? " few" : ""}`}>
        {games.map((g) => (
          <div key={g.id} className={`gtGame ${g.state}${g.favorite ? " fav" : ""}`}>
            {[g.away, g.home].map((t) => (
              <div key={t.abbr} className={`gtTeam${g.state === "post" && t.winner ? " won" : ""}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {t.logo ? <img src={t.logo} alt="" /> : <i />}
                <b>{t.name}</b>
                {t.record && g.state === "pre" ? <small>{t.record}</small> : null}
                <em>{g.state === "pre" ? "" : t.score}</em>
              </div>
            ))}
            <div className="gtStatus">
              {g.state === "pre" ? `${kickoff.format(new Date(g.start))}${g.network ? ` · ${g.network}` : ""}` : g.detail}
              {g.state === "in" && <i className="gtLive">LIVE</i>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

type WeatherInfo = { sky: { kind: string; rect: number[] } | null; cards: { kind: string; rect: number[] }[] };

/** The moving weather on top of the weather picture (the Pi drew it itself): sun, moon, clouds, rain, snow, storm, fog. */
function WeatherArt({ on, stamp }: { on: boolean; stamp: number }) {
  const [info, setInfo] = useState<WeatherInfo | null>(null);
  useEffect(() => {
    let stopped = false;
    void fetch("/api/pos/greeter/weather/info", { cache: "no-store" })
      .then((r) => r.json() as Promise<WeatherInfo>)
      .then((next) => { if (!stopped) setInfo(next); })
      .catch(() => undefined);
    return () => { stopped = true; };
  }, [stamp]);
  if (!info) return null;
  const spots = [...(info.sky ? [{ ...info.sky, big: true }] : []), ...info.cards.map((c) => ({ ...c, big: false }))];
  return (
    <div className={`gtSlide gtWeatherArt${on ? " on" : ""}`} aria-hidden>
      {spots.map((spot, i) => {
        const [x, y, w, h] = spot.rect;
        return (
          <div key={i} className={`wx ${spot.kind}${spot.big ? " big" : ""}`} style={{ left: x, top: y, width: w, height: h }}>
            {(spot.kind === "clear" || spot.kind === "partly_cloudy") && <i className="sun" />}
            {spot.kind === "clear_night" && <><i className="moon" /><i className="star s1" /><i className="star s2" /><i className="star s3" /></>}
            {["partly_cloudy", "cloudy", "rain", "snow", "storm"].includes(spot.kind) && <><i className="cloud c1" />{spot.kind !== "partly_cloudy" && <i className="cloud c2" />}</>}
            {spot.kind === "rain" && [0, 1, 2, 3, 4, 5].map((d) => <i key={d} className={`drop d${d}`} />)}
            {spot.kind === "snow" && [0, 1, 2, 3, 4, 5].map((d) => <i key={d} className={`flake d${d}`} />)}
            {spot.kind === "storm" && <i className="bolt" />}
            {spot.kind === "fog" && [0, 1, 2].map((d) => <i key={d} className={`fogband f${d}`} />)}
          </div>
        );
      })}
    </div>
  );
}
