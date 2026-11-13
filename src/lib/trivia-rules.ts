import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { storeClock } from "./busy-times";

// Lobby trivia rules with no database: QR tokens, question picks, answer order, boards and names.
// Unit-tested in tests/lobby-trivia.test.ts; lobby-trivia.ts does the storage.

export const TRIVIA_DAILY_LIMIT = 15;
/** The greeter TV shows a new QR every minute. */
export const TRIVIA_SLOT_MS = 60_000;
/** A QR still works for this many minutes after the TV moved on (so 2-3 minutes after it first showed). */
export const TRIVIA_GRACE_SLOTS = 2;
/** One scan lets a phone play for this long; after that they scan the TV again. */
export const TRIVIA_VISIT_MS = 30 * 60_000;
export const TRIVIA_PERIODS = ["today", "month", "year"] as const;
export type TriviaPeriod = (typeof TRIVIA_PERIODS)[number];
export const TRIVIA_LETTERS = ["A", "B", "C", "D"] as const;

export const triviaSlot = (nowMs: number) => Math.floor(nowMs / TRIVIA_SLOT_MS);
const sign = (key: Buffer, slot: number) => createHmac("sha256", key).update(`lobby-trivia:${slot}`).digest("base64url").slice(0, 16);

/** The token in the TV's QR for a minute slot: "<slot base 36>.<signature>". */
export function triviaToken(slot: number, key: Buffer): string {
  return `${slot.toString(36)}.${sign(key, slot)}`;
}

/** True when the token was made with our key and shown on the TV no more than TRIVIA_GRACE_SLOTS minutes ago. */
export function triviaTokenValid(token: string, nowMs: number, key: Buffer): boolean {
  const match = /^([0-9a-z]{1,12})\.([\w-]{16})$/.exec(token.trim());
  if (!match) return false;
  const slot = parseInt(match[1], 36), current = triviaSlot(nowMs);
  if (!Number.isSafeInteger(slot) || slot > current || slot < current - TRIVIA_GRACE_SLOTS) return false;
  const expected = Buffer.from(sign(key, slot)), given = Buffer.from(match[2]);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A question this player hasn't had today, or null once they've had TRIVIA_DAILY_LIMIT (or the bank ran out). */
export function pickTriviaQuestion(bankIds: string[], askedToday: Iterable<string>, random: () => number = Math.random): string | null {
  const asked = new Set(askedToday);
  if (asked.size >= TRIVIA_DAILY_LIMIT) return null;
  const left = bankIds.filter((id) => !asked.has(id));
  return left.length ? left[Math.min(left.length - 1, Math.floor(random() * left.length))] : null;
}

/**
 * The order the four answers show in for one player, as indexes into [right, ...wrong]. Fixed per player and
 * question, so the letter they tap means the same thing on the server.
 */
export function triviaChoiceOrder(playerId: number | string, questionId: string): number[] {
  const hash = createHash("sha256").update(`${playerId}:${questionId}`).digest();
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = hash[i] % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** The answers in display order (A–D) and which letter is right. */
export function triviaChoices(question: { id: string; a: string; wrong: readonly string[] }, playerId: number | string): { choices: string[]; correctLetter: string } {
  const all = [question.a, ...question.wrong];
  const order = triviaChoiceOrder(playerId, question.id);
  return { choices: order.map((index) => all[index]), correctLetter: TRIVIA_LETTERS[order.indexOf(0)] };
}

/** First business date in a board's period. */
export function triviaPeriodStart(period: TriviaPeriod, businessDate: string): string {
  if (period === "month") return `${businessDate.slice(0, 7)}-01`;
  if (period === "year") return `${businessDate.slice(0, 4)}-01-01`;
  return businessDate;
}

export const triviaBusinessDate = (at: Date = new Date()) => storeClock(at).businessDate;

export type TriviaScore = { playerId: number; name: string; correct: number; reachedAt: string };
/** Most correct answers first; a tie goes to whoever got there first. */
export function rankTriviaScores<T extends TriviaScore>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.correct - a.correct || Date.parse(a.reachedAt) - Date.parse(b.reachedAt) || a.playerId - b.playerId);
}

/** Off unless switched on in POS Settings; with no setting saved yet, on everywhere except production. */
export function triviaEnabledByDefault(appEnv: string | undefined): boolean {
  return appEnv?.trim().toLowerCase() !== "production";
}

// Checked after folding look-alike characters (0→o, 1→i, $→s…) and dropping spaces and punctuation, so "F u.c k"
// and "5h1t" are caught. LONG words match anywhere in the name; SHORT ones only as the whole name or a whole
// word, since they hide inside ordinary names (Cass, Dickens, Spicy, Sussex).
const BLOCKED_ANYWHERE = [
  "fuck", "fuk", "fck", "shit", "bitch", "cunt", "whore", "slut", "nigg", "fagg", "faggot", "retard",
  "pussy", "penis", "vagina", "dildo", "porn", "rapist", "molest", "nazi", "hitler", "kkk", "bastard", "asshole",
  "dumbass", "jackass", "bigass", "douche", "boner", "blowjob", "handjob", "jizz", "cumshot", "titties",
  "boobs", "horny", "orgasm", "masturb", "erection", "testicle", "scrotum", "chink", "kike", "wetback", "tranny",
  "pedophile", "incest", "bestial", "cocksuck", "motherf", "twat", "skank", "milf", "nude", "naked",
  "killyou", "killurself", "killyourself",
];
const BLOCKED_WORDS = [
  "ass", "fag", "cum", "cock", "dick", "homo", "dyke", "anal", "anus", "spic", "hoe", "hoes", "sex", "sexy", "tits", "wank",
  "prick", "thot", "pedo", "kys", "kill", "die", "rape", "nut", "nuts", "poop", "pee", "butt", "crap", "damn",
  "hell", "piss", "weed", "drugs", "meth",
];
const FOLD: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "9": "g", "+": "t" };
const fold = (text: string) => [...text.toLowerCase()].map((c) => FOLD[c] ?? c).join("");

/** True when a nickname has a word we won't put on the TV. */
export function triviaNameBlocked(name: string): boolean {
  const folded = fold(name);
  const squashed = folded.replace(/[^a-z]/g, "");
  // Doubled letters ("fuuuck") collapse too.
  const single = squashed.replace(/(.)\1+/g, "$1");
  const collapse = (word: string) => word.replace(/(.)\1+/g, "$1");
  if (BLOCKED_ANYWHERE.some((word) => squashed.includes(word) || (collapse(word).length >= 4 && single.includes(collapse(word))))) return true;
  const words = folded.split(/[^a-z]+/).filter(Boolean);
  return BLOCKED_WORDS.some((word) => squashed === word || single === word || words.includes(word));
}

/** A tidy nickname, or an error to show the player. */
export function cleanTriviaName(raw: unknown): { name: string } | { error: string } {
  const typed = String(raw ?? "").normalize("NFKC");
  const name = typed.replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16).trim();
  if (name.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return { error: "Pick a nickname with at least 2 letters or numbers." };
  // Checked before symbols are stripped too, so "a$$hole" doesn't slip through as "ahole".
  if (triviaNameBlocked(typed) || triviaNameBlocked(name)) return { error: "Please pick a different nickname." };
  return { name };
}
