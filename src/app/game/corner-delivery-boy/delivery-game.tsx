"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  DELIVERY_CAR_CRASHES,
  DELIVERY_COLLISION_FAILURES,
  DELIVERY_FACEBOOK_PEOPLE,
  DELIVERY_FACEBOOK_URL,
  DELIVERY_FAILURES,
  DELIVERY_FIRED,
  DELIVERY_PRIZE,
  DELIVERY_STAGES,
} from "@/lib/delivery-boy/config";
import { deliveryAudio } from "@/lib/games/delivery-audio";
import { perfectionPenalty } from "@/lib/games/complaints";
import { MenuAdTicker } from "@/app/games/components/menu-ad-ticker";
import { buildFeed, FacebookFeed, reactions, type FacebookPost } from "./facebook-feed";
import { drawStreet, porchPoint, type StreetFrame } from "./street-renderer";
import { loadAssets, type Assets } from "./art-assets";
import { lotKindFor } from "./lots";
import {
  collisionRadius,
  CONDITION_BONUS_PER_POINT,
  CRITTERS,
  DEADLY,
  EXTRA_SUBS,
  freshFx,
  HAZARD_LANE_MIN,
  HAZARD_LANE_SPAN,
  HOUSE_SPAWN_Y,
  inThrowWindow,
  INVULNERABLE_SECONDS,
  LANE_MAX,
  LANE_MIN,
  laneX,
  LOT_JITTER,
  LOT_SPACING,
  ONCOMING_LANE,
  PARKED_LANE,
  pctY,
  PERFECT_SHIFT_BONUS,
  PICKUPS,
  PLAYER_Y,
  PORCH_WINDOW,
  RESIDENTIAL,
  RESTOCK_SUBS,
  SAMPLE_POINTS,
  SCREEN_H,
  SCREEN_W,
  SCROLL_RATE,
  START_LANE,
  STEER_RATE,
  touchesPlayer,
  STREETS,
  SUBS_LEFT_BONUS,
  WRECK_SECONDS,
  type Fx,
  type HazardType,
  type House,
  type Scenery,
  type Side,
  type Stats,
  type Thing,
} from "./street-model";
type Run = { runId: string; token: string };
type Reward = {
  code?: string;
  prize_type?: string;
  expires_at?: string;
  error?: string;
};
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
type Sfx =
  | "throw"
  | "delivery"
  | "miss"
  | "crash"
  | "start"
  | "steer"
  | "gameover"
  | "menu"
  | "bark"
  | "meow"
  | "moo"
  | "squish"
  | "ouch"
  | "victory";
type Mode = "home" | "play" | "between" | "won" | "lost";
const quips = [
  "SUB SECURED",
  "PORCH PERFECT",
  "YEET DELIVERY",
  "BREAD HAS LANDED",
  "DINNER DEPLOYED",
  "ABSOLUTELY DELIVERED",
];
const orderPayloads = [
  "Italian Sub",
  "Big Boss Sub",
  "Chicken Parm Sub",
  "Jumbo Pizza Box",
  "Steak Sub",
  "Turkey Sub",
  "Wing Bucket",
  "Meatball Sub",
];
const HIGH_SCORE_KEY = "corner-delivery-high-score";
const DRIVER_NAME_KEY = "corner-delivery-driver-name";
const REDUCED_EFFECTS_KEY = "corner-delivery-reduced-effects";
const fresh = (): Stats => ({
  score: 0,
  delivered: 0,
  missed: 0,
  hits: 0,
  combo: 0,
  bestCombo: 0,
});
const pick = <T,>(items: readonly T[]) =>
  items[Math.floor(Math.random() * items.length)];
const recentFailures = new Map<string, string[]>();
function pickFailure(key: string, pool: readonly string[]) {
  const recent = recentFailures.get(key) || [];
  const available = pool.filter((line) => !recent.includes(line));
  const selected = pick(available.length ? available : pool);
  recentFailures.set(key, [...recent.slice(-4), selected]);
  return selected;
}
function storageGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
type Sim = {
  stage: number;
  lane: number;
  things: Thing[];
  houses: House[];
  scenery: Scenery[];
  distance: number;
  time: number;
  health: number;
  ammo: number;
  routeDelivered: number;
  porchPerfects: number;
  samples: number;
  log: House[];
  boost: number;
  slow: number;
  damaged: number;
  invulnerable: number;
  spawnTimer: number;
  sceneryTimer: number;
  potholeTimer: number;
  parkedTimer: number;
  racerTimer: number;
  steer: number;
  /** When each order comes in, and on which side of the street. */
  plan: { at: number; side: Side }[];
  waiting: Record<Side, number>;
  nextLot: Record<Side, number>;
  lotNumber: Record<Side, number>;
  stats: Stats;
  lastImpact: string;
  ending: boolean;
};
let houseId = 0;
function makeHouse(stage: number, side: Side, y: number, number: number, customer: boolean): House {
  return {
    id: ++houseId,
    side,
    y,
    customer,
    number,
    address: `${number} ${STREETS[stage - 1]}`,
    item: pick(orderPayloads),
    kind: lotKindFor(stage, number),
    seed: stage * 100003 + number * 7919,
    state: "pending",
  };
}
function newSim(stage: number, stats: Stats): Sim {
  const route = DELIVERY_STAGES[stage - 1];
  // Orders come in steadily through the shift; the last one leaves enough
  // street to reach it even under FROZEN SUB slow-motion.
  const start = 2.5,
    end = route.time - 9,
    gap = (end - start) / route.deliveries;
  const plan = Array.from({ length: route.deliveries }, (_, i) => ({
    at: start + gap * i + Math.random() * gap * 0.4,
    side: (Math.random() > 0.5 ? "right" : "left") as Side,
  }));
  // The block is already built when the shift starts: houses line both sides.
  const houses: House[] = [],
    lotNumber = { left: 98 + stage * 100, right: 99 + stage * 100 },
    nextLot = { left: 0, right: 0 };
  for (const side of ["left", "right"] as const) {
    let y = side === "left" ? 92 : 80;
    for (; y > HOUSE_SPAWN_Y; y -= LOT_SPACING) {
      lotNumber[side] += 2;
      houses.push(makeHouse(stage, side, y, lotNumber[side], false));
    }
    nextLot[side] = HOUSE_SPAWN_Y + LOT_SPACING - (y + LOT_SPACING);
  }
  return {
    stage,
    lane: START_LANE,
    things: [],
    houses,
    scenery: [],
    distance: 0,
    time: route.time,
    health: 3,
    ammo: route.deliveries + EXTRA_SUBS,
    routeDelivered: 0,
    porchPerfects: 0,
    samples: 0,
    log: [],
    boost: 0,
    slow: 0,
    damaged: 0,
    invulnerable: 0,
    spawnTimer: 0,
    sceneryTimer: 0,
    potholeTimer: 0,
    parkedTimer: 0,
    racerTimer: 0,
    steer: 0,
    plan,
    waiting: { left: 0, right: 0 },
    nextLot,
    lotNumber,
    stats,
    lastImpact: "",
    ending: false,
  };
}
type Frame = Pick<
  Sim,
  "stage" | "routeDelivered" | "porchPerfects" | "samples" | "log" | "stats" | "ending"
