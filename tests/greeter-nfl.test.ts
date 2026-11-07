import assert from "node:assert/strict";
import test from "node:test";
import { nflGamesFrom } from "../src/lib/greeter-nfl";

const event = (id: string, date: string, away: string, home: string, state = "pre") => ({
  id, date, status: { type: { state, shortDetail: `10/25 - 1:00 PM EDT` } },
  competitions: [{ broadcasts: [{ names: ["CBS"] }], competitors: [
    { homeAway: "away" as const, score: "0", team: { abbreviation: away, shortDisplayName: away } },
    { homeAway: "home" as const, score: "0", team: { abbreviation: home, shortDisplayName: home } },
  ] }],
});

test("nfl: keeps only today's games (store time), in kickoff order, Bills picked out", () => {
  const payload = { events: [
    event("3", "2026-10-25T20:25Z", "GB", "DET"),
    event("1", "2026-10-25T17:00Z", "MIA", "BUF"),
    event("4", "2026-10-26T00:20Z", "KC", "SEA"), // 8:20 PM Sunday Eastern, still Sunday
    event("5", "2026-10-27T00:15Z", "DAL", "PHI"), // Monday night
  ] };
  const games = nflGamesFrom(payload, new Date("2026-10-25T15:00:00Z"));
  assert.deepEqual(games.map((g) => g.id), ["1", "3", "4"]);
  assert.equal(games[0].favorite, true);
  assert.equal(games[0].detail, "1:00 PM EDT");
  assert.equal(games[0].network, "CBS");
  assert.deepEqual(nflGamesFrom(payload, new Date("2026-10-22T15:00:00Z")), []);
});
