/**
 * NFL games for the greeter's "NFL today" screen, from ESPN's public scoreboard feed (the same one
 * espn.com uses). Only games on today's store date are kept, so the screen shows up on game days
 * (Sunday, Monday and Thursday nights, late-season Saturdays) and nowhere else. Cached for a minute.
 */
const FEED = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const CACHE_MS = 60_000;
/** The home crowd's team gets picked out on the screen. */
export const NFL_FAVORITE = "BUF";

export type NflTeam = { abbr: string; name: string; logo: string; score: string; record: string; winner: boolean };
export type NflGame = { id: string; start: string; state: "pre" | "in" | "post"; detail: string; network: string; away: NflTeam; home: NflTeam; favorite: boolean };

type EspnCompetitor = { homeAway: "home" | "away"; score?: string; winner?: boolean; team: { abbreviation: string; shortDisplayName: string; logo?: string }; records?: { summary?: string }[] };
type EspnEvent = { id: string; date: string; status: { type: { state: string; shortDetail: string } }; competitions: { competitors: EspnCompetitor[]; broadcasts?: { names?: string[] }[] }[] };

let cache: { at: number; payload: { events?: EspnEvent[] } } | null = null;

const storeDate = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(at);

function team(c: EspnCompetitor | undefined): NflTeam {
  return {
    abbr: c?.team.abbreviation ?? "",
    name: c?.team.shortDisplayName ?? "",
    logo: c?.team.logo ?? "",
    score: c?.score ?? "",
    record: c?.records?.[0]?.summary ?? "",
    winner: Boolean(c?.winner),
  };
}

/** Pure: today's games from a scoreboard payload, kickoff order. */
export function nflGamesFrom(payload: { events?: EspnEvent[] }, now: Date): NflGame[] {
  const today = storeDate(now);
  return (payload.events ?? [])
    .filter((event) => storeDate(new Date(event.date)) === today)
    .map((event) => {
      const competition = event.competitions[0];
      const away = team(competition?.competitors.find((c) => c.homeAway === "away"));
      const home = team(competition?.competitors.find((c) => c.homeAway === "home"));
      const state = (["pre", "in", "post"].includes(event.status.type.state) ? event.status.type.state : "pre") as NflGame["state"];
      return {
        id: event.id, start: event.date, state, detail: event.status.type.shortDetail.replace(/^\d+\/\d+ - /, ""),
        network: competition?.broadcasts?.[0]?.names?.[0] ?? "",
        away, home, favorite: away.abbr === NFL_FAVORITE || home.abbr === NFL_FAVORITE,
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

export async function nflGamesToday(now = new Date()): Promise<NflGame[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return nflGamesFrom(cache.payload, now);
  try {
    const response = await fetch(FEED, { headers: { "user-agent": "CornerDeli-TV/1.0 (ordercornerdeli.com)" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(String(response.status));
    cache = { at: Date.now(), payload: await response.json() };
  } catch (error) {
    console.error("NFL scoreboard unavailable", error);
    if (!cache) return [];
  }
  return nflGamesFrom(cache.payload, now);
}
