"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { MenuAdTicker } from "@/app/games/components/menu-ad-ticker";

type Size = "SMALL" | "REGULAR" | "JUMBO";
type Top =
  "pepperoni" | "sausage" | "mushroom" | "pepper" | "onion" | "olive" | "bacon";
type Side = "whole" | "left" | "right";
type Tool = "sauce" | "cheese" | "cut" | Top;
type Point = { x: number; y: number };
type Ticket = {
  id: number;
  size: Size;
  req: { topping: Top; side: Side; count: number }[];
  extraCheese: boolean;
  wellDone: boolean;
  patience: number;
  boss?: boolean;
};
type Build = {
  size: Size;
  sauce: Point[];
  cheese: Point[];
  toppings: (Point & { topping: Top })[];
  cuts: { from: Point; to: Point }[];
};
type Result = {
  total: number;
  sauce: number;
  cheese: number;
  toppings: number;
  placement: number;
  label: string;
  strike: boolean;
};
type Run = { runId: string; token: string };
type Leader = {
  player_name: string;
  score: number | string;
  pizzas_made: number;
  perfects: number;
  completed_at: string;
  status: string;
  game_version: string;
};
const TOPS: Top[] = [
    "pepperoni",
    "sausage",
    "mushroom",
    "pepper",
    "onion",
    "olive",
    "bacon",
  ],
  ICON: Record<Top, string> = {
    pepperoni: "●",
    sausage: "◆",
    mushroom: "♠",
    pepper: "⌁",
    onion: "◌",
    olive: "○",
    bacon: "▰",
  };
