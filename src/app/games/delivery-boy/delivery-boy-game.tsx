"use client";

import React, { useEffect, useRef, useState } from "react";
import { arcadeAudio } from "@/lib/games/arcade-audio";
import LeaderboardModal from "../components/leaderboard-modal";

interface Obstacle {
  x: number;
  y: number;
  width: number;
  height: number;
  speed: number;
}

interface Collectible {
  x: number;
  y: number;
  width: number;
  height: number;
  type: "pizza" | "battery";
  speed: number;
}

export default function DeliveryBoyGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [score, setScore] = useState(0);
  const [pizzasDelivered, setPizzasDelivered] = useState(0);
  const [battery, setBattery] = useState(100);
  const [gameOver, setGameOver] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [initials, setInitials] = useState("");
  const [savedScore, setSavedScore] = useState(false);

  const playerRef = useRef({
    lane: 1,
    targetX: 170,
    x: 170,
    y: 420,
    width: 60,
    height: 100,
  });

  const gameStateRef = useRef({
    score: 0,
    pizzas: 0,
    battery: 100,
    speed: 5,
    obstacles: [] as Obstacle[],
    collectibles: [] as Collectible[],
    lastSpawn: 0,
    roadOffset: 0,
    running: false,
  });

  const lanes = [70, 170, 270];

  const startGame = () => {
    arcadeAudio.stopBGM();
    arcadeAudio.playSound("start");
    arcadeAudio.startBGM();

    setGameOver(false);
    setScore(0);
    setPizzasDelivered(0);
    setBattery(100);
    setGameStarted(true);
    setSavedScore(false);

    gameStateRef.current = {
      score: 0,
      pizzas: 0,
      battery: 100,
      speed: 5.5,
      obstacles: [],
      collectibles: [],
      lastSpawn: Date.now(),
      roadOffset: 0,
      running: true,
    };

    playerRef.current.lane = 1;
    playerRef.current.x = lanes[1];
    playerRef.current.targetX = lanes[1];
  };

  const moveLeft = () => {
    if (!gameStateRef.current.running) return;
    const nextLane = Math.max(0, playerRef.current.lane - 1);
    playerRef.current.lane = nextLane;
    playerRef.current.targetX = lanes[nextLane];
    arcadeAudio.playSound("steer");
  };

  const moveRight = () => {
    if (!gameStateRef.current.running) return;
    const nextLane = Math.min(2, playerRef.current.lane + 1);
    playerRef.current.lane = nextLane;
    playerRef.current.targetX = lanes[nextLane];
    arcadeAudio.playSound("steer");
  };

  const toggleSound = () => {
    const isMuted = arcadeAudio.toggleMute();
    setMuted(isMuted);
  };

  const submitScore = async () => {
    if (!initials.trim() || savedScore) return;
    try {
      await fetch("/api/games/leaderboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId: "delivery-boy",
          playerName: initials.toUpperCase(),
          score: score,
          metadata: { pizzas: pizzasDelivered },
        }),
      });
      setSavedScore(true);
      setShowLeaderboard(true);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "a") moveLeft();
      if (e.key === "ArrowRight" || e.key === "d") moveRight();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const carImg = new Image();
    carImg.src = "/games/delivery-boy/equinox-ev-rear-v1.png";

    let animationId: number;

    const loop = () => {
      const state = gameStateRef.current;
      const player = playerRef.current;

      ctx.fillStyle = "#161616";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "#333";
      ctx.fillRect(0, 0, 24, canvas.height);
      ctx.fillRect(canvas.width - 24, 0, 24, canvas.height);

      ctx.strokeStyle = "#eedd44";
      ctx.lineWidth = 4;
      ctx.setLineDash([24, 24]);
      ctx.lineDashOffset = -state.roadOffset;

      ctx.beginPath();
      ctx.moveTo(120, 0);
      ctx.lineTo(120, canvas.height);
      ctx.moveTo(220, 0);
      ctx.lineTo(220, canvas.height);
      ctx.stroke();
      ctx.setLineDash([]);

      if (state.running) {
        state.roadOffset = (state.roadOffset + state.speed) % 48;
        state.score += 1;
        setScore(state.score);

        if (state.score % 45 === 0) {
          state.battery = Math.max(0, state.battery - 1);
          setBattery(state.battery);
          if (state.battery <= 0) {
            state.running = false;
            arcadeAudio.stopBGM();
            arcadeAudio.playSound("crash");
            setGameOver(true);
          }
        }

        if (state.score % 500 === 0) {
          state.speed += 0.4;
        }

        player.x += (player.targetX - player.x) * 0.25;

        const now = Date.now();
        if (now - state.lastSpawn > 1100 - Math.min(500, state.speed * 30)) {
          state.lastSpawn = now;
          const spawnLane = Math.floor(Math.random() * 3);
          const isItem = Math.random() > 0.45;

          if (isItem) {
            state.collectibles.push({
              x: lanes[spawnLane] + 10,
              y: -40,
              width: 30,
              height: 30,
              type: Math.random() > 0.35 ? "pizza" : "battery",
              speed: state.speed,
            });
          } else {
            state.obstacles.push({
              x: lanes[spawnLane] + 5,
              y: -50,
              width: 40,
              height: 40,
              speed: state.speed,
            });
          }
        }

        for (let i = state.collectibles.length - 1; i >= 0; i--) {
          const item = state.collectibles[i];
          item.y += item.speed;

          if (item.type === "pizza") {
            ctx.fillStyle = "#ff5500";
            ctx.beginPath();
            ctx.arc(item.x + 15, item.y + 15, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.font = "bold 13px sans-serif";
            ctx.fillText("🍕", item.x + 7, item.y + 20);
          } else {
            ctx.fillStyle = "#00e676";
            ctx.fillRect(item.x + 4, item.y + 4, 22, 22);
            ctx.fillStyle = "#000";
            ctx.font = "bold 12px sans-serif";
            ctx.fillText("⚡", item.x + 9, item.y + 20);
          }

          if (
            Math.abs(item.x - player.x) < 36 &&
            Math.abs(item.y - player.y) < 55
          ) {
            if (item.type === "pizza") {
              state.pizzas += 1;
              setPizzasDelivered(state.pizzas);
              state.score += 250;
              arcadeAudio.playSound("pizza");
            } else {
              state.battery = Math.min(100, state.battery + 20);
              setBattery(state.battery);
              arcadeAudio.playSound("battery");
            }
            state.collectibles.splice(i, 1);
            continue;
          }

          if (item.y > canvas.height + 40) {
            state.collectibles.splice(i, 1);
          }
        }

        for (let i = state.obstacles.length - 1; i >= 0; i--) {
          const obs = state.obstacles[i];
          obs.y += obs.speed;

          ctx.fillStyle = "#0a0a0a";
          ctx.beginPath();
          ctx.ellipse(obs.x + 20, obs.y + 20, 20, 14, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#444";
          ctx.lineWidth = 2;
          ctx.stroke();

          if (
            Math.abs(obs.x - player.x) < 34 &&
            Math.abs(obs.y - player.y) < 50
          ) {
            state.running = false;
            arcadeAudio.stopBGM();
            arcadeAudio.playSound("crash");
            setGameOver(true);
          }

          if (obs.y > canvas.height + 40) {
            state.obstacles.splice(i, 1);
          }
        }
      }

      if (carImg.complete && carImg.naturalWidth !== 0) {
        ctx.drawImage(
          carImg,
          player.x - 26,
          player.y - 48,
          player.width + 12,
          player.height
        );
      } else {
        ctx.fillStyle = "#0ea5e9";
        ctx.fillRect(player.x - 20, player.y - 30, 40, 70);
      }

      animationId = requestAnimationFrame(loop);
    };

    animationId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(animationId);
      arcadeAudio.stopBGM();
    };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center p-3 max-w-sm mx-auto select-none font-mono">
      <div className="w-full flex justify-between items-center mb-2 px-3 py-2 bg-neutral-900 border border-neutral-800 text-white rounded-xl text-xs font-bold shadow-lg">
        <div>
          SCORE: <span className="text-amber-400">{score}</span>
        </div>
        <div>🍕 {pizzasDelivered}</div>
        <div
          className={
            battery < 25 ? "text-red-400 animate-pulse" : "text-emerald-400"
          }
        >
          ⚡ {battery}%
        </div>
        <button
          onClick={toggleSound}
          className="text-xs px-2 py-1 bg-neutral-800 rounded hover:bg-neutral-700"
        >
          {muted ? "🔇" : "🔊"}
        </button>
      </div>

      <div className="relative border-4 border-neutral-800 rounded-3xl overflow-hidden shadow-2xl bg-neutral-950">
        <canvas ref={canvasRef} width={340} height={520} />

        {(!gameStarted || gameOver) && (
          <div className="absolute inset-0 bg-neutral-950/90 flex flex-col items-center justify-center text-white p-6 text-center">
            <h2 className="text-2xl font-black mb-2 text-amber-400 tracking-wider">
              {gameOver ? "DELIVERY FAILED" : "DELIVERY BOY"}
            </h2>
            <p className="text-xs text-neutral-400 mb-4 max-w-[240px]">
              {gameOver
                ? `Delivered ${pizzasDelivered} orders! Score: ${score}`
                : "Pilot the Equinox EV! Collect pizzas and battery packs. Avoid the potholes."}
            </p>

            {gameOver && !savedScore && (
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  maxLength={4}
                  placeholder="NAME"
                  value={initials}
                  onChange={(e) => setInitials(e.target.value.toUpperCase())}
                  className="w-24 px-3 py-2 bg-neutral-900 border border-amber-500 rounded-lg text-center font-bold text-amber-400 uppercase tracking-widest focus:outline-none"
                />
                <button
                  onClick={submitScore}
                  disabled={!initials.trim()}
                  className="px-4 py-2 bg-amber-500 disabled:opacity-50 hover:bg-amber-400 text-neutral-950 font-black rounded-lg text-xs tracking-wider"
                >
                  SAVE
                </button>
              </div>
            )}

            <div className="flex flex-col gap-2 w-full max-w-[200px]">
              <button
                onClick={startGame}
                className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-neutral-950 font-black rounded-xl text-sm tracking-wider shadow-lg active:scale-95 transition"
              >
                {gameOver ? "PLAY AGAIN" : "START SHIFT"}
              </button>
              <button
                onClick={() => setShowLeaderboard(true)}
                className="w-full py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 font-bold rounded-xl text-xs border border-neutral-700 active:scale-95 transition"
              >
                🏆 LEADERBOARD
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="w-full grid grid-cols-2 gap-3 mt-3">
        <button
          onClick={moveLeft}
          className="py-4 bg-neutral-900 active:bg-neutral-800 text-white font-black rounded-2xl text-lg border border-neutral-800 active:scale-95 transition shadow-md"
        >
          ◀ LEFT
        </button>
        <button
          onClick={moveRight}
          className="py-4 bg-neutral-900 active:bg-neutral-800 text-white font-black rounded-2xl text-lg border border-neutral-800 active:scale-95 transition shadow-md"
        >
          RIGHT ▶
        </button>
      </div>

      <LeaderboardModal
        gameId="delivery-boy"
        isOpen={showLeaderboard}
        onClose={() => setShowLeaderboard(false)}
      />
    </div>
  );
}
