"use client";

import { useEffect, useRef, useState } from "react";

const POLL_MS = 4_000;
const PANEL_MS = 8_000;
const CHEER_MS = 5_000;
/** A right answer stays marked on the question screen this long before the next question takes over. */
const SOLVED_HOLD_MS = 12_000;
const BOARD_NAMES = { today: "Today", month: "This month", year: "This year" } as const;
type Period = keyof typeof BOARD_NAMES;
type TvQuestion = { id: string; q: string; topic: string; choices: string[] };
type Solve = TvQuestion & { answerId: number; answer: string; name: string | null };
type Trivia = { enabled: boolean; qrSvg?: string; boards?: Record<Period, { rank: number; name: string; correct: number }[]>; question?: TvQuestion | null; solves?: Solve[] };
/** What the question screen shows: the question someone is on, marked once someone gets it right. */
export type TriviaShowing = TvQuestion & { answer?: string; name?: string | null; solvedId?: number };
export type TriviaFeed = { trivia: Trivia | null; cheer: string | null; showing: TriviaShowing | null };

/**
 * Polls GET /api/pos/greeter/trivia: this minute's QR, the boards, the question someone is on and right answers.
 * A right answer queues a "<name> got it!" and marks that question for SOLVED_HOLD_MS.
 */
export function useTriviaFeed(): TriviaFeed {
  const [trivia, setTrivia] = useState<Trivia | null>(null);
  const [cheer, setCheer] = useState<string | null>(null);
  const [showing, setShowing] = useState<TriviaShowing | null>(null);
  const seen = useRef<Set<number> | null>(null);
  const queue = useRef<string[]>([]);
  const hold = useRef<{ until: number; showing: TriviaShowing } | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch("/api/pos/greeter/trivia", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as Trivia;
        if (stopped) return;
        setTrivia(next);
        const solves = next.solves ?? [];
        // Each right answer once; the ones already there when the page loaded are skipped.
        const fresh = seen.current ? solves.filter((s) => !seen.current!.has(s.answerId)) : [];
        seen.current = new Set([...(seen.current ?? []), ...solves.map((s) => s.answerId)]);
        queue.current.push(...[...fresh].reverse().map((s) => s.name ?? "Someone"));
        if (fresh[0]) hold.current = { until: Date.now() + SOLVED_HOLD_MS, showing: { ...fresh[0], name: fresh[0].name ?? "Someone", solvedId: fresh[0].answerId } };
        if (hold.current && hold.current.until > Date.now()) setShowing(hold.current.showing);
        else {
          hold.current = null;
          setShowing(next.enabled && next.question ? next.question : null);
        }
      } catch {
        // keep the last QR; it is refreshed on the next poll
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    // One cheer at a time.
    const cheers = window.setInterval(() => setCheer(queue.current.shift() ?? null), CHEER_MS);
    return () => { stopped = true; window.clearInterval(timer); window.clearInterval(cheers); };
  }, []);

  return { trivia: trivia?.enabled ? trivia : null, cheer, showing };
}

/**
 * Lobby trivia in the greeter TV's top-right corner, clear of every slide's content: this minute's QR (it changes
 * every minute, so a photo of it soon stops working), the top 5 Today → This month → This year, and "<name> got
 * it!" when someone answers right. Hidden on the NFL screen; bigger, under the welcome, for each walk-in. Gone when
 * trivia is switched off in POS Settings.
 */
export default function TriviaCorner({ feed, welcome, hidden }: { feed: TriviaFeed; welcome: boolean; hidden: boolean }) {
  const [panel, setPanel] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setPanel((p) => p + 1), PANEL_MS);
    return () => window.clearInterval(timer);
  }, []);
  const { trivia, cheer } = feed;
  if (!trivia?.qrSvg || !trivia.boards) return null;
  const period = (Object.keys(BOARD_NAMES) as Period[])[panel % 3];
  const rows = trivia.boards[period];
  // A walk-in: big "Play trivia while you wait" QR under the welcome, back to the corner after.
  const big = welcome;

  return (
    <aside className={`gtTrivia${big ? " big" : ""}${hidden && !big ? " away" : ""}`} aria-live="polite">
      <div className="gtTriviaInfo">
        {cheer ? (
          <div className="gtCheer" key={cheer}><span>🎉</span><strong>{cheer}</strong><em>got it!</em></div>
        ) : big ? (
          <div className="gtTriviaPitch"><strong>Play trivia while you wait!</strong><span>Scan with your phone camera</span></div>
        ) : (
          <div className="gtTriviaBoard">
            <span>Trivia · {BOARD_NAMES[period]}</span>
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

/** Full-screen question someone is playing, shown in the fun fact's turn; the right answer lights up once someone gets it. */
export function TriviaSlide({ showing, on }: { showing: TriviaShowing; on: boolean }) {
  return (
    <section className={`gtSlide gtTriviaSlide${on ? " on" : ""}`}>
      <header><span>Lobby trivia</span><em>{showing.topic}</em></header>
      <h2>{showing.q}</h2>
      <ul>
        {showing.choices.map((choice) => <li key={choice} className={showing.answer === choice ? "right" : showing.answer ? "out" : ""}>{choice}{showing.answer === choice && <b>✓</b>}</li>)}
      </ul>
      <p className={showing.answer ? "solved" : ""}>{showing.answer ? <><strong>{showing.name}</strong> got it!</> : "Someone's playing now. Scan the code to join in!"}</p>
    </section>
  );
}
