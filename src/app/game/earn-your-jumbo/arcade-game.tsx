"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { MenuAdTicker } from "@/app/games/components/menu-ad-ticker";
type Layer = "dough" | "sauce" | "cheese";
type Tray = {
  id: number;
  x: number;
  step: number;
  crisis: boolean;
  fire: boolean;
};
type Burst = { id: number; x: number; layer: Layer; bad?: boolean };
type Run = { runId: string; token: string };
type Leader = {
  player_name: string;
  score: number | string;
  pizzas_made: number;
  perfects: number;
  completed_at: string;
};
const LAYERS: Layer[] = ["dough", "sauce", "cheese"],
  KEYS: Record<string, Layer> = {
    ArrowLeft: "dough",
    ArrowDown: "sauce",
    ArrowRight: "cheese",
    a: "dough",
    s: "sauce",
    d: "cheese",
  },
  ICON = { dough: "◯", sauce: "●", cheese: "▰" };
class Audio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  timer = 0;
  step = 0;
  frantic = false;
  start() {
    if (this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    this.ctx = new C();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.45;
    this.master.connect(this.ctx.destination);
    this.tick();
  }
  note(f: number, d = 0.09, v = 0.09, type: OscillatorType = "square", at = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + at,
      o = this.ctx.createOscillator(),
      g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = f * (this.frantic ? 2 : 1);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + d + 0.01);
  }
  tick() {
    this.timer = window.setInterval(
      () => {
        const b = [110, 147, 165, 147, 123, 165, 196, 165],
          l = [440, 494, 523, 659, 587, 523, 494, 392];
        this.note(b[this.step % 8], 0.12, 0.065, "triangle");
        if (this.step % 2 === 0) this.note(l[(this.step / 2) % 8], 0.08, 0.05);
        if (this.step % 4 === 2) this.note(1200, 0.025, 0.025);
        this.step++;
      },
      this.frantic ? 72 : 90,
    );
  }
  frenzy() {
    if (this.frantic) return;
    this.frantic = true;
    clearInterval(this.timer);
    this.tick();
    this.note(523, 0.12, 0.12);
    this.note(1046, 0.2, 0.12, "square", 0.12);
  }
  sfx(k: "splat" | "error" | "perfect" | "victory") {
    if (k === "splat") {
      this.note(180, 0.08, 0.12, "sawtooth");
      this.note(110, 0.1, 0.08, "triangle", 0.03);
    } else if (k === "error") {
      this.note(155, 0.3, 0.16, "sawtooth");
      this.note(110, 0.3, 0.14, "square", 0.06);
    } else if (k === "perfect") {
      [659, 784, 988].forEach((n, i) =>
        this.note(n, 0.15, 0.12, "square", i * 0.045),
      );
    } else {
      clearInterval(this.timer);
      [392, 440, 494, 523, 659, 587, 659, 784, 1046].forEach((n, i) =>
        this.note(n, 0.28, 0.14, i % 2 ? "triangle" : "square", i * 0.1),
      );
    }
  }
  stop() {
    clearInterval(this.timer);
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
export default function Game() {
  const [mode, setMode] = useState<"home" | "play" | "won" | "lost">("home"),
    [name, setName] = useState(""),
    [time, setTime] = useState(60),
    [score, setScore] = useState(0),
    [perfects, setPerfects] = useState(0),
    [combo, setCombo] = useState(0),
    [delivered, setDelivered] = useState(0),
    [ruined, setRuined] = useState(0),
    [trays, setTrays] = useState<Tray[]>([]),
    [bursts, setBursts] = useState<Burst[]>([]),
    [flash, setFlash] = useState(""),
    [startError, setStartError] = useState(""),
    [reward, setReward] = useState<{ code?: string; error?: string } | null>(
      null,
    ),
    [muted, setMuted] = useState(false);
  const [showLeaders, setShowLeaders] = useState(false),
    [leaders, setLeaders] = useState<Leader[]>([]),
    [leadersLoading, setLeadersLoading] = useState(false);
  const state = useRef({
      mode: "home",
      time: 60,
      score: 0,
      perfects: 0,
      combo: 0,
      delivered: 0,
      ruined: 0,
      trays: [] as Tray[],
      last: 0,
      nextId: 1,
      lastSpawn: 0,
      speed: 13,
      boostUntil: 0,
      run: null as Run | null,
      checkpoints: 0,
    }),
    audio = useRef(new Audio());
  const sync = useCallback(() => {
    const s = state.current;
    setTime(Math.max(0, Math.ceil(s.time)));
    setScore(s.score);
    setPerfects(s.perfects);
    setCombo(s.combo);
    setDelivered(s.delivered);
    setRuined(s.ruined);
    setTrays([...s.trays]);
  }, []);
  const burst = (x: number, layer: Layer, bad = false) => {
    const id = Date.now() + Math.random();
    setBursts((v) => [...v, { id, x, layer, bad }]);
    setTimeout(() => setBursts((v) => v.filter((p) => p.id !== id)), 460);
  };
  const fail = useCallback((message: string) => {
    const s = state.current;
    if (s.mode !== "play") return;
    s.ruined++;
    s.combo = 0;
    s.mode = "lost";
    setRuined(s.ruined);
    setFlash(message);
    setMode("lost");
    audio.current.sfx("error");
  }, []);
  const act = useCallback(
    (layer: Layer) => {
      const s = state.current;
      if (s.mode !== "play") return;
      const tray = s.trays
        .filter((t) => t.step < 3)
        .sort((a, b) => Math.abs(a.x - 50) - Math.abs(b.x - 50))[0];
      if (!tray || Math.abs(tray.x - 50) > 30 || LAYERS[tray.step] !== layer) {
        burst(tray?.x ?? 50, layer, true);
        fail(
          `WRONG DROP — ${layer.toUpperCase()} HIT THE WRONG PART OF THE LINE!`,
        );
        return;
      }
      const perfect = Math.abs(tray.x - 50) <= 8;
      tray.step++;
      tray.crisis = false;
      if (perfect) {
        s.combo++;
        s.perfects++;
        s.boostUntil = performance.now() + 650;
        s.score += 100 * (s.combo >= 5 ? 2 : 1);
        tray.fire = s.combo >= 5;
        setFlash("PERFECT! +5% SPEED");
        audio.current.sfx("perfect");
      } else {
        s.combo = 0;
        s.score += 45;
        setFlash("GOOD!");
        audio.current.sfx("splat");
      }
      burst(tray.x, layer);
      setTimeout(() => setFlash(""), 280);
      sync();
    },
    [fail, sync],
  );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const l = KEYS[e.key];
      if (l) {
        e.preventDefault();
        act(l);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [act]);
  const checkpoint = useCallback(async () => {
    const s = state.current;
    if (!s.run) return;
    s.checkpoints++;
    await fetch("/api/pizza-gauntlet/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "arcade_checkpoint",
        runId: s.run.runId,
        token: s.run.token,
        elapsed: 60 - s.time,
        score: s.score,
        delivered: s.delivered,
        perfects: s.perfects,
        ruined: s.ruined,
        sequence: s.checkpoints,
      }),
    });
  }, []);
  const win = useCallback(async () => {
    const s = state.current;
    if (s.mode !== "play") return;
    s.mode = "won";
    s.time = 0;
    sync();
    setMode("won");
    audio.current.sfx("victory");
    if (!s.run) return;
    await checkpoint();
    const r = await fetch("/api/pizza-gauntlet/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "arcade_complete",
          runId: s.run.runId,
          token: s.run.token,
          score: s.score,
          delivered: s.delivered,
          perfects: s.perfects,
          ruined: s.ruined,
        }),
      }),
      d = await r.json();
    setReward(r.ok ? d : { error: d.error || "Prize validation failed." });
  }, [checkpoint, sync]);
  useEffect(() => {
    if (mode !== "play") return;
    let raf = 0;
    const frame = (now: number) => {
      const s = state.current;
      if (s.mode !== "play") return;
      if (!s.last) s.last = now;
      const dt = Math.min(0.04, (now - s.last) / 1000);
      s.last = now;
      s.time -= dt;
      if (s.time <= 15) audio.current.frenzy();
      s.speed =
        9.5 *
        (1 + Math.floor(s.delivered / 3) * 0.05) *
        (s.time <= 15 ? 1.2 : 1) *
        (now < s.boostUntil ? 1.05 : 1);
      if (now - s.lastSpawn > Math.max(1400, 2500 - s.delivered * 25)) {
        s.trays.push({
          id: s.nextId++,
          x: -9,
          step: 0,
          crisis: false,
          fire: false,
        });
        s.lastSpawn = now;
      }
      s.trays.forEach((t) => {
        t.x += s.speed * dt;
        if (t.x > 78 && t.step < 3) t.crisis = true;
      });
      const out = s.trays.find((t) => t.x >= 108);
      if (out) {
        if (out.step < 3) {
          fail(
            "AN INCOMPLETE PIZZA LEFT THE BELT. THE CUSTOMER SAW EVERYTHING.",
          );
          return;
        }
        s.delivered++;
        s.score += 250 * (s.combo >= 5 ? 2 : 1);
        s.trays = s.trays.filter((t) => t.id !== out.id);
      }
      if (s.time <= 0) {
        void win();
        return;
      }
      sync();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [mode, fail, sync, win]);
  useEffect(() => {
    if (mode !== "play") return;
    const id = setInterval(() => void checkpoint(), 10000);
    return () => clearInterval(id);
  }, [mode, checkpoint]);
  useEffect(() => () => audio.current.stop(), []);
  async function begin() {
    setStartError("");
    audio.current.stop();
    audio.current = new Audio();
    audio.current.start();
    const r = await fetch("/api/pizza-gauntlet/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start", playerName: name }),
    });
    if (!r.ok) {
      const problem = await r
        .json()
        .catch(() => ({ error: "Game service is unavailable." }));
      setStartError(problem.error || "Game service is unavailable.");
      audio.current.stop();
      return;
    }
    const run = (await r.json()) as Run;
    state.current = {
      mode: "play",
      time: 60,
      score: 0,
      perfects: 0,
      combo: 0,
      delivered: 0,
      ruined: 0,
      trays: [],
      last: 0,
      nextId: 1,
      lastSpawn: 0,
      speed: 13,
      boostUntil: 0,
      run,
      checkpoints: 0,
    };
    setReward(null);
    setFlash("");
    setMode("play");
    sync();
  }
  function toggle() {
    const n = !muted;
    setMuted(n);
    if (audio.current.master) audio.current.master.gain.value = n ? 0 : 0.45;
  }
  async function openLeaderboard() {
    setShowLeaders(true);
    setLeadersLoading(true);
    const response = await fetch("/api/pizza-gauntlet/leaderboard");
    const data = await response.json();
    setLeaders(Array.isArray(data.leaders) ? data.leaders : []);
    setLeadersLoading(false);
  }
  return (
    <main
      className={`gauntlet ${time <= 15 && mode === "play" ? "final-frenzy" : ""}`}
    >
      {mode === "home" && (
        <section className="gauntlet-home">
          <img
            className="game-corner-logo"
            src="https://rezku-pos-upload.imgix.net/2e2a0810-d179-474b-a40b-e4104c60d8c1/olo/logo/jO52kF7dMM84upTQGozunTrduBxjbylAFeGYc8r_RT8.png?fit=max&auto=compress&fmt=png32&h=180"
            alt="Corner Deli"
          />
          <div className="cabinet-logo">CORNER DELI ARCADE</div>
          <h1>
            THE PIZZA
            <br />
            <i>GAUNTLET</i>
          </h1>
          <p>60 seconds. Three ingredients. Zero ruined pizzas.</p>
          <MenuAdTicker />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="PLAYER NAME"
            maxLength={40}
          />
          <button onClick={begin}>PRESS START</button>
          <button className="leaderboard-button" onClick={openLeaderboard}>
            🏆 LEADERBOARD
          </button>
          {startError && <strong className="start-error">{startError}</strong>}
          <small>← DOUGH &nbsp; ↓ SAUCE &nbsp; → CHEESE</small>
        </section>
      )}
      {mode === "play" && (
        <>
          <header className="chalk-hud">
            <div>
              <small>SHIFT</small>
              <b>{String(time).padStart(2, "0")}</b>
            </div>
            <div>
              <small>SCORE</small>
              <b>{String(score).padStart(6, "0")}</b>
            </div>
            <div className={`fire-meter ${combo >= 5 ? "lit" : ""}`}>
              <small>COMBO FIRE</small>
              <b>×{Math.max(1, combo)}</b>
            </div>
            <button onClick={toggle}>{muted ? "🔇" : "🔊"}</button>
          </header>
          <div className="customers">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <i key={i}>
                {time > 40 ? "🙂" : time > 15 ? (i % 2 ? "😒" : "😠") : "🤯"}
              </i>
            ))}
          </div>
          <section className="conveyor">
            <MenuAdTicker overlay />
            <div className="sweet-zone">
              <b>PERFECT</b>
            </div>
            {trays.map((t) => (
              <article
                key={t.id}
                className={`tray ${t.crisis ? "crisis" : ""} ${t.fire ? "combo-fire" : ""}`}
                style={{ left: `${t.x}%` }}
              >
                <div className="recipe-chain">
                  {LAYERS.map((l, i) => (
                    <span className={i < t.step ? "done" : ""} key={l}>
                      {ICON[l]}
                    </span>
                  ))}
                </div>
                <div className={`pizza step-${t.step}`}>
                  {t.step > 1 && <i className="sauce" />}
                  {t.step > 2 && <i className="cheese" />}
                </div>
              </article>
            ))}
            {bursts.map((p) => (
              <i
                key={p.id}
                className={`splat ${p.layer} ${p.bad ? "bad" : ""}`}
                style={{ left: `${p.x}%` }}
              >
                ✦
              </i>
            ))}
            <div className="belt-teeth" />
          </section>
          <div
            className={`timing-callout ${flash.includes("WRONG") ? "bad" : ""}`}
          >
            {flash}
          </div>
          <section className="lane-controls">
            {LAYERS.map((l, i) => (
              <button key={l} onPointerDown={() => act(l)}>
                <kbd>{["←", "↓", "→"][i]}</kbd>
                <span>{ICON[l]}</span>
                <b>{l}</b>
              </button>
            ))}
          </section>
          <footer>
            <span>DELIVERED {delivered}</span>
            <span>PERFECT {perfects}</span>
            <span>RUINED {ruined}</span>
          </footer>
        </>
      )}
      {mode === "lost" && (
        <section className="end-card lost">
          <div className="ruined-pizza">🍕</div>
          <h1>SHIFT DESTROYED</h1>
          <p>{flash}</p>
          <b>One ruined pizza means the Jumbo lives to see another day.</b>
          <button onClick={begin}>RUN IT BACK</button>
          <button className="leaderboard-button" onClick={openLeaderboard}>
            🏆 LEADERBOARD
          </button>
        </section>
      )}
      {mode === "won" && (
        <section className="end-card won">
          <div className="confetti">✦ ◆ ● ★ ✦ ◆ ● ★ ✦ ◆</div>
          <h1>SHIFT SURVIVED!</h1>
          <p>{delivered} pizzas escaped the line. Not one was ruined.</p>
          <b>YOU EARNED A FREE JUMBO CHEESE PIZZA</b>
          {reward?.code ? (
            <code>{reward.code}</code>
          ) : (
            <small>{reward?.error || "VALIDATING RUN…"}</small>
          )}
          <button onClick={begin}>PLAY AGAIN</button>
          <button className="leaderboard-button" onClick={openLeaderboard}>
            🏆 LEADERBOARD
          </button>
        </section>
      )}
      {showLeaders && (
        <section className="leaderboard-modal" role="dialog" aria-modal="true">
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
              <p>LOADING SCORES…</p>
            ) : leaders.length === 0 ? (
              <p>No winners yet. The board is waiting.</p>
            ) : (
              <ol>
                {leaders.map((leader, index) => (
                  <li
                    key={`${leader.player_name}-${leader.completed_at}-${index}`}
                  >
                    <b>{index + 1}</b>
                    <strong>{leader.player_name}</strong>
                    <span>
                      {Number(leader.score).toLocaleString()} PTS
                      <small>
                        {leader.pizzas_made} PIZZAS · {leader.perfects} PERFECT
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
