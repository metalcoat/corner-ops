"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Mode = "home" | "play" | "qte" | "over";
type Hazard = {
  id: number;
  kind: "frost" | "grease";
  x: number;
  y: number;
  vx: number;
};
type Spark = { x: number; y: number; life: number; color: string };
type GameState = {
  tension: number;
  temperature: number;
  score: number;
  height: number;
  seconds: number;
  midpoint: number;
  pulling: boolean;
  wobble: number;
  hazards: Hazard[];
  sparks: Spark[];
  nextHazard: number;
  qteAt: number;
  last: number;
};

const ROUND_SECONDS = 40;
const fresh = (): GameState => ({
  tension: 32,
  temperature: 100,
  score: 0,
  height: 0,
  seconds: ROUND_SECONDS,
  midpoint: 0,
  pulling: false,
  wobble: 0,
  hazards: [],
  sparks: [],
  nextHazard: 1.3,
  qteAt: 2500,
  last: 0,
});

class CheeseAudio {
  context: AudioContext | null = null;
  hum: OscillatorNode | null = null;
  humGain: GainNode | null = null;
  get ctx() {
    if (!this.context) this.context = new AudioContext();
    if (this.context.state === "suspended") void this.context.resume();
    return this.context;
  }
  tone(
    from: number,
    to: number,
    duration: number,
    volume = 0.12,
    type: OscillatorType = "square",
  ) {
    const ctx = this.ctx,
      oscillator = ctx.createOscillator(),
      gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, to),
      ctx.currentTime + duration,
    );
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration);
  }
  noise(duration: number, volume: number) {
    const ctx = this.ctx,
      buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate),
      data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource(),
      filter = ctx.createBiquadFilter(),
      gain = ctx.createGain();
    source.buffer = buffer;
    filter.type = "bandpass";
    filter.frequency.value = 1100;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  }
  stretch(tension: number) {
    this.tone(170 + tension * 2.5, 230 + tension * 4, 0.09, 0.045, "triangle");
  }
  ding() {
    this.tone(1046.5, 1568, 0.14, 0.12);
    window.setTimeout(() => this.tone(1568, 2093, 0.18, 0.1), 80);
  }
  snap() {
    this.noise(0.2, 0.28);
    this.tone(760, 68, 0.34, 0.2, "sawtooth");
  }
  crunch() {
    this.noise(0.34, 0.3);
    this.tone(130, 42, 0.26, 0.16, "square");
  }
  fanfare() {
    [523, 659, 784, 1047, 1319].forEach((note, i) =>
      window.setTimeout(() => this.tone(note, note * 1.03, 0.28, 0.12), i * 90),
    );
  }
}

const audio = new CheeseAudio();

