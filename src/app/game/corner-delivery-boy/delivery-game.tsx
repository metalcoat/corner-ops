"use client";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  DELIVERY_CAR_CRASHES,
  DELIVERY_COLLISION_FAILURES,
  DELIVERY_COMPLAINTS,
  DELIVERY_FAILURES,
  DELIVERY_PRIZE,
  DELIVERY_ROUTE_SUCCESSES,
  DELIVERY_STAGES,
} from "@/lib/delivery-boy/config";
import { deliveryAudio } from "@/lib/games/delivery-audio";
import { MenuAdTicker } from "@/app/games/components/menu-ad-ticker";
type Thing = {
  id: number;
  type:
    | "deer"
    | "dog"
    | "cat"
    | "goose"
    | "raccoon"
    | "mower"
    | "van"
    | "squirrel"
    | "cow"
    | "person"
    | "car"
    | "pothole"
    | "boost"
    | "slow";
  lane: number;
  y: number;
  speed?: number;
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
type DeliveryLeader = {
  player_name: string;
  status: string;
  game_version: string;
  stage: number;
  score: number;
  delivered: number;
  missed: number;
  hits: number;
  completed_at: string;
};
type Stats = {
  score: number;
  delivered: number;
  missed: number;
  hits: number;
  combo: number;
  bestCombo: number;
};
type ScoreBurst = { id: number; text: string; tone: "good" | "bad" };
const fresh: Stats = {
  score: 0,
  delivered: 0,
  missed: 0,
  hits: 0,
  combo: 0,
  bestCombo: 0,
};
const communities = [
  { name: "LISBON", warning: "WATCH FOR COWS" },
  { name: "HEUVELTON", warning: "TRACTORS HAVE RIGHT OF WAY. THEY DECIDED." },
  { name: "MORRISTOWN", warning: "RIVER WIND MAY RELOCATE SUBS" },
  { name: "WADDINGTON", warning: "UNMARKED DRIVEWAYS AHEAD" },
  { name: "RENSSELAER FALLS", warning: "GPS HAS LEFT THE CHAT" },
  { name: "MADRID", warning: "MAILBOXES MAY BE STRUCTURAL" },
] as const;
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
const orderPayloads = [
  "Italian Sub",
  "Big Boss Sub",
  "Chicken Parm Sub",
  "Jumbo Pizza Box",
  "Steak Sub",
  "Turkey Sub",
];
const recentFailures = new Map<string, string[]>();
function pickFailure(key: string, pool: readonly string[]) {
  const recent = recentFailures.get(key) || [];
  const available = pool.filter((line) => !recent.includes(line));
  const choices = available.length ? available : [...pool];
  const selected = choices[Math.floor(Math.random() * choices.length)];
  recentFailures.set(key, [...recent.slice(-4), selected]);
  return selected;
}
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
    [successMessage, setSuccessMessage] = useState(""),
    [failure, setFailure] = useState(""),
    [run, setRun] = useState<Run | null>(null),
    [sequence, setSequence] = useState(0),
    [reward, setReward] = useState<any>(null),
    [muted, setMuted] = useState(() => deliveryAudio.getSettings().muted),
    [audioSettings, setAudioSettings] = useState(() =>
      deliveryAudio.getSettings(),
    ),
    [showAudio, setShowAudio] = useState(false),
    [reducedEffects, setReducedEffects] = useState(false),
    [boost, setBoost] = useState(0),
    [slow, setSlow] = useState(0),
    [damaged, setDamaged] = useState(0),
    [paused, setPaused] = useState(false),
    [orderPayload, setOrderPayload] = useState(orderPayloads[0]),
    [brokenWindow, setBrokenWindow] = useState(false),
    [scoreBursts, setScoreBursts] = useState<ScoreBurst[]>([]),
    [community, setCommunity] = useState<(typeof communities)[number]>(
      communities[0],
    ),
    [ammo, setAmmo] = useState(8),
    [shaking, setShaking] = useState(false),
    [skidding, setSkidding] = useState(false),
    [particles, setParticles] = useState<
      { id: number; side: "left" | "right"; y: number }[]
    >([]);
  const [showLeaders, setShowLeaders] = useState(false),
    [leaders, setLeaders] = useState<DeliveryLeader[]>([]),
    [leadersLoading, setLeadersLoading] = useState(false);
  const keys = useRef(new Set<string>()),
    last = useRef(0),
    spawn = useRef(0),
    deliveryGap = useRef(0),
    impactFailure = useRef(""),
    cosmeticId = useRef(0),
    lossSaved = useRef(false),
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
  async function openLeaderboard() {
    setShowLeaders(true);
    setLeadersLoading(true);
    const response = await fetch("/api/delivery-boy/leaderboard");
    const data = await response.json();
    setLeaders(Array.isArray(data.leaders) ? data.leaders : []);
    setLeadersLoading(false);
  }
  useEffect(() => {
    state.current = { mode, time, health, stage, target };
  }, [mode, time, health, stage, target]);
  useEffect(() => {
    if (mode !== "lost" || !run || lossSaved.current) return;
    lossSaved.current = true;
    const activeSeconds =
      DELIVERY_STAGES.slice(0, stage - 1).reduce(
        (total, route) => total + route.time,
        0,
      ) + Math.max(0, DELIVERY_STAGES[stage - 1].time - time);
    void fetch("/api/delivery-boy/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "loss",
        token: run.token,
        runId: run.runId,
        stage,
        activeSeconds,
        score: stats.score,
        delivered: stats.delivered,
        missed: stats.missed,
        hits: stats.hits,
      }),
    });
  }, [mode, run, stage, stats, time]);
  useEffect(() => {
    playerLane.current = lane;
  }, [lane]);
  useEffect(() => {
    if (mode !== "lost" && mode !== "won") return;
    const previous = Number(
      localStorage.getItem("corner-delivery-high-score") || 0,
    );
    localStorage.setItem(
      "corner-delivery-high-score",
      String(Math.max(previous, stats.score)),
    );
  }, [mode, stats.score]);
  const beep = useCallback(
    (
      kind:
        | "throw"
        | "delivery"
        | "miss"
        | "hit"
        | "coin"
        | "start"
        | "steer"
        | "gameover"
        | "menu"
        | "yelp"
        | "bark"
        | "meow"
        | "moo"
        | "squish"
        | "ouch"
        | "victory",
    ) => {
      deliveryAudio.setMuted(muted);
      if (kind === "delivery" || kind === "coin")
        deliveryAudio.play("delivery");
      else if (kind === "hit") deliveryAudio.play("crash");
      else if (kind === "start") {
        deliveryAudio.play("start");
        deliveryAudio.transition("action");
      } else deliveryAudio.play(kind);
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
    deliveryAudio.setMuted(muted);
  }, [muted]);
  useEffect(
    () => () => {
      if (audio.current) {
        clearInterval(audio.current.timer);
        void audio.current.ctx.close();
      }
      deliveryAudio.stop();
    },
    [],
  );
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const saved = localStorage.getItem("corner-delivery-reduced-effects");
    setReducedEffects(saved === null ? motion.matches : saved === "true");
    const visibility = () =>
      document.hidden || paused || mode !== "play"
        ? deliveryAudio.suspend()
        : deliveryAudio.resume();
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [mode, paused]);
  function pop(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 850);
  }
  const scoreBurst = useCallback((text: string, tone: "good" | "bad") => {
    const id = ++cosmeticId.current;
    setScoreBursts((bursts) => [...bursts, { id, text, tone }]);
    window.setTimeout(
      () =>
        setScoreBursts((bursts) => bursts.filter((burst) => burst.id !== id)),
      900,
    );
  }, []);
  const vibrate = useCallback((pattern: number | number[]) => {
    if (typeof navigator !== "undefined" && "vibrate" in navigator)
      navigator.vibrate(pattern);
  }, []);
  const impact = useCallback(() => {
    setShaking(true);
    window.setTimeout(() => setShaking(false), 210);
  }, []);
  const move = useCallback(
    (d: number) => {
      if (Math.abs(d) >= 0.18) {
        setSkidding(true);
        window.setTimeout(() => setSkidding(false), 230);
        beep("steer");
      }
      setLane((v) =>
        Math.max(-0.18, Math.min(2.18, v + d * (damaged ? 0.58 : 1))),
      );
    },
    [beep, damaged],
  );
  const deliver = useCallback(() => {
    const t = state.current.target;
    if (state.current.mode !== "play" || paused || !t.active) return;
    if (ammo <= 0) {
      pop("NO SUBS LEFT. YOU DELIVERED THE INVENTORY TO SHRUBS.");
      return;
    }
    const throwId = Date.now();
    setAmmo((count) => Math.max(0, count - 1));
    setThrown({ id: throwId, side: t.side, start: playerLane.current });
    beep("throw");
    window.setTimeout(() => setThrown(null), 650);
    const timed = t.y >= 60 && t.y <= 88,
      correctSide =
        t.side === "left"
          ? playerLane.current < 0.72
          : playerLane.current > 1.28;
    if (timed && correctSide) {
      const perfect = t.y >= 71 && t.y <= 79;
      setTarget((x) => ({ ...x, active: false }));
      setRouteDelivered((n) => n + 1);
      setOrderPayload(
        orderPayloads[Math.floor(Math.random() * orderPayloads.length)],
      );
      setParticles((items) => [
        ...items,
        { id: throwId, side: t.side, y: t.y },
      ]);
      window.setTimeout(
        () =>
          setParticles((items) => items.filter((item) => item.id !== throwId)),
        750,
      );
      setStats((s) => {
        const combo = s.combo + 1,
          multiplier = Math.min(4, Math.max(1, combo)),
          score = s.score + (perfect ? 200 : 100) * multiplier;
        return {
          ...s,
          delivered: s.delivered + 1,
          combo,
          bestCombo: Math.max(s.bestCombo, combo),
          score: Math.round(score),
        };
      });
      if (perfect) setBoost(2);
      scoreBurst(
        perfect
          ? `PERFECT +${200 * Math.min(4, stats.combo + 1)}`
          : `GOOD +${100 * Math.min(4, stats.combo + 1)}`,
        "good",
      );
      vibrate([15, 30]);
      pop(
        perfect
          ? quips[Math.floor(Math.random() * quips.length)]
          : "RIGHT HOUSE. QUESTIONABLE THROW.",
      );
      window.setTimeout(() => beep("delivery"), 190);
    } else {
      setStats((s) => ({ ...s, score: Math.max(0, s.score - 50), combo: 0 }));
      setBrokenWindow(true);
      window.setTimeout(() => setBrokenWindow(false), 420);
      scoreBurst("BROKEN WINDOW -50", "bad");
      vibrate([45, 25, 45]);
      pop(
        !correctSide
          ? `WRONG HOUSE! THAT WAS ${t.neighbor}`
          : t.y < 60
            ? "TOO EARLY! SUB IN SHRUB"
            : "MISSED THE ADDRESS!",
      );
      impact();
      beep("miss");
    }
  }, [ammo, beep, impact, paused, scoreBurst, stats.combo, vibrate]);
  useEffect(() => {
    const speedRatio = Math.min(1, (cfg.speed + (boost > 0 ? 65 : 0)) / 330);
    const urgencyRatio = Math.max(0, Math.min(1, (20 - time) / 20));
    deliveryAudio.setIntensity(speedRatio, urgencyRatio);
  }, [cfg.speed, boost, time]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        (e.key === "p" || e.key === "P" || e.key === "Escape") &&
        mode === "play"
      ) {
        e.preventDefault();
        setPaused((value) => !value);
        return;
      }
      keys.current.add(e.key);
      if ([" ", "Enter", "w", "W"].includes(e.key) && !paused) {
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
  }, [deliver, mode, paused]);
  useEffect(() => {
    if (mode !== "play" || paused) return;
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
          Math.max(
            -0.18,
            Math.min(
              2.18,
              v + (right ? 1 : -1) * dt * 1.7 * (damaged ? 0.58 : 1),
            ),
          ),
        );
      const speed = Math.max(
        0.65,
        (DELIVERY_STAGES[state.current.stage - 1].speed +
          (boost > 0 ? 65 : 0) -
          (slow > 0 ? 120 : 0)) /
          100,
      );
      const elapsed =
          DELIVERY_STAGES[state.current.stage - 1].time - state.current.time,
        speedRamp = 1 + Math.floor(Math.max(0, elapsed) / 30) * 0.08;
      if (spawn.current > Math.max(0.36, 1.05 - state.current.stage * 0.09)) {
        spawn.current = 0;
        const types: Thing["type"][] =
            state.current.stage <= 1
              ? ["squirrel", "cat", "pothole", "pothole"]
              : state.current.stage <= 3
                ? ["dog", "cat", "raccoon", "person", "car", "pothole", "mower"]
                : [
                    "deer",
                    "dog",
                    "goose",
                    "cow",
                    "person",
                    "car",
                    "van",
                    "pothole",
                    "mower",
                  ],
          roll = Math.random(),
          type =
            roll < 0.08
              ? "slow"
              : roll < 0.17
                ? "boost"
                : types[Math.floor(Math.random() * types.length)];
        setThings((a) => [
          ...a,
          {
            id: Date.now() + Math.random(),
            type,
            lane: Math.random() * 2,
            y: -12,
            speed:
              type === "mower" || type === "van" || type === "goose" ? 1.35 : 1,
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
          const n = {
              ...x,
              y: x.y + dt * speed * speedRamp * 36 * (x.speed || 1),
            },
            collisionRadius =
              n.type === "car" || n.type === "van"
                ? 0.36
                : n.type === "cow"
                  ? 0.29
                  : n.type === "deer"
                    ? 0.21
                    : n.type === "dog"
                      ? 0.13
                      : n.type === "cat" || n.type === "raccoon"
                        ? 0.11
                        : n.type === "goose"
                          ? 0.15
                          : n.type === "mower"
                            ? 0.2
                            : n.type === "squirrel"
                              ? 0.07
                              : n.type === "person"
                                ? 0.13
                                : 0.18;
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
            if (
              (n.type === "car" || n.type === "van") &&
              Math.abs(n.lane - playerLane.current) >= 0.17
            ) {
              setDamaged(4);
              setHealth((health) => Math.max(0, health - 1));
              setStats((stats) => ({
                ...stats,
                score: Math.max(0, stats.score - 500),
                hits: stats.hits + 1,
                combo: 0,
              }));
              pop(
                "SIDESWIPE! -500. ALIGNMENT NOW PROVIDED BY A SHOPPING CART.",
              );
              impact();
              beep("hit");
              continue;
            }
            if (
              n.type === "car" ||
              n.type === "van" ||
              n.type === "cow" ||
              n.type === "person" ||
              n.type === "mower"
            ) {
              const reason =
                n.type === "car"
                  ? pickFailure("car", DELIVERY_CAR_CRASHES)
                  : pickFailure(n.type, DELIVERY_COLLISION_FAILURES[n.type]);
              impactFailure.current = reason;
              setFailure(reason);
              setStats((s) => ({ ...s, hits: s.hits + 1, combo: 0 }));
              setMode("lost");
              impact();
              beep(
                n.type === "person" ? "ouch" : n.type === "cow" ? "moo" : "hit",
              );
              continue;
            }
            if (n.type === "squirrel") {
              impactFailure.current = pickFailure(
                "squirrel",
                DELIVERY_COLLISION_FAILURES.squirrel,
              );
              setStats((s) => ({
                ...s,
                score: Math.max(0, s.score - 100),
                hits: s.hits + 1,
                combo: 0,
              }));
              pop("SQUIRREL TAP! -100. IT HAS RETAINED COUNSEL.");
              beep("squish");
              continue;
            }
            if (n.type === "cat") {
              impactFailure.current = pickFailure(
                "cat",
                DELIVERY_COLLISION_FAILURES.cat,
              );
              setHealth((health) => Math.max(0, health - 1));
              setStats((stats) => ({
                ...stats,
                score: Math.max(0, stats.score - 175),
                hits: stats.hits + 1,
                combo: 0,
              }));
              pop("CAT INCIDENT! -175. IT WILL BE REVIEWING THIS RIDE ONLINE.");
              impact();
              beep("meow");
              continue;
            }
            if (n.type === "goose" || n.type === "raccoon") {
              impactFailure.current = pickFailure(
                n.type,
                DELIVERY_COLLISION_FAILURES[n.type],
              );
              setHealth((health) => Math.max(0, health - 1));
              setStats((stats) => ({
                ...stats,
                score: Math.max(0, stats.score - 150),
                hits: stats.hits + 1,
                combo: 0,
              }));
              pop(
                n.type === "goose"
                  ? "GOOSE INCIDENT! IT HAS CLAIMED THE LANE AND YOUR INSURANCE."
                  : "RACCOON INCIDENT! THE SUB HAS BEEN RECLASSIFIED AS TRASH.",
              );
              impact();
              beep("hit");
              continue;
            }
            const collisionType =
              n.type === "deer" ? "deer" : n.type === "dog" ? "dog" : "pothole";
            const reasonPool = DELIVERY_COLLISION_FAILURES[collisionType];
            impactFailure.current = pickFailure(collisionType, reasonPool);
            setHealth((h) => Math.max(0, h - (n.type === "deer" ? 2 : 1)));
            setStats((s) => ({ ...s, hits: s.hits + 1, combo: 0 }));
            pop(
              n.type === "deer"
                ? "YOU HIT A DEER. THE DEER IS ANGRY."
                : `${n.type.toUpperCase()} INCIDENT!`,
            );
            impact();
            beep(n.type === "dog" ? "bark" : "hit");
            continue;
          }
          if (n.y < 112) next.push(n);
        }
        return next;
      });
      setTarget((t) => {
        if (!t.active) return t;
        const y = t.y + dt * speed * 36;
        if (y > 108) {
          setStats((s) => ({ ...s, missed: s.missed + 1, combo: 0 }));
          pop(`MISSED ${t.address}. CUSTOMER ALREADY CALLED.`);
          return { ...t, y, active: false };
        }
        return { ...t, y };
      });
      setScenery((items) => {
        const next: Scenery[] = [];
        for (const x of items) {
          const n = { ...x, y: x.y + dt * speed * 36 },
            onLeftCurb = playerLane.current < -0.04 && n.side === "left",
            onRightCurb = playerLane.current > 2.04 && n.side === "right";
          if (
            n.y > 82 &&
            n.y < 91 &&
            (onLeftCurb || onRightCurb) &&
            (n.kind === "abandoned" || n.kind === "tent")
          ) {
            const reason =
              n.kind === "abandoned"
                ? pickFailure(
                    "abandoned",
                    DELIVERY_COLLISION_FAILURES.abandoned,
                  )
                : pickFailure("tent", DELIVERY_COLLISION_FAILURES.tent);
            impactFailure.current = reason;
            setFailure(reason);
            setStats((s) => ({ ...s, hits: s.hits + 1, combo: 0 }));
            setMode("lost");
            impact();
            beep(n.kind === "tent" ? "ouch" : "hit");
            continue;
          }
          if (n.y < 112) next.push(n);
        }
        return next;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode, paused, boost, slow, damaged, beep, impact]);
  useEffect(() => {
    if (mode !== "play" || paused) return;
    const id = setInterval(() => {
      setTime((t) => Math.max(0, t - 1));
      setBoost((b) => Math.max(0, b - 1));
      setSlow((s) => Math.max(0, s - 1));
      setDamaged((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [mode, paused]);
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
    const spawnId = window.setInterval(
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
      clearInterval(spawnId);
    };
  }, [mode, zone]);
  useEffect(() => {
    if (mode !== "play") return;
    const startsRural = stage >= 3;
    setZone(startsRural ? "rural" : "city");
    if (startsRural)
      setCommunity(communities[Math.floor(Math.random() * communities.length)]);
    const id = window.setInterval(
      () =>
        setZone((current) => {
          const next = current === "city" ? "rural" : "city";
          if (next === "rural")
            setCommunity(
              communities[Math.floor(Math.random() * communities.length)],
            );
          return next;
        }),
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
        health <= 0 && impactFailure.current
          ? impactFailure.current
          : pickFailure("route", DELIVERY_FAILURES),
      );
      setMode("lost");
      beep("gameover");
    }
  }, [mode, health, time, beep]);
  useEffect(() => {
    if (mode !== "play" || routeDelivered < cfg.deliveries) return;
    void finishRoute();
  }, [routeDelivered, mode, cfg.deliveries]);
  async function start() {
    lossSaved.current = false;
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
    setAmmo(DELIVERY_STAGES[n - 1].deliveries + 4);
    setFailure("");
    setPaused(false);
    setOrderPayload(
      orderPayloads[Math.floor(Math.random() * orderPayloads.length)],
    );
    impactFailure.current = "";
    setLane(1);
    setDamaged(0);
    deliveryAudio.transition("action");
    setMode("play");
  }
  async function finishRoute() {
    setMode("between");
    deliveryAudio.transition("menu");
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
    if (Math.random() < 0.58) {
      setComplaint(
        DELIVERY_COMPLAINTS[
          Math.floor(Math.random() * DELIVERY_COMPLAINTS.length)
        ],
      );
      setSuccessMessage("");
    } else {
      setComplaint("");
      setSuccessMessage(
        DELIVERY_ROUTE_SUCCESSES[
          Math.floor(Math.random() * DELIVERY_ROUTE_SUCCESSES.length)
        ],
      );
    }
  }
  async function nextRoute() {
    setComplaint("");
    setSuccessMessage("");
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
    if (r.ok) beep("victory");
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
          <img
            className="game-corner-logo"
            src="https://rezku-pos-upload.imgix.net/2e2a0810-d179-474b-a40b-e4104c60d8c1/olo/logo/jO52kF7dMM84upTQGozunTrduBxjbylAFeGYc8r_RT8.png?fit=max&auto=compress&fmt=png32&h=180"
            alt="Corner Deli"
          />
          <div className="delivery-brand">CORNER DELI PRESENTS</div>
          <h1>
            <i>DELIVERY BOY</i>
          </h1>
          <div className="van-hero">
            <img
              src="/games/delivery-boy/delivery-suv-pixel-v2.png"
              alt="Corner Deli delivery car"
            />
          </div>
          <p>Deliver subs. Dodge wildlife. Survive customer logic.</p>
          <MenuAdTicker />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Driver name"
          />
          <button onClick={start}>START THE CAR</button>
          <button
            className="driver-leaderboard-button"
            onClick={openLeaderboard}
          >
            DRIVER LEADERBOARD
          </button>
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
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
              <small>
                {stage <= 1
                  ? "SUBURBAN"
                  : stage <= 3
                    ? "DOWNTOWN / MAIN ST"
                    : "RUSH HOUR / RIVER RD"}
              </small>
              <b>ROUTE {stage}</b>
            </div>
            <div className="active-order-hud">
              <small>TOSS</small>
              <b>{orderPayload}</b>
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
            <div className={`combo-hud combo-${Math.min(4, stats.combo)}`}>
              <small>TIP STREAK</small>
              <b>
                {stats.combo >= 4
                  ? "DELI HERO ×4"
                  : `×${Math.max(1, stats.combo)}`}
              </b>
            </div>
            <div className={ammo < 3 ? "ammo-hud critical" : "ammo-hud"}>
              <small>SUBS</small>
              <b>
                <i className="sub-ammo-icon" /> {ammo}
              </b>
            </div>
            {slow > 0 && (
              <div className="slow-hud">
                <small>SLOW TIME</small>
                <b>{slow}s</b>
              </div>
            )}
            <button
              aria-label="Audio settings"
              onClick={() => setShowAudio(!showAudio)}
            >
              {muted ? "SOUND OFF" : "SOUND"}
            </button>
          </header>
          <section
            className={`delivery-world zone-${zone} ${time < 16 ? "panic" : ""} ${stage >= 4 ? "night" : ""} ${slow ? "slow-motion" : ""} ${shaking && !reducedEffects ? "impact-shake" : ""} ${brokenWindow && !reducedEffects ? "window-shatter" : ""} ${paused ? "paused" : ""} ${reducedEffects ? "reduced-effects" : ""}`}
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
            <MenuAdTicker overlay roadside />
            <div className="route-progress" aria-label="Route progress">
              <i
                style={{
                  width: `${Math.min(100, (routeDelivered / cfg.deliveries) * 100)}%`,
                }}
              />
              <b>
                {routeDelivered}/{cfg.deliveries} TO FINISH
              </b>
            </div>
            <div className="horizon-layer" />
            <div className="midground-layer" />
            {zone === "rural" && (
              <div
                className="community-sign"
                key={`${community.name}-${stage}`}
              >
                <small>ENTERING</small>
                <b>{community.name}</b>
                <span>{community.warning}</span>
              </div>
            )}
            {target.active && (
              <div className="address-ticket">
                <small>DELIVER TO</small>
                <b>{target.address}</b>
                <i>{target.side.toUpperCase()} SIDE</i>
              </div>
            )}
            <div className="sky">
              <span className={stage >= 4 ? "pixel-moon" : "pixel-store"} />
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
                  style={
                    {
                      top: `${x.y}%`,
                      "--depth": Math.max(
                        0.48,
                        Math.min(1.08, 0.48 + x.y / 175),
                      ),
                    } as CSSProperties
                  }
                  key={x.id}
                />
              ))}
              {target.active && (
                <>
                  <div
                    className={`house decoy ${target.side === "left" ? "right" : "left"}`}
                    style={
                      {
                        top: `${target.y + 7}%`,
                        "--depth": Math.max(
                          0.5,
                          Math.min(1.08, 0.5 + target.y / 170),
                        ),
                      } as CSSProperties
                    }
                  >
                    <span className="house-sprite" />
                    <b>{target.neighbor}</b>
                  </div>
                  <div
                    className={`house target ${target.side} ${target.y >= 60 && target.y <= 88 ? "in-range" : ""}`}
                    style={
                      {
                        top: `${target.y}%`,
                        "--depth": Math.max(
                          0.5,
                          Math.min(1.08, 0.5 + target.y / 170),
                        ),
                      } as CSSProperties
                    }
                  >
                    <span className="house-sprite" />
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
                <Fragment key={x.id}>
                  {(x.speed || 1) > 1 && x.y < 18 && (
                    <i
                      className="hazard-warning"
                      style={{ left: `${16.66 + x.lane * 33.33}%` }}
                    >
                      !
                    </i>
                  )}
                  <i
                    className={`hazard ${x.type}`}
                    style={
                      {
                        left: `${16.66 + x.lane * 33.33}%`,
                        top: `${x.y}%`,
                        "--depth": Math.max(
                          0.45,
                          Math.min(1.12, 0.45 + x.y / 145),
                        ),
                      } as CSSProperties
                    }
                  />
                </Fragment>
              ))}
              <div
                className={`driver ${boost ? "boost" : ""} ${skidding ? "skidding" : ""} ${damaged ? "damaged" : ""}`}
                style={{ left: `${lane * 50}%` }}
              >
                <img
                  src="/games/delivery-boy/delivery-suv-pixel-v2.png"
                  alt=""
                  draggable={false}
                />
                <b className="wrapped-sub" aria-hidden="true" />
              </div>
              {skidding && <i className="skid-trail" />}
              {thrown && (
                <i
                  key={thrown.id}
                  className={`flying-sub ${thrown.side}`}
                  style={
                    { "--start": `${thrown.start * 50}%` } as CSSProperties
                  }
                />
              )}
              {particles.map((particle) => (
                <i
                  key={particle.id}
                  className={`delivery-particles ${particle.side}`}
                  style={{ top: `${particle.y}%` }}
                />
              ))}
              {stage >= 4 && (
                <div className="headlights" style={{ left: `${lane * 50}%` }} />
              )}
            </div>
            {toast && <div className="delivery-toast">{toast}</div>}
            {scoreBursts.map((burst) => (
              <div className={`score-burst ${burst.tone}`} key={burst.id}>
                {burst.text}
              </div>
            ))}
            {paused && (
              <div className="pause-card">
                <b>ROUTE PAUSED</b>
                <span>Press P or Esc to keep disappointing customers.</span>
              </div>
            )}
            <div className="hearts" aria-label={`${health} condition points`}>
              {[0, 1, 2].map((point) => (
                <i className={point < health ? "full" : "empty"} key={point} />
              ))}
            </div>
            {showAudio && (
              <aside className="audio-panel">
                <b>AUDIO MIX</b>
                {(["master", "music", "effects"] as const).map((channel) => (
                  <label key={channel}>
                    {channel.toUpperCase()}
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={audioSettings[channel]}
                      onChange={(event) => {
                        const next = {
                          ...audioSettings,
                          [channel]: Number(event.target.value),
                        };
                        setAudioSettings(next);
                        deliveryAudio.setLevels({ [channel]: next[channel] });
                      }}
                    />
                  </label>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={muted}
                    onChange={(event) => setMuted(event.target.checked)}
                  />{" "}
                  MUTE
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={reducedEffects}
                    onChange={(event) => {
                      setReducedEffects(event.target.checked);
                      localStorage.setItem(
                        "corner-delivery-reduced-effects",
                        String(event.target.checked),
                      );
                    }}
                  />{" "}
                  REDUCED EFFECTS
                </label>
              </aside>
            )}
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
          <h1>{complaint ? "CUSTOMER FEEDBACK" : "ROUTE LEGEND"}</h1>
          <div className="complaint-card">{complaint || successMessage}</div>
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
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
          <button
            className="driver-leaderboard-button"
            onClick={openLeaderboard}
          >
            DRIVER LEADERBOARD
          </button>
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
        </section>
      )}
      {mode === "won" && (
        <section className="delivery-summary win">
          <small>YOU SURVIVED THE ROUTE</small>
          <h1>FREE SUB EARNED</h1>
          <div className="reward-code">{reward?.code}</div>
          <p>{DELIVERY_PRIZE.terms}</p>
          <button
            className="driver-leaderboard-button"
            onClick={openLeaderboard}
          >
            DRIVER LEADERBOARD
          </button>
        </section>
      )}
      {showLeaders && (
        <section className="driver-leaderboard" role="dialog" aria-modal="true">
          <div>
            <button
              className="driver-board-close"
              onClick={() => setShowLeaders(false)}
            >
              ×
            </button>
            <small>CORNER DELI ROUTE RECORDS</small>
            <h2>DELIVERY LEGENDS</h2>
            {leadersLoading ? (
              <p>LOADING ROUTES…</p>
            ) : leaders.length === 0 ? (
              <p>No winning drivers yet. The deer remain undefeated.</p>
            ) : (
              <ol>
                {leaders.map((leader, index) => (
                  <li
                    key={`${leader.player_name}-${leader.completed_at}-${index}`}
                  >
                    <b>{index + 1}</b>
                    <strong>{leader.player_name}</strong>
                    <span>
                      {leader.status === "won"
                        ? "FINISHED · "
                        : `ROUTE ${leader.stage} · `}
                      {Number(leader.score).toLocaleString()} PTS
                      <small>
                        {leader.delivered} DELIVERED · {leader.hits} HITS ·{" "}
                        {leader.game_version} · {leader.missed} MISSED
                      </small>
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
