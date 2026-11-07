"use client";

import { useEffect, useRef, useState } from "react";

const POLL_MS = 4_000;
const PANEL_MS = 8_000;
const CHEER_MS = 5_000;
/** After a walk-in's welcome the QR stays big this long, then shrinks back into the corner. */
const BIG_AFTER_WELCOME_MS = 15_000;
const BOARD_NAMES = { today: "Today", month: "This month", year: "This year" } as const;
type Period = keyof typeof BOARD_NAMES;
type Trivia = {
  enabled: boolean; qrSvg?: string; boards?: Record<Period, { rank: number; name: string; correct: number }[]>;
  cheers?: { id: number; name: string }[]; question?: { id: string; q: string; topic: string } | null;
};
type Panel = Period | "question";

/**
 * Lobby trivia in the greeter TV's bottom-right corner, on every slide: this minute's QR (it changes every
 * minute, so a photo of it soon stops working), the top 5 Today → This month → This year, the question someone
 * is on, and "<name> got it!" when someone answers right. Gone when trivia is switched off in POS Settings.
 */
export default function TriviaCorner({ welcome }: { welcome: boolean }) {
  const [trivia, setTrivia] = useState<Trivia | null>(null);
  const [panel, setPanel] = useState(0);
  const [cheer, setCheer] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const cheered = useRef<Set<number> | null>(null);
  const queue = useRef<string[]>([]);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch("/api/pos/greeter/trivia", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as Trivia;
        if (stopped) return;
        setTrivia(next);
        // Cheer each right answer once; the ones already there when the page loaded are skipped.
        const fresh = (next.cheers ?? []).filter((c) => !cheered.current?.has(c.id));
        if (cheered.current) queue.current.push(...fresh.reverse().map((c) => c.name));
        cheered.current = new Set([...(cheered.current ?? []), ...(next.cheers ?? []).map((c) => c.id)]);
      } catch {
        // keep the last QR; it is refreshed on the next poll
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);

  // One cheer at a time.
  useEffect(() => {
    const timer = window.setInterval(() => setCheer(queue.current.shift() ?? null), CHEER_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setPanel((p) => p + 1), PANEL_MS);
    return () => window.clearInterval(timer);
  }, []);

  // A walk-in: big "Play trivia while you wait" QR through the welcome and a little after.
  useEffect(() => {
    if (welcome) { setBig(true); return; }
    const timer = window.setTimeout(() => setBig(false), BIG_AFTER_WELCOME_MS);
    return () => window.clearTimeout(timer);
  }, [welcome]);

  if (!trivia?.enabled || !trivia.qrSvg || !trivia.boards) return null;
  const panels: Panel[] = ["today", "month", "year", ...(trivia.question ? ["question" as const] : [])];
  const showing = panels[panel % panels.length];
  const rows = showing === "question" ? [] : trivia.boards[showing];

  return (
    <aside className={`gtTrivia${big ? " big" : ""}`} aria-live="polite">
      <div className="gtTriviaInfo">
        {cheer ? (
          <div className="gtCheer" key={cheer}><span>🎉</span><strong>{cheer}</strong><em>got it!</em></div>
        ) : big ? (
          <div className="gtTriviaPitch"><strong>Play trivia while you wait!</strong><span>Scan with your phone camera</span></div>
        ) : showing === "question" ? (
          <div className="gtTriviaQuestion"><span>Someone&apos;s playing · {trivia.question!.topic}</span><p>{trivia.question!.q}</p></div>
        ) : (
          <div className="gtTriviaBoard">
            <span>Trivia leaders · {BOARD_NAMES[showing]}</span>
            {rows.length
              ? <ol>{rows.map((row) => <li key={row.rank}><b>{row.rank}</b><i>{row.name}</i><em>{row.correct}</em></li>)}</ol>
              : <p>Be the first on the board!</p>}
          </div>
        )}
      </div>
      <div className="gtTriviaQr">
        <div className="gtQr" dangerouslySetInnerHTML={{ __html: trivia.qrSvg }} />
        <span>Play trivia</span>
      </div>
    </aside>
  );
}