export default function CheesePullGame() {
  const canvas = useRef<HTMLCanvasElement>(null),
    game = useRef(fresh()),
    frame = useRef(0),
    qteTimer = useRef(0);
  const [mode, setMode] = useState<Mode>("home"),
    [view, setView] = useState(fresh()),
    [reason, setReason] = useState(""),
    [high, setHigh] = useState(0),
    [qteTaps, setQteTaps] = useState(0),
    [claimName, setClaimName] = useState(""),
    [showClaim, setShowClaim] = useState(false);

  useEffect(
    () => setHigh(Number(localStorage.getItem("cheese-pull-high") || 0)),
    [],
  );
  const particles = useCallback((x: number, y: number, color: string) => {
    for (let i = 0; i < 12; i++)
      game.current.sparks.push({
        x: x + (Math.random() - 0.5) * 30,
        y: y + (Math.random() - 0.5) * 30,
        life: 1,
        color,
      });
  }, []);
  const end = useCallback(
    (message: string, sound: "snap" | "crunch" | "win") => {
      setReason(message);
      setMode("over");
      game.current.pulling = false;
      if (sound === "snap") audio.snap();
      else if (sound === "crunch") audio.crunch();
      else audio.fanfare();
      const score = Math.floor(game.current.score),
        previous = Number(localStorage.getItem("cheese-pull-high") || 0);
      localStorage.setItem(
        "cheese-pull-high",
        String(Math.max(score, previous)),
      );
      setHigh(Math.max(score, previous));
    },
    [],
  );
  const start = useCallback(() => {
    game.current = fresh();
    setView(game.current);
    setReason("");
    setQteTaps(0);
    setShowClaim(false);
    setMode("play");
    void audio.ctx.resume();
  }, []);
  const pull = useCallback(
    (active: boolean) => {
      if (mode === "play") {
        game.current.pulling = active;
        if (active) audio.stretch(game.current.tension);
      }
    },
    [mode],
  );
  const punch = useCallback(() => {
    if (mode !== "qte") return;
    setQteTaps((taps) => {
      const next = taps + 1;
      audio.tone(240 + next * 45, 340 + next * 55, 0.06, 0.07);
      if (next >= 8) {
        window.clearTimeout(qteTimer.current);
        game.current.qteAt = (Math.floor(game.current.score / 2500) + 1) * 2500;
        particles(0, 0, "#ffd74a");
        setMode("play");
        audio.ding();
        return 0;
      }
      return next;
    });
  }, [mode, particles]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (
        mode === "qte" &&
        (event.code === "Space" || event.code === "ArrowUp")
      ) {
        event.preventDefault();
        punch();
        return;
      }
      if (event.code === "Space" || event.code === "ArrowUp") {
        event.preventDefault();
        pull(true);
      }
      if (event.code === "ArrowDown") game.current.pulling = false;
      if (event.code === "ArrowLeft")
        game.current.midpoint = Math.max(-0.8, game.current.midpoint - 0.12);
      if (event.code === "ArrowRight")
        game.current.midpoint = Math.min(0.8, game.current.midpoint + 0.12);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space" || event.code === "ArrowUp") pull(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [mode, pull, punch]);

  useEffect(() => {
    if (mode !== "play") return;
    const loop = (now: number) => {
      const state = game.current,
        dt = Math.min(0.033, Math.max(0, (now - (state.last || now)) / 1000));
      state.last = now;
      const level = Math.floor(state.score / 1000),
        pullRate = 22 * Math.pow(1.15, level),
        cooling = 5.7 + level * 1.15;
      state.seconds -= dt;
      state.nextHazard -= dt;
      state.wobble = Math.max(0, state.wobble - dt);
      if (state.pulling) {
        state.tension += pullRate * dt;
        state.height += (9 + level * 1.4) * dt;
      } else state.tension -= 29 * dt;
      state.tension = Math.max(5, state.tension);
      state.temperature -= cooling * dt;
      const sweetLow = 75 + Math.min(10, level * 2),
        sweet = state.tension >= sweetLow && state.tension <= 95;
      const multiplier = sweet ? Math.min(5, 2 + level) : 1;
      state.score += (state.pulling ? 48 : 8) * multiplier * dt;
      if (sweet && Math.random() < 0.25)
        particles(0, 0, Math.random() > 0.5 ? "#ff6b24" : "#62e9ff");
      if (state.nextHazard <= 0) {
        state.nextHazard = Math.max(0.65, 1.7 - level * 0.12);
        state.hazards.push({
          id: Date.now(),
          kind: Math.random() > 0.5 ? "frost" : "grease",
          x: Math.random() * 0.8 + 0.1,
          y: -0.08,
          vx: (Math.random() - 0.5) * 0.13,
        });
      }
      const canvasWidth = canvas.current?.width || 700,
        strandX =
          canvasWidth *
          (0.5 +
            state.midpoint * 0.23 +
            (state.wobble ? Math.sin(now / 55) * 0.12 : 0));
      state.hazards = state.hazards.filter((hazard) => {
        hazard.y += dt * (0.23 + level * 0.025);
        hazard.x += hazard.vx * dt;
        if (
          hazard.y > 0.25 &&
          hazard.y < 0.8 &&
          Math.abs(hazard.x * canvasWidth - strandX) < 38
        ) {
          if (hazard.kind === "frost") {
            state.temperature = Math.max(0, state.temperature - 40);
            audio.crunch();
          } else {
            state.wobble = 2.5;
            audio.noise(0.12, 0.1);
          }
          particles(
            hazard.x * canvasWidth,
            hazard.y * (canvas.current?.height || 700),
            hazard.kind === "frost" ? "#8deaff" : "#ffbd28",
          );
          return false;
        }
        return hazard.y < 1.1;
      });
      state.sparks.forEach((spark) => {
        spark.y -= dt * 35;
        spark.life -= dt * 1.8;
      });
      state.sparks = state.sparks.filter((spark) => spark.life > 0);
      if (state.score >= state.qteAt) {
        state.qteAt = Number.POSITIVE_INFINITY;
        setMode("qte");
        setQteTaps(0);
        qteTimer.current = window.setTimeout(
          () =>
            end(
              "THE CRUST WON. THE CHEESE HAS FILED FOR WORKERS' COMP.",
              "crunch",
            ),
          2000,
        );
      } else if (state.tension >= 100)
        end("SNAP! YOU PULLED LIKE THE MOZZARELLA OWED YOU MONEY.", "snap");
      else if (state.temperature <= 0)
        end("THE CHEESE COOLED INTO A LOAD-BEARING STRUCTURE.", "crunch");
      else if (state.seconds <= 0)
        end("SHIFT SURVIVED. THE CHEESE IS NOW VISIBLE FROM SPACE.", "win");
      setView({
        ...state,
        hazards: [...state.hazards],
        sparks: [...state.sparks],
      });
      frame.current = requestAnimationFrame(loop);
    };
    frame.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame.current);
  }, [mode, end, particles]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const resize = () => {
      const box = element.getBoundingClientRect(),
        ratio = Math.min(2, devicePixelRatio || 1);
      element.width = box.width * ratio;
      element.height = box.height * ratio;
      draw();
    };
    const draw = () => {
      const ctx = element.getContext("2d");
      if (!ctx) return;
      const w = element.width,
        h = element.height,
        s = game.current;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#19142d";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#2b2350";
      for (let y = 0; y < h; y += 48) ctx.fillRect(0, y, w, 3);
      const wobble = s.wobble ? Math.sin(performance.now() / 55) * w * 0.1 : 0,
        midX = w * (0.5 + s.midpoint * 0.23) + wobble;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#fff0a5";
      ctx.shadowColor = "#ffb31f";
      ctx.shadowBlur = 24;
      ctx.lineWidth = Math.max(10, w * 0.025 - s.height * 0.05);
      ctx.beginPath();
      ctx.moveTo(w * 0.5, h * 0.17);
      ctx.bezierCurveTo(midX, h * 0.34, midX, h * 0.66, w * 0.5, h * 0.83);
      ctx.stroke();
      ctx.shadowBlur = 0;
      const stick = (y: number, flip: boolean) => {
        ctx.save();
        ctx.translate(w * 0.5, y);
        if (flip) ctx.rotate(Math.PI);
        ctx.fillStyle = "#b45a20";
        ctx.strokeStyle = "#ffca58";
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.roundRect(-w * 0.19, -h * 0.055, w * 0.38, h * 0.11, 22);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#f89b32";
        ctx.fillRect(-w * 0.13, -h * 0.022, w * 0.26, h * 0.025);
        ctx.restore();
      };
      stick(h * 0.11, false);
      stick(h * 0.89, true);
      s.hazards.forEach((hazard) => {
        ctx.font = `${Math.max(34, w * 0.07)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(
          hazard.kind === "frost" ? "❄️" : "🟠",
          hazard.x * w,
          hazard.y * h,
        );
      });
      s.sparks.forEach((spark) => {
        ctx.globalAlpha = spark.life;
        ctx.fillStyle = spark.color;
        ctx.fillRect(
          (spark.x || midX) + (Math.random() - 0.5) * 55,
          (spark.y || h * 0.5) + (Math.random() - 0.5) * 50,
          8,
          8,
        );
      });
      ctx.globalAlpha = 1;
    };
    resize();
    let paintFrame = 0;
    const paint = () => {
      draw();
      paintFrame = requestAnimationFrame(paint);
    };
    paintFrame = requestAnimationFrame(paint);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(paintFrame);
      window.removeEventListener("resize", resize);
    };
  }, [mode]);

  const tier =
    view.score >= 5000
      ? "LEGENDARY CHEESE PULL"
      : view.score >= 2500
        ? "SOLID PULL"
        : "LIMP CHEESE";
  return (
    <main className="cheese-game">
      {mode === "home" ? (
        <section className="cheese-card">
          <small>CORNER DELI ARCADE</small>
          <h1>
            CHEESE PULL:
            <br />
            <i>THE MELTDOWN</i>
          </h1>
          <p>
            Pull fast enough to stay hot. Not so fast that it snaps. This is
            apparently a job now.
          </p>
          <b>HIGH SCORE {high.toLocaleString()}</b>
          <button onClick={start}>START PULLING</button>
          <a href="/games">← ALL GAMES</a>
        </section>
      ) : (
        <>
          <header className="cheese-hud">
            <b>{Math.floor(view.score).toLocaleString()} PTS</b>
            <span>{Math.max(0, Math.ceil(view.seconds))}s</span>
            <i>
              {view.tension >= 75 && view.tension <= 95
                ? `SUPER STRETCH ×${Math.min(5, 2 + Math.floor(view.score / 1000))}`
                : "KEEP IT MELTY"}
            </i>
          </header>
          <section
            className="cheese-stage"
            onPointerDown={(e) => {
              if (mode === "qte") punch();
              else {
                pull(true);
                const rect = e.currentTarget.getBoundingClientRect();
                game.current.midpoint = Math.max(
                  -0.8,
                  Math.min(
                    0.8,
                    ((e.clientX - rect.left) / rect.width - 0.5) * 2,
                  ),
                );
              }
            }}
            onPointerMove={(e) => {
              if (!e.buttons) return;
              const rect = e.currentTarget.getBoundingClientRect();
              game.current.midpoint = Math.max(
                -0.8,
                Math.min(0.8, ((e.clientX - rect.left) / rect.width - 0.5) * 2),
              );
            }}
            onPointerUp={() => pull(false)}
            onPointerCancel={() => pull(false)}
          >
            <canvas ref={canvas} />
            <div className="cheese-gauges">
              <label>
                TENSION{" "}
                <i style={{ width: `${Math.min(100, view.tension)}%` }} />
              </label>
              <label>
                TEMP{" "}
                <i style={{ width: `${Math.max(0, view.temperature)}%` }} />
              </label>
            </div>
            {mode === "qte" && (
              <div className="crust-qte">
                <b>CRUST CRUNCH!</b>
                <span>TAP! {qteTaps}/8</span>
              </div>
            )}
            {mode === "over" && (
              <div className="cheese-over">
                <small>{tier}</small>
                <h2>{reason}</h2>
                <p>
                  You pulled {Math.max(1, Math.floor(view.height))} feet of
                  melted cheese.
                </p>
                <b>{Math.floor(view.score).toLocaleString()} POINTS</b>
                {view.score >= 2500 && (
                  <button onClick={() => setShowClaim(true)}>
                    {view.score >= 5000
                      ? "VIEW TEST MOZZ STICK VOUCHER"
                      : "VIEW TEST DIP / SODA COUPON"}
                  </button>
                )}
                <button onClick={start}>PULL AGAIN</button>
                <a href="/games">ALL GAMES</a>
              </div>
            )}
            {showClaim && (
              <div className="cheese-claim">
                <button onClick={() => setShowClaim(false)}>×</button>
                <small>DEVELOPMENT TEST COUPON — NOT REDEEMABLE</small>
                <h2>
                  {view.score >= 5000
                    ? "FREE MOZZARELLA STICKS / CAKE"
                    : "FREE DIP / SODA"}
                </h2>
                <input
                  value={claimName}
                  onChange={(e) => setClaimName(e.target.value)}
                  placeholder="Customer name"
                />
                <b>CHEESE-TEST-{Math.floor(view.score)}</b>
                <p>
                  Real redemption remains disabled until server-side validation
                  is added.
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
