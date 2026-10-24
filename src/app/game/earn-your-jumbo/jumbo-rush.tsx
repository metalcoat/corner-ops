"use client";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MenuAdTicker } from "@/app/games/components/menu-ad-ticker";
import { DeliManAudio } from "@/lib/games/deli-man/audio";
import { randomComplaint } from "@/lib/games/complaints";
import { MIN_DELIVERED, MAX_STRIKES, PizzaRush, SHIFT_SECONDS, type Stats } from "@/lib/games/pizza-rush/engine";
import { renderRush, type Trail } from "@/lib/games/pizza-rush/render";

type Run = { runId: string; token: string };
type Reward = { code?: string; prize_type?: string; expires_at?: string; error?: string };
type Leader = { player_name: string; score: number | string; pizzas_made: number; perfects: number; status: string };
type Mode = "home" | "play" | "paused" | "won" | "lost";

const NAME_KEY = "jumbo-rush-name";
const MUTE_KEY = "jumbo-rush-muted";
const LOSSES = [
  "THE CUSTOMERS HAVE WON.",
  "YOU HAVE BEEN MOVED TO DISHES.",
  "YOUR APRON HAS BEEN CONFISCATED.",
  "MANAGEMENT WOULD LIKE A WORD.",
  "PLEASE CLOCK OUT.",
];

declare global {
  interface Window {
    __jumboRush?: PizzaRush;
  }
}

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/pizza-gauntlet/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data.error || "Game service unavailable."));
  return data;
}