>;
const snapshot = (s: Sim): Frame => ({
  stage: s.stage,
  routeDelivered: s.routeDelivered,
  porchPerfects: s.porchPerfects,
  samples: s.samples,
  log: s.log,
  stats: s.stats,
  ending: s.ending,
});
function streetFrame(s: Sim): StreetFrame {
  const route = DELIVERY_STAGES[s.stage - 1];
  return {
    stage: s.stage,
    day: route.day,
    dayName: route.name,
    street: STREETS[s.stage - 1],
    lane: s.lane,
    steer: s.steer,
    things: s.things,
    houses: s.houses,
    scenery: s.scenery,
    distance: s.distance,
    time: s.time,
    totalTime: route.time,
    health: s.health,
    ammo: s.ammo,
    routeDelivered: s.routeDelivered,
    deliveries: route.deliveries,
    quota: route.quota,
    score: s.stats.score,
    combo: s.stats.combo,
    boost: s.boost,
    slow: s.slow,
    damaged: s.damaged,
    invulnerable: s.invulnerable,
  };
}
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
export default function DeliveryGame() {
  const [mode, setMode] = useState<Mode>("home"),
    [name, setName] = useState(""),
    [frame, setFrame] = useState<Frame>(() => snapshot(newSim(1, fresh()))),
    [countdown, setCountdown] = useState<number | null>(null),
    [paused, setPaused] = useState(false),
    [wrecked, setWrecked] = useState<"fired" | "crash" | null>(null),
    [toast, setToast] = useState(""),
    [feed, setFeed] = useState<FacebookPost[]>([]),
    [routeBonus, setRouteBonus] = useState({ subs: 0, condition: 0, perfect: 0 }),
    [checkpointState, setCheckpointState] = useState<
      "idle" | "saving" | "saved" | "error"
    >("idle"),
    [failure, setFailure] = useState(""),
    [run, setRun] = useState<Run | null>(null),
    [starting, setStarting] = useState(false),
    [startError, setStartError] = useState(""),
    [claiming, setClaiming] = useState(false),
    [reward, setReward] = useState<Reward | null>(null),
    [copied, setCopied] = useState(false),
    [best, setBest] = useState(0),
    [newBest, setNewBest] = useState(false),
    [muted, setMuted] = useState(() => deliveryAudio.getSettings().muted),
    [audioSettings, setAudioSettings] = useState(() =>
      deliveryAudio.getSettings(),
    ),
    [showAudio, setShowAudio] = useState(false),
    [reducedEffects, setReducedEffects] = useState(false),
    [practiceMode, setPracticeMode] = useState(false);
  const [showLeaders, setShowLeaders] = useState(false),
    [leaders, setLeaders] = useState<DeliveryLeader[]>([]),
    [leadersState, setLeadersState] = useState<"loading" | "ready" | "error">(
      "loading",
    );
  const sim = useRef<Sim>(newSim(1, fresh())),
    fx = useRef<Fx>(freshFx()),
    keys = useRef(new Set<string>()),
    runRef = useRef<Run | null>(null),
    sequence = useRef(0),
    lossSaved = useRef(false),
    cosmeticId = useRef(0),
    timers = useRef(new Set<number>()),
    canvasRef = useRef<HTMLCanvasElement>(null),
    controlsRef = useRef<HTMLDivElement>(null),
    stepRef = useRef<(dt: number, now: number) => void>(() => {}),
    assetsRef = useRef<Assets | null>(null),
    live = useRef({
      mode: "home" as Mode,
      paused: false,
      running: false,
      countdown: null as number | null,
      wrecked: null as "fired" | "crash" | null,
      reducedEffects: false,
    }),
    touch = useRef({ x: 0, y: 0, moved: false });
  const stage = frame.stage,
    cfg = DELIVERY_STAGES[stage - 1],
    stats = frame.stats,
    running = mode === "play" && (countdown === null || countdown === 0);
  live.current = { mode, paused, running, countdown, wrecked, reducedEffects };

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
  }, []);
  const sfx = useCallback((kind: Sfx) => {
    if (kind === "start") {
      deliveryAudio.play("start");
      deliveryAudio.transition("action");
    } else deliveryAudio.play(kind);
  }, []);
  const pop = useCallback((message: string) => {
    fx.current.toast = { text: message, at: performance.now() };
    setToast(message);
  }, []);
  const scoreBurst = useCallback((text: string, good: boolean) => {
    fx.current.bursts = [
      ...fx.current.bursts.slice(-2),
      { id: ++cosmeticId.current, text, good, at: performance.now() },
    ];
  }, []);
  const vibrate = useCallback((pattern: number | number[]) => {
    if (typeof navigator !== "undefined" && "vibrate" in navigator)
      navigator.vibrate(pattern);
  }, []);
  const impact = useCallback(() => {
    fx.current.shakeAt = performance.now();
  }, []);
  const commit = useCallback(() => setFrame(snapshot(sim.current)), []);

  async function openLeaderboard() {
    setShowLeaders(true);
    setLeadersState("loading");
    try {
      const response = await fetch("/api/delivery-boy/leaderboard");
      const data = await response.json();
      setLeaders(Array.isArray(data.leaders) ? data.leaders : []);
      setLeadersState("ready");
    } catch {
      setLeadersState("error");
    }
  }

  useEffect(() => {
    setBest(Number(storageGet(HIGH_SCORE_KEY) || 0));
    setPracticeMode(new URLSearchParams(window.location.search).has("practice"));
    void loadAssets().then((assets) => (assetsRef.current = assets)).catch(() => {});
    setName(storageGet(DRIVER_NAME_KEY) || "");
    const saved = storageGet(REDUCED_EFFECTS_KEY);
    setReducedEffects(
      saved === null
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : saved === "true",
    );
    const pending = timers.current;
    return () => {
      pending.forEach((id) => clearTimeout(id));
      pending.clear();
      deliveryAudio.stop();
    };
  }, []);
  useEffect(() => {
    deliveryAudio.setMuted(muted);
  }, [muted]);
  // Hiding the tab pauses the shift instead of letting the clock run out.
  useEffect(() => {
    const clearKeys = () => keys.current.clear();
    const visibility = () => {
      if (document.hidden && live.current.mode === "play") setPaused(true);
      if (document.hidden || paused || mode !== "play")
        deliveryAudio.suspend();
      else deliveryAudio.resume();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", clearKeys);
    visibility();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", clearKeys);
    };
  }, [mode, paused]);

  // Personal best + run result reporting.
  useEffect(() => {
    if (mode !== "lost" && mode !== "won") return;
    const previous = Number(storageGet(HIGH_SCORE_KEY) || 0);
    if (stats.score > previous) {
      storageSet(HIGH_SCORE_KEY, String(stats.score));
      setBest(stats.score);
      setNewBest(previous > 0 || stats.score > 0);
    }
  }, [mode, stats.score]);
  useEffect(() => {
    const current = runRef.current;
    if (mode !== "lost" || !current || lossSaved.current) return;
    lossSaved.current = true;
    const s = sim.current;
    const activeSeconds =
      DELIVERY_STAGES.slice(0, s.stage - 1).reduce(
        (total, route) => total + route.time,
        0,
      ) + Math.max(0, DELIVERY_STAGES[s.stage - 1].time - s.time);
    void fetch("/api/delivery-boy/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "loss",
        token: current.token,
        runId: current.runId,
        stage: s.stage,
        activeSeconds: Math.round(activeSeconds),
        score: s.stats.score,
        delivered: s.stats.delivered,
        missed: s.stats.missed,
        hits: s.stats.hits,
      }),
    }).catch(() => {});
  }, [mode]);

  const endRun = useCallback(
    (reason: string, sound: Sfx, kind: "fired" | "crash" = "crash") => {
      const s = sim.current;
      if (s.ending) return;
      s.ending = true;
      keys.current.clear();
      commit();
      setFailure(reason);
      setFeed(buildFeed(s.log, false).slice(0, 2));
      setWrecked(kind);
      impact();
      vibrate([80, 40, 120]);
      sfx(sound);
      if (sound !== "gameover") later(() => sfx("gameover"), 420);
      later(
        () => {
          setWrecked(null);
          setMode("lost");
          deliveryAudio.transition("menu");
        },
        live.current.reducedEffects ? 400 : WRECK_SECONDS * 1000 + 300,
      );
    },
    [commit, impact, later, sfx, vibrate],
  );

  const saveCheckpoint = useCallback(async () => {
    const current = runRef.current;
    if (!current) {
      setCheckpointState("saved");
      return;
    }
    const s = sim.current;
    setCheckpointState("saving");
    const nextSequence = sequence.current + 1;
    const checkpoint = {
      runId: current.runId,
      stage: s.stage,
      sequence: nextSequence,
      activeSeconds: Math.round(
        DELIVERY_STAGES.slice(0, s.stage).reduce((n, r) => n + r.time, 0) -
          s.time,
      ),
      score: s.stats.score,
      delivered: s.stats.delivered,
      missed: s.stats.missed,
      hits: s.stats.hits,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch("/api/delivery-boy/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "checkpoint",
            token: current.token,
            checkpoint,
          }),
        });
        if (response.ok) {
          sequence.current = nextSequence;
          setCheckpointState("saved");
          return;
        }
        // The server rejected the checkpoint itself; retrying won't help.
        if (response.status < 500) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
    }
    setCheckpointState("error");
  }, []);

  // The street is over: keep the job if the quota was met.
  const finishShift = useCallback(() => {
    const s = sim.current;
    if (s.ending) return;
    const route = DELIVERY_STAGES[s.stage - 1];
    if (s.routeDelivered < route.quota) {
      endRun(
        `${pickFailure("fired", DELIVERY_FIRED)} (${s.routeDelivered} of ${route.quota} needed.)`,
        "gameover",
        "fired",
      );
      return;
    }
    s.ending = true;
    keys.current.clear();
    const perfect = s.routeDelivered === route.deliveries,
      bonus = {
        subs: s.ammo * SUBS_LEFT_BONUS,
        condition: s.health * CONDITION_BONUS_PER_POINT,
        perfect: perfect ? PERFECT_SHIFT_BONUS : 0,
      };
    s.stats = {
      ...s.stats,
      score: s.stats.score + bonus.subs + bonus.condition + bonus.perfect,
    };
    commit();
    setRouteBonus(bonus);
    setFeed(buildFeed(s.log, true));
    setMode("between");
    deliveryAudio.transition("menu");
    sfx("victory");
    void saveCheckpoint();
  }, [commit, endRun, saveCheckpoint, sfx]);

  const move = useCallback(
    (d: number) => {
      const s = sim.current;
      if (!live.current.running || live.current.paused || s.ending) return;
      if (Math.abs(d) >= 0.18) {
        fx.current.skidAt = performance.now();
        sfx("steer");
      }
      s.lane = Math.max(
        LANE_MIN,
        Math.min(LANE_MAX, s.lane + d * (s.damaged > 0 ? 0.58 : 1)),
      );
    },
    [sfx],
  );

  // Toss a sub at a side of the street. "auto" aims at the order in range.
  const toss = useCallback(
    (aim: Side | "auto") => {
      const s = sim.current;
      if (!live.current.running || live.current.paused || s.ending) return;
      if (s.ammo <= 0) {
        pop("OUT OF SUBS! GRAB A SUB BAG OFF THE ROAD");
        sfx("miss");
        return;
      }
      const reachable = s.houses.filter(
        (h) =>
          inThrowWindow(h.y) &&
          (h.state === "pending" || (!h.customer && h.state !== "sampled")),
      );
      const centered = (a: House, b: House) =>
        Math.abs(a.y - 75) - Math.abs(b.y - 75);
      const side: Side =
        aim !== "auto"
          ? aim
          : ([...reachable].filter((h) => h.customer && h.state === "pending").sort(centered)[0] ??
              [...reachable].sort(centered)[0])?.side ??
            (s.lane < 1 ? "left" : "right");
      const house = reachable
        .filter((h) => h.side === side)
        .sort((a, b) => Number(b.customer) - Number(a.customer) || centered(a, b))[0];
      const now = performance.now(),
        from = { x: laneX(s.lane), y: pctY(PLAYER_Y) - 6 },
        to = house
          ? porchPoint(side, house.y, house)
          : { x: side === "left" ? 36 : SCREEN_W - 36, y: from.y - 26 };
      s.ammo -= 1;
      fx.current.throws = [
        ...fx.current.throws,
        { id: ++cosmeticId.current, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, at: now },
      ];
      sfx("throw");
      // Like Paperboy, you have to be on that half of the road to reach the porch.
      const farSide = side === "left" ? s.lane > 1.35 : s.lane < 0.65;
      if (!house || farSide) {
        s.stats = { ...s.stats, score: Math.max(0, s.stats.score - 25), combo: 0 };
        scoreBurst("SHRUB -25", false);
        pop(
          farSide
            ? "TOO FAR! DRIVE CLOSER TO THAT SIDE"
            : "NOTHING THERE. A SHRUB ATE WELL TONIGHT.",
        );
        sfx("miss");
        return;
      }
      const burst = () =>
        later(() => {
          fx.current.particles = [
            ...fx.current.particles,
            { id: ++cosmeticId.current, x: to.x, y: to.y, at: performance.now() },
          ];
        }, 300);
      if (!house.customer) {
        house.state = "sampled";
        s.samples += 1;
        s.log = [...s.log, { ...house }];
        s.stats = { ...s.stats, score: s.stats.score + SAMPLE_POINTS };
        burst();
        scoreBurst(`SAMPLE +${SAMPLE_POINTS}`, true);
        pop("FREE SAMPLE! THEY DIDN'T ORDER. THEY WILL BE POSTING ABOUT THIS.");
        later(() => sfx("delivery"), 190);
        return;
      }
      const porch = house.y >= PORCH_WINDOW.start && house.y <= PORCH_WINDOW.end,
        combo = s.stats.combo + 1,
        multiplier = Math.min(4, combo),
        points = (porch ? 200 : 100) * multiplier;
      house.state = "delivered";
      house.landed = porch ? "porch" : "lawn";
      s.log = [...s.log, { ...house }];
      s.routeDelivered += 1;
      if (porch) s.porchPerfects += 1;
      s.stats = {
        ...s.stats,
        delivered: s.stats.delivered + 1,
        combo,
        bestCombo: Math.max(s.stats.bestCombo, combo),
        score: s.stats.score + points,
      };
      if (porch) s.boost = Math.max(s.boost, 2);
      burst();
      scoreBurst(`${porch ? "PORCH" : "LAWN"} +${points}`, true);
      vibrate([15, 30]);
      // A perfect porch landing can still earn a complaint.
      const penalty = porch ? perfectionPenalty(0.2, 150) : null;
      if (penalty) {
        s.stats = { ...s.stats, score: Math.max(0, s.stats.score - penalty.points) };
        later(() => scoreBurst(`COMPLAINT -${penalty.points}`, false), 450);
        pop(penalty.complaint);
      } else pop(porch ? pick(quips) : "ON THE LAWN. THEY WILL MENTION THIS.");
      later(() => sfx("delivery"), 190);
    },
    [later, pop, scoreBurst, sfx, vibrate],
  );

  // Keyboard: steering is read from `keys` by the simulation.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (showLeaders) {
        if (e.key === "Escape") setShowLeaders(false);
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (mode !== "play") return;
      const key = e.key.toLowerCase();
      if (key === "p" || key === "escape") {
        e.preventDefault();
        if (!sim.current.ending) setPaused((value) => !value);
        return;
      }
      if (["arrowleft", "arrowright", "a", "d", " "].includes(key))
        e.preventDefault();
      keys.current.add(key);
      if (e.repeat) return;
      if (key === "q" || key === "z") toss("left");
      else if (key === "e" || key === "x") toss("right");
      else if ([" ", "enter", "w", "arrowup"].includes(key)) {
        e.preventDefault();
        toss("auto");
      }
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [toss, mode, showLeaders]);

  // 3-2-1-GO before each shift.
  useEffect(() => {
    if (mode !== "play" || countdown === null || paused) return;
    const id = window.setTimeout(
      () => {
        if (countdown > 1) sfx("menu");
        else if (countdown === 1) sfx("start");
        setCountdown(countdown === 0 ? null : countdown - 1);
      },
      countdown === 0 ? 450 : 700,
    );
    return () => clearTimeout(id);
  }, [countdown, mode, paused, sfx]);

  // One simulation step. Assigned every render so it always sees the latest
  // callbacks; the animation loop below calls it through stepRef.
  stepRef.current = (dt: number, now: number) => {
    const s = sim.current;
    const route = DELIVERY_STAGES[s.stage - 1];
    s.time = Math.max(0, s.time - dt);
    s.boost = Math.max(0, s.boost - dt);
    s.slow = Math.max(0, s.slow - dt);
    s.damaged = Math.max(0, s.damaged - dt);
    s.invulnerable = Math.max(0, s.invulnerable - dt);
    s.spawnTimer += dt;
    s.sceneryTimer += dt;

    const held = keys.current,
      left = held.has("arrowleft") || held.has("a") || held.has("touch-left"),
      right = held.has("arrowright") || held.has("d") || held.has("touch-right");
    // Ease the car's heading toward the steering direction (for drawing).
    s.steer += ((left === right ? 0 : right ? 1 : -1) - s.steer) * Math.min(1, dt * 10);
    if (left !== right)
      s.lane = Math.max(
        LANE_MIN,
        Math.min(
          LANE_MAX,
          s.lane + (right ? 1 : -1) * dt * STEER_RATE * (s.damaged > 0 ? 0.58 : 1),
        ),
      );

    const speed = Math.max(
        0.65,
        (route.speed + (s.boost > 0 ? 65 : 0) - (s.slow > 0 ? 120 : 0)) / 100,
      ),
      elapsed = route.time - s.time,
      speedRamp = 1 + Math.floor(Math.max(0, elapsed) / 30) * 0.08,
      scroll = dt * speed * SCROLL_RATE;
    s.distance += scroll;
    if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250))
      deliveryAudio.setIntensity(
        Math.min(1, (route.speed + (s.boost > 0 ? 65 : 0)) / 330),
        Math.max(0, Math.min(1, (20 - s.time) / 20)),
      );

    // Traffic, critters and pickups.
    // Monday is gentle; it gets busier through the week. Nothing spawns in
    // the first few seconds of a shift.
    const calm = elapsed < 3.5;
    if (calm) {
      s.spawnTimer = 0;
      s.parkedTimer = 0;
      s.potholeTimer = 0;
    }
    if (s.spawnTimer > [2.1, 1.6, 1.3, 1.05, 0.85][s.stage - 1]) {
      s.spawnTimer = 0;
      const crowded =
        s.things.filter((x) => x.y < 8 && !PICKUPS.has(x.type)).length >= 2;
      const types: HazardType[] =
          s.stage <= 1
            ? ["squirrel", "cat", "dog", "goose", "squirrel", "ebike"]
            : s.stage <= 3
              ? ["dog", "cat", "raccoon", "person", "car", "mower", "goose", "ebike", "ebike", "tarpcar"]
              : ["deer", "deer", "dog", "goose", "cow", "person", "car", "van", "mower", "ebike", "tarpcar"],
        restockChance = s.ammo <= 2 ? 0.14 : 0.05,
        roll = Math.random(),
        type: Thing["type"] =
          roll < 0.07
            ? "slow"
            : roll < 0.15
              ? "boost"
              : roll < 0.15 + restockChance
                ? "restock"
                : pick(types);
      if (!crowded || PICKUPS.has(type)) {
        const crossing = CRITTERS.has(type) && Math.random() < 0.55,
          fromLeft = Math.random() < 0.5,
          // Tarp-covered cars sit parked against a curb; traffic keeps to its lane.
          parked =
            type === "tarpcar"
              ? fromLeft
                ? PARKED_LANE.left
                : PARKED_LANE.right
              : type === "car" || type === "van"
                ? ONCOMING_LANE.min + Math.random() * (ONCOMING_LANE.max - ONCOMING_LANE.min)
                : null;
        s.things = [
          ...s.things,
          {
            id: ++cosmeticId.current,
            type,
            lane:
              parked ??
              (crossing
                ? fromLeft
                  ? -0.3
                  : 2.3
                : HAZARD_LANE_MIN + Math.random() * HAZARD_LANE_SPAN),
            y: crossing ? 8 + Math.random() * 25 : -12,
            vx: crossing ? (fromLeft ? 1 : -1) * ((s.stage === 1 ? 0.32 : 0.45) + Math.random() * 0.4) : 0,
            speed:
              type === "car"
                ? 1.6
                : type === "van"
                  ? 1.4
                  : type === "ebike"
                    ? 1.5
                    : type === "mower" || type === "goose"
                      ? 1.2
                      : 1,
            variant: Math.floor(Math.random() * 12),
            phase: Math.random() * Math.PI * 2,
          },
        ];
      }
    }
    // Cars parked along both curbs narrow the street.
    s.parkedTimer += dt;
    if (s.parkedTimer > [3.2, 2.4, 1.8, 1.5, 1.3][s.stage - 1] + Math.random() * 2) {
      s.parkedTimer = 0;
      const side = Math.random() < 0.5 ? "left" : "right",
        lane = PARKED_LANE[side],
        clear = !s.things.some(
          (t) => (t.type === "parked" || t.type === "tarpcar") && Math.abs(t.lane - lane) < 0.2 && t.y < 20,
        );
      if (clear)
        s.things = [
          ...s.things,
          {
            id: ++cosmeticId.current,
            type: Math.random() < 0.18 ? "tarpcar" : "parked",
            lane,
            y: -14,
            variant: Math.floor(Math.random() * 12),
            // Right-side cars face our way (we see the back); left-side ones face us.
            size: side === "right" ? 1 : 0,
          },
        ];
    }
    // Harder days: cars race by, head-on down the other lane or passing us in it.
    if (s.stage >= 3) {
      s.racerTimer += dt;
      if (s.racerTimer > Math.max(3, 9 - s.stage * 1.2) + Math.random() * 3) {
        s.racerTimer = 0;
        const fromBehind = Math.random() < 0.45;
        s.things = [
          ...s.things,
          {
            id: ++cosmeticId.current,
            type: "racer",
            lane: ONCOMING_LANE.min + Math.random() * (ONCOMING_LANE.max - ONCOMING_LANE.min),
            y: fromBehind ? 116 : -20,
            speed: fromBehind ? -1.6 : 2.8,
            variant: Math.floor(Math.random() * 12),
          },
        ];
        pop(fromBehind ? "CAR PASSING ON YOUR LEFT!" : "SOMEONE IS RACING DOWN THE OTHER LANE!");
      }
    }
    // Ogdensburg potholes: random, frequent, all sizes.
    s.potholeTimer += dt;
    if (s.potholeTimer > [2.6, 2, 1.6, 1.3, 1.1][s.stage - 1] + Math.random() * 1.6) {
      s.potholeTimer = 0;
      s.things = [
        ...s.things,
        {
          id: ++cosmeticId.current,
          type: "pothole",
          lane: 0.1 + Math.random() * 1.8,
          y: -8,
          size: 0.6 + Math.random() * 1,
        },
      ];
    }
    // Orders that have come in wait for the next house on their side.
    while (s.plan.length && s.plan[0].at <= elapsed) s.waiting[s.plan.shift()!.side]++;
    for (const side of ["left", "right"] as const)
      if (s.distance >= s.nextLot[side]) {
        s.nextLot[side] = s.distance + LOT_SPACING + Math.random() * LOT_JITTER;
        s.lotNumber[side] += 2;
        // Orders only come from homes; a waiting order takes the next house.
        const customer =
          s.waiting[side] > 0 && RESIDENTIAL.has(lotKindFor(s.stage, s.lotNumber[side]));
        if (customer) s.waiting[side]--;
        s.houses = [
          ...s.houses,
          makeHouse(s.stage, side, HOUSE_SPAWN_Y, s.lotNumber[side], customer),
        ];
      }
    if (s.sceneryTimer > 2.4) {
      s.sceneryTimer = 0;
      const kinds: Scenery["kind"][] = ["pole", "pole", "trash", "trash", "cart", "tent", "abandoned", "dumpster"];
      s.scenery = [
        ...s.scenery.slice(-10),
        {
          id: ++cosmeticId.current,
          kind: pick(kinds),
          side: Math.random() > 0.5 ? "right" : "left",
          y: -14,
        },
      ];
    }

    const hit = (damage: number, penalty: number, reason: string, message: string, sound: Sfx) => {
      s.lastImpact = reason;
      s.health = Math.max(0, s.health - damage);
      s.invulnerable = INVULNERABLE_SECONDS;
      s.stats = {
        ...s.stats,
        score: Math.max(0, s.stats.score - penalty),
        hits: s.stats.hits + 1,
        combo: 0,
      };
      if (penalty) scoreBurst(`-${penalty}`, false);
      if (damage) {
        impact();
        vibrate(60);
      }
      pop(message);
      sfx(sound);
    };

    const things: Thing[] = [];
    for (const x of s.things) {
      const moving = (x.speed ?? 1) !== 1,
        n = {
          ...x,
          y: x.y + scroll * (moving ? speedRamp * (x.speed ?? 1) : 1),
          lane:
            x.lane +
            (x.vx ?? 0) * dt +
            // Kids on e-bikes weave across the street.
            (x.type === "ebike" ? Math.cos(x.phase ?? 0) * dt * 1.1 : 0),
          phase: (x.phase ?? 0) + dt * 2.6,
        };
      const gone = n.y >= 118 || n.y < -30 || n.lane < -0.7 || n.lane > 2.7;
      const touching =
        touchesPlayer(n.type, n.y) && Math.abs(n.lane - s.lane) < collisionRadius(n.type, n.size);
      if (!touching) {
        if (!gone) things.push(n);
        continue;
      }
      if (n.type === "restock") {
        s.ammo += RESTOCK_SUBS;
        pop(`SUB BAG! +${RESTOCK_SUBS} SUBS`);
        scoreBurst(`+${RESTOCK_SUBS} SUBS`, true);
        sfx("delivery");
        continue;
      }
      if (n.type === "boost" || n.type === "slow") {
        if (n.type === "boost") {
          s.boost = 4;
          pop("TURBO PICKLE! +350");
        } else {
          s.slow = 6;
          pop("FROZEN SUB TIME! TRAFFIC SLOWED");
        }
        s.stats = { ...s.stats, score: s.stats.score + 350 };
        scoreBurst("+350", true);
        sfx("delivery");
        continue;
      }
      // Freshly hit: everything passes through while the car blinks.
      if (s.invulnerable > 0) {
        if (!gone) things.push(n);
        continue;
      }
      if ((n.type === "car" || n.type === "van" || n.type === "racer") && Math.abs(n.lane - s.lane) >= 0.12) {
        s.damaged = 4;
        hit(1, 500, pickFailure("car", DELIVERY_CAR_CRASHES),
          "SIDESWIPE! -500. ALIGNMENT NOW PROVIDED BY A SHOPPING CART.", "crash");
        continue;
      }
      if (DEADLY.has(n.type)) {
        s.stats = { ...s.stats, hits: s.stats.hits + 1, combo: 0 };
        s.things = things;
        endRun(
          n.type === "car" || n.type === "van" || n.type === "racer"
            ? pickFailure("car", DELIVERY_CAR_CRASHES)
            : pickFailure(n.type, DELIVERY_COLLISION_FAILURES[n.type as "cow" | "person" | "mower"]),
          n.type === "person" ? "ouch" : n.type === "cow" ? "moo" : "crash",
        );
        return;
      }
      switch (n.type) {
        case "squirrel":
          hit(0, 100, pickFailure("squirrel", DELIVERY_COLLISION_FAILURES.squirrel),
            "SQUIRREL TAP! IT HAS RETAINED COUNSEL.", "squish");
          break;
        case "cat":
          hit(1, 175, pickFailure("cat", DELIVERY_COLLISION_FAILURES.cat),
            "CAT INCIDENT! IT WILL BE REVIEWING THIS RIDE ONLINE.", "meow");
          break;
        case "goose":
        case "raccoon":
          hit(1, 150, pickFailure(n.type, DELIVERY_COLLISION_FAILURES[n.type]),
            n.type === "goose"
              ? "GOOSE INCIDENT! IT HAS CLAIMED THE LANE AND YOUR INSURANCE."
              : "RACCOON INCIDENT! THE SUB HAS BEEN RECLASSIFIED AS TRASH.", "crash");
          break;
        case "deer":
          hit(2, 0, pickFailure("deer", DELIVERY_COLLISION_FAILURES.deer),
            "YOU HIT A DEER. THE DEER IS ANGRY.", "crash");
          break;
        case "dog":
          hit(1, 0, pickFailure("dog", DELIVERY_COLLISION_FAILURES.dog),
            "DOG INCIDENT! EVERY PORCH CAMERA SAW THAT.", "bark");
          break;
        case "ebike":
          hit(1, 200, pickFailure("ebike", DELIVERY_COLLISION_FAILURES.ebike),
            "E-BIKE KID! HE IS FINE. HE IS ALREADY FILMING IT.", "ouch");
          break;
        case "tarpcar":
          hit(1, 300, pickFailure("tarpcar", DELIVERY_COLLISION_FAILURES.tarpcar),
            "YOU HIT THE TARP CAR. IT HAS NOT MOVED SINCE 2011.", "crash");
          break;
        case "parked":
          hit(1, 250, pickFailure("car", DELIVERY_CAR_CRASHES),
            "PARKED CAR! THE OWNER WAS WATCHING FROM THE PORCH.", "crash");
          break;
        case "pothole":
          if ((n.size ?? 1) < 0.95) {
            s.stats = { ...s.stats, score: Math.max(0, s.stats.score - 50) };
            impact();
            scoreBurst("BUMP -50", false);
            sfx("crash");
            break;
          }
          hit(1, 0, pickFailure("pothole", DELIVERY_COLLISION_FAILURES.pothole),
            "POTHOLE! THE SUSPENSION HAS FILED A COMPLAINT.", "crash");
          break;
        default:
          hit(1, 0, pickFailure("pothole", DELIVERY_COLLISION_FAILURES.pothole),
            "POTHOLE! THE SUSPENSION HAS FILED A COMPLAINT.", "crash");
      }
    }
    s.things = things;

    const houses: House[] = [];
    for (const h of s.houses) {
      h.y += scroll;
      if (h.customer && h.state === "pending" && h.y > 100) {
        h.state = "missed";
        s.log = [...s.log, { ...h }];
        s.stats = { ...s.stats, missed: s.stats.missed + 1, combo: 0 };
        pop(`MISSED ${h.address}. THEY'RE ALREADY TYPING.`);
        scoreBurst("MISSED", false);
      }
      if (h.y < 124) houses.push(h);
    }
    s.houses = houses;

    const scenery: Scenery[] = [];
    for (const x of s.scenery) {
      const n = { ...x, y: x.y + scroll },
        onCurb =
          (s.lane < -0.04 && n.side === "left") || (s.lane > 2.04 && n.side === "right");
      if (
        s.invulnerable <= 0 &&
        n.y > 80 &&
        n.y < 90 &&
        onCurb &&
        (n.kind === "abandoned" || n.kind === "tent" || n.kind === "dumpster")
      ) {
        s.stats = { ...s.stats, hits: s.stats.hits + 1, combo: 0 };
        s.scenery = scenery;
        endRun(
          pickFailure(n.kind, DELIVERY_COLLISION_FAILURES[n.kind === "dumpster" ? "abandoned" : n.kind]),
          n.kind === "tent" ? "ouch" : "crash",
        );
        return;
      }
      if (n.y < 116) scenery.push(n);
    }
    s.scenery = scenery;

    if (s.health <= 0) {
      endRun(s.lastImpact || pickFailure("route", DELIVERY_FAILURES), "crash");
      return;
    }
    if (s.time <= 0) finishShift();
  };

  // Render loop: always draws while on the street; only steps when running.
  useEffect(() => {
    if (mode !== "play") return;
    const canvas = canvasRef.current,
      ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const fit = () => {
      const controls = controlsRef.current?.offsetHeight ?? 0;
      let scale = Math.min(window.innerWidth / SCREEN_W, (window.innerHeight - controls - 8) / SCREEN_H);
      // Whole-number scaling keeps every pixel the same size where there's room.
      if (scale >= 2) scale = Math.floor(scale);
      canvas.style.width = `${Math.floor(SCREEN_W * scale)}px`;
      canvas.style.height = `${Math.floor(SCREEN_H * scale)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    let raf = 0,
      last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.04, (now - last) / 1000);
      last = now;
      const state = live.current,
        f = fx.current;
      if (state.running && !state.paused && !sim.current.ending) stepRef.current(dt, now);
      // Lets automated play-tests read the street in development builds.
      if (process.env.NODE_ENV !== "production")
        (window as unknown as { __deliverySim?: Sim }).__deliverySim = sim.current;
      if (f.toast && now - f.toast.at > 1500 + f.toast.text.length * 28) f.toast = null;
      f.bursts = f.bursts.filter((b) => now - b.at < 900);
      f.throws = f.throws.filter((t) => now - t.at < 330);
      f.particles = f.particles.filter((p) => now - p.at < 600);
      if (assetsRef.current)
        drawStreet(ctx, streetFrame(sim.current), f, {
          countdown: state.countdown,
          wrecked: state.wrecked,
          reducedEffects: state.reducedEffects,
        }, now, assetsRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, [mode]);

  function begin(n: number, carried: Stats) {
    sim.current = newSim(n, carried);
    fx.current = freshFx();
    keys.current.clear();
    setFrame(snapshot(sim.current));
    setToast("");
    setFailure("");
    setFeed([]);
    setWrecked(null);
    setPaused(false);
    setCheckpointState("idle");
    setCountdown(3);
    deliveryAudio.transition("action");
    setMode("play");
  }
  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (starting) return;
    setStarting(true);
    setStartError("");
    storageSet(DRIVER_NAME_KEY, name.trim());
    try {
      assetsRef.current = await loadAssets();
      const response = await fetch("/api/delivery-boy/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", playerName: name }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStartError(data.error || "Dispatch could not start your shift.");
        return;
      }
      runRef.current = data;
      setRun(data);
      sequence.current = 0;
      lossSaved.current = false;
      setReward(null);
      setNewBest(false);
      setCopied(false);
      begin(1, fresh());
    } catch {
      setStartError("Dispatch is offline. Check your connection and try again.");
    } finally {
      setStarting(false);
    }
  }
  // Testing only (?practice in the URL): jump straight to any day. Practice
  // shifts never contact the server, so they can't earn a prize.
  async function practice(day: number) {
    try {
      assetsRef.current = await loadAssets();
    } catch {
      setStartError("Could not load the game art. Refresh and try again.");
      return;
    }
    runRef.current = null;
    setRun(null);
    setReward(null);
    setNewBest(false);
    begin(day, fresh());
  }
  async function nextRoute() {
    if (checkpointState === "saving") return;
    if (checkpointState === "error") {
      void saveCheckpoint();
      return;
    }
    if (stage < DELIVERY_STAGES.length) {
      begin(stage + 1, sim.current.stats);
      return;
    }
    if (!run) {
      setMode("home");
      return;
    }
    if (claiming) return;
    setClaiming(true);
    try {
      const response = await fetch("/api/delivery-boy/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "complete", runId: run.runId, token: run.token }),
      });
      const data: Reward = await response.json().catch(() => ({}));
      setReward(response.ok ? data : { error: data.error || "Prize could not be issued." });
      if (response.ok) sfx("victory");
      setMode(response.ok ? "won" : "lost");
    } catch {
      setReward({ error: "Dispatch is offline. Tap CLAIM again in a moment." });
    } finally {
      setClaiming(false);
    }
  }
  function copyCode() {
    if (!reward?.code) return;
    void navigator.clipboard?.writeText(reward.code).then(
      () => setCopied(true),
      () => {},
    );
  }
  function holdSteer(direction: Side, held: boolean) {
    keys.current[held ? "add" : "delete"](`touch-${direction}`);
  }
  function touchEnd(e: React.TouchEvent<HTMLElement>) {
    const p = e.changedTouches[0],
      dx = p.clientX - touch.current.x,
      dy = p.clientY - touch.current.y;
    if (touch.current.moved || Math.hypot(dx, dy) >= 18) return;
    // Tap a side of the street to toss a sub that way.
    const box = e.currentTarget.getBoundingClientRect();
    toss(p.clientX < box.left + box.width / 2 ? "left" : "right");
  }
  function touchMove(e: React.TouchEvent) {
    const p = e.touches[0],
      dx = p.clientX - touch.current.x;
    if (Math.abs(dx) > 3) {
      move(dx / 150);
      touch.current = { x: p.clientX, y: p.clientY, moved: true };
    }
  }
  const bestLine = newBest ? (
    <div className="new-best">NEW PERSONAL BEST · {stats.score.toLocaleString()}</div>
  ) : best > 0 ? (
    <div className="home-best">YOUR BEST · {best.toLocaleString()}</div>
  ) : null;
  const shiftReport = (
    <div className="route-report" aria-label="Shift report">
      {frame.log
        .filter((h) => h.customer)
        .map((h) => (
          <span className={h.state} key={h.id}>
            <b>{h.address}</b>
            {h.state === "delivered"
              ? h.landed === "porch"
                ? "✓ PORCH"
                : "✓ LAWN"
              : "✗ MISSED"}
          </span>
        ))}
      {frame.samples > 0 && (
        <span className="sampled">
          <b>FREE SAMPLES</b>
          {frame.samples} HOUSES THAT DIDN&apos;T ORDER
        </span>
      )}
    </div>
  );
  return (
    <main className={`delivery-boy ${mode === "play" ? "on-street" : ""}`}>
      {mode === "home" && (
        <form className="delivery-home" onSubmit={start}>
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
            <img src="/games/delivery-boy/delivery-suv-pixel-v2.png" alt="Corner Deli delivery car" />
          </div>
          <p>
            Five shifts. One Equinox. Toss subs onto porches at 30 mph. Make
            quota and the customers will still complain on Facebook.
          </p>
          <MenuAdTicker />
          <input
            value={name}
            maxLength={40}
            aria-label="Driver name"
            onChange={(e) => setName(e.target.value)}
            placeholder="Driver name"
          />
          <button type="submit" disabled={starting}>
            {starting ? "WARMING UP THE ENGINE…" : "CLOCK IN"}
          </button>
          {startError && (
            <div className="start-error" role="alert">
              {startError}
            </div>
          )}
          {bestLine}
          <button type="button" className="driver-leaderboard-button" onClick={openLeaderboard}>
            DRIVER LEADERBOARD
          </button>
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
          {DELIVERY_FACEBOOK_URL && (
            <a className="fb-real-link home" href={DELIVERY_FACEBOOK_URL} target="_blank" rel="noreferrer">
              Read the real reviews on Corner Deli&apos;s Facebook →
            </a>
          )}
          <ul className="how-to-play">
            <li>
              <b>STEER</b> ← → / A D, hold the arrows, or swipe
            </li>
            <li>
              <b>TOSS</b> Q / E to toss left / right, SPACE aims for you, or tap that side of the street
            </li>
            <li>
              <b>ORDERS</b> houses marked ORDER with the red mailbox flag up. Land it on the PORCH for double points
            </li>
            <li>
              <b>QUOTA</b> hit each shift&apos;s quota before the street ends
            </li>
            <li>
              <b>SAMPLES</b> dim houses didn&apos;t order. Toss one anyway. See what happens
            </li>
            <li>
              <b>SUB BAGS</b> on the road refill your subs
            </li>
          </ul>
          <div className="sub-prize">SURVIVE MONDAY–FRIDAY · WIN: {DELIVERY_PRIZE.name.toUpperCase()}</div>
          {practiceMode && (
            <div className="practice-days">
              <b>PRACTICE (TESTING ONLY · NO PRIZE)</b>
              {DELIVERY_STAGES.map((route, index) => (
                <button type="button" key={route.day} onClick={() => void practice(index + 1)}>
                  {route.day.slice(0, 3)}
                  {index >= 3 ? " ☾" : ""}
                </button>
              ))}
            </div>
          )}
        </form>
      )}
      {mode === "play" && (
        <section className="paperboy-stage">
          <div className="paperboy-screen">
            <canvas
              ref={canvasRef}
              width={SCREEN_W}
              height={SCREEN_H}
              role="img"
              aria-label={`${cfg.day} shift on ${STREETS[stage - 1]}`}
              onTouchStart={(e) =>
                (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false })
              }
              onTouchMove={touchMove}
              onTouchEnd={touchEnd}
            />
            {paused && (
              <div className="pause-card">
                <b>SHIFT PAUSED</b>
                <span>Press P or Esc to keep disappointing customers.</span>
                <button onClick={() => setPaused(false)}>RESUME</button>
              </div>
            )}
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
                        const next = { ...audioSettings, [channel]: Number(event.target.value) };
                        setAudioSettings(next);
                        deliveryAudio.setLevels({ [channel]: next[channel] });
                      }}
                    />
                  </label>
                ))}
                <label>
                  <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} />{" "}
                  MUTE
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={reducedEffects}
                    onChange={(event) => {
                      setReducedEffects(event.target.checked);
                      storageSet(REDUCED_EFFECTS_KEY, String(event.target.checked));
                    }}
                  />{" "}
                  REDUCED EFFECTS
                </label>
              </aside>
            )}
            <p className="sr-only" aria-live="polite">
              {toast}
            </p>
          </div>
          <div className="paperboy-controls" ref={controlsRef}>
            <div className="touch-controls paperboy">
              <button
                aria-label="Steer left"
                onPointerDown={() => {
                  move(-0.25);
                  holdSteer("left", true);
                }}
                onPointerUp={() => holdSteer("left", false)}
                onPointerLeave={() => holdSteer("left", false)}
                onPointerCancel={() => holdSteer("left", false)}
                onContextMenu={(e) => e.preventDefault()}
              >
                ◀
              </button>
              <button className="deliver" onPointerDown={() => toss("left")}>
                ◤ TOSS
              </button>
              <button className="deliver" onPointerDown={() => toss("right")}>
                TOSS ◥
              </button>
              <button
                aria-label="Steer right"
                onPointerDown={() => {
                  move(0.25);
                  holdSteer("right", true);
                }}
                onPointerUp={() => holdSteer("right", false)}
                onPointerLeave={() => holdSteer("right", false)}
                onPointerCancel={() => holdSteer("right", false)}
                onContextMenu={(e) => e.preventDefault()}
              >
                ▶
              </button>
            </div>
            <div className="paperboy-buttons">
              <button
                aria-label={paused ? "Resume" : "Pause"}
                onClick={() => !frame.ending && setPaused((value) => !value)}
              >
                {paused ? "▶ RESUME" : "❚❚ PAUSE"}
              </button>
              <span className="key-hint">← → STEER · Q / E TOSS · SPACE AUTO-TOSS · P PAUSE</span>
              <button aria-label="Audio settings" onClick={() => setShowAudio(!showAudio)}>
                {muted ? "SOUND OFF" : "SOUND"}
              </button>
            </div>
          </div>
        </section>
      )}
      {mode === "between" && (
        <section className="delivery-summary">
          <small>
            {cfg.day} SURVIVED · SHIFT {stage} OF {DELIVERY_STAGES.length}
          </small>
          <h1>{frame.routeDelivered === cfg.deliveries ? "PERFECT SHIFT" : "YOU KEPT YOUR JOB"}</h1>
          {shiftReport}
          <div className="route-bonus">
            <span>
              SUBS LEFT <b>+{routeBonus.subs.toLocaleString()}</b>
            </span>
            <span>
              CAR CONDITION <b>+{routeBonus.condition.toLocaleString()}</b>
            </span>
            {routeBonus.perfect > 0 && (
              <span>
                EVERY ORDER <b>+{routeBonus.perfect.toLocaleString()}</b>
              </span>
            )}
          </div>
          <div className="route-stats">
            <b>
              {stats.score.toLocaleString()}
              <small>SCORE</small>
            </b>
            <b>
              {frame.porchPerfects}/{frame.routeDelivered}
              <small>ON THE PORCH</small>
            </b>
            <b>
              ×{stats.bestCombo}
              <small>BEST STREAK</small>
            </b>
            <b>
              {stats.hits}
              <small>ANIMAL/OBJECT INCIDENTS</small>
            </b>
          </div>
          <h2 className="fb-heading">MEANWHILE, ON FACEBOOK…</h2>
          <FacebookFeed posts={feed} />
          {checkpointState === "error" && (
            <div className="start-error" role="alert">
              Dispatch didn&apos;t log this shift. Retry so your prize run stays valid.
            </div>
          )}
          {reward?.error && (
            <div className="start-error" role="alert">
              {reward.error}
            </div>
          )}
          <button onClick={nextRoute} disabled={checkpointState === "saving" || claiming}>
            {checkpointState === "saving"
              ? "LOGGING SHIFT…"
              : checkpointState === "error"
                ? "RETRY LOGGING SHIFT"
                : claiming
                  ? "CHECKING YOUR WEEK…"
                  : stage === DELIVERY_STAGES.length
                    ? run
                      ? "CLAIM FREE SUB"
                      : "PRACTICE OVER · MENU"
                    : `CLOCK IN FOR ${DELIVERY_STAGES[stage].day} →`}
          </button>
        </section>
      )}
      {mode === "lost" && (
        <section className="delivery-summary">
          <small>
            {cfg.day} · SHIFT {stage} OF {DELIVERY_STAGES.length}
          </small>
          <h1>SHIFT OVER</h1>
          <div className="complaint-card">
            {reward?.error || failure || "The subs survived. Your dignity did not."}
          </div>
          <div className="route-stats">
            <b>
              {stats.score.toLocaleString()}
              <small>SCORE</small>
            </b>
            <b>
              {stats.delivered}
              <small>DELIVERED</small>
            </b>
            <b>
              ×{stats.bestCombo}
              <small>BEST STREAK</small>
            </b>
          </div>
          {bestLine}
          {startError && (
            <div className="start-error" role="alert">
              {startError}
            </div>
          )}
          <button onClick={() => void start()} disabled={starting}>
            {starting ? "WARMING UP THE ENGINE…" : "CLOCK IN AGAIN"}
          </button>
          {feed.length > 0 && (
            <>
              <h2 className="fb-heading">THE COMMENTS ARE ALREADY IN</h2>
              <FacebookFeed posts={feed} />
            </>
          )}
          <button className="driver-leaderboard-button" onClick={openLeaderboard}>
            DRIVER LEADERBOARD
          </button>
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
        </section>
      )}
      {mode === "won" && (
        <section className="delivery-summary win">
          <small>YOU SURVIVED MONDAY THROUGH FRIDAY</small>
          <h1>FREE SUB EARNED</h1>
          <button type="button" className="reward-code" onClick={copyCode} title="Copy code">
            {reward?.code}
          </button>
          <div className="reward-meta">
            {copied ? "CODE COPIED" : "TAP CODE TO COPY · SHOW IT AT THE COUNTER"}
            {reward?.expires_at && ` · EXPIRES ${new Date(reward.expires_at).toLocaleDateString()}`}
          </div>
          <p>{DELIVERY_PRIZE.terms}</p>
          <div className="route-stats">
            <b>
              {stats.score.toLocaleString()}
              <small>SCORE</small>
            </b>
            <b>
              {stats.delivered}
              <small>DELIVERED</small>
            </b>
            <b>
              ×{stats.bestCombo}
              <small>BEST STREAK</small>
            </b>
          </div>
          {bestLine}
          <FacebookFeed
            posts={[
              {
                id: 1,
                author: "Corner Deli",
                page: true,
                text: `Shoutout to ${name.trim() || "our newest driver"} for surviving a full week of deliveries. Please stop asking if they're single.`,
                reactions: reactions(1),
                comments: [
                  {
                    author: pick(DELIVERY_FACEBOOK_PEOPLE),
                    text: "Is this the one who threw a sub onto my porch at 30 mph? Because yes. Ten stars.",
                  },
                  {
                    author: pick(DELIVERY_FACEBOOK_PEOPLE),
                    text: "They missed my house on Thursday and I will be bringing it up at every family gathering.",
                  },
                ],
              },
            ]}
          />
          <button className="driver-leaderboard-button" onClick={openLeaderboard}>
            DRIVER LEADERBOARD
          </button>
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
        </section>
      )}
      {showLeaders && (
        <section
          className="driver-leaderboard"
          role="dialog"
          aria-modal="true"
          aria-label="Driver leaderboard"
          onClick={(e) => e.target === e.currentTarget && setShowLeaders(false)}
        >
          <div>
            <button className="driver-board-close" aria-label="Close leaderboard" autoFocus onClick={() => setShowLeaders(false)}>
              ×
            </button>
            <small>CORNER DELI ROUTE RECORDS</small>
            <h2>DELIVERY LEGENDS</h2>
            {leadersState === "loading" ? (
              <p>LOADING ROUTES…</p>
            ) : leadersState === "error" ? (
              <p>Dispatch radio is down. Try again in a minute.</p>
            ) : leaders.length === 0 ? (
              <p>No winning drivers yet. The deer remain undefeated.</p>
            ) : (
              <ol>
                {leaders.map((leader, index) => (
                  <li key={`${leader.player_name}-${leader.completed_at}-${index}`}>
                    <b>{index + 1}</b>
                    <strong>{leader.player_name}</strong>
                    <span>
                      {leader.status === "won"
                        ? "FINISHED · "
                        : `${DELIVERY_STAGES[Math.max(0, Math.min(DELIVERY_STAGES.length, leader.stage) - 1)].day} · `}
                      {Number(leader.score).toLocaleString()} PTS
                      <small>
                        {leader.delivered} DELIVERED · {leader.missed} MISSED · {leader.hits} HITS
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
