import type { NextRequest } from "next/server";
import { getSql } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const gameId = searchParams.get("gameId") || "delivery-boy";
    const requestedLimit = Number.parseInt(searchParams.get("limit") || "10", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 50))
      : 10;

    const scores = await getSql()`
      SELECT id, player_name, score, metadata, created_at
       FROM arcade_leaderboards
       WHERE game_id = ${gameId}
       ORDER BY score DESC, created_at ASC
       LIMIT ${limit}
    `;

    return Response.json({ success: true, scores });
  } catch (error) {
    console.error("Failed to load leaderboard:", error);
    return Response.json(
      { success: false, error: "Failed to load scores" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { gameId, playerName, score, metadata } = body;

    if (
      typeof gameId !== "string" ||
      !gameId.trim() ||
      gameId.length > 50 ||
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      typeof playerName !== "string" ||
      !playerName.trim()
    ) {
      return Response.json(
        { success: false, error: "Invalid score submission" },
        { status: 400 }
      );
    }

    const sanitizedName =
      String(playerName).trim().slice(0, 16).toUpperCase() || "ANON";

    const safeMetadata =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata
        : {};
    const entries = await getSql()`
      INSERT INTO arcade_leaderboards (game_id, player_name, score, metadata)
      VALUES (
        ${gameId.trim()},
        ${sanitizedName},
        ${Math.floor(score)},
        ${JSON.stringify(safeMetadata)}::jsonb
      )
      RETURNING id, player_name, score, created_at
    `;

    return Response.json({ success: true, entry: entries[0] }, { status: 201 });
  } catch (error) {
    console.error("Failed to submit score:", error);
    return Response.json(
      { success: false, error: "Failed to record score" },
      { status: 500 }
    );
  }
}
