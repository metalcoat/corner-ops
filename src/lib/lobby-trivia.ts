import { getSql, withTransaction } from "@/lib/db";
import { secureCookies } from "@/lib/cookie-security";
import { clientIp, consumeRateLimit, type RateLimitPolicy } from "@/lib/rate-limit";
import { hmacSignature, constantTimeEqual, purposeKey } from "@/lib/security-keys";
import { TRIVIA_QUESTIONS, type TriviaQuestion } from "@/lib/trivia-questions";
import {
  TRIVIA_DAILY_LIMIT, TRIVIA_LETTERS, TRIVIA_PERIODS, TRIVIA_VISIT_MS, pickTriviaQuestion, triviaBusinessDate,
  triviaChoices, triviaEnabledByDefault, triviaPeriodStart, triviaSlot, triviaToken, triviaTokenValid, type TriviaPeriod,
} from "@/lib/trivia-rules";

// Lobby trivia storage: the on/off switch, players, questions asked and answered, and the boards.
// The greeter TV shows a QR that changes every minute (/api/pos/greeter/trivia); a scan lets that phone
// play for 30 minutes (visit cookie). Players are remembered by a signed cookie and, if they sign in with
// their phone on the ordering site, by customer id across phones.

const BUSINESS = "Corner Deli";
const PLAYER_COOKIE = "corner_trivia_player";
const VISIT_COOKIE = "corner_trivia_visit";
const PLAYER_MAX_AGE = 2 * 365 * 86_400;
const QUESTIONS = new Map(TRIVIA_QUESTIONS.map((question) => [question.id, question]));

export class TriviaError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const triviaQrKey = () => purposeKey("lobby-trivia-qr");

/** Where the TV's QR sends phones: the public site, never the store server's LAN address. */
export function triviaBaseUrl(): string {
  const configured = process.env.TRIVIA_BASE_URL?.trim() || process.env.CUSTOMER_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return process.env.APP_ENV === "production" ? "https://ordercornerdeli.com" : "https://dev.ordercornerdeli.com";
}

export function currentTriviaLink(now = Date.now()): { url: string; expiresAt: number } {
  const slot = triviaSlot(now);
  return { url: `${triviaBaseUrl()}/trivia?t=${triviaToken(slot, triviaQrKey())}`, expiresAt: (slot + 1) * 60_000 };
}

export const triviaScanValid = (token: string, now = Date.now()) => triviaTokenValid(token, now, triviaQrKey());

// --- cookies ---

function cookieValue(request: Request, name: string): string {
  return (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}
const signed = (value: string, purpose: string) => `${value}.${hmacSignature(value, purpose)}`;
function readSigned(request: Request, name: string, purpose: string): string | null {
  const raw = cookieValue(request, name), dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const value = raw.slice(0, dot);
  return constantTimeEqual(hmacSignature(value, purpose), raw.slice(dot + 1)) ? value : null;
}
const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies() ? "; Secure" : ""}`;

export const playerCookie = (playerId: number) => cookie(PLAYER_COOKIE, signed(String(playerId), "lobby-trivia-player"), PLAYER_MAX_AGE);
export const visitCookie = (now = Date.now()) => cookie(VISIT_COOKIE, signed(String(now + TRIVIA_VISIT_MS), "lobby-trivia-visit"), TRIVIA_VISIT_MS / 1000);

export function playerIdFrom(request: Request): number | null {
  const id = Number(readSigned(request, PLAYER_COOKIE, "lobby-trivia-player"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** When this phone's last scan stops letting it play (ms), or 0. */
export function visitEndsAt(request: Request, now = Date.now()): number {
  const until = Number(readSigned(request, VISIT_COOKIE, "lobby-trivia-visit"));
  return Number.isFinite(until) && until > now ? until : 0;
}

// --- rate limits (the store Wi-Fi puts many phones behind one address, so per-address limits are roomy) ---

const policy = (scope: string, discriminator: string, max: number, windowSeconds: number): RateLimitPolicy => ({ scope, discriminator, maxFailures: max, windowSeconds, blockSeconds: windowSeconds });
export const limitTriviaScan = (request: Request) => consumeRateLimit([policy("trivia-scan", `ip:${clientIp(request)}`, 60, 600)]);
export const limitTriviaJoin = (request: Request) => consumeRateLimit([policy("trivia-join", `ip:${clientIp(request)}`, 20, 3600)]);
export const limitTriviaAnswer = (request: Request, playerId: number) => consumeRateLimit([
  policy("trivia-answer", `ip:${clientIp(request)}`, 150, 60),
  policy("trivia-answer", `player:${playerId}`, 30, 60),
]);

// --- the switch ---

export async function triviaEnabled(business = BUSINESS): Promise<boolean> {
  const row = (await getSql()`SELECT enabled FROM trivia_settings WHERE business = ${business}`)[0];
  return row ? Boolean(row.enabled) : triviaEnabledByDefault(process.env.APP_ENV);
}

export async function saveTriviaEnabled(enabled: boolean, updatedBy: string, business = BUSINESS): Promise<boolean> {
  await getSql()`
    INSERT INTO trivia_settings (business, enabled, updated_by, updated_at) VALUES (${business}, ${enabled}, ${updatedBy}, NOW())
    ON CONFLICT (business) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
  return enabled;
}

