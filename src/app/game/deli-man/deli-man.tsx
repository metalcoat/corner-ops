"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SCREEN_H, SCREEN_W, STEP_MS } from "@/lib/games/deli-man/constants";
import { Game } from "@/lib/games/deli-man/game";
import type { Button } from "@/lib/games/deli-man/input";

const MUTE_KEY = "deli-man-muted";

declare global {
  interface Window {
    __deliMan?: Game;
  }
}

export default function DeliMan() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [muted, setMuted] = useState(false);
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const game = new Game();
    gameRef.current = game;
    let initialMute = false;
    try {
      initialMute = localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      /* ignore */
    }
    game.audio.setMuted(initialMute);
    setMuted(initialMute);
    if (process.env.NODE_ENV !== "production") window.__deliMan = game;
    if (window.matchMedia?.("(pointer: coarse)").matches) setTouch(true);

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      acc += Math.min(100, now - last);
      last = now;
      let steps = 0;
      while (acc >= STEP_MS && steps < 4) {
        game.update();
        acc -= STEP_MS;
        steps++;
      }
      if (steps === 4) acc = 0;
      game.render(ctx);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      game.audio.unlock();
      if (event.code === "KeyM") {
        setMuted((value) => !value);
        return;
      }
      if (game.input.keyDown(event.code)) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (game.input.keyUp(event.code)) event.preventDefault();
    };
    const onBlur = () => game.pauseIfPlaying();
    const onVisibility = () => {
      if (document.hidden) game.pauseIfPlaying();
    };
    const onFirstTouch = () => setTouch(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("touchstart", onFirstTouch, { once: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("touchstart", onFirstTouch);
      document.removeEventListener("visibilitychange", onVisibility);
      game.audio.dispose();
      if (window.__deliMan === game) delete window.__deliMan;
      gameRef.current = null;
    };
  }, []);

  useEffect(() => {
    gameRef.current?.audio.setMuted(muted);
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [muted]);

  // Scale the 256x240 canvas: whole-number zoom when there is room, otherwise fit.
  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const fit = () => {
      const w = frame.clientWidth;
      const h = frame.clientHeight;
      let scale = Math.min(w / SCREEN_W, h / SCREEN_H);
      if (scale >= 2) scale = Math.floor(scale);
      canvas.style.width = `${Math.floor(SCREEN_W * scale)}px`;
      canvas.style.height = `${Math.floor(SCREEN_H * scale)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [touch]);

  const onCanvasPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const game = gameRef.current;
    const canvas = canvasRef.current;
    if (!game || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    game.tap(((event.clientX - rect.left) / rect.width) * SCREEN_W, ((event.clientY - rect.top) / rect.height) * SCREEN_H);
  }, []);

  const press = useCallback((button: Button, down: boolean) => {
    const game = gameRef.current;
    if (!game) return;
    game.audio.unlock();
    game.input.setTouch(button, down);
  }, []);

  return (
    <main className={`deli-man${touch ? " dm-touch-on" : ""}`}>
      <div className="dm-frame" ref={frameRef}>
        <canvas
          ref={canvasRef}
          width={SCREEN_W}
          height={SCREEN_H}
          className="dm-canvas"
          aria-label="DELI MAN game screen"
          onPointerDown={onCanvasPointer}
        />
      </div>
      {touch && <TouchPad press={press} />}
      <footer className="dm-bar">
        <Link href="/games">◀ ARCADE</Link>
        <span className="dm-keys">
          ARROWS/WASD MOVE · Z/K/SPACE JUMP · X/J SHOOT (HOLD = JUMBO SHOT) · Q/E WEAPON · ENTER PAUSE
        </span>
        <button type="button" onClick={() => setMuted((value) => !value)} aria-pressed={muted}>
          {muted ? "SOUND OFF" : "SOUND ON"}
        </button>
      </footer>
    </main>
  );
}

function capture(event: ReactPointerEvent<HTMLElement>) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    /* pointer already gone */
  }
}

function TouchPad({ press }: { press: (button: Button, down: boolean) => void }) {
  const dirs = useRef<Record<string, boolean>>({ left: false, right: false, up: false, down: false });

  const setDirs = useCallback(
    (next: Record<string, boolean>) => {
      for (const key of ["left", "right", "up", "down"] as const) {
        if (dirs.current[key] !== next[key]) press(key, next[key]);
      }
      dirs.current = next;
    },
    [press],
  );

  const onPad = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.type === "pointerdown") capture(event);
    if (event.type === "pointerup" || event.type === "pointercancel") {
      setDirs({ left: false, right: false, up: false, down: false });
      return;
    }
    if (event.type === "pointermove" && event.buttons === 0 && event.pointerType === "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - rect.left) / rect.width - 0.5;
    const dy = (event.clientY - rect.top) / rect.height - 0.5;
    const dead = 0.14;
    setDirs({
      left: dx < -dead && Math.abs(dx) > Math.abs(dy) * 0.45,
      right: dx > dead && Math.abs(dx) > Math.abs(dy) * 0.45,
      up: dy < -dead && Math.abs(dy) > Math.abs(dx) * 0.45,
      down: dy > dead && Math.abs(dy) > Math.abs(dx) * 0.45,
    });
  };

  const button = (name: Button, label: string, className: string) => (
    <button
      type="button"
      className={className}
      onPointerDown={(event) => {
        event.preventDefault();
        capture(event);
        press(name, true);
      }}
      onPointerUp={() => press(name, false)}
      onPointerCancel={() => press(name, false)}
      onLostPointerCapture={() => press(name, false)}
      onContextMenu={(event) => event.preventDefault()}
    >
      {label}
    </button>
  );

  return (
    <div className="dm-pad" onContextMenu={(event) => event.preventDefault()}>
      <div
        className="dm-dpad"
        role="group"
        aria-label="Direction pad"
        onPointerDown={onPad}
        onPointerMove={onPad}
        onPointerUp={onPad}
        onPointerCancel={onPad}
      >
        <span className="dm-arrow up" />
        <span className="dm-arrow left" />
        <span className="dm-arrow right" />
        <span className="dm-arrow down" />
      </div>
      <div className="dm-mid">
        {button("next", "WPN", "dm-small")}
        {button("start", "START", "dm-small")}
      </div>
      <div className="dm-ab">
        {button("shoot", "B", "dm-round dm-b")}
        {button("jump", "A", "dm-round dm-a")}
      </div>
    </div>
  );
}
