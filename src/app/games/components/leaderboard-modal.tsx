"use client";

import React, { useEffect, useState } from "react";

interface ScoreEntry {
  id: string;
  player_name: string;
  score: number;
  created_at: string;
}

export default function LeaderboardModal({
  gameId,
  isOpen,
  onClose,
}: {
  gameId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    fetch(`/api/games/leaderboard?gameId=${encodeURIComponent(gameId)}&limit=10`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setScores(data.scores);
      })
      .finally(() => setLoading(false));
  }, [isOpen, gameId]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-neutral-900 border-2 border-amber-500 rounded-2xl p-5 text-white font-mono shadow-2xl">
        <div className="flex justify-between items-center border-b border-neutral-800 pb-3 mb-4">
          <h3 className="text-xl font-black tracking-wider text-amber-400">
            🏆 TOP DELIVERIES
          </h3>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white text-xl font-bold px-2 py-1"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="py-8 text-center text-neutral-400 animate-pulse">
            LOADING SCORES...
          </div>
        ) : scores.length === 0 ? (
          <div className="py-8 text-center text-neutral-500">
            NO SCORES YET! BE THE FIRST.
          </div>
        ) : (
          <div className="space-y-2 mb-4">
            {scores.map((entry, idx) => (
              <div
                key={entry.id}
                className="flex justify-between items-center py-1.5 px-3 bg-neutral-950/60 rounded border border-neutral-800 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={
                      idx === 0 ? "text-amber-400 font-bold" : "text-neutral-500"
                    }
                  >
                    #{idx + 1}
                  </span>
                  <span className="font-bold text-neutral-200">
                    {entry.player_name}
                  </span>
                </div>
                <span className="text-amber-300 font-black">
                  {entry.score.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full py-3 bg-neutral-800 hover:bg-neutral-700 font-bold rounded-xl active:scale-95 transition"
        >
          BACK TO GAME
        </button>
      </div>
    </div>
  );
}