async function assertOn() {
  if (!(await triviaEnabled())) throw new TriviaError("Trivia is paused right now. Check back another time!", 409);
}

// --- players ---

export type TriviaPlayer = { id: number; name: string; linked: boolean };

export async function triviaPlayer(playerId: number | null): Promise<TriviaPlayer | null> {
  if (!playerId) return null;
  const row = (await getSql()`
    UPDATE trivia_players SET last_seen_at = NOW() WHERE id = ${playerId} AND business = ${BUSINESS}
    RETURNING id, nickname, customer_id`)[0];
  return row ? { id: Number(row.id), name: String(row.nickname), linked: Boolean(row.customer_id) } : null;
}

export async function createTriviaPlayer(name: string): Promise<TriviaPlayer> {
  await assertOn();
  const row = (await getSql()`INSERT INTO trivia_players (business, nickname) VALUES (${BUSINESS}, ${name}) RETURNING id`)[0];
  return { id: Number(row.id), name, linked: false };
}

export async function renameTriviaPlayer(playerId: number, name: string): Promise<void> {
  await getSql()`UPDATE trivia_players SET nickname = ${name} WHERE id = ${playerId} AND business = ${BUSINESS}`;
}

/**
 * Ties a player to a customer who signed in with a texted code. If that customer already plays on another phone,
 * this phone's answers move over to them (never more than 15 a day) and this phone becomes that player.
 */
export async function linkTriviaCustomer(playerId: number, customerId: string): Promise<number> {
  return withTransaction(async () => {
    const sql = getSql();
    const existing = (await sql`SELECT id FROM trivia_players WHERE business = ${BUSINESS} AND customer_id = ${customerId} FOR UPDATE`)[0];
    if (!existing) {
      await sql`UPDATE trivia_players SET customer_id = ${customerId} WHERE id = ${playerId} AND business = ${BUSINESS}`;
      return playerId;
    }
    const keep = Number(existing.id);
    if (keep === playerId) return keep;
    await sql`
      WITH room AS (SELECT business_date, ${TRIVIA_DAILY_LIMIT} - COUNT(*) AS room FROM trivia_answers WHERE player_id = ${keep} GROUP BY business_date),
      movable AS (
        SELECT a.id, ROW_NUMBER() OVER (PARTITION BY a.business_date ORDER BY a.asked_at) AS n, COALESCE(room.room, ${TRIVIA_DAILY_LIMIT}) AS room
        FROM trivia_answers a LEFT JOIN room USING (business_date)
        WHERE a.player_id = ${playerId}
          AND NOT EXISTS (SELECT 1 FROM trivia_answers b WHERE b.player_id = ${keep} AND b.business_date = a.business_date AND b.question_id = a.question_id))
      UPDATE trivia_answers SET player_id = ${keep} WHERE id IN (SELECT id FROM movable WHERE n <= room)`;
    await sql`DELETE FROM trivia_players WHERE id = ${playerId}`;
    return keep;
  });
}

// --- questions ---

export type TriviaQuestionView = { id: string; topic: string; q: string; choices: string[]; number: number };
export type TriviaDay = { answered: number; correct: number; left: number; question: TriviaQuestionView | null };

const view = (question: TriviaQuestion, playerId: number, number: number): TriviaQuestionView =>
  ({ id: question.id, topic: question.topic, q: question.q, choices: triviaChoices(question, playerId).choices, number });

