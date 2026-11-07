import { NextResponse } from "next/server";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { TriviaError, saveTriviaEnabled, setTriviaPlayerHidden, triviaEnabled, triviaSettingsPlayers } from "@/lib/lobby-trivia";

export const runtime = "nodejs";

async function manager() {
  const actor = await orderingActor("Corner Deli");
  return actor && canManagePos(actor) ? actor : null;
}

const payload = async () => ({ enabled: await triviaEnabled(), players: await triviaSettingsPlayers() });

/** Lobby trivia switch and the player list (hide a name from the boards). */
export async function GET() {
  if (!(await manager())) return NextResponse.json({ error: "Manager sign-in required." }, { status: 403 });
  return NextResponse.json(await payload(), { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request) {
  const actor = await manager();
  if (!actor) return NextResponse.json({ error: "Manager sign-in required." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown; playerId?: unknown; hidden?: unknown };
  try {
    if (typeof body.enabled === "boolean") await saveTriviaEnabled(body.enabled, actor.name);
    if (body.playerId !== undefined && typeof body.hidden === "boolean") await setTriviaPlayerHidden(Number(body.playerId), body.hidden, actor.name);
    return NextResponse.json(await payload());
  } catch (error) {
    if (error instanceof TriviaError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
