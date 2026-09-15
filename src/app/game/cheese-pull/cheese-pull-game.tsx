"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Mode = "home" | "play" | "over" | "won";
type Shot = { x: number; y: number };
type Enemy = { id: number; x: number; y: number; kind: string; hp: number };
type State = {
  x: number;
  y: number;
  vy: number;
  level: number;
  distance: number;
  health: number;
  score: number;
  ammo: number;
  combo: number;
  bossHp: number;
  shots: Shot[];
  enemies: Enemy[];
  nextEnemy: number;
  last: number;
  message: string;
};
const fresh = (): State => ({
  x: 120,
  y: 0,
  vy: 0,
  level: 1,
  distance: 0,
  health: 5,
  score: 0,
  ammo: 18,
  combo: 0,
  bossHp: 0,
  shots: [],
  enemies: [],
  nextEnemy: 1.4,
  last: 0,
  message: "GET THE FOOD THERE WHILE IT IS STILL LEGALLY WARM",
});
const ENEMIES = [
  "GOOSE",
  "POTHOLE",
  "PARKING CONE",
  "ANGRY RACCOON",
  "ROGUE LAWNMOWER",
  "FACEBOOK COMMENT",
];
const LEVELS = [
  "OGDENSBURG SIDE STREETS",
  "HEUVELTON AFTER DARK",
  "LISBON COMPLAINT DISTRICT",
];
const QUIPS = [
  "THE GOOSE HAS BEEN INFORMED THIS IS A DELIVERY VEHICLE.",
  "DPW SAYS THE POTHOLE IS A HISTORIC LANDMARK.",
  "THE RACCOON DEMANDED EXTRA BLUE CHEESE.",
  "THE LAWNMOWER HAD NO INSURANCE.",
  "THE FACEBOOK COMMENT WAS POSTED BEFORE THE FOOD WAS ORDERED.",
  "CUSTOMER SAW YOU ARRIVE AND ASKED WHERE YOU WERE.",
];
class Audio {
  ctx: AudioContext | null = null;
  timer = 0;
  tone(f: number, d = 0.09, v = 0.08, delay = 0) {
    if (!this.ctx) this.ctx = new AudioContext();
    const c = this.ctx,
      o = c.createOscillator(),
      g = c.createGain(),
      t = c.currentTime + delay;
    o.type = "square";
    o.frequency.value = f;
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + d);
  }
  start() {
    this.stop();
    let n = 0;
    this.timer = window.setInterval(() => {
      this.tone([131, 165, 196, 262][n % 4], 0.08, 0.035);
      if (n % 2 === 0) this.tone([523, 659, 784, 659][n % 4], 0.05, 0.025);
      n++;
    }, 110);
  }
  shoot() {
    this.tone(620, 0.06, 0.12);
    this.tone(260, 0.09, 0.08, 0.035);
  }
  hit() {
    this.tone(100, 0.25, 0.16);
  }
  win() {
    [523, 659, 784, 1047].forEach((n, i) => this.tone(n, 0.2, 0.12, i * 0.09));
  }
  stop() {
    clearInterval(this.timer);
  }
}
const audio = new Audio();