/** Today's tally for a player and the question waiting for an answer, if one is. */
export async function triviaDay(playerId: number, date = triviaBusinessDate()): Promise<TriviaDay> {
  const rows = await getSql()`
    SELECT question_id, answered_at IS NOT NULL AS answered, COALESCE(correct, FALSE) AS correct
    FROM trivia_answers WHERE player_id = ${playerId} AND business_date = ${date}::date ORDER BY asked_at, id`;
  const pending = rows.find((row) => !row.answered && QUESTIONS.has(String(row.question_id)));
  const answered = rows.filter((row) => row.answered).length;
  return {
    answered,
    correct: rows.filter((row) => row.correct).length,
    left: Math.max(0, TRIVIA_DAILY_LIMIT - rows.length) + (pending ? 1 : 0),
    question: pending ? view(QUESTIONS.get(String(pending.question_id))!, playerId, rows.indexOf(pending) + 1) : null,
  };
}

/** The question waiting for this player, or a new one they haven't had today; null once they've had 15. */
export async function nextTriviaQuestion(playerId: number, date = triviaBusinessDate(), random: () => number = Math.random): Promise<TriviaDay> {
  await assertOn();
  return withTransaction(async () => {
    const sql = getSql();
    // One request at a time per player, so two taps can't both start a 16th question.
    if (!(await sql`SELECT id FROM trivia_players WHERE id = ${playerId} AND business = ${BUSINESS} FOR UPDATE`)[0]) throw new TriviaError("Scan the TV to start again.", 404);
    // A question taken out of the bank since it was asked doesn't count against the day.
    const asked = (await sql`SELECT question_id FROM trivia_answers WHERE player_id = ${playerId} AND business_date = ${date}::date`).map((row) => String(row.question_id));
    const gone = asked.filter((id) => !QUESTIONS.has(id));
    if (gone.length) await sql`DELETE FROM trivia_answers WHERE player_id = ${playerId} AND business_date = ${date}::date AND question_id = ANY(${gone}::text[]) AND answered_at IS NULL`;
    const day = await triviaDay(playerId, date);
    if (day.question) return day;
    const pick = pickTriviaQuestion([...QUESTIONS.keys()], asked.filter((id) => QUESTIONS.has(id)), random);
    if (!pick) return day;
    await sql`INSERT INTO trivia_answers (player_id, business_date, question_id) VALUES (${playerId}, ${date}::date, ${pick})`;
    return triviaDay(playerId, date);
  });
}

export type TriviaResult = { correct: boolean; chosen: string; correctLetter: string; correctAnswer: string; day: TriviaDay };

/** Checks an answer on the server. Each question can be answered once; the right answer is only sent back now. */
export async function answerTrivia(playerId: number, questionId: string, letter: string, date = triviaBusinessDate()): Promise<TriviaResult> {
  await assertOn();
  const question = QUESTIONS.get(questionId);
  const chosen = letter.trim().toUpperCase();
  if (!question || !(TRIVIA_LETTERS as readonly string[]).includes(chosen)) throw new TriviaError("That answer didn't come through. Try again.");
  const { correctLetter } = triviaChoices(question, playerId);
  const correct = chosen === correctLetter;
  // The newest unanswered ask of this question (it may have been asked just before the 4 AM day change).
  const row = (await getSql()`
    UPDATE trivia_answers SET choice = ${chosen}, correct = ${correct}, answered_at = NOW()
    WHERE id = (SELECT id FROM trivia_answers WHERE player_id = ${playerId} AND question_id = ${questionId} AND answered_at IS NULL
                ORDER BY asked_at DESC LIMIT 1)
    RETURNING id`)[0];
  if (!row) throw new TriviaError("That question was already answered.", 409);
  return { correct, chosen, correctLetter, correctAnswer: question.a, day: await triviaDay(playerId, date) };
}

// --- boards ---

export type TriviaBoardRow = { rank: number; name: string; correct: number; you?: boolean };
export type TriviaBoards = Record<TriviaPeriod, TriviaBoardRow[]>;

