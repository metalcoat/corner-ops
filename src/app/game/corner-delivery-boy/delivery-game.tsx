"use client";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  DELIVERY_CAR_CRASHES,
  DELIVERY_COLLISION_FAILURES,
  DELIVERY_COMPLAINTS,
  DELIVERY_FACEBOOK_COMMENTS,
  DELIVERY_FACEBOOK_DELIVERED,
  DELIVERY_FACEBOOK_MISSED,
  DELIVERY_FACEBOOK_PEOPLE,
  DELIVERY_FACEBOOK_PERFECT,
  DELIVERY_FACEBOOK_REPLIES,
  DELIVERY_FACEBOOK_SAMPLES,
  DELIVERY_FACEBOOK_URL,
  DELIVERY_FAILURES,
  DELIVERY_FIRED,
  DELIVERY_PRIZE,
  DELIVERY_ROUTE_SUCCESSES,
  DELIVERY_STAGES,
} from "@/lib/delivery-boy/config";
import { deliveryAudio } from "@/lib/games/delivery-audio";
import { MenuAdTicker } from "@/app/games/components/menu-ad-ticker";
type HazardType =
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
  | "pothole";
type Pickup = "boost" | "slow" | "restock";
type Thing = {
  id: number;
  type: HazardType | Pickup;
  lane: number;
  y: number;
  speed?: number;
};
type Side = "left" | "right";
// Paperboy rules: houses that ordered glow and want their food on the porch;
// houses that didn't order can still be hit with a "free sample".
type House = {
  id: number;
  side: Side;
  y: number;
  customer: boolean;
  address: string;
  item: string;
  state: "pending" | "delivered" | "missed" | "sampled";
  landed?: "porch" | "lawn";
};
type HouseSlot = { at: number; side: Side; customer: boolean };
type Scenery = {
  id: number;
  kind: "abandoned" | "tent" | "cart" | "trash" | "house";
  side: Side;
  y: number;
};
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
type Stats = {
  score: number;
  delivered: number;
  missed: number;
  hits: number;
  combo: number;
  bestCombo: number;
};
type FacebookPost = {
  id: number;
  author: string;
  page?: boolean;
  text: string;
  stars?: number;
  reactions: { like: number; haha: number; angry: number };
  comments: { author: string; text: string; page?: boolean }[];
};
type ScoreBurst = { id: number; text: string; tone: "good" | "bad" };
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
const communities = [
  { name: "LISBON", warning: "WATCH FOR COWS" },
  { name: "HEUVELTON", warning: "TRACTORS HAVE RIGHT OF WAY. THEY DECIDED." },
  { name: "MORRISTOWN", warning: "RIVER WIND MAY RELOCATE SUBS" },
  { name: "WADDINGTON", warning: "UNMARKED DRIVEWAYS AHEAD" },
  { name: "RENSSELAER FALLS", warning: "GPS HAS LEFT THE CHAT" },
  { name: "MADRID", warning: "MAILBOXES MAY BE STRUCTURAL" },
] as const;
type Community = (typeof communities)[number];
const quips = [
  "SUB SECURED",
  "PORCH PERFECT",
  "YEET DELIVERY",
  "BREAD HAS LANDED",
  "DINNER DEPLOYED",
  "ABSOLUTELY DELIVERED",
];
const streets = [
  "JAY ST",
  "PROCTOR AVE",
  "KNOX ST",
  "STATE ST",
  "FORD ST",
  "PATTERSON ST",
  "GREEN ST",
  "RIVERSIDE DR",
  "CANTON ST",
  "MORRIS ST",
  "LAKE ST",
  "CATHERINE ST",
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
// The driver can roam from curb to curb; hazards stay on the asphalt. Both are
// drawn with the same lane → % mapping so what you see is what you collide with.
const LANE_MIN = -0.18;
const LANE_MAX = 2.18;
const HAZARD_LANE_MIN = 0.15;
const HAZARD_LANE_SPAN = 1.7;
const laneLeft = (lane: number) => `${lane * 50}%`;
const STEER_RATE = 1.7;
const THROW_WINDOW = { start: 58, end: 90 };
const PORCH_WINDOW = { start: 69, end: 81 };
const INVULNERABLE_SECONDS = 1.2;
const WRECK_SECONDS = 1.1;
const EXTRA_SUBS = 3;
const RESTOCK_SUBS = 3;
const SUBS_LEFT_BONUS = 50;
const CONDITION_BONUS_PER_POINT = 150;
const PERFECT_SHIFT_BONUS = 1000;
const SAMPLE_POINTS = 75;
const DEADLY = new Set<Thing["type"]>(["car", "van", "cow", "person", "mower"]);
const PICKUPS = new Set<Thing["type"]>(["boost", "slow", "restock"]);
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
const shuffle = <T,>(items: T[]) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};
const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
const recentFailures = new Map<string, string[]>();
function pickFailure(key: string, pool: readonly string[]) {
  const recent = recentFailures.get(key) || [];
  const available = pool.filter((line) => !recent.includes(line));
  const selected = pick(available.length ? available : pool);
  recentFailures.set(key, [...recent.slice(-4), selected]);
  return selected;
}
function collisionRadius(type: Thing["type"]) {
  switch (type) {
    case "car":
    case "van":
      return 0.36;
    case "cow":
      return 0.29;
    case "deer":
      return 0.21;
    case "mower":
      return 0.2;
    case "goose":
      return 0.15;
    case "dog":
    case "person":
      return 0.13;
    case "cat":
    case "raccoon":
      return 0.11;
    case "squirrel":
      return 0.07;
    default:
      return 0.18;
  }
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
/** Lays the street out: every ordering house plus some that didn't order. */
function planStreet(stage: number): HouseSlot[] {
  const route = DELIVERY_STAGES[stage - 1],
    others = Math.round(route.deliveries * 0.8),
    flags = shuffle([
      ...Array<boolean>(route.deliveries).fill(true),
      ...Array<boolean>(others).fill(false),
    ]);
  // The first house always ordered so the shift starts with a clear target.
  const first = flags.indexOf(true);
  [flags[0], flags[first]] = [flags[first], flags[0]];
  const start = 2.5,
    end = route.time - 5,
    gap = (end - start) / flags.length;
  return flags.map((customer, index) => ({
    at: start + gap * index + Math.random() * gap * 0.35,
    side: Math.random() > 0.5 ? "right" : "left",
    customer,
  }));
}
type Sim = {
  stage: number;
  lane: number;
  things: Thing[];
  houses: House[];
  street: HouseSlot[];
  usedNumbers: Set<string>;
  scenery: Scenery[];
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
  zoneTimer: number;
  cowTimer: number;
  zone: "city" | "rural";
  community: Community;
  stats: Stats;
  lastImpact: string;
  ending: boolean;
};
function newSim(stage: number, stats: Stats): Sim {
  const route = DELIVERY_STAGES[stage - 1];
  const rural = stage >= 3;
  return {
    stage,
    lane: 1,
    things: [],
    houses: [],
    street: planStreet(stage),
    usedNumbers: new Set(),
    scenery: [],
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
    zoneTimer: 0,
    cowTimer: 0,
    zone: rural ? "rural" : "city",
    community: rural ? pick(communities) : communities[0],
    stats,
    lastImpact: "",
    ending: false,
  };
}
type Frame = Pick<
  Sim,
  | "stage"
  | "lane"
  | "things"
  | "houses"
  | "scenery"
  | "time"
  | "health"
  | "ammo"
  | "routeDelivered"
  | "porchPerfects"
  | "samples"
  | "log"
  | "boost"
  | "slow"
  | "damaged"
  | "invulnerable"
  | "zone"
  | "community"
  | "stats"
  | "ending"
>;
const snapshot = (s: Sim): Frame => ({
  stage: s.stage,
  lane: s.lane,
  things: s.things,
  houses: s.houses,
  scenery: s.scenery,
  time: s.time,
  health: s.health,
  ammo: s.ammo,
  routeDelivered: s.routeDelivered,
  porchPerfects: s.porchPerfects,
  samples: s.samples,
  log: s.log,
  boost: s.boost,
  slow: s.slow,
  damaged: s.damaged,
  invulnerable: s.invulnerable,
  zone: s.zone,
  community: s.community,
  stats: s.stats,
  ending: s.ending,
});
const inThrowWindow = (y: number) =>
  y >= THROW_WINDOW.start && y <= THROW_WINDOW.end;
const reactions = (heat: number) => ({
  like: Math.floor(Math.random() * 40) + 3,
  haha: Math.floor(Math.random() * 180 * heat) + 12,
  angry: Math.floor(Math.random() * 25 * heat),
});
/**
 * The Corner Deli Facebook page after a shift: the page brags, then the
 * customers complain anyway, including the ones whose food landed perfectly.
 */
function buildFeed(log: House[], shiftCleared: boolean): FacebookPost[] {
  let id = 0;
  const people = shuffle([...DELIVERY_FACEBOOK_PEOPLE]);
  const someone = () => people[id++ % people.length];
  const comments = (count: number) =>
    Array.from({ length: count }, () => {
      const author = someone();
      return {
        author,
        text: fill(pick(DELIVERY_FACEBOOK_COMMENTS), { name: someone() }),
      };
    });
  const post = (
    text: string,
    house: House | null,
    heat: number,
    stars?: number,
  ): FacebookPost => ({
    id: ++id,
    author: someone(),
    text: fill(text, {
      item: house?.item ?? "sub",
      address: house?.address ?? "my house",
    }),
    stars,
    reactions: reactions(heat),
    comments: [
      ...comments(1 + Math.floor(Math.random() * 2)),
      ...(Math.random() < 0.6
        ? [
            {
              author: "Corner Deli",
              text: pick(DELIVERY_FACEBOOK_REPLIES),
              page: true,
            },
          ]
        : []),
    ],
  });
  const delivered = shuffle(log.filter((h) => h.state === "delivered")),
    missed = shuffle(log.filter((h) => h.state === "missed")),
    sampled = shuffle(log.filter((h) => h.state === "sampled")),
    feed: FacebookPost[] = [];
  if (shiftCleared)
    feed.push({
      id: ++id,
      author: "Corner Deli",
      page: true,
      text: `Shift complete! ${pick(
        missed.length ? DELIVERY_COMPLAINTS : DELIVERY_ROUTE_SUCCESSES,
      )}`,
      reactions: reactions(0.6),
      comments: comments(1),
    });
  if (!missed.length && delivered.length)
    feed.push(post(pick(DELIVERY_FACEBOOK_PERFECT), null, 1, 4));
  for (const house of delivered.slice(0, missed.length ? 1 : 2))
    feed.push(
      post(
        pick(DELIVERY_FACEBOOK_DELIVERED),
        house,
        1,
        1 + Math.floor(Math.random() * 3),
      ),
    );
  for (const house of missed.slice(0, 2))
    feed.push(post(pick(DELIVERY_FACEBOOK_MISSED), house, 1.4, 1));
  if (sampled[0]) feed.push(post(pick(DELIVERY_FACEBOOK_SAMPLES), sampled[0], 1.2, 1));
  return feed;
}
const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
function FacebookFeed({ posts }: { posts: FacebookPost[] }) {
  if (!posts.length) return null;
  return (
    <section className="fb-feed" aria-label="Corner Deli Facebook page">
      <header>
        <i className="fb-avatar page">CD</i>
        <div>
          <b>Corner Deli</b>
          <small>Facebook page · Ogdensburg, NY · Visitor posts</small>
        </div>
      </header>
      {posts.map((p) => (
        <article className="fb-post" key={p.id}>
          <div className="fb-byline">
            <i className={`fb-avatar ${p.page ? "page" : ""}`}>
              {p.page ? "CD" : p.author.slice(0, 1)}
            </i>
            <div>
              <b>{p.author}</b>
              <small>
                {p.page ? "Page" : "Just now"}
                {p.stars ? ` · ${"★".repeat(p.stars)}${"☆".repeat(5 - p.stars)}` : ""}
              </small>
            </div>
          </div>
          <p>{p.text}</p>
          <div className="fb-reactions">
            <span>
              👍 {p.reactions.like} · 😆 {p.reactions.haha}
              {p.reactions.angry ? ` · 😡 ${p.reactions.angry}` : ""}
            </span>
            <span>
              {p.comments.length} comment{p.comments.length === 1 ? "" : "s"}
            </span>
          </div>
          {p.comments.map((c, index) => (
            <div className={`fb-comment ${c.page ? "page" : ""}`} key={index}>
              <i className={`fb-avatar small ${c.page ? "page" : ""}`}>
                {c.page ? "CD" : c.author.slice(0, 1)}
              </i>
              <div>
                <b>{c.author}</b>
                {c.page && <small> · Author</small>}
                <span>{c.text}</span>
              </div>
            </div>
          ))}
        </article>
      ))}
      {DELIVERY_FACEBOOK_URL && (
        <a
          className="fb-real-link"
          href={DELIVERY_FACEBOOK_URL}
          target="_blank"
          rel="noreferrer"
        >
          See the real Corner Deli page →
        </a>
      )}
    </section>
  );
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
    [wrecked, setWrecked] = useState(false),
    [thrown, setThrown] = useState<{
      id: number;
      side: Side;
      start: number;
    } | null>(null),
    [particles, setParticles] = useState<
      { id: number; side: Side; y: number }[]
    >([]),
    [scoreBursts, setScoreBursts] = useState<ScoreBurst[]>([]),
    [toast, setToast] = useState(""),
    [shaking, setShaking] = useState(false),
    [skidding, setSkidding] = useState(false),
    [brokenWindow, setBrokenWindow] = useState(false),
    [feed, setFeed] = useState<FacebookPost[]>([]),
    [routeBonus, setRouteBonus] = useState({
      subs: 0,
      condition: 0,
      perfect: 0,
    }),
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
    [reducedEffects, setReducedEffects] = useState(false);
  const [showLeaders, setShowLeaders] = useState(false),
    [leaders, setLeaders] = useState<DeliveryLeader[]>([]),
    [leadersState, setLeadersState] = useState<"loading" | "ready" | "error">(
      "loading",
    );
  const sim = useRef<Sim>(newSim(1, fresh())),
    keys = useRef(new Set<string>()),
    runRef = useRef<Run | null>(null),
    sequence = useRef(0),
    lossSaved = useRef(false),
    cosmeticId = useRef(0),
    timers = useRef(new Set<number>()),
    live = useRef({ mode: "home" as Mode, paused: false, running: false }),
    touch = useRef({ x: 0, y: 0, moved: false });
  const stage = frame.stage,
    cfg = DELIVERY_STAGES[stage - 1],
    stats = frame.stats,
    running = mode === "play" && (countdown === null || countdown === 0);
  live.current = { mode, paused, running };

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
  const pop = useCallback(
    (message: string) => {
      setToast(message);
      later(
        () => setToast((current) => (current === message ? "" : current)),
        1100,
      );
    },
    [later],
  );
  const scoreBurst = useCallback(
    (text: string, tone: "good" | "bad") => {
      const id = ++cosmeticId.current;
      setScoreBursts((bursts) => [...bursts.slice(-3), { id, text, tone }]);
      later(
        () =>
          setScoreBursts((bursts) => bursts.filter((burst) => burst.id !== id)),
        900,
      );
    },
    [later],
  );
  const vibrate = useCallback((pattern: number | number[]) => {
    if (typeof navigator !== "undefined" && "vibrate" in navigator)
      navigator.vibrate(pattern);
  }, []);
  const impact = useCallback(() => {
    setShaking(true);
    later(() => setShaking(false), 210);
  }, [later]);
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
  useEffect(() => {
    const speedRatio = Math.min(
      1,
      (cfg.speed + (frame.boost > 0 ? 65 : 0)) / 330,
    );
    const urgencyRatio = Math.max(0, Math.min(1, (20 - frame.time) / 20));
    deliveryAudio.setIntensity(speedRatio, urgencyRatio);
  }, [cfg.speed, frame.boost, frame.time]);

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
    (reason: string, sound: Sfx) => {
      const s = sim.current;
      if (s.ending) return;
      s.ending = true;
      keys.current.clear();
      commit();
      setFailure(reason);
      setFeed(buildFeed(s.log, false).slice(0, 2));
      setWrecked(true);
      impact();
      vibrate([80, 40, 120]);
      sfx(sound);
      if (sound !== "gameover") later(() => sfx("gameover"), 420);
      later(
        () => {
          setWrecked(false);
          setMode("lost");
          deliveryAudio.transition("menu");
        },
        reducedEffects ? 300 : WRECK_SECONDS * 1000,
      );
    },
    [commit, impact, later, reducedEffects, sfx, vibrate],
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
        setSkidding(true);
        later(() => setSkidding(false), 230);
        sfx("steer");
      }
      s.lane = Math.max(
        LANE_MIN,
        Math.min(LANE_MAX, s.lane + d * (s.damaged > 0 ? 0.58 : 1)),
      );
      commit();
    },
    [commit, later, sfx],
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
        (h) => inThrowWindow(h.y) && (h.state === "pending" || (!h.customer && h.state !== "sampled")),
      );
      const centered = (a: House, b: House) =>
        Math.abs(a.y - 75) - Math.abs(b.y - 75);
      const side: Side =
        aim !== "auto"
          ? aim
          : ([...reachable].filter((h) => h.customer).sort(centered)[0] ??
              [...reachable].sort(centered)[0])?.side ??
            (s.lane < 1 ? "left" : "right");
      const house = reachable.filter((h) => h.side === side).sort(centered)[0];
      const throwId = ++cosmeticId.current;
      s.ammo -= 1;
      setThrown({ id: throwId, side, start: s.lane });
      sfx("throw");
      later(
        () =>
          setThrown((current) => (current?.id === throwId ? null : current)),
        650,
      );
      // Like Paperboy, you have to be on that half of the road to reach the porch.
      const farSide = side === "left" ? s.lane > 1.35 : s.lane < 0.65;
      if (!house || farSide) {
        s.stats = {
          ...s.stats,
          score: Math.max(0, s.stats.score - 25),
          combo: 0,
        };
        scoreBurst("SUB IN SHRUB -25", "bad");
        pop(
          farSide
            ? "TOO FAR! DRIVE CLOSER TO THAT SIDE"
            : "NOTHING THERE. A SHRUB ATE WELL TONIGHT.",
        );
        sfx("miss");
        commit();
        return;
      }
      const burst = () => {
        setParticles((items) => [...items, { id: throwId, side, y: house.y }]);
        later(
          () =>
            setParticles((items) => items.filter((item) => item.id !== throwId)),
          750,
        );
      };
      if (!house.customer) {
        house.state = "sampled";
        s.samples += 1;
        s.log = [...s.log, { ...house }];
        s.stats = { ...s.stats, score: s.stats.score + SAMPLE_POINTS };
        s.houses = [...s.houses];
        burst();
        scoreBurst(`FREE SAMPLE +${SAMPLE_POINTS}`, "good");
        pop("FREE SAMPLE! THEY DIDN'T ORDER. THEY WILL BE POSTING ABOUT THIS.");
        later(() => sfx("delivery"), 190);
        commit();
        return;
      }
      const porch =
          house.y >= PORCH_WINDOW.start && house.y <= PORCH_WINDOW.end,
        combo = s.stats.combo + 1,
        multiplier = Math.min(4, combo),
        points = (porch ? 200 : 100) * multiplier;
      house.state = "delivered";
      house.landed = porch ? "porch" : "lawn";
      s.houses = [...s.houses];
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
      scoreBurst(
        `${porch ? "PORCH" : "LAWN"} +${points}${multiplier > 1 ? ` ×${multiplier}` : ""}`,
        "good",
      );
      vibrate([15, 30]);
      pop(porch ? pick(quips) : "ON THE LAWN. THEY WILL MENTION THIS.");
      later(() => sfx("delivery"), 190);
      commit();
    },
    [commit, later, pop, scoreBurst, sfx, vibrate],
  );

  // Keyboard: steering is read from `keys` by the game loop.
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
      countdown === 0 ? 450 : 650,
    );
    return () => clearTimeout(id);
  }, [countdown, mode, paused, sfx]);

  // Main simulation loop. All per-frame state lives in `sim`; React only
  // receives a snapshot to draw, so collisions are applied exactly once.
  useEffect(() => {
    if (!running || paused) return;
    let raf = 0,
      last = performance.now();
    const loop = (now: number) => {
      const s = sim.current;
      if (s.ending) return;
      const dt = Math.min(0.04, (now - last) / 1000);
      last = now;
      const route = DELIVERY_STAGES[s.stage - 1];
      s.time = Math.max(0, s.time - dt);
      s.boost = Math.max(0, s.boost - dt);
      s.slow = Math.max(0, s.slow - dt);
      s.damaged = Math.max(0, s.damaged - dt);
      s.invulnerable = Math.max(0, s.invulnerable - dt);
      s.spawnTimer += dt;
      s.sceneryTimer += dt;
      s.zoneTimer += dt;
      s.cowTimer += dt;

      const held = keys.current,
        left = held.has("arrowleft") || held.has("a") || held.has("touch-left"),
        right =
          held.has("arrowright") || held.has("d") || held.has("touch-right");
      if (left !== right)
        s.lane = Math.max(
          LANE_MIN,
          Math.min(
            LANE_MAX,
            s.lane +
              (right ? 1 : -1) * dt * STEER_RATE * (s.damaged > 0 ? 0.58 : 1),
          ),
        );

      const speed = Math.max(
          0.65,
          (route.speed + (s.boost > 0 ? 65 : 0) - (s.slow > 0 ? 120 : 0)) /
            100,
        ),
        elapsed = route.time - s.time,
        speedRamp = 1 + Math.floor(Math.max(0, elapsed) / 30) * 0.08,
        scroll = dt * speed * 36;

      if (s.spawnTimer > Math.max(0.36, 1.05 - s.stage * 0.09)) {
        s.spawnTimer = 0;
        // Never stack enough hazards at the horizon to wall off the road.
        const crowded =
          s.things.filter((x) => x.y < 8 && !PICKUPS.has(x.type)).length >= 2;
        const types: HazardType[] =
            s.stage <= 1
              ? ["squirrel", "cat", "pothole", "pothole"]
              : s.stage <= 3
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
        if (!crowded || PICKUPS.has(type))
          s.things = [
            ...s.things,
            {
              id: ++cosmeticId.current,
              type,
              lane: HAZARD_LANE_MIN + Math.random() * HAZARD_LANE_SPAN,
              y: -12,
              speed:
                type === "mower" || type === "van" || type === "goose"
                  ? 1.35
                  : 1,
            },
          ];
      }
      if (s.zone === "rural" && s.stage >= 2) {
        if (s.cowTimer > Math.max(2.4, 4.2 - s.stage * 0.3)) {
          s.cowTimer = 0;
          s.things = [
            ...s.things,
            {
              id: ++cosmeticId.current,
              type: "cow",
              lane: HAZARD_LANE_MIN + Math.random() * HAZARD_LANE_SPAN,
              y: -12,
            },
          ];
        }
      }
      // Houses arrive on the street plan's schedule, whatever your speed.
      while (s.street.length && s.street[0].at <= elapsed) {
        const slot = s.street.shift()!;
        let address = "";
        do
          address = `${Math.floor(Math.random() * 1800) + 12} ${pick(streets)}`;
        while (s.usedNumbers.has(address));
        s.usedNumbers.add(address);
        s.houses = [
          ...s.houses,
          {
            id: ++cosmeticId.current,
            side: slot.side,
            y: -14,
            customer: slot.customer,
            address,
            item: pick(orderPayloads),
            state: "pending",
          },
        ];
      }
      if (s.sceneryTimer > (s.zone === "rural" ? 2.6 : 0.9)) {
        s.sceneryTimer = 0;
        const kinds: Scenery["kind"][] =
          s.zone === "rural"
            ? ["trash", "cart", "trash"]
            : ["abandoned", "tent", "cart", "trash", "trash"];
        s.scenery = [
          ...s.scenery.slice(-14),
          {
            id: ++cosmeticId.current,
            kind: pick(kinds),
            side: Math.random() > 0.5 ? "right" : "left",
            y: -12,
          },
        ];
      }
      if (s.zoneTimer > Math.max(9, 15 - s.stage * 0.9)) {
        s.zoneTimer = 0;
        s.zone = s.zone === "city" ? "rural" : "city";
        if (s.zone === "rural") s.community = pick(communities);
      }

      const hit = (
        damage: number,
        penalty: number,
        reason: string,
        message: string,
        sound: Sfx,
      ) => {
        s.lastImpact = reason;
        s.health = Math.max(0, s.health - damage);
        s.invulnerable = INVULNERABLE_SECONDS;
        s.stats = {
          ...s.stats,
          score: Math.max(0, s.stats.score - penalty),
          hits: s.stats.hits + 1,
          combo: 0,
        };
        if (penalty) scoreBurst(`-${penalty}`, "bad");
        if (damage) {
          impact();
          vibrate(60);
        }
        pop(message);
        sfx(sound);
      };

      const things: Thing[] = [];
      for (const x of s.things) {
        const n = { ...x, y: x.y + scroll * speedRamp * (x.speed || 1) };
        const touching =
          n.y > 78 &&
          n.y < 91 &&
          Math.abs(n.lane - s.lane) < collisionRadius(n.type);
        if (!touching) {
          if (n.y < 112) things.push(n);
          continue;
        }
        if (n.type === "restock") {
          s.ammo += RESTOCK_SUBS;
          pop(`SUB BAG! +${RESTOCK_SUBS} SUBS`);
          scoreBurst(`+${RESTOCK_SUBS} SUBS`, "good");
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
          scoreBurst("+350", "good");
          sfx("delivery");
          continue;
        }
        // Freshly hit: everything passes through while the car blinks.
        if (s.invulnerable > 0) {
          if (n.y < 112) things.push(n);
          continue;
        }
        if (
          (n.type === "car" || n.type === "van") &&
          Math.abs(n.lane - s.lane) >= 0.17
        ) {
          s.damaged = 4;
          hit(
            1,
            500,
            pickFailure("car", DELIVERY_CAR_CRASHES),
            "SIDESWIPE! -500. ALIGNMENT NOW PROVIDED BY A SHOPPING CART.",
            "crash",
          );
          continue;
        }
        if (DEADLY.has(n.type)) {
          s.stats = { ...s.stats, hits: s.stats.hits + 1, combo: 0 };
          s.things = things;
          endRun(
            n.type === "car" || n.type === "van"
              ? pickFailure("car", DELIVERY_CAR_CRASHES)
              : pickFailure(
                  n.type,
                  DELIVERY_COLLISION_FAILURES[
                    n.type as "cow" | "person" | "mower"
                  ],
                ),
            n.type === "person" ? "ouch" : n.type === "cow" ? "moo" : "crash",
          );
          return;
        }
        switch (n.type) {
          case "squirrel":
            hit(
              0,
              100,
              pickFailure("squirrel", DELIVERY_COLLISION_FAILURES.squirrel),
              "SQUIRREL TAP! IT HAS RETAINED COUNSEL.",
              "squish",
            );
            break;
          case "cat":
            hit(
              1,
              175,
              pickFailure("cat", DELIVERY_COLLISION_FAILURES.cat),
              "CAT INCIDENT! IT WILL BE REVIEWING THIS RIDE ONLINE.",
              "meow",
            );
            break;
          case "goose":
          case "raccoon":
            hit(
              1,
              150,
              pickFailure(n.type, DELIVERY_COLLISION_FAILURES[n.type]),
              n.type === "goose"
                ? "GOOSE INCIDENT! IT HAS CLAIMED THE LANE AND YOUR INSURANCE."
                : "RACCOON INCIDENT! THE SUB HAS BEEN RECLASSIFIED AS TRASH.",
              "crash",
            );
            break;
          case "deer":
            hit(
              2,
              0,
              pickFailure("deer", DELIVERY_COLLISION_FAILURES.deer),
              "YOU HIT A DEER. THE DEER IS ANGRY.",
              "crash",
            );
            break;
          case "dog":
            hit(
              1,
              0,
              pickFailure("dog", DELIVERY_COLLISION_FAILURES.dog),
              "DOG INCIDENT! EVERY PORCH CAMERA SAW THAT.",
              "bark",
            );
            break;
          default:
            hit(
              1,
              0,
              pickFailure("pothole", DELIVERY_COLLISION_FAILURES.pothole),
              "POTHOLE! THE SUSPENSION HAS FILED A COMPLAINT.",
              "crash",
            );
        }
      }
      s.things = things;

      const houses: House[] = [];
      for (const h of s.houses) {
        const n = { ...h, y: h.y + scroll };
        if (n.customer && n.state === "pending" && n.y > 100) {
          n.state = "missed";
          s.log = [...s.log, n];
          s.stats = { ...s.stats, missed: s.stats.missed + 1, combo: 0 };
          pop(`MISSED ${n.address}. THEY'RE ALREADY TYPING.`);
          scoreBurst("MISSED ORDER", "bad");
        }
        if (n.y < 116) houses.push(n);
      }
      s.houses = houses;

      const scenery: Scenery[] = [];
      for (const x of s.scenery) {
        const n = { ...x, y: x.y + scroll },
          onCurb =
            (s.lane < -0.04 && n.side === "left") ||
            (s.lane > 2.04 && n.side === "right");
        if (
          s.invulnerable <= 0 &&
          n.y > 82 &&
          n.y < 91 &&
          onCurb &&
          (n.kind === "abandoned" || n.kind === "tent")
        ) {
          s.stats = { ...s.stats, hits: s.stats.hits + 1, combo: 0 };
          s.scenery = scenery;
          endRun(
            pickFailure(n.kind, DELIVERY_COLLISION_FAILURES[n.kind]),
            n.kind === "tent" ? "ouch" : "crash",
          );
          return;
        }
        if (n.y < 112) scenery.push(n);
      }
      s.scenery = scenery;

      if (s.health <= 0) {
        endRun(s.lastImpact || pickFailure("route", DELIVERY_FAILURES), "crash");
        return;
      }
      if (s.time <= 0) {
        finishShift();
        return;
      }
      commit();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [
    running,
    paused,
    commit,
    endRun,
    finishShift,
    impact,
    pop,
    scoreBurst,
    sfx,
    vibrate,
  ]);

  function begin(n: number, carried: Stats) {
    sim.current = newSim(n, carried);
    keys.current.clear();
    setFrame(snapshot(sim.current));
    setThrown(null);
    setParticles([]);
    setScoreBursts([]);
    setToast("");
    setFailure("");
    setFeed([]);
    setWrecked(false);
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
    if (!run || claiming) return;
    setClaiming(true);
    try {
      const response = await fetch("/api/delivery-boy/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          runId: run.runId,
          token: run.token,
        }),
      });
      const data: Reward = await response.json().catch(() => ({}));
      setReward(
        response.ok
          ? data
          : { error: data.error || "Prize could not be issued." },
      );
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
  const time = Math.ceil(frame.time),
    lane = frame.lane,
    nextOrder = frame.houses
      .filter((h) => h.customer && h.state === "pending")
      .sort((a, b) => b.y - a.y)[0],
    inRange = (h: House) => inThrowWindow(h.y) && h.state === "pending",
    tossReady = frame.houses.some((h) => h.customer && inRange(h)),
    progress = Math.min(100, ((cfg.time - frame.time) / cfg.time) * 100);
  const bestLine = newBest ? (
    <div className="new-best">
      NEW PERSONAL BEST · {stats.score.toLocaleString()}
    </div>
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
    <main className="delivery-boy">
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
            <img
              src="/games/delivery-boy/delivery-suv-pixel-v2.png"
              alt="Corner Deli delivery car"
            />
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
          <button
            type="button"
            className="driver-leaderboard-button"
            onClick={openLeaderboard}
          >
            DRIVER LEADERBOARD
          </button>
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
          {DELIVERY_FACEBOOK_URL && (
            <a
              className="fb-real-link home"
              href={DELIVERY_FACEBOOK_URL}
              target="_blank"
              rel="noreferrer"
            >
              Read the real reviews on Corner Deli&apos;s Facebook →
            </a>
          )}
          <ul className="how-to-play">
            <li>
              <b>STEER</b> ← → / A D, hold the arrows, or swipe
            </li>
            <li>
              <b>TOSS</b> Q / E to toss left / right, SPACE aims for you, or
              tap that side of the street
            </li>
            <li>
              <b>ORDERS</b> glowing houses ordered. Land it on the PORCH for
              double points
            </li>
            <li>
              <b>QUOTA</b> hit each shift&apos;s quota before the street ends
            </li>
            <li>
              <b>SAMPLES</b> dark houses didn&apos;t order. Toss one anyway.
              See what happens
            </li>
            <li>
              <b>SUB BAGS</b> on the road refill your subs
            </li>
          </ul>
          <div className="sub-prize">
            SURVIVE MONDAY–FRIDAY · WIN: {DELIVERY_PRIZE.name.toUpperCase()}
          </div>
        </form>
      )}
      {mode === "play" && (
        <>
          <header className="delivery-hud">
            <div>
              <small>{cfg.name.toUpperCase()}</small>
              <b>{cfg.day}</b>
            </div>
            <div className="active-order-hud">
              <small>NEXT ORDER</small>
              <b>{nextOrder ? nextOrder.item : "—"}</b>
            </div>
            <div className={frame.routeDelivered >= cfg.quota ? "quota-met" : ""}>
              <small>ORDERS · NEED {cfg.quota}</small>
              <b>
                {frame.routeDelivered}/{cfg.deliveries}
              </b>
            </div>
            <div className={time < 11 ? "hot" : ""}>
              <small>BACK AT DELI</small>
              <b>{time}s</b>
            </div>
            <div>
              <small>SCORE</small>
              <b>{stats.score.toLocaleString()}</b>
            </div>
            <div className={`combo-hud combo-${Math.min(4, stats.combo)}`}>
              <small>TIP STREAK</small>
              <b>
                {stats.combo >= 4
                  ? "DELI HERO ×4"
                  : `×${Math.max(1, stats.combo)}`}
              </b>
            </div>
            <div className={frame.ammo < 3 ? "ammo-hud critical" : "ammo-hud"}>
              <small>SUBS</small>
              <b>
                <i className="sub-ammo-icon" /> {frame.ammo}
              </b>
            </div>
            {frame.slow > 0 && (
              <div className="slow-hud">
                <small>SLOW TIME</small>
                <b>{Math.ceil(frame.slow)}s</b>
              </div>
            )}
            <button
              className="hud-pause"
              aria-label={paused ? "Resume" : "Pause"}
              onClick={() => !frame.ending && setPaused((value) => !value)}
            >
              {paused ? "▶" : "❚❚"}
            </button>
            <button
              aria-label="Audio settings"
              onClick={() => setShowAudio(!showAudio)}
            >
              {muted ? "SOUND OFF" : "SOUND"}
            </button>
          </header>
          <section
            className={`delivery-world zone-${frame.zone} ${time < 11 ? "panic" : ""} ${stage >= 4 ? "night" : ""} ${frame.slow ? "slow-motion" : ""} ${shaking && !reducedEffects ? "impact-shake" : ""} ${brokenWindow && !reducedEffects ? "window-shatter" : ""} ${paused ? "paused" : ""} ${wrecked ? "wrecked" : ""} ${reducedEffects ? "reduced-effects" : ""}`}
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
            <div className="route-progress" aria-label="Street progress">
              <i style={{ width: `${progress}%` }} />
              <b>
                {frame.routeDelivered >= cfg.quota
                  ? "QUOTA MET · FINISH THE STREET"
                  : `${cfg.quota - frame.routeDelivered} MORE TO KEEP YOUR JOB`}
              </b>
            </div>
            <div className="horizon-layer" />
            <div className="midground-layer" />
            {frame.zone === "rural" && (
              <div
                className="community-sign"
                key={`${frame.community.name}-${stage}`}
              >
                <small>ENTERING</small>
                <b>{frame.community.name}</b>
                <span>{frame.community.warning}</span>
              </div>
            )}
            {nextOrder && (
              <div className="address-ticket">
                <small>NEXT ORDER</small>
                <b>{nextOrder.address}</b>
                <i>
                  {nextOrder.side.toUpperCase()} SIDE · {nextOrder.item}
                </i>
              </div>
            )}
            <div className="sky">
              <span className={stage >= 4 ? "pixel-moon" : "pixel-store"} />
              <i>{cfg.day}</i>
            </div>
            <div className="road">
              <div className="sidewalk left-walk" />
              <div className="sidewalk right-walk" />
              <div className="lane-lines" />
              <div className="speed-lines" />
              {frame.scenery.map((x) => (
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
              {frame.houses.map((h) => (
                <div
                  key={h.id}
                  className={`house ${h.customer ? "target" : "decoy"} ${h.side} ${h.state} ${inRange(h) && h.customer ? "in-range" : ""}`}
                  style={
                    {
                      top: `${h.y}%`,
                      "--depth": Math.max(
                        0.5,
                        Math.min(1.08, 0.5 + h.y / 170),
                      ),
                    } as CSSProperties
                  }
                >
                  <span className="house-sprite" />
                  <b>{h.customer ? h.address : "NO ORDER"}</b>
                  {h.customer && (
                    <em>
                      {h.state === "delivered"
                        ? h.landed === "porch"
                          ? "✓ ON THE PORCH"
                          : "✓ ON THE LAWN"
                        : h.state === "missed"
                          ? "✗ MISSED"
                          : inRange(h)
                            ? h.side === "left"
                              ? "◀ TOSS NOW"
                              : "TOSS NOW ▶"
                            : h.item.toUpperCase()}
                    </em>
                  )}
                  {h.state === "sampled" && <em>FREE SAMPLE</em>}
                </div>
              ))}
              {frame.things.map((x) => (
                <Fragment key={x.id}>
                  {((x.speed || 1) > 1 || DEADLY.has(x.type)) && x.y < 18 && (
                    <i
                      className="hazard-warning"
                      style={{ left: laneLeft(x.lane) }}
                    >
                      !
                    </i>
                  )}
                  <i
                    className={`hazard ${x.type}`}
                    style={
                      {
                        left: laneLeft(x.lane),
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
                className={`driver ${frame.boost ? "boost" : ""} ${skidding ? "skidding" : ""} ${frame.damaged ? "damaged" : ""} ${frame.invulnerable > 0 && !frame.ending ? "invulnerable" : ""}`}
                style={{ left: laneLeft(lane) }}
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
                  style={{ "--start": laneLeft(thrown.start) } as CSSProperties}
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
                <div className="headlights" style={{ left: laneLeft(lane) }} />
              )}
            </div>
            {toast && <div className="delivery-toast">{toast}</div>}
            {scoreBursts.map((burst) => (
              <div className={`score-burst ${burst.tone}`} key={burst.id}>
                {burst.text}
              </div>
            ))}
            {countdown !== null && (
              <div className="route-countdown" aria-live="assertive">
                <small>
                  {cfg.day} · {cfg.name.toUpperCase()}
                </small>
                <b key={countdown}>{countdown === 0 ? "GO!" : countdown}</b>
                <span>
                  {cfg.deliveries} ORDERS · NEED {cfg.quota} ·{" "}
                  {cfg.deliveries + EXTRA_SUBS} SUBS IN THE BAG
                </span>
              </div>
            )}
            {wrecked && (
              <div className="wreck-stamp" aria-live="assertive">
                {frame.health > 0 && frame.time <= 0 ? "FIRED" : "SHIFT OVER"}
              </div>
            )}
            {paused && (
              <div className="pause-card">
                <b>SHIFT PAUSED</b>
                <span>Press P or Esc to keep disappointing customers.</span>
                <button onClick={() => setPaused(false)}>RESUME</button>
              </div>
            )}
            <div
              className="hearts"
              aria-label={`${frame.health} condition points`}
            >
              {[0, 1, 2].map((point) => (
                <i
                  className={point < frame.health ? "full" : "empty"}
                  key={point}
                />
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
                      storageSet(
                        REDUCED_EFFECTS_KEY,
                        String(event.target.checked),
                      );
                    }}
                  />{" "}
                  REDUCED EFFECTS
                </label>
              </aside>
            )}
            <div
              className="touch-controls paperboy"
              onTouchStart={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
            >
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
              <button
                className={`deliver ${tossReady ? "ready" : ""}`}
                onPointerDown={() => toss("left")}
              >
                ◤ TOSS
              </button>
              <button
                className={`deliver ${tossReady ? "ready" : ""}`}
                onPointerDown={() => toss("right")}
              >
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
          </section>
        </>
      )}
      {mode === "between" && (
        <section className="delivery-summary">
          <small>
            {cfg.day} SURVIVED · SHIFT {stage} OF {DELIVERY_STAGES.length}
          </small>
          <h1>
            {frame.routeDelivered === cfg.deliveries
              ? "PERFECT SHIFT"
              : "YOU KEPT YOUR JOB"}
          </h1>
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
              Dispatch didn&apos;t log this shift. Retry so your prize run stays
              valid.
            </div>
          )}
          {reward?.error && (
            <div className="start-error" role="alert">
              {reward.error}
            </div>
          )}
          <button
            onClick={nextRoute}
            disabled={checkpointState === "saving" || claiming}
          >
            {checkpointState === "saving"
              ? "LOGGING SHIFT…"
              : checkpointState === "error"
                ? "RETRY LOGGING SHIFT"
                : claiming
                  ? "CHECKING YOUR WEEK…"
                  : stage === DELIVERY_STAGES.length
                    ? "CLAIM FREE SUB"
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
            {reward?.error ||
              failure ||
              "The subs survived. Your dignity did not."}
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
          <small>YOU SURVIVED MONDAY THROUGH FRIDAY</small>
          <h1>FREE SUB EARNED</h1>
          <button
            type="button"
            className="reward-code"
            onClick={copyCode}
            title="Copy code"
          >
            {reward?.code}
          </button>
          <div className="reward-meta">
            {copied
              ? "CODE COPIED"
              : "TAP CODE TO COPY · SHOW IT AT THE COUNTER"}
            {reward?.expires_at &&
              ` · EXPIRES ${new Date(reward.expires_at).toLocaleDateString()}`}
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
      {showLeaders && (
        <section
          className="driver-leaderboard"
          role="dialog"
          aria-modal="true"
          aria-label="Driver leaderboard"
          onClick={(e) => e.target === e.currentTarget && setShowLeaders(false)}
        >
          <div>
            <button
              className="driver-board-close"
              aria-label="Close leaderboard"
              autoFocus
              onClick={() => setShowLeaders(false)}
            >
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
                  <li
                    key={`${leader.player_name}-${leader.completed_at}-${index}`}
                  >
                    <b>{index + 1}</b>
                    <strong>{leader.player_name}</strong>
                    <span>
                      {leader.status === "won"
                        ? "FINISHED · "
                        : `${DELIVERY_STAGES[Math.max(0, Math.min(DELIVERY_STAGES.length, leader.stage) - 1)].day} · `}
                      {Number(leader.score).toLocaleString()} PTS
                      <small>
                        {leader.delivered} DELIVERED · {leader.missed} MISSED ·{" "}
                        {leader.hits} HITS
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