export default function DeliveryBlaster() {
  const canvas = useRef<HTMLCanvasElement>(null),
    game = useRef(fresh()),
    frame = useRef(0);
  const [mode, setMode] = useState<Mode>("home"),
    [view, setView] = useState(fresh()),
    [high, setHigh] = useState(0);
  useEffect(
    () => setHigh(Number(localStorage.getItem("delivery-blaster-high") || 0)),
    [],
  );
  const finish = useCallback((won: boolean) => {
    const s = game.current;
    setMode(won ? "won" : "over");
    audio.stop();
    if (won) audio.win();
    else audio.hit();
    const old = Number(localStorage.getItem("delivery-blaster-high") || 0);
    if (s.score > old) {
      localStorage.setItem("delivery-blaster-high", String(s.score));
      setHigh(s.score);
    }
  }, []);
  const start = useCallback(() => {
    game.current = fresh();
    setView(game.current);
    setMode("play");
    audio.start();
  }, []);
  const jump = useCallback(() => {
    const s = game.current;
    if (mode === "play" && s.y === 0) s.vy = 630;
  }, [mode]);
  const shoot = useCallback(() => {
    const s = game.current;
    if (mode !== "play" || s.ammo <= 0) return;
    s.ammo--;
    s.shots.push({ x: s.x + 55, y: s.y + 76 });
    audio.shoot();
  }, [mode]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (["Space", "ArrowUp", "KeyW"].includes(e.code)) {
        e.preventDefault();
        jump();
      }
      if (["KeyX", "KeyF", "Enter"].includes(e.code)) {
        e.preventDefault();
        shoot();
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [jump, shoot]);
  useEffect(() => {
    if (mode !== "play") return;
    const loop = (now: number) => {
      const s = game.current,
        dt = Math.min(0.035, (now - (s.last || now)) / 1000),
        speed = 230 + s.level * 42;
      s.last = now;
      s.distance += speed * dt;
      s.nextEnemy -= dt;
      s.y = Math.max(0, s.y + s.vy * dt);
      s.vy -= 1400 * dt;
      if (s.y === 0 && s.vy < 0) s.vy = 0;
      if (s.nextEnemy <= 0 && s.bossHp === 0) {
        s.nextEnemy = Math.max(0.55, 1.5 - s.level * 0.22);
        s.enemies.push({
          id: Date.now() + Math.random(),
          x: 1100,
          y: 0,
          kind: ENEMIES[Math.floor(Math.random() * ENEMIES.length)],
          hp: 1,
        });
      }
      s.enemies.forEach((e) => (e.x -= speed * dt));
      s.shots.forEach((b) => (b.x += 660 * dt));
      for (const shot of s.shots)
        for (const enemy of s.enemies)
          if (
            enemy.hp > 0 &&
            Math.abs(shot.x - enemy.x) < 48 &&
            Math.abs(shot.y - (enemy.y + 50)) < 70
          ) {
            enemy.hp = 0;
            shot.x = 9999;
            s.combo++;
            s.score += 100 * Math.min(5, s.combo);
            s.message = QUIPS[Math.floor(Math.random() * QUIPS.length)];
            audio.shoot();
          }
      const crash = s.enemies.find(
        (e) => e.hp > 0 && e.x < 190 && e.x > 70 && s.y < 70,
      );
      if (crash) {
        crash.hp = 0;
        s.health--;
        s.combo = 0;
        s.message = `HIT ${crash.kind}. ${QUIPS[Math.floor(Math.random() * QUIPS.length)]}`;
        audio.hit();
        navigator.vibrate?.([40, 30, 40]);
        if (s.health <= 0) {
          finish(false);
          return;
        }
      }
      s.enemies = s.enemies.filter((e) => e.hp > 0 && e.x > -100);
      s.shots = s.shots.filter((b) => b.x < 1200);
      const goal = s.level * 2400;
      if (s.distance >= goal && s.bossHp === 0) {
        s.bossHp = 4 + s.level * 2;
        s.message =
          "BOSS: CUSTOMER CLAIMS YOU NEVER ARRIVED WHILE WATCHING YOU ARRIVE";
      }
      if (s.bossHp > 0) {
        const bossX = 930;
        for (const shot of s.shots)
          if (shot.x > bossX) {
            shot.x = 9999;
            s.bossHp--;
            s.score += 250;
            audio.hit();
          }
        if (s.bossHp <= 0) {
          s.score += 1000;
          s.ammo += 12;
          if (s.level === 3) {
            s.message =
              "FOOD DELIVERED. CUSTOMER COMPLAINED IT WAS TOO ON TIME.";
            finish(true);
            return;
          }
          s.level++;
          s.distance = (s.level - 1) * 2400;
          s.message = `LEVEL ${s.level}: ${LEVELS[s.level - 1]}`;
        }
      }
      if (s.ammo === 0 && !s.shots.length && s.bossHp > 0) {
        s.message = "OUT OF SUBS. THE CUSTOMER HAS WON THE ARGUMENT.";
        finish(false);
        return;
      }
      setView({ ...s, enemies: [...s.enemies], shots: [...s.shots] });
      frame.current = requestAnimationFrame(loop);
    };
    frame.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame.current);
  }, [finish, mode]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const draw = () => {
      const c = el.getContext("2d");
      if (!c) return;
      const box = el.getBoundingClientRect(),
        r = Math.min(2, devicePixelRatio || 1);
      if (el.width !== box.width * r) {
        el.width = box.width * r;
        el.height = box.height * r;
      }
      const w = el.width,
        h = el.height,
        s = game.current,
        ground = h * 0.78;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = s.level === 2 ? "#10152d" : "#69b9df";
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#405238";
      c.fillRect(0, ground, w, h - ground);
      c.fillStyle = "#46494d";
      c.fillRect(0, ground + 35, w, h - ground);
      c.fillStyle = "#fff4aa";
      for (let x = -(s.distance % 180); x < w; x += 180)
        c.fillRect(x, ground + 90, 85, 8);
      for (let x = 100 - ((s.distance * 0.22) % 330); x < w; x += 330) {
        c.fillStyle = "#d5b172";
        c.fillRect(x, ground - 165, 190, 165);
        c.fillStyle = "#7e3026";
        c.beginPath();
        c.moveTo(x - 20, ground - 165);
        c.lineTo(x + 95, ground - 250);
        c.lineTo(x + 210, ground - 165);
        c.fill();
        c.fillStyle = "#83d9ff";
        c.fillRect(x + 28, ground - 120, 48, 55);
        c.fillRect(x + 116, ground - 120, 48, 55);
      }
      c.font = `900 ${Math.max(18, w * 0.022)}px monospace`;
      c.fillStyle = "#fff";
      c.fillText(LEVELS[s.level - 1], 20, 38);
      c.save();
      c.translate(s.x * r, ground - s.y * r);
      c.fillStyle = "#575f66";
      c.fillRect(0, -105 * r, 76 * r, 105 * r);
      c.fillStyle = "#e8fbff";
      c.fillRect(12 * r, -92 * r, 52 * r, 32 * r);
      c.fillStyle = "#ffd84b";
      c.fillRect(57 * r, -42 * r, 28 * r, 13 * r);
      c.restore();
      s.enemies.forEach((e) => {
        c.font = `${55 * r}px sans-serif`;
        c.fillText(
          e.kind === "GOOSE"
            ? "🪿"
            : e.kind === "POTHOLE"
              ? "🕳️"
              : e.kind === "ANGRY RACCOON"
                ? "🦝"
                : e.kind === "ROGUE LAWNMOWER"
                  ? "🏎️"
                  : e.kind === "FACEBOOK COMMENT"
                    ? "💬"
                    : "🚧",
          e.x * r,
          ground,
        );
      });
      s.shots.forEach((b) => {
        c.font = `${34 * r}px sans-serif`;
        c.fillText("🥪", b.x * r, ground - b.y * r);
      });
      if (s.bossHp > 0) {
        c.font = `${100 * r}px sans-serif`;
        c.fillText("😡", 900 * r, ground);
        c.fillStyle = "#e32f27";
        c.fillRect(
          880 * r,
          ground - 140 * r,
          Math.max(0, s.bossHp) * 22 * r,
          12 * r,
        );
      }
    };
    let id = 0;
    const paint = () => {
      draw();
      id = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(id);
  }, [mode]);
  return (
    <main className="blaster-game">
      {mode === "home" ? (
        <section className="blaster-card">
          <small>CORNER DELI ARCADE</small>
          <h1>
            DELIVERY <i>BLASTER</i>
          </h1>
          <p>
            Jump the nonsense. Blast obstacles with wrapped subs. Defeat the
            customer complaint at the end of every route. Deliver the food.
          </p>
          <b>HIGH SCORE {high.toLocaleString()}</b>
          <button onClick={start}>START ROUTE</button>
          <a href="/games">← ALL GAMES</a>
        </section>
      ) : (
        <>
          <header className="blaster-hud">
            <b>{view.score.toLocaleString()} PTS</b>
            <span>{"❤️".repeat(view.health)}</span>
            <i>SUB AMMO {view.ammo}</i>
            <strong>LEVEL {view.level}/3</strong>
          </header>
          <section className="blaster-stage">
            <canvas ref={canvas} />
            <div className="boss-message">{view.message}</div>
            <div className="route-meter">
              <i
                style={{
                  width: `${Math.min(100, (view.distance / (view.level * 2400)) * 100)}%`,
                }}
              />
            </div>
            <div className="blaster-controls">
              <button onPointerDown={jump}>⬆ JUMP</button>
              <button onPointerDown={shoot}>🥪 FIRE SUB</button>
            </div>
            {(mode === "over" || mode === "won") && (
              <div className="blaster-over">
                <small>
                  {mode === "won" ? "ALL FOOD DELIVERED" : "ROUTE FAILED"}
                </small>
                <h2>{view.message}</h2>
                <b>{view.score.toLocaleString()} POINTS</b>
                <button onClick={start}>PLAY AGAIN</button>
                <a href="/games">ALL GAMES</a>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