/** Top players Today, This month and This year: most correct answers, ties to whoever got there first. */
export async function triviaBoards(limit = 5, playerId: number | null = null, date = triviaBusinessDate()): Promise<TriviaBoards> {
  const sql = getSql();
  const boards = {} as TriviaBoards;
  for (const period of TRIVIA_PERIODS) {
    const rows = await sql`
      SELECT p.id, p.nickname, COUNT(*)::int AS correct, MAX(a.answered_at) AS reached
      FROM trivia_answers a JOIN trivia_players p ON p.id = a.player_id
      WHERE p.business = ${BUSINESS} AND NOT p.hidden AND a.correct
        AND a.business_date BETWEEN ${triviaPeriodStart(period, date)}::date AND ${date}::date
      GROUP BY p.id ORDER BY correct DESC, reached ASC, p.id LIMIT ${limit}`;
    boards[period] = rows.map((row, index) => ({ rank: index + 1, name: String(row.nickname), correct: Number(row.correct), ...(playerId === Number(row.id) ? { you: true } : {}) }));
  }
  return boards;
}

/** A player's own correct answers this day, month and year. */
export async function triviaTotals(playerId: number, date = triviaBusinessDate()): Promise<Record<TriviaPeriod, number>> {
  const row = (await getSql()`
    SELECT COUNT(*) FILTER (WHERE business_date = ${date}::date)::int AS today,
           COUNT(*) FILTER (WHERE business_date >= ${triviaPeriodStart("month", date)}::date)::int AS month,
           COUNT(*)::int AS year
    FROM trivia_answers WHERE player_id = ${playerId} AND correct
      AND business_date BETWEEN ${triviaPeriodStart("year", date)}::date AND ${date}::date`)[0];
  return { today: Number(row?.today ?? 0), month: Number(row?.month ?? 0), year: Number(row?.year ?? 0) };
}

/** For the TV: correct answers in the last half minute ("Sam got it!") and the newest question someone is on. */
export async function triviaLive(): Promise<{ cheers: { id: number; name: string }[]; question: { id: string; q: string; topic: string } | null }> {
  const sql = getSql();
  const [cheers, latest] = await Promise.all([
    sql`SELECT a.id, p.nickname FROM trivia_answers a JOIN trivia_players p ON p.id = a.player_id
        WHERE p.business = ${BUSINESS} AND NOT p.hidden AND a.correct AND a.answered_at > NOW() - INTERVAL '30 seconds'
        ORDER BY a.answered_at DESC LIMIT 5`,
    sql`SELECT a.question_id FROM trivia_answers a JOIN trivia_players p ON p.id = a.player_id
        WHERE p.business = ${BUSINESS} AND a.asked_at > NOW() - INTERVAL '15 minutes' ORDER BY a.asked_at DESC LIMIT 1`,
  ]);
  const question = latest[0] ? QUESTIONS.get(String(latest[0].question_id)) : undefined;
  return {
    cheers: cheers.map((row) => ({ id: Number(row.id), name: String(row.nickname) })),
    question: question ? { id: question.id, q: question.q, topic: question.topic } : null,
  };
}

// --- POS Settings ---

export type TriviaSettingsPlayer = { id: number; name: string; hidden: boolean; linked: boolean; today: number; month: number; lastSeen: string };

/** Players seen in the last 90 days, newest first, for hiding names from the boards. */
export async function triviaSettingsPlayers(date = triviaBusinessDate()): Promise<TriviaSettingsPlayer[]> {
  const rows = await getSql()`
    SELECT p.id, p.nickname, p.hidden, p.customer_id IS NOT NULL AS linked, to_char(p.last_seen_at AT TIME ZONE 'America/New_York', 'Mon DD, HH12:MI AM') AS last_seen,
      COUNT(a.id) FILTER (WHERE a.correct AND a.business_date = ${date}::date)::int AS today,
      COUNT(a.id) FILTER (WHERE a.correct AND a.business_date >= ${triviaPeriodStart("month", date)}::date)::int AS month
    FROM trivia_players p LEFT JOIN trivia_answers a ON a.player_id = p.id
    WHERE p.business = ${BUSINESS} AND p.last_seen_at > NOW() - INTERVAL '90 days'
    GROUP BY p.id ORDER BY p.last_seen_at DESC LIMIT 200`;
  return rows.map((row) => ({ id: Number(row.id), name: String(row.nickname), hidden: Boolean(row.hidden), linked: Boolean(row.linked), today: Number(row.today), month: Number(row.month), lastSeen: String(row.last_seen) }));
}

export async function setTriviaPlayerHidden(playerId: number, hidden: boolean, by: string): Promise<void> {
  const row = (await getSql()`UPDATE trivia_players SET hidden = ${hidden}, hidden_by = ${hidden ? by : null} WHERE id = ${playerId} AND business = ${BUSINESS} RETURNING id`)[0];
  if (!row) throw new TriviaError("That player wasn't found.", 404);
}
