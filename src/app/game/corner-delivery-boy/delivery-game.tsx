"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  DELIVERY_CAR_CRASHES,
  DELIVERY_COMPLAINTS,
  DELIVERY_FAILURES,
  DELIVERY_PRIZE,
  DELIVERY_STAGES,
} from "@/lib/delivery-boy/config";
type Thing = {
  id: number;
  type:
    "deer" | "dog" | "squirrel" | "cow" | "car" | "pothole" | "boost" | "slow";
  lane: number;
  y: number;
};
type Target = {
  y: number;
  side: "left" | "right";
  active: boolean;
  address: string;
  neighbor: string;
};
type Scenery = {
  id: number;
  kind: "abandoned" | "tent" | "cart" | "trash" | "house";
  side: "left" | "right";
  y: number;
};
type Run = { runId: string; token: string };
type Stats = {
  score: number;
  delivered: number;
  missed: number;
  hits: number;
  combo: number;
  bestCombo: number;
};
const fresh: Stats = {
  score: 0,
  delivered: 0,
  missed: 0,
  hits: 0,
  combo: 0,
  bestCombo: 0,
};
const icons: Record<Thing["type"], string> = {
  deer: "🦌",
  dog: "🐕",
  squirrel: "🐿️",
  cow: "🐄",
  car: "🚗",
  pothole: "◉",
  boost: "⚡",
  slow: "❄️",
};
const quips = [
  "SUB SECURED",
  "PORCH PERFECT",
  "YEET DELIVERY",
  "BREAD HAS LANDED",
  "DINNER DEPLOYED",
  "ABSOLUTELY DELIVERED",
];
const addresses = [
  "412 JAY ST",
  "830 PROCTOR AVE",
  "1515 KNOX ST",
  "96 STATE ST",
  "217 FORD ST",
  "609 PATTERSON ST",
  "1401 GREEN ST",
  "28 RIVERSIDE DR",
];
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
export default function DeliveryGame() {
  const emptyTarget: Target = {
    y: -20,
    side: "left",
    active: false,
    address: "",
    neighbor: "",
  };
  const [mode, setMode] = useState<
      "home" | "play" | "between" | "won" | "lost"
    >("home"),
    [name, setName] = useState(""),
    [stage, setStage] = useState(1),
    [zone, setZone] = useState<"city" | "rural">("city"),
    [lane, setLane] = useState(1),
    [things, setThings] = useState<Thing[]>([]),
    [scenery, setScenery] = useState<Scenery[]>([]),
    [thrown, setThrown] = useState<{
      id: number;
      side: "left" | "right";
      start: number;
    } | null>(null),
    [target, setTarget] = useState<Target>(emptyTarget),
    [routeDelivered, setRouteDelivered] = useState(0),
    [time, setTime] = useState(70),
    [health, setHealth] = useState(3),
    [stats, setStats] = useState(fresh),
    [toast, setToast] = useState(""),
    [complaint, setComplaint] = useState(""),
    [failure, setFailure] = useState(""),
    [run, setRun] = useState<Run | null>(null),
    [sequence, setSequence] = useState(0),
    [reward, setReward] = useState<any>(null),
    [muted, setMuted] = useState(false),
    [boost, setBoost] = useState(0),
    [slow, setSlow] = useState(0);
  const keys = useRef(new Set<string>()),
    last = useRef(0),
    spawn = useRef(0),
    deliveryGap = useRef(0),
    playerLane = useRef(1),
    state = useRef<{
      mode: string;
      time: number;
      health: number;
      stage: number;
      target: Target;
    }>({ mode: "home", time: 70, health: 3, stage: 1, target: emptyTarget }),
    audio = useRef<{
      ctx: AudioContext;
      gain: GainNode;
      timer: number;
      step: number;
    } | null>(null),
    touch = useRef({ x: 0, y: 0, moved: false });
  const cfg = DELIVERY_STAGES[stage - 1];
  useEffect(() => {
    state.current = { mode, time, health, stage, target };
  }, [mode, time, health, stage, target]);
  useEffect(() => {
    playerLane.current = lane;
  }, [lane]);
  const beep = useCallback(
    (kind: "throw" | "hit" | "coin" | "start") => {
      if (muted) return;
      const A = window.AudioContext || window.webkitAudioContext;
      if (!A) return;
      const c = new A(),
        o = c.createOscillator(),
        g = c.createGain();
      o.type = kind === "hit" ? "sawtooth" : "square";
      o.frequency.setValueAtTime(
        kind === "coin"
          ? 900
          : kind === "throw"
            ? 440
            : kind === "start"
              ? 330
              : 100,
        c.currentTime,
      );
      o.frequency.exponentialRampToValueAtTime(
        kind === "hit" ? 45 : kind === "coin" ? 1500 : 660,
        c.currentTime + 0.14,
      );
      g.gain.setValueAtTime(0.06, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.18);
      o.connect(g);
      g.connect(c.destination);
      o.start();
      o.stop(c.currentTime + 0.2);
    },
    [muted],
  );
  function soundtrack() {
    if (audio.current) return;
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return;
    const ctx = new A(),
      gain = ctx.createGain();
    gain.gain.value = muted ? 0 : 0.05;
    gain.connect(ctx.destination);
    const lead = [
        329.6, 392, 493.9, 659.3, 587.3, 493.9, 392, 440, 523.3, 659.3, 784,
        659.3, 523.3, 440, 392, 293.7,
      ],
      bass = [82.4, 82.4, 98, 110, 65.4, 65.4, 73.4, 98],
      chords = [
        [164.8, 196, 246.9],
        [196, 246.9, 293.7],
        [130.8, 164.8, 196],
        [146.8, 196, 246.9],
      ],
      s = { ctx, gain, timer: 0, step: 0 };
    const play = (
      f: number,
      type: OscillatorType,
      vol: number,
      len: number,
      when = 0,
    ) => {
      const o = ctx.createOscillator(),
        g = ctx.createGain(),
        at = ctx.currentTime + when;
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(vol, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + len);
      o.connect(g);
      g.connect(gain);
      o.start(at);
      o.stop(at + len);
    };
    s.timer = window.setInterval(() => {
      const beat = s.step % 16,
        bar = Math.floor(s.step / 16) % 4,
        night = state.current.stage >= 4,
        urgent = Math.max(0, (18 - state.current.time) / 18);
      play(
        lead[beat] * (night ? 0.75 : 1),
        beat % 4 ? "triangle" : "square",
        0.22,
        0.16,
      );
      if (beat % 2 === 0)
        play(
          bass[Math.floor(beat / 2)] * (night ? 0.75 : 1),
          "square",
          0.25,
          0.22,
        );
      if (beat % 4 === 0)
        chords[bar].forEach((n, i) =>
          play(n * (night ? 0.75 : 1), "triangle", 0.07, 0.48, i * 0.008),
        );
      play(
        beat % 4 === 0 ? 62 : beat % 4 === 2 ? 145 : 220,
        "square",
        beat % 2 ? 0.035 : 0.16,
        0.055,
      );
      if (urgent > 0.55) play(lead[beat] * 2, "sine", 0.06, 0.06, 0.065);
      s.step++;
    }, 128);
    audio.current = s;
  }
  useEffect(() => {
    if (audio.current)
      audio.current.gain.gain.setTargetAtTime(
        muted ? 0 : 0.045,
        audio.current.ctx.currentTime,
        0.05,
      );
  }, [muted]);
  useEffect(
    () => () => {
      if (audio.current) {
        clearInterval(audio.current.timer);
        void audio.current.ctx.close();
      }
    },
    [],
  );
  function pop(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 850);
  }
  const move = useCallback(
    (d: number) => setLane((v) => Math.max(-0.18, Math.min(2.18, v + d))),
    [],
  );
  const deliver = useCallback(() => {
    const t = state.current.target;
    if (state.current.mode !== "play" || !t.active) return;
    setThrown({ id: Date.now(), side: t.side, start: playerLane.current });
    window.setTimeout(() => setThrown(null), 650);
    const timed = t.y >= 60 && t.y <= 88,
      correctSide =
        t.side === "left"
          ? playerLane.current < 0.72
          : playerLane.current > 1.28;
    if (timed && correctSide) {
      const perfect = t.y >= 70 && t.y <= 80;
      setTarget((x) => ({ ...x, active: false }));
      setRouteDelivered((n) => n + 1);
      setStats((s) => {
        const combo = s.combo + 1,
          score =
            s.score + (perfect ? 1000 : 600) * Math.min(5, 1 + combo * 0.1);
        return {
          ...s,
          delivered: s.delivered + 1,
          combo,
          bestCombo: Math.max(s.bestCombo, combo),
          score: Math.round(score),
        };
      });
      pop(
        perfect
          ? quips[Math.floor(Math.random() * quips.length)]
          : "RIGHT HOUSE. QUESTIONABLE THROW.",
      );
      beep("throw");
    } else {
      setStats((s) => ({ ...s, score: Math.max(0, s.score - 200), combo: 0 }));
      pop(
        !correctSide
          ? `WRONG HOUSE! THAT WAS ${t.neighbor}`
          : t.y < 60
            ? "TOO EARLY! SUB IN SHRUB"
            : "MISSED THE ADDRESS!",
      );
      beep("hit");
    }
  }, [beep]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keys.current.add(e.key);
      if ([" ", "Enter"].includes(e.key)) {
        e.preventDefault();
        deliver();
      }
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [deliver]);
  useEffect(() => {
    if (mode !== "play") return;
    let raf = 0;
    last.current = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.04, (now - last.current) / 1000);
      last.current = now;
      spawn.current += dt;
      deliveryGap.current += dt;
      const left =
          keys.current.has("ArrowLeft") ||
          keys.current.has("a") ||
          keys.current.has("A"),
        right =
          keys.current.has("ArrowRight") ||
          keys.current.has("d") ||
          keys.current.has("D");
      if (left !== right)
        setLane((v) =>
          Math.max(-0.18, Math.min(2.18, v + (right ? 1 : -1) * dt * 1.7)),
        );
      const speed = Math.max(
        0.65,
        (DELIVERY_STAGES[state.current.stage - 1].speed +
          (boost > 0 ? 65 : 0) -
          (slow > 0 ? 120 : 0)) /
          100,
      );
      if (spawn.current > Math.max(0.36, 1.05 - state.current.stage * 0.09)) {
        spawn.current = 0;
        const types: Thing["type"][] = [
            "deer",
            "dog",
            "squirrel",
            "car",
            "pothole",
            "boost",
            "slow",
          ],
          roll = Math.random(),
          type =
            roll < 0.08
              ? "slow"
              : roll < 0.17
                ? "boost"
                : types[Math.floor(Math.random() * 5)];
        setThings((a) => [
          ...a,
          {
            id: Date.now() + Math.random(),
            type,
            lane: Math.random() * 2,
            y: -12,
          },
        ]);
      }
      if (
        deliveryGap.current > Math.max(2.8, 4.4 - state.current.stage * 0.25) &&
        !state.current.target.active
      ) {
        deliveryGap.current = 0;
        const address = addresses[Math.floor(Math.random() * addresses.length)],
          neighbor = addresses.filter((x) => x !== address)[
            Math.floor(Math.random() * (addresses.length - 1))
          ];
        setTarget({
          y: -14,
          side: Math.random() > 0.5 ? "right" : "left",
          active: true,
          address,
          neighbor,
        });
      }
      setThings((a) => {
        const next: Thing[] = [];
        for (const x of a) {
          const n = { ...x, y: x.y + dt * speed * 36 },
            collisionRadius =
              n.type === "car" || n.type === "cow"
                ? 0.4
                : n.type === "deer"
                  ? 0.32
                  : n.type === "dog"
                    ? 0.22
                    : n.type === "squirrel"
                      ? 0.12
                      : 0.26;
          if (
            n.y > 78 &&
            n.y < 91 &&
            Math.abs(n.lane - playerLane.current) < collisionRadius
          ) {
            if (n.type === "boost" || n.type === "slow") {
              if (n.type === "boost") {
                setBoost(4);
                pop("TURBO PICKLE! +350");
              } else {
                setSlow(6);
                pop("FROZEN SUB TIME! TRAFFIC SLOWED");
              }
              setStats((s) => ({ ...s, score: s.score + 350 }));
              beep("coin");
              continue;
            }
            if (n.type === "car" || n.type === "cow") {
              setFailure(
                n.type === "car"
                  ? DELIVERY_CAR_CRASHES[
                      Math.floor(Math.random() * DELIVERY_CAR_CRASHES.length)
                    ]
                  : "You hit a cow outside Lisbon. The cow walked away. Your Equinox, employment, and relationship with agriculture did not.",
              );
              setStats((s) => ({ ...s, hits: s.hits + 1, combo: 0 }));
              setMode("lost");
              beep("hit");
              continue;
            }
            if (n.type === "squirrel") {
              setStats((s) => ({
                ...s,
                score: Math.max(0, s.score - 100),
                hits: s.hits + 1,
                combo: 0,
              }));
              pop("SQUIRREL TAP! -100. IT HAS RETAINED COUNSEL.");
              beep("hit");
              continue;
            }
            setHealth((h) => Math.max(0, h - (n.type === "deer" ? 2 : 1)));
            setStats((s) => ({ ...s, hits: s.hits + 1, combo: 0 }));
            pop(
              n.type === "deer"
                ? "YOU HIT A DEER. THE DEER IS ANGRY."
                : `${n.type.toUpperCase()} INCIDENT!`,
            );
            beep("hit");
            continue;
          }
          if (n.y < 112) next.push(n);
        }
        return next;
      });
      setTarget((t) => {
        if (!t.active) return t;
        const y = t.y + dt * speed * 28;
        if (y > 108) {
          setStats((s) => ({ ...s, missed: s.missed + 1, combo: 0 }));
          pop(`MISSED ${t.address}. CUSTOMER ALREADY CALLED.`);
          return { ...t, y, active: false };
        }
        return { ...t, y };
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode, boost, slow, beep]);
  useEffect(() => {
    if (mode !== "play") return;
    const id = setInterval(() => {
      setTime((t) => Math.max(0, t - 1));
      setBoost((b) => Math.max(0, b - 1));
      setSlow((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [mode]);
  useEffect(() => {
    if (mode !== "play") return;
    const cityKinds: Scenery["kind"][] = [
        "house",
        "house",
        "house",
        "abandoned",
        "tent",
        "cart",
        "trash",
      ],
      ruralKinds: Scenery["kind"][] = ["house", "house", "trash"];
    const moveId = window.setInterval(
        () =>
          setScenery((items) => {
            const next: Scenery[] = [];
            for (const x of items) {
              const n = { ...x, y: x.y + 1.25 + stage * 0.12 },
                onLeftCurb = playerLane.current < 0.18 && n.side === "left",
                onRightCurb = playerLane.current > 1.82 && n.side === "right";
              if (
                n.y > 75 &&
                n.y < 94 &&
                (onLeftCurb || onRightCurb) &&
                (n.kind === "abandoned" || n.kind === "tent")
              ) {
                setFailure(
                  n.kind === "abandoned"
                    ? DELIVERY_CAR_CRASHES[
                        Math.floor(Math.random() * DELIVERY_CAR_CRASHES.length)
                      ]
                    : "You drove into an occupied tent. Ogdensburg located the incident paperwork faster than it has located a solution to literally anything else.",
                );
                setStats((s) => ({ ...s, hits: s.hits + 1, combo: 0 }));
                setMode("lost");
                beep("hit");
                continue;
              }
              if (n.y < 112) next.push(n);
            }
            return next;
          }),
        50,
      ),
      spawnId = window.setInterval(
        () => {
          const kinds = zone === "rural" ? ruralKinds : cityKinds,
            kind = kinds[Math.floor(Math.random() * kinds.length)];
          setScenery((items) => [
            ...items.slice(-14),
            {
              id: Date.now() + Math.random(),
              kind,
              side: Math.random() > 0.5 ? "right" : "left",
              y: -12,
            },
          ]);
        },
        zone === "rural" ? 2600 : 900,
      );
    return () => {
      clearInterval(moveId);
      clearInterval(spawnId);
    };
  }, [mode, stage, zone, beep]);
  useEffect(() => {
    if (mode !== "play") return;
    setZone(stage >= 3 ? "rural" : "city");
    const id = window.setInterval(
      () => setZone((z) => (z === "city" ? "rural" : "city")),
      Math.max(9000, 15000 - stage * 900),
    );
    return () => clearInterval(id);
  }, [mode, stage]);
  useEffect(() => {
    if (mode !== "play" || zone !== "rural") return;
    const id = window.setInterval(
      () =>
        setThings((items) => [
          ...items,
          {
            id: Date.now() + Math.random(),
            type: "cow",
            lane: Math.random() * 2,
            y: -12,
          },
        ]),
      3600,
    );
    return () => clearInterval(id);
  }, [mode, zone]);
  useEffect(() => {
    if (mode === "play" && (health <= 0 || time <= 0)) {
      setFailure(
        DELIVERY_FAILURES[Math.floor(Math.random() * DELIVERY_FAILURES.length)],
      );
      setMode("lost");
      beep("hit");
    }
  }, [mode, health, time, beep]);
  useEffect(() => {
    if (mode !== "play" || routeDelivered < cfg.deliveries) return;
    void finishRoute();
  }, [routeDelivered, mode, cfg.deliveries]);
  async function start() {
    soundtrack();
    beep("start");
    const r = await fetch("/api/delivery-boy/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", playerName: name }),
      }),
      d = await r.json();
    if (!r.ok) {
      pop(d.error || "Could not start route");
      return;
    }
    setRun(d);
    begin(1);
  }
  function begin(n: number) {
    setStage(n);
    setRouteDelivered(0);
    setHealth(3);
    setTime(DELIVERY_STAGES[n - 1].time);
    setThings([]);
    setScenery([]);
    setTarget(emptyTarget);
    setLane(1);
    setMode("play");
  }
  async function finishRoute() {
    setMode("between");
    const nextSeq = sequence + 1,
      checkpoint = {
        runId: run?.runId,
        stage,
        sequence: nextSeq,
        activeSeconds:
          DELIVERY_STAGES.slice(0, stage).reduce((n, s) => n + s.time, 0) -
          time,
        score: stats.score,
        delivered: stats.delivered,
        missed: stats.missed,
        hits: stats.hits,
      };
    if (run) {
      const r = await fetch("/api/delivery-boy/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "checkpoint",
          token: run.token,
          checkpoint,
        }),
      });
      if (r.ok) setSequence(nextSeq);
    }
    if (Math.random() < 0.72)
      setComplaint(
        DELIVERY_COMPLAINTS[
          Math.floor(Math.random() * DELIVERY_COMPLAINTS.length)
        ],
      );
  }
  async function nextRoute() {
    setComplaint("");
    if (stage < DELIVERY_STAGES.length) {
      begin(stage + 1);
      return;
    }
    if (!run) return;
    const r = await fetch("/api/delivery-boy/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          runId: run.runId,
          token: run.token,
        }),
      }),
      d = await r.json();
    setReward(d);
    setMode(r.ok ? "won" : "lost");
  }
  function touchEnd(e: React.TouchEvent) {
    const p = e.changedTouches[0],
      dx = p.clientX - touch.current.x,
      dy = p.clientY - touch.current.y;
    if (!touch.current.moved && Math.hypot(dx, dy) < 18) deliver();
  }
  function touchMove(e: React.TouchEvent) {
    const p = e.touches[0],
      dx = p.clientX - touch.current.x;
    if (Math.abs(dx) > 3) {
      move(dx / 150);
      touch.current = { x: p.clientX, y: p.clientY, moved: true };
    }
  }
  return (
    <main className="delivery-boy">
      {mode === "home" && (
        <section className="delivery-home">
          <div className="delivery-brand">CORNER DELI PRESENTS</div>
          <h1>
            CORNER
            <br />
            <i>DELIVERY BOY</i>
          </h1>
          <div className="van-hero">
            🥪<span>🚗</span>
            <b>💨</b>
          </div>
          <p>Deliver subs. Dodge wildlife. Survive customer logic.</p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Driver name"
          />
          <button onClick={start}>START THE CAR</button>
          <small>← → or swipe to steer · SPACE or DELIVER to throw</small>
          <div className="sub-prize">
            WIN: {DELIVERY_PRIZE.name.toUpperCase()}
          </div>
        </section>
      )}
      {mode === "play" && (
        <>
          <header className="delivery-hud">
            <div>
              <small>ROUTE {stage}</small>
              <b>{cfg.name}</b>
            </div>
            <div>
              <small>DELIVERED</small>
              <b>
                {routeDelivered}/{cfg.deliveries}
              </b>
            </div>
            <div className={time < 16 ? "hot" : ""}>
              <small>TIME</small>
              <b>{time}</b>
            </div>
            <div>
              <small>SCORE</small>
              <b>{stats.score}</b>
            </div>
            <div>
              <small>COMBO</small>
              <b>{stats.combo}×</b>
            </div>
            {slow > 0 && (
              <div className="slow-hud">
                <small>SLOW TIME</small>
                <b>{slow}s</b>
              </div>
            )}
            <button onClick={() => setMuted(!muted)}>
              {muted ? "🔇" : "🔊"}
            </button>
          </header>
          <section
            className={`delivery-world zone-${zone} ${time < 16 ? "panic" : ""} ${stage >= 4 ? "night" : ""} ${slow ? "slow-motion" : ""}`}
            onTouchStart={(e) =>
              (touch.current = {
                x: e.touches[0].clientX,
                y: e.touches[0].clientY,
                moved: false,
              })
            }
            onTouchMove={touchMove}
            onTouchEnd={touchEnd}
          >
            {target.active && (
              <div className="address-ticket">
                <small>DELIVER TO</small>
                <b>{target.address}</b>
                <i>{target.side.toUpperCase()} SIDE</i>
              </div>
            )}
            <div className="sky">
              <span>{stage >= 4 ? "🌙" : "🏪"}</span>
              <i>ROUTE {stage}</i>
            </div>
            <div className="road">
              <div className="sidewalk left-walk" />
              <div className="sidewalk right-walk" />
              <div className="lane-lines" />
              <div className="speed-lines" />
              {scenery.map((x) => (
                <i
                  className={`scenery ${x.kind} ${x.side}`}
                  style={{ top: `${x.y}%` }}
                  key={x.id}
                >
                  {x.kind === "house"
                    ? "🏠"
                    : x.kind === "abandoned"
                      ? "🚘"
                      : x.kind === "tent"
                        ? "⛺🧍"
                        : x.kind === "cart"
                          ? "🛒"
                          : "🗑️"}
                </i>
              ))}
              {target.active && (
                <>
                  <div
                    className={`house decoy ${target.side === "left" ? "right" : "left"}`}
                    style={{ top: `${target.y + 7}%` }}
                  >
                    <span>🏠</span>
                    <b>{target.neighbor}</b>
                  </div>
                  <div
                    className={`house target ${target.side} ${target.y >= 60 && target.y <= 88 ? "in-range" : ""}`}
                    style={{ top: `${target.y}%` }}
                  >
                    <span>🏠</span>
                    <b>{target.address}</b>
                    <em>
                      {target.y >= 60 && target.y <= 88
                        ? "◀ DELIVER NOW ▶"
                        : "TARGET"}
                    </em>
                  </div>
                </>
              )}
              {things.map((x) => (
                <i
                  className={`hazard ${x.type}`}
                  key={x.id}
                  style={{ left: `${16.66 + x.lane * 33.33}%`, top: `${x.y}%` }}
                >
                  {icons[x.type]}
                </i>
              ))}
              <div
                className={`driver ${boost ? "boost" : ""}`}
                style={{ left: `${lane * 50}%` }}
              >
                <img
                  src="/games/delivery-boy/equinox-ev-rear-v1.png"
                  alt=""
                  draggable={false}
                />
                <b className="wrapped-sub">SUB</b>
              </div>
              {thrown && (
                <i
                  key={thrown.id}
                  className={`flying-sub ${thrown.side}`}
                  style={
                    { "--start": `${thrown.start * 50}%` } as CSSProperties
                  }
                >
                  ▰
                </i>
              )}
            </div>
            {stage >= 4 && <div className="headlights" />}
            {toast && <div className="delivery-toast">{toast}</div>}
            <div className="hearts">
              {"❤️".repeat(health)}
              {"🖤".repeat(3 - health)}
            </div>
            <div className="touch-controls">
              <button onPointerDown={() => move(-0.25)}>◀</button>
              <button className="deliver" onPointerDown={deliver}>
                THROW TO ADDRESS
              </button>
              <button onPointerDown={() => move(0.25)}>▶</button>
            </div>
          </section>
        </>
      )}
      {mode === "between" && (
        <section className="delivery-summary">
          <small>ROUTE {stage} CLEAR</small>
          <h1>{complaint ? "CUSTOMER FEEDBACK" : "MIRACLE: NO COMPLAINT"}</h1>
          <div className="complaint-card">
            {complaint ||
              "Everything was great. This event has a 0.0004% historical occurrence rate."}
          </div>
          <div className="route-stats">
            <b>
              {stats.score}
              <small>SCORE</small>
            </b>
            <b>
              {stats.delivered}
              <small>DELIVERED</small>
            </b>
            <b>
              {stats.hits}
              <small>ANIMAL/OBJECT INCIDENTS</small>
            </b>
          </div>
          <button onClick={nextRoute}>
            {stage === DELIVERY_STAGES.length
              ? "CLAIM FREE SUB"
              : "NEXT ROUTE →"}
          </button>
        </section>
      )}
      {mode === "lost" && (
        <section className="delivery-summary">
          <h1>ROUTE FAILED</h1>
          <div className="complaint-card">
            {reward?.error ||
              failure ||
              "The subs survived. Your dignity did not."}
          </div>
          <button onClick={() => location.reload()}>DRIVE AGAIN</button>
        </section>
      )}
      {mode === "won" && (
        <section className="delivery-summary win">
          <small>YOU SURVIVED THE ROUTE</small>
          <h1>FREE SUB EARNED</h1>
          <div className="reward-code">{reward?.code}</div>
          <p>{DELIVERY_PRIZE.terms}</p>
        </section>
      )}
    </main>
  );
}