export default function JumboRush() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<PizzaRush | null>(null);
  const audioRef = useRef<DeliManAudio | null>(null);
  const runRef = useRef<Run | null>(null);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const seqRef = useRef(0);
  const validRef = useRef(true);
  const trailRef = useRef<Trail>([]);
  const pointerRef = useRef<number | null>(null);
  const [mode, setMode] = useState<Mode>("home");
  const [name, setName] = useState("");
  const [muted, setMuted] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Stats | null>(null);
  const [reward, setReward] = useState<Reward | null>(null);
  const [practice, setPractice] = useState(false);
  const [lossLine, setLossLine] = useState(LOSSES[0]);
  const [complaint, setComplaint] = useState("");
  const [leaders, setLeaders] = useState<Leader[] | null>(null);
  const [showLeaders, setShowLeaders] = useState(false);

  // Game loop, sizing and sound.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const game = new PizzaRush();
    const audio = new DeliManAudio();
    gameRef.current = game;
    audioRef.current = audio;
    if (process.env.NODE_ENV !== "production") window.__jumboRush = game;
    try {
      setName(localStorage.getItem(NAME_KEY) || "");
      const m = localStorage.getItem(MUTE_KEY) === "1";
      setMuted(m);
      audio.setMuted(m);
    } catch {
      /* ignore */
    }
    game.onSound = (sound) => {
      const map = { slice: "hit", jumbo: "bigShot", hazard: "explode", drop: "hurt", combo: "oneUp", espresso: "pickup", phase: "ready", whoosh: "move" } as const;
      audio.sfx(map[sound]);
    };
    let dpr = 1;
    const fit = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      game.resize(rect.width, rect.height);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      game.update((now - last) / 1000);
      last = now;
      trailRef.current = trailRef.current.filter((p) => now - p.t < 160);
      renderRush(ctx, game, trailRef.current, now, dpr);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      audio.dispose();
      if (window.__jumboRush === game) delete window.__jumboRush;
    };
  }, []);

  useEffect(() => {
    audioRef.current?.setMuted(muted);
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [muted]);

  // Losing focus pauses the shift (shift time stops; the server only counts shift time).
  useEffect(() => {
    const pause = () => {
      if (gameRef.current?.state === "play" && mode === "play") {
        gameRef.current.state = "ready";
        setMode("paused");
        audioRef.current?.stopMusic();
      }
    };
    const onVisibility = () => document.hidden && pause();
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mode]);

  const send = useCallback((body: Record<string, unknown>) => {
    const next = chainRef.current.then(() => post(body)).catch((error) => {
      validRef.current = false;
      throw error;
    });
    chainRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const begin = useCallback(async () => {
    const game = gameRef.current!;
    const audio = audioRef.current!;
    audio.unlock();
    setMessage("");
    setReward(null);
    setResult(null);
    const player = name.trim().slice(0, 40);
    try {
      localStorage.setItem(NAME_KEY, player);
    } catch {
      /* ignore */
    }
    runRef.current = null;
    seqRef.current = 0;
    validRef.current = true;
    chainRef.current = Promise.resolve();
    let isPractice = false;
    try {
      runRef.current = (await post({ action: "start", playerName: player || "Anonymous Cook" })) as Run;
    } catch {
      isPractice = true;
    }
    setPractice(isPractice);

    game.onCheckpoint = (stats) => {
      const run = runRef.current;
      if (!run || game.state === "lost") return;
      seqRef.current++;
      void send({ action: "arcade_checkpoint", runId: run.runId, token: run.token, sequence: seqRef.current, ...stats }).catch(() => undefined);
    };
    game.onEnd = (won, stats) => {
      setResult(stats);
      setComplaint(randomComplaint());
      audio.stopMusic();
      const run = runRef.current;
      if (!won) {
        setLossLine(LOSSES[Math.floor(Math.random() * LOSSES.length)]);
        setMode("lost");
        audio.sfx("death");
        if (run) void send({ action: "arcade_loss", runId: run.runId, token: run.token, ...stats }).catch(() => undefined);
        return;
      }
      setMode("won");
      audio.play("victory");
      if (!run) return;
      if (stats.delivered < MIN_DELIVERED) {
        setReward({ error: `SLICE AT LEAST ${MIN_DELIVERED} PIZZAS TO EARN THE JUMBO.` });
        return;
      }
      send({ action: "arcade_complete", runId: run.runId, token: run.token, score: stats.score, delivered: stats.delivered, perfects: stats.perfects, ruined: stats.ruined })
        .then((data) => setReward(data as Reward))
        .catch((error: Error) => setReward({ error: validRef.current ? error.message : "THE SHIFT COULDN'T BE VALIDATED (CONNECTION DROPPED)." }));
    };
    game.start();
    trailRef.current = [];
    audio.play("stage4");
    setMode("play");
  }, [name, send]);

  const resume = () => {
    const game = gameRef.current!;
    audioRef.current?.unlock();
    game.state = "play";
    audioRef.current?.play("stage4");
    setMode("play");
  };

  const openLeaders = async () => {
    setShowLeaders(true);
    setLeaders(null);
    try {
      const data = (await (await fetch("/api/pizza-gauntlet/leaderboard", { cache: "no-store" })).json()) as { leaders?: Leader[] };
      setLeaders(data.leaders || []);
    } catch {
      setLeaders([]);
    }
  };

  // Swipes.
  const toLocal = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (mode !== "play") return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    pointerRef.current = event.pointerId;
    const p = toLocal(event);
    gameRef.current?.beginStroke(p.x, p.y);
    trailRef.current = [{ ...p, t: performance.now() }];
  };
  const onMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    const game = gameRef.current!;
    const now = performance.now();
    // Use every coalesced point so fast swipes don't skip over a pizza.
    const native = event.nativeEvent as PointerEvent;
    const points = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const rect = event.currentTarget.getBoundingClientRect();
    for (const e of points.length ? points : [native]) {
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      game.swipeTo(p.x, p.y);
      trailRef.current.push({ ...p, t: now });
    }
  };
  const onUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    gameRef.current?.endStroke();
  };

  return (
    <main className="jumbo-rush">
      <canvas
        ref={canvasRef}
        className="jr-canvas"
        aria-label="Jumbo Rush play area. Swipe to slice pizzas."
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(event) => event.preventDefault()}
      />
      {mode === "play" && (
        <button type="button" className="jr-mute" onClick={() => setMuted((v) => !v)} aria-pressed={muted}>
          {muted ? "🔇" : "🔊"}
        </button>
      )}

      {mode === "home" && (
        <section className="jr-card">
          <small className="jr-kicker">CORNER DELI ARCADE · EARN YOUR JUMBO</small>
          <h1>
            JUMBO <i>RUSH</i>
          </h1>
          <p className="jr-lede">The oven&apos;s out of control. Swipe to slice every pizza before it hits the floor.</p>
          <ul className="jr-rules">
            <li>🍕 Swipe through pizzas. Hit 3+ in one swipe for a combo.</li>
            <li>📞 Don&apos;t slice the ringing phone, the 1-star review or the expired coupon.</li>
            <li>📦 Drop a pizza or slice a hazard: strike. {MAX_STRIKES} strikes and you&apos;re out.</li>
            <li>⭐ Golden JUMBO takes 4 slices. ☕ Espresso slows time.</li>
            <li>🏆 Last the whole {Math.round(SHIFT_SECONDS / 60)}-minute rush and slice {MIN_DELIVERED}+ pizzas: free Jumbo Cheese Pizza.</li>
          </ul>
          <MenuAdTicker />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="YOUR NAME" maxLength={40} aria-label="Your name" />
          <button type="button" className="jr-go" onClick={() => void begin()}>
            CLOCK IN
          </button>
          <div className="jr-row">
            <button type="button" onClick={() => void openLeaders()}>
              LEADERBOARD
            </button>
            <a href="/games">← ALL GAMES</a>
          </div>
          {message && <strong className="jr-error">{message}</strong>}
        </section>
      )}

      {mode === "paused" && (
        <section className="jr-card jr-small">
          <h2>ON BREAK</h2>
          <p>The pizzas are waiting. So is the customer. So is the phone.</p>
          <button type="button" className="jr-go" onClick={resume}>
            BACK TO WORK
          </button>
        </section>
      )}

      {(mode === "won" || mode === "lost") && result && (
        <section className={`jr-card ${mode === "won" ? "jr-won" : ""}`}>
          <small className="jr-kicker">{mode === "won" ? "SHIFT COMPLETE" : "SHIFT TERMINATED"}</small>
          <h1>{mode === "won" ? "YOU SURVIVED THE RUSH" : lossLine}</h1>
          <p className="jr-stats">
            {result.score.toLocaleString()} PTS · {result.delivered} PIZZAS · {result.perfects} COMBOS · {result.ruined} STRIKES
          </p>
          <p className="jr-complaint">STILL, A CUSTOMER CALLED: {complaint}</p>
          {mode === "won" &&
            (practice ? (
              <strong className="jr-error">PRACTICE SHIFT: THE PRIZE SERVER WAS UNREACHABLE.</strong>
            ) : reward?.code ? (
              <div className="jr-prize">
                <b>YOU EARNED A FREE JUMBO CHEESE PIZZA</b>
                <code>{reward.code}</code>
                <small>
                  Show this code at the counter.
                  {reward.expires_at ? ` Expires ${new Date(reward.expires_at).toLocaleDateString()}.` : ""} Extra toppings regular price.
                </small>
              </div>
            ) : (
              <small className="jr-validating">{reward?.error || "VALIDATING YOUR SHIFT…"}</small>
            ))}
          <button type="button" className="jr-go" onClick={() => void begin()}>
            {mode === "won" ? "ONE MORE SHIFT" : "CLOCK BACK IN"}
          </button>
          <div className="jr-row">
            <button type="button" onClick={() => void openLeaders()}>
              LEADERBOARD
            </button>
            <a href="/games">← ALL GAMES</a>
          </div>
        </section>
      )}

      {showLeaders && (
        <section className="jr-modal" onClick={() => setShowLeaders(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <button type="button" className="jr-close" onClick={() => setShowLeaders(false)} aria-label="Close">
              ×
            </button>
            <small className="jr-kicker">CORNER DELI HIGH SCORES</small>
            <h2>PIZZA LEGENDS</h2>
            {leaders === null ? (
              <p>LOADING…</p>
            ) : leaders.length === 0 ? (
              <p>NO LEGENDS YET.</p>
            ) : (
              <ol>
                {leaders.slice(0, 15).map((l, i) => (
                  <li key={`${l.player_name}-${i}`}>
                    <b>{i + 1}</b>
                    <strong>
                      {l.player_name}
                      {l.status === "won" ? " 🍕" : ""}
                    </strong>
                    <span>
                      {Number(l.score).toLocaleString()}
                      <small>{l.pizzas_made} PIZZAS</small>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
