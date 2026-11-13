import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";

// Lobby trivia against the dev database: the 15-a-day cap, server-side scoring, boards, hiding a name,
// linking a phone (answers merge, still 15 a day) and the on/off switch. Everything it makes is removed after.
loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("Lobby trivia validation requires private local PostgreSQL.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

async function main() {
  const { getSql } = await import("../src/lib/db");
  const trivia = await import("../src/lib/lobby-trivia");
  const { TRIVIA_QUESTIONS } = await import("../src/lib/trivia-questions");
  const { triviaChoices } = await import("../src/lib/trivia-rules");
  const sql = getSql();
  const date = "2026-01-15";
  const byId = new Map(TRIVIA_QUESTIONS.map((q) => [q.id, q]));
  const saved = (await sql`SELECT enabled, updated_by FROM trivia_settings WHERE business = 'Corner Deli'`)[0];
  const customerId = randomUUID();
  const players: number[] = [];
  try {
    await trivia.saveTriviaEnabled(true, "validator");
    const alice = await trivia.createTriviaPlayer(`Val A ${Date.now() % 1000}`);
    const bob = await trivia.createTriviaPlayer(`Val B ${Date.now() % 1000}`);
    players.push(alice.id, bob.id);

    // Fifteen questions, none repeated; the 16th never comes.
    const seen = new Set<string>();
    for (let i = 0; i < 15; i += 1) {
      const day = await trivia.nextTriviaQuestion(alice.id, date);
      assert.ok(day.question, `question ${i + 1}`);
      // Asking again before answering gives the same question (no re-rolling a hard one).
      assert.equal((await trivia.nextTriviaQuestion(alice.id, date)).question?.id, day.question.id);
      assert.ok(!seen.has(day.question.id));
      seen.add(day.question.id);
      const question = byId.get(day.question.id)!;
      const right = triviaChoices(question, alice.id).correctLetter;
      const letter = i < 10 ? right : ["A", "B", "C", "D"].find((l) => l !== right)!;
      const result = await trivia.answerTrivia(alice.id, question.id, letter, date);
      assert.equal(result.correct, i < 10);
      assert.equal(result.correctAnswer, question.a);
      await assert.rejects(trivia.answerTrivia(alice.id, question.id, right, date), /already answered/);
    }
    const done = await trivia.nextTriviaQuestion(alice.id, date);
    assert.equal(done.question, null);
    assert.equal(done.answered, 15);
    assert.equal(done.correct, 10);
    assert.equal(done.left, 0);
    // A question never asked can't be answered.
    const unasked = TRIVIA_QUESTIONS.find((q) => !seen.has(q.id))!;
    await assert.rejects(trivia.answerTrivia(alice.id, unasked.id, "A", date), /already answered/);

    // Bob gets 10 right too, but later: Alice ranks above him on the tie.
    for (let i = 0; i < 10; i += 1) {
      const q = byId.get((await trivia.nextTriviaQuestion(bob.id, date)).question!.id)!;
      await trivia.answerTrivia(bob.id, q.id, triviaChoices(q, bob.id).correctLetter, date);
    }
    const boards = await trivia.triviaBoards(50, alice.id, date);
    const names = boards.today.map((row) => row.name);
    assert.ok(names.indexOf(alice.name) >= 0 && names.indexOf(alice.name) < names.indexOf(bob.name), "tie goes to whoever got there first");
    assert.equal(boards.today.find((row) => row.name === alice.name)?.you, true);
    assert.equal((await trivia.triviaTotals(alice.id, date)).month, 10);

    // Hidden from the boards, still counted.
    await trivia.setTriviaPlayerHidden(bob.id, true, "validator");
    assert.ok(!(await trivia.triviaBoards(50, null, date)).today.some((row) => row.name === bob.name));
    await trivia.setTriviaPlayerHidden(bob.id, false, "validator");

    // Linking: Bob signs in as the customer Alice already linked; his answers move over, capped at 15 for the day.
    await sql`INSERT INTO ordering_customers (id, business, display_name) VALUES (${customerId}, 'Corner Deli', 'Trivia Validator')`;
    assert.equal(await trivia.linkTriviaCustomer(alice.id, customerId), alice.id);
    assert.equal(await trivia.linkTriviaCustomer(bob.id, customerId), alice.id);
    players.splice(players.indexOf(bob.id), 1);
    assert.equal(Number((await sql`SELECT COUNT(*) AS n FROM trivia_answers WHERE player_id = ${alice.id} AND business_date = ${date}::date`)[0].n), 15);
    assert.equal((await sql`SELECT id FROM trivia_players WHERE id = ${bob.id}`).length, 0);

    // Switched off: no new questions, no answers.
    await trivia.saveTriviaEnabled(false, "validator");
    assert.equal(await trivia.triviaEnabled(), false);
    await assert.rejects(trivia.nextTriviaQuestion(alice.id, "2026-01-16"), /paused/);
    await assert.rejects(trivia.createTriviaPlayer("Nope"), /paused/);
    console.log("Lobby trivia validation passed: 15-a-day cap, scoring, tie-break, hiding, phone link merge, on/off switch.");
  } finally {
    if (players.length) await sql`DELETE FROM trivia_players WHERE id = ANY(${players}::bigint[])`;
    await sql`DELETE FROM ordering_customers WHERE id = ${customerId}`;
    if (saved) await sql`UPDATE trivia_settings SET enabled = ${saved.enabled}, updated_by = ${saved.updated_by} WHERE business = 'Corner Deli'`;
    else await sql`DELETE FROM trivia_settings WHERE business = 'Corner Deli'`;
  }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
