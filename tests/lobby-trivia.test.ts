import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { TRIVIA_QUESTIONS } from "../src/lib/trivia-questions";
import {
  TRIVIA_DAILY_LIMIT, TRIVIA_SLOT_MS, cleanTriviaName, pickTriviaQuestion, rankTriviaScores, triviaBusinessDate, triviaChoices,
  triviaEnabledByDefault, triviaPeriodStart, triviaSlot, triviaToken, triviaTokenValid,
} from "../src/lib/trivia-rules";

const key = randomBytes(32);

test("lobby trivia: a QR token works for 2-3 minutes after it was shown, then never again", () => {
  const shownAt = Date.UTC(2026, 10, 7, 17, 0, 30);
  const token = triviaToken(triviaSlot(shownAt), key);
  assert.ok(triviaTokenValid(token, shownAt, key));
  assert.ok(triviaTokenValid(token, shownAt + 2 * TRIVIA_SLOT_MS, key), "still good two minutes on");
  assert.ok(!triviaTokenValid(token, shownAt + 3 * TRIVIA_SLOT_MS, key), "expired three minutes on");
  assert.ok(!triviaTokenValid(token, shownAt + 86_400_000, key), "a photo is useless the next day");
  // Not before it was shown (a future slot can't be pre-made), not with another key, not tampered.
  assert.ok(!triviaTokenValid(triviaToken(triviaSlot(shownAt) + 1, key), shownAt, key));
  assert.ok(!triviaTokenValid(token, shownAt, randomBytes(32)));
  assert.ok(!triviaTokenValid(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, shownAt, key));
  assert.ok(!triviaTokenValid("", shownAt, key));
  assert.ok(!triviaTokenValid("zzzz.not-a-token", shownAt, key));
});

test("lobby trivia: at most 15 questions a day, never the same one twice", () => {
  const bank = TRIVIA_QUESTIONS.map((q) => q.id);
  const asked: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const next = pickTriviaQuestion(bank, asked);
    if (!next) break;
    assert.ok(!asked.includes(next), "no repeats within the day");
    asked.push(next);
  }
  assert.equal(asked.length, TRIVIA_DAILY_LIMIT);
  assert.equal(pickTriviaQuestion(bank, asked), null);
  // A small bank runs out before the cap.
  assert.equal(pickTriviaQuestion(["a", "b"], ["a", "b"]), null);
  assert.equal(pickTriviaQuestion(["a", "b"], ["a"], () => 0.99), "b");
});

test("lobby trivia: the right letter is fixed per player and only the right answer scores", () => {
  const question = TRIVIA_QUESTIONS[0];
  const first = triviaChoices(question, 42), again = triviaChoices(question, 42);
  assert.deepEqual(first, again);
  assert.equal(first.choices["ABCD".indexOf(first.correctLetter)], question.a);
  assert.deepEqual([...first.choices].sort(), [question.a, ...question.wrong].sort());
  // Across players the right answer lands on every letter, so A isn't always right.
  const letters = new Set(Array.from({ length: 60 }, (_, player) => triviaChoices(question, player).correctLetter));
  assert.equal(letters.size, 4);
});

test("lobby trivia: boards rank by correct answers, ties to whoever got there first", () => {
  const ranked = rankTriviaScores([
    { playerId: 1, name: "Late", correct: 5, reachedAt: "2026-11-07T18:00:00Z" },
    { playerId: 2, name: "Top", correct: 9, reachedAt: "2026-11-07T19:00:00Z" },
    { playerId: 3, name: "Early", correct: 5, reachedAt: "2026-11-07T17:00:00Z" },
  ]);
  assert.deepEqual(ranked.map((row) => row.name), ["Top", "Early", "Late"]);
  assert.equal(triviaPeriodStart("today", "2026-11-07"), "2026-11-07");
  assert.equal(triviaPeriodStart("month", "2026-11-07"), "2026-11-01");
  assert.equal(triviaPeriodStart("year", "2026-11-07"), "2026-01-01");
  // 2:30 AM belongs to the day before (4 AM business day).
  assert.equal(triviaBusinessDate(new Date("2026-11-08T07:30:00Z")), "2026-11-07");
  assert.equal(triviaBusinessDate(new Date("2026-11-08T09:30:00Z")), "2026-11-08");
});

test("lobby trivia: switch defaults on except in production", () => {
  assert.equal(triviaEnabledByDefault(undefined), true);
  assert.equal(triviaEnabledByDefault("development"), true);
  assert.equal(triviaEnabledByDefault("production"), false);
  assert.equal(triviaEnabledByDefault(" Production "), false);
});

test("lobby trivia: nicknames are tidied and rude ones refused", () => {
  assert.deepEqual(cleanTriviaName("  Sam   the  Man  "), { name: "Sam the Man" });
  assert.deepEqual(cleanTriviaName("<b>Jo</b>"), { name: "bJob" });
  assert.ok("error" in cleanTriviaName("x"));
  for (const rude of ["fuck", "F u c k", "5h1t", "Big Ass", "a$$hole", "FUUUCK", "dick"]) assert.ok("error" in cleanTriviaName(rude), rude);
  for (const fine of ["Cass", "Dickens", "Spicy", "Sussex", "Grandma Jo", "Bills Fan 17", "Hello"]) assert.ok("name" in cleanTriviaName(fine), fine);
});

test("lobby trivia: question bank is big, unique and well formed", () => {
  assert.ok(TRIVIA_QUESTIONS.length >= 150);
  assert.equal(new Set(TRIVIA_QUESTIONS.map((q) => q.id)).size, TRIVIA_QUESTIONS.length);
  for (const q of TRIVIA_QUESTIONS) {
    assert.equal(new Set([q.a, ...q.wrong]).size, 4, q.id);
    assert.ok(q.q.length > 10 && [q.a, ...q.wrong].every((text) => text.length > 0 && text.length <= 40), q.id);
  }
});