const blank = (): Build => ({
  size: "REGULAR",
  sauce: [],
  cheese: [],
  toppings: [],
  cuts: [],
});
const losses = [
  "THE CUSTOMERS HAVE WON.",
  "YOU HAVE BEEN MOVED TO DISHES.",
  "CRAIG IS TAKING OVER.",
  "YOUR APRON HAS BEEN CONFISCATED.",
  "MANAGEMENT WOULD LIKE TO SPEAK WITH YOU.",
  "PLEASE CLOCK OUT.",
];
const complaints = [
  ["THERE WASN'T ENOUGH CHEESE.", "CHEESE COVERAGE: 100%"],
  ["THESE USED TO BE LOADED.", "HISTORICAL LOADEDNESS: UNCHANGED"],
  ["IT DOESN'T TASTE LIKE 2007.", "FIRST ORDER ON FILE: 2024"],
  ["I ORDERED EXTRA CHEESE.", "TICKET: NO EXTRA CHEESE"],
  ["THE PEPPERONI ISN'T EVEN.", "DISTRIBUTION: 98%"],
  ["I WANTED WELL DONE, NOT THAT WELL DONE.", "COOK: REQUESTED WELL DONE"],
  ["THIS CHEESE TASTES DIFFERENT.", "SAME CHEESE SINCE OPENING"],
  ["THE PIZZA LOOKS SMALLER.", "PAN REMAINS DEFIANTLY 16 INCHES"],
  ["THERE ARE ONLY 31 PEPPERONIS.", "PLAYER PLACED: 32"],
  ["IT WAS READY TOO FAST TO BE FRESH.", "CUSTOMER ATE 75% BEFORE CALLING"],
] as const;
const events = [
  {
    title: "PHONE IS RINGING",
    text: "Caller: Are you open? Clock: 6:14 PM.",
    choices: ["YES", "EXPLAIN TIME"],
    correct: 0,
  },
  {
    title: "FRYER TIMER",
    text: "BEEP. BEEP. The fryer is becoming legally sentient.",
    choices: ["SILENCE IT", "LET IT ASCEND"],
    correct: 0,
  },
  {
    title: "EMPLOYEE QUESTION",
    text: "Is a medium the regular?",
    choices: ["YES", "WE DISCUSSED THIS"],
    correct: 0,
  },
  {
    title: "CUSTOMER AT COUNTER",
    text: "I called this in. I TALKED TO A GUY.",
    choices: ["SEARCH NOTHING", "ASK WHICH GUY"],
    correct: 1,
  },
  {
    title: "DELIVERY DRIVER",
    text: "Where's Maple Street? It was ordered nine seconds ago.",
    choices: ["POINT AT TICKET", "RELEASE GEESE"],
    correct: 0,
  },
  {
    title: "PRINTER JAM",
    text: "Seventeen feet of emotional damage just printed.",
    choices: ["CLEAR JAM", "BLAME WIFI"],
    correct: 0,
  },
];
function ticket(id: number, e: number, boss = false): Ticket {
  if (boss)
    return {
      id,
      size: "JUMBO",
      extraCheese: true,
      wellDone: true,
      patience: 55,
      boss: true,
      req: ["pepperoni", "sausage", "mushroom", "pepper", "onion", "bacon"].map(
        (t, i) => ({
          topping: t as Top,
          side: i % 3 === 0 ? "left" : i % 3 === 1 ? "right" : "whole",
          count: 5,
        }),
      ),
    };
  const n = e < 22 ? 1 : e < 48 ? 2 : e < 78 ? 3 : 4;
  return {
    id,
    size: (["SMALL", "REGULAR", "JUMBO"] as Size[])[
      Math.floor(Math.random() * (e < 20 ? 2 : 3))
    ],
    req: [...TOPS]
      .sort(() => Math.random() - 0.5)
      .slice(0, n)
      .map((t, i) => ({
        topping: t,
        side: e > 28 && i < 2 ? (i ? "right" : "left") : "whole",
        count: e > 70 ? 6 : 5,
      })),
    extraCheese: e > 35 && Math.random() < 0.25,
    wellDone: e > 55 && Math.random() < 0.2,
    patience: Math.max(34, 64 - Math.floor(e / 8)),
  };
}
class Audio {
  ctx: AudioContext | null = null;
  gain: GainNode | null = null;
  loop = 0;
  start() {
    if (this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    this.ctx = new C();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.3;
    this.gain.connect(this.ctx.destination);
    let s = 0;
    this.loop = window.setInterval(() => {
      this.tone(
        [110, 147, 165, 147, 123, 165, 196, 147][s % 8],
        0.1,
        0.04,
        "triangle",
      );
      if (s % 2 === 0) this.tone([440, 523, 587, 659][(s / 2) % 4], 0.06, 0.03);
      s++;
    }, 115);
  }
  tone(
    f: number,
    d = 0.08,
    v = 0.08,
    type: OscillatorType = "square",
    delay = 0,
  ) {
    if (!this.ctx || !this.gain) return;
    const t = this.ctx.currentTime + delay,
      o = this.ctx.createOscillator(),
      g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g);
    g.connect(this.gain);
    o.start(t);
    o.stop(t + d + 0.02);
  }
  sfx(k: "drop" | "spread" | "box" | "bad" | "perfect" | "phone") {
    if (k === "drop") {
      this.tone(230, 0.06, 0.08, "triangle");
      this.tone(155, 0.08, 0.05, "square", 0.02);
    }
    if (k === "spread") this.tone(125, 0.04, 0.02, "sawtooth");
    if (k === "box") {
      this.tone(95, 0.1, 0.12);
      this.tone(320, 0.08, 0.06, "triangle", 0.08);
    }
    if (k === "bad") {
      this.tone(145, 0.3, 0.13, "sawtooth");
      this.tone(90, 0.3, 0.1, "square", 0.03);
    }
    if (k === "perfect")
      [523, 659, 784, 1046].forEach((n, i) =>
        this.tone(n, 0.16, 0.09, i % 2 ? "triangle" : "square", i * 0.05),
      );
    if (k === "phone")
      [740, 580, 740].forEach((n, i) =>
        this.tone(n, 0.14, 0.06, "square", i * 0.12),
      );
  }
  stop() {
    clearInterval(this.loop);
    void this.ctx?.close();
    this.ctx = null;
    this.gain = null;
  }
}

export default function Game() {
  const [mode, setMode] = useState<"home" | "play" | "won" | "lost">("home"),
    [name, setName] = useState(""),
    [elapsed, setElapsed] = useState(0),
    [tickets, setTickets] = useState<Ticket[]>([]),
    [activeId, setActiveId] = useState(0),
    [build, setBuild] = useState<Build>(blank),
    [tool, setTool] = useState<Tool>("sauce"),
    [drag, setDrag] = useState(false),
    [cutStart, setCutStart] = useState<Point | null>(null),
    [score, setScore] = useState(0),
    [strikes, setStrikes] = useState(0),
    [made, setMade] = useState(0),
    [perfects, setPerfects] = useState(0),
    [combo, setCombo] = useState(0),
    [bestCombo, setBestCombo] = useState(0),
    [average, setAverage] = useState(100),
    [result, setResult] = useState<Result | null>(null),
    [event, setEvent] = useState<(typeof events)[number] | null>(null),
    [complaint, setComplaint] = useState<(typeof complaints)[number] | null>(
      null,
    ),
    [message, setMessage] = useState(""),
    [reward, setReward] = useState<{ code?: string; error?: string } | null>(
      null,
    ),
    [run, setRun] = useState<Run | null>(null),
    [leaders, setLeaders] = useState<Leader[]>([]),
    [showLeaders, setShowLeaders] = useState(false),
    [leadersLoading, setLeadersLoading] = useState(false),
    [muted, setMuted] = useState(false),
    [boss, setBoss] = useState(false),
    [finalDone, setFinalDone] = useState(0),
    [phoneCalls, setPhoneCalls] = useState(0);
  const audio = useRef(new Audio()),
    seq = useRef(0),
    scores = useRef<number[]>([]),
    lastSpawn = useRef(0),
    eventAt = useRef(18),
    expired = useRef(new Set<number>());
  const active = tickets.find((t) => t.id === activeId) || tickets[0];
  const phase =
    elapsed < 22
      ? "OPENING"
      : elapsed < 48
        ? "DINNER"
        : elapsed < 78
          ? "RUSH"
          : elapsed < 103
            ? "CHAOS"
            : "CLOSING";
  const select = useCallback((next: Ticket[]) => {
    setTickets(next);
    setActiveId((old) =>
      next.some((t) => t.id === old) ? old : next[0]?.id || 0,
    );
  }, []);
  useEffect(() => {
    if (mode !== "play" || result || event || complaint) return;
    const i = setInterval(() => {
      setElapsed((v) => Math.min(120, v + 0.1));
      setTickets((v) => v.map((t) => ({ ...t, patience: t.patience - 0.1 })));
    }, 100);
    return () => clearInterval(i);
  }, [mode, result, event, complaint]);
  useEffect(() => {
    if (mode !== "play" || result || event || complaint) return;
    const late = tickets.find(
      (t) => t.patience <= 0 && !expired.current.has(t.id),
    );
    if (!late) return;
    expired.current.add(late.id);
    audio.current.sfx("bad");
    setMessage(
      `ORDER #${String(late.id).slice(-3)} HAS ACHIEVED ROOM TEMPERATURE.`,
    );
    setTimeout(() => setMessage(""), 2200);
    const ns = strikes + 1;
    setStrikes(ns);
    setCombo(0);
    select(tickets.filter((t) => t.id !== late.id));
    if (ns >= 3) {
      setMode("lost");
      if (run)
        void fetch("/api/pizza-gauntlet/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "arcade_loss",
            runId: run.runId,
            token: run.token,
            score,
            delivered: made,
            perfects,
            ruined: ns,
          }),
        });
    }
  }, [
    complaint,
    event,
    made,
    mode,
    perfects,
    result,
    run,
    score,
    select,
    strikes,
    tickets,
  ]);
  useEffect(() => {
    if (mode !== "play") return;
    if (!boss && elapsed >= 103) {
      setBoss(true);
      setMessage("9:59 PM · WARNING · BOSS ORDER · WE HAVE PEOPLE OVER.");
      select([0, 1, 2].map((i) => ticket(900 + i, elapsed, true)));
      setBuild(blank());
      setTimeout(() => setMessage(""), 2600);
      return;
    }
    if (boss) return;
    const cap = elapsed < 45 ? 1 : elapsed < 78 ? 2 : 3;
    if (
      tickets.length < cap &&
      elapsed - lastSpawn.current > (elapsed < 45 ? 4 : 2.5)
    ) {
      const n = [...tickets, ticket(Math.floor(performance.now()), elapsed)];
      lastSpawn.current = elapsed;
      select(n);
    }
    if (!event && elapsed >= eventAt.current && elapsed < 100) {
      const ev = events[Math.floor(Math.random() * events.length)];
      setEvent(ev);
      if (ev.title.includes("PHONE")) setPhoneCalls((v) => v + 1);
      audio.current.sfx("phone");
      eventAt.current += 16 + Math.random() * 7;
    }
  }, [boss, elapsed, event, mode, select, tickets]);
  const checkpoint = useCallback(async () => {
    if (!run) return;
    seq.current++;
    await fetch("/api/pizza-gauntlet/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "arcade_checkpoint",
        runId: run.runId,
        token: run.token,
        elapsed,
        score,
        delivered: made,
        perfects,
        ruined: strikes,
        sequence: seq.current,
      }),
    }).catch(() => null);
  }, [run, elapsed, score, made, perfects, strikes]);
  useEffect(() => {
    if (mode !== "play") return;
    const i = setInterval(() => void checkpoint(), 10000);
    return () => clearInterval(i);
  }, [mode, checkpoint]);
  useEffect(() => () => audio.current.stop(), []);
  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 100,
      y: ((e.clientY - r.top) / r.height) * 100,
    };
  };
  const valid = (p: Point) => Math.hypot(p.x - 50, p.y - 50) <= 43;
  function apply(p: Point) {
    if (!active || !valid(p)) return;
    if (tool === "sauce" || tool === "cheese") {
      setBuild((v) =>
        v[tool].length >= 85 ? v : { ...v, [tool]: [...v[tool], p] },
      );
      audio.current.sfx("spread");
    } else if (tool !== "cut") {
      setBuild((v) => ({
        ...v,
        toppings: [...v.toppings, { ...p, topping: tool }],
      }));
      audio.current.sfx("drop");
    }
  }
  function down(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    if (tool === "cut") setCutStart(p);
    else {
      setDrag(true);
      apply(p);
    }
  }
  function move(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag || (tool !== "sauce" && tool !== "cheese")) return;
    const p = point(e),
      a = tool === "sauce" ? build.sauce : build.cheese,
      l = a.at(-1);
    if (!l || Math.hypot(l.x - p.x, l.y - p.y) > 4) apply(p);
  }
  function up(e: React.PointerEvent<HTMLDivElement>) {
    const p = point(e);
    if (tool === "cut" && cutStart && valid(p))
      setBuild((v) => ({ ...v, cuts: [...v.cuts, { from: cutStart, to: p }] }));
    setCutStart(null);
    setDrag(false);
  }
  const coverage = (p: Point[], target: number) =>
    Math.min(
      100,
      Math.round(
        (new Set(
          p.map((v) => `${Math.floor(v.x / 12)}:${Math.floor(v.y / 12)}`),
        ).size /
          target) *
          100,
      ),
    );
  function inspect() {
    if (!active) return;
    const sauce = coverage(build.sauce, 28),
      cheese = coverage(build.cheese, active.extraCheese ? 34 : 27);
    let correct = 0,
      total = 0,
      right = 0;
    active.req.forEach((r) => {
      const m = build.toppings.filter((p) => p.topping === r.topping);
      correct += Math.min(r.count, m.length);
      total += r.count;
      right += m.filter(
        (p) => r.side === "whole" || (r.side === "left" ? p.x < 50 : p.x >= 50),
      ).length;
    });
    const toppings = Math.max(
        0,
        Math.round((correct / Math.max(1, total)) * 100) -
          Math.max(0, build.toppings.length - total) * 5,
      ),
      placement = Math.min(
        100,
        Math.round((right / Math.max(1, build.toppings.length)) * 100),
      ),
      size = build.size === active.size ? 100 : 0,
      cuts = Math.min(100, build.cuts.length * 24),
      totalScore = Math.round(
        size * 0.18 +
          sauce * 0.2 +
          cheese * 0.2 +
          toppings * 0.25 +
          placement * 0.12 +
          cuts * 0.05,
      ),
      label =
        totalScore >= 98
          ? "PERFECT"
          : totalScore >= 93
            ? "SEND IT"
            : totalScore >= 84
              ? "CLOSE ENOUGH"
              : totalScore >= 70
                ? "SOMEBODY'S CALLING"
                : totalScore >= 50
                  ? "CRAIG MADE THIS"
                  : "REFUND INCOMING",
      strike = size === 0 || toppings < 40 || totalScore < 58;
    setResult({
      total: totalScore,
      sauce,
      cheese,
      toppings,
      placement,
      label,
      strike,
    });
    audio.current.sfx(strike ? "bad" : totalScore >= 93 ? "perfect" : "box");
  }
  async function accept() {
    if (!active || !result) return;
    const ns = strikes + (result.strike ? 1 : 0),
      nm = made + 1,
      np = perfects + (result.total >= 93 ? 1 : 0),
      nc = result.total >= 88 ? combo + 1 : 0;
    scores.current.push(result.total);
    const avg = Math.round(
      scores.current.reduce((a, b) => a + b, 0) / scores.current.length,
    );
    setAverage(avg);
    setStrikes(ns);
    setMade(nm);
    setPerfects(np);
    setCombo(nc);
    setBestCombo((v) => Math.max(v, nc));
    const newScore = score + result.total * 12 * Math.max(1, Math.min(4, nc));
    setScore(newScore);
    const wasBoss = !!active.boss,
      remaining = tickets.filter((t) => t.id !== active.id);
    setResult(null);
    setBuild(blank());
    select(remaining);
    if (ns >= 3) {
      setMode("lost");
      if (run)
        void fetch("/api/pizza-gauntlet/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "arcade_loss",
            runId: run.runId,
            token: run.token,
            score: newScore,
            delivered: nm,
            perfects: np,
            ruined: ns,
          }),
        });
      return;
    }
    if (Math.random() < 0.32 && !wasBoss)
      setComplaint(complaints[Math.floor(Math.random() * complaints.length)]);
    if (wasBoss) {
      const done = finalDone + 1;
      setFinalDone(done);
      if (done >= 3 && nm >= 8 && avg >= 72) await finish(nm, np, ns, newScore);
    }
  }
  async function finish(
    nm: number,
    np: number,
    ns: number,
    finalScore: number,
  ) {
    setMode("won");
    if (!run) return;
    seq.current++;
    const cp = await fetch("/api/pizza-gauntlet/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "arcade_checkpoint",
        runId: run.runId,
        token: run.token,
        elapsed,
        score: finalScore,
        delivered: nm,
        perfects: np,
        ruined: ns,
        sequence: seq.current,
      }),
    }).catch(() => null);
    if (!cp?.ok) {
      setReward({ error: "Final shift checkpoint could not be validated." });
      return;
    }
    const r = await fetch("/api/pizza-gauntlet/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "arcade_complete",
          runId: run.runId,
          token: run.token,
          score: finalScore,
          delivered: nm,
          perfects: np,
          ruined: ns,
        }),
      }),
      d = await r.json();
    setReward(r.ok ? d : { error: d.error || "Prize validation failed." });
  }
  async function begin() {
    audio.current.stop();
    audio.current = new Audio();
    audio.current.start();
    const r = await fetch("/api/pizza-gauntlet/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start", playerName: name }),
    });
    if (!r.ok) {
      setMessage((await r.json()).error || "GAME SERVICE UNAVAILABLE");
      return;
    }
    setRun(await r.json());
    setMode("play");
    setElapsed(0);
    setScore(0);
    setStrikes(0);
    setMade(0);
    setPerfects(0);
    setCombo(0);
    setBestCombo(0);
    setAverage(100);
    setBoss(false);
    setFinalDone(0);
    scores.current = [];
    expired.current.clear();
    seq.current = 0;
    lastSpawn.current = -10;
    eventAt.current = 18;
    setBuild(blank());
    select([ticket(1, 0)]);
  }
  async function openLeaders() {
    setShowLeaders(true);
    setLeadersLoading(true);
    const r = await fetch("/api/pizza-gauntlet/leaderboard"),
      d = await r.json();
    setLeaders(Array.isArray(d.leaders) ? d.leaders : []);
    setLeadersLoading(false);
  }
  return (
    <main className="gauntlet">
      {mode === "home" && (
        <section className="gauntlet-home">
          <div className="cabinet-logo">CORNER DELI ARCADE</div>
          <h1>
            THE PIZZA <i>GAUNTLET</i>
          </h1>
          <p>Read the ticket. Build the pizza. Survive the customer.</p>
          <MenuAdTicker />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="PLAYER NAME"
            maxLength={40}
          />
          <button onClick={begin}>CLOCK IN</button>
          <button className="leaderboard-button" onClick={openLeaders}>
            LEADERBOARD
          </button>
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
          {message && <strong className="start-error">{message}</strong>}
        </section>
      )}
      {mode === "play" && (
        <>
          <header className="station-hud">
            <div>
              <small>SHIFT</small>
              <b>{phase}</b>
            </div>
            <div>
              <small>CLOCK</small>
              <b>
                {elapsed >= 103
                  ? "9:59"
                  : `${5 + Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`}
              </b>
            </div>
            <div>
              <small>SCORE</small>
              <b>{score}</b>
            </div>
            <div>
              <small>STRIKES</small>
              <b>{"X".repeat(strikes) || "—"}</b>
            </div>
            <div>
              <small>COMBO</small>
              <b>×{Math.max(1, combo)}</b>
            </div>
            <button
              onClick={() => {
                const n = !muted;
                setMuted(n);
                if (audio.current.gain)
                  audio.current.gain.gain.value = n ? 0 : 0.3;
              }}
            >
              {muted ? "MUTE" : "SOUND"}
            </button>
          </header>
          <section className="pizza-station">
            <aside className="ticket-rail">
              <h2>ORDER RAIL</h2>
              {tickets.map((t) => (
                <button
                  key={t.id}
                  className={`${t.id === active?.id ? "active" : ""} ${t.boss ? "boss-ticket" : ""}`}
                  onClick={() => {
                    setActiveId(t.id);
                    setBuild(blank());
                  }}
                >
                  <b>
                    #{String(t.id).slice(-3)} · {t.size}
                  </b>
                  {t.req.map((r) => (
                    <span key={`${r.topping}-${r.side}`}>
                      {r.side === "whole" ? "" : `1/2 ${r.side.toUpperCase()} `}
                      {r.topping.toUpperCase()}
                    </span>
                  ))}
                  {t.extraCheese && <em>EXTRA CHEESE</em>}
                  {t.wellDone && <em>WELL DONE</em>}
                  <small>{Math.max(0, Math.ceil(t.patience))} SEC</small>
                </button>
              ))}
            </aside>
            <div className="prep-area">
              <div className="size-row">
                {(["SMALL", "REGULAR", "JUMBO"] as Size[]).map((s) => (
                  <button
                    className={build.size === s ? "selected" : ""}
                    onClick={() => setBuild((v) => ({ ...v, size: s }))}
                    key={s}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="pizza-board">
                <div
                  className={`build-pizza ${active?.wellDone ? "well-done" : ""}`}
                  onPointerDown={down}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={() => setDrag(false)}
                >
                  <div className="half-guide" />
                  {build.sauce.map((p, i) => (
                    <i
                      className="mark sauce-mark"
                      style={{ left: `${p.x}%`, top: `${p.y}%` }}
                      key={`s${i}`}
                    />
                  ))}
                  {build.cheese.map((p, i) => (
                    <i
                      className="mark cheese-mark"
                      style={{ left: `${p.x}%`, top: `${p.y}%` }}
                      key={`c${i}`}
                    />
                  ))}
                  {build.toppings.map((p, i) => (
                    <i
                      className={`placed-topping ${p.topping}`}
                      style={{ left: `${p.x}%`, top: `${p.y}%` }}
                      key={`t${i}`}
                    >
                      {ICON[p.topping]}
                    </i>
                  ))}
                  {build.cuts.map((c, i) => {
                    const dx = c.to.x - c.from.x,
                      dy = c.to.y - c.from.y;
                    return (
                      <i
                        className="cut-line"
                        key={i}
                        style={{
                          left: `${c.from.x}%`,
                          top: `${c.from.y}%`,
                          width: `${Math.hypot(dx, dy)}%`,
                          rotate: `${Math.atan2(dy, dx)}rad`,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="tool-tray">
                <button
                  className={tool === "sauce" ? "active" : ""}
                  onClick={() => setTool("sauce")}
                >
                  SAUCE
                </button>
                <button
                  className={tool === "cheese" ? "active" : ""}
                  onClick={() => setTool("cheese")}
                >
                  CHEESE
                </button>
                {TOPS.map((t) => (
                  <button
                    className={`${t} ${tool === t ? "active" : ""}`}
                    onClick={() => setTool(t)}
                    key={t}
                  >
                    <i>{ICON[t]}</i>
                    {t}
                  </button>
                ))}
                <button
                  className={tool === "cut" ? "active" : ""}
                  onClick={() => setTool("cut")}
                >
                  CUT
                </button>
              </div>
              <button
                className="send-pizza"
                disabled={!active}
                onClick={inspect}
              >
                SLIDE INTO OVEN · CUT · BOX · SEND
              </button>
            </div>
          </section>
          {message && <div className="boss-order-banner">{message}</div>}
          {event && (
            <aside className="nonsense-card">
              <small>RESTAURANT INTERRUPTION</small>
              <h2>{event.title}</h2>
              <p>{event.text}</p>
              {event.choices.map((c, i) => (
                <button
                  key={c}
                  onClick={() => {
                    setScore((v) =>
                      Math.max(0, v + (i === event.correct ? 150 : -100)),
                    );
                    if (i !== event.correct) setCombo(0);
                    setEvent(null);
                  }}
                >
                  {c}
                </button>
              ))}
            </aside>
          )}
          {complaint && (
            <aside className="nonsense-card complaint">
              <small>CUSTOMER CALLED</small>
              <h2>“{complaint[0]}”</h2>
              <p>{complaint[1]}</p>
              {[
                "ADD MORE CHEESE",
                "REMAKE IT",
                "STARE AT WALL",
                "EXPLAIN MATH",
              ].map((c, i) => (
                <button
                  key={c}
                  onClick={() => {
                    setScore((v) => Math.max(0, v + (i === 2 ? 25 : -35)));
                    setComplaint(null);
                  }}
                >
                  {c}
                </button>
              ))}
            </aside>
          )}
          {result && (
            <aside className="inspection">
              <small>QUALITY CONTROL</small>
              <dl>
                {[
                  ["SAUCE", result.sauce],
                  ["CHEESE", result.cheese],
                  ["TOPPINGS", result.toppings],
                  ["PLACEMENT", result.placement],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}%</dd>
                  </div>
                ))}
              </dl>
              <strong>{result.total}%</strong>
              <h2>{result.label}</h2>
              <button onClick={accept}>SEND IT</button>
            </aside>
          )}
        </>
      )}
      {mode === "lost" && (
        <section className="end-card">
          <small>SHIFT TERMINATED</small>
          <h1>{losses[Math.floor(Math.random() * losses.length)]}</h1>
          <p>
            PIZZAS {made} · ACCURACY {average}% · PERFECT {perfects} · PHONE
            CALLS {phoneCalls} · LONGEST COMBO {bestCombo} · SCORE {score}
          </p>
          <button onClick={begin}>CLOCK BACK IN</button>
          <button onClick={openLeaders}>LEADERBOARD</button>
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
        </section>
      )}
      {mode === "won" && (
        <section className="end-card won">
          <small>SHIFT COMPLETE</small>
          <h1>AGAINST ALL ODDS</h1>
          <p>MANAGEMENT HAS REVIEWED YOUR PERFORMANCE.</p>
          <b>YOU HAVE EARNED A JUMBO PIZZA.</b>
          {reward?.code ? (
            <code>{reward.code}</code>
          ) : (
            <small>{reward?.error || "VALIDATING SHIFT…"}</small>
          )}
          <button onClick={begin}>ONE MORE SHIFT</button>
          <button onClick={openLeaders}>LEADERBOARD</button>
          <a className="return-games" href="/games">
            ← ALL GAMES
          </a>
        </section>
      )}
      {showLeaders && (
        <section className="leaderboard-modal">
          <div>
            <button
              className="leaderboard-close"
              onClick={() => setShowLeaders(false)}
            >
              ×
            </button>
            <small>CORNER DELI HIGH SCORES</small>
            <h2>PIZZA LEGENDS</h2>
            {leadersLoading ? (
              <p>LOADING…</p>
            ) : (
              <ol>
                {leaders.map((l, i) => (
                  <li key={`${l.player_name}-${i}`}>
                    <b>{i + 1}</b>
                    <strong>{l.player_name}</strong>
                    <span>
                      {Number(l.score).toLocaleString()} PTS
                      <small>
                        {l.pizzas_made} PIZZAS · {l.perfects} GREAT
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
