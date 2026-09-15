import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { PRIZE, STAGES } from "./config";
import type { RunCheckpoint } from "./types";
import { PIZZA_GAME_VERSION } from "@/lib/games/versions";

let schema: Promise<void> | null = null;
export function ensureGauntletSchema() {
  if (!schema)
    schema = (async () => {
      const sql = getSql();
      await sql`CREATE TABLE IF NOT EXISTS pizza_gauntlet_runs(id UUID PRIMARY KEY,token_hash TEXT NOT NULL,player_name TEXT NOT NULL DEFAULT 'Anonymous Cook',status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','won','lost','abandoned')),stage INTEGER NOT NULL DEFAULT 1,stage_orders INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL DEFAULT 0,active_seconds INTEGER NOT NULL DEFAULT 0,stats JSONB NOT NULL DEFAULT '{}'::jsonb,checkpoints JSONB NOT NULL DEFAULT '[]'::jsonb,started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`;
      await sql`ALTER TABLE pizza_gauntlet_runs ADD COLUMN IF NOT EXISTS game_version TEXT NOT NULL DEFAULT 'legacy'`;
      await sql`CREATE INDEX IF NOT EXISTS pizza_gauntlet_runs_board_idx ON pizza_gauntlet_runs(status,completed_at DESC)`;
      await sql`CREATE TABLE IF NOT EXISTS pizza_gauntlet_rewards(id UUID PRIMARY KEY,run_id UUID NOT NULL UNIQUE REFERENCES pizza_gauntlet_runs(id),code TEXT NOT NULL UNIQUE,prize_type TEXT NOT NULL,terms JSONB NOT NULL,completion_stats JSONB NOT NULL,issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ,redeemed_at TIMESTAMPTZ,redeemed_by TEXT,redemption_note TEXT NOT NULL DEFAULT '')`;
    })();
  return schema;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const code = () =>
  `JUMBO-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
export async function startRun(playerName: string) {
  await ensureGauntletSchema();
  const id = randomUUID(),
    token = randomBytes(32).toString("base64url");
  await getSql()`INSERT INTO pizza_gauntlet_runs(id,token_hash,player_name,game_version)VALUES(${id},${digest(token)},${playerName.trim().slice(0, 40) || "Anonymous Cook"},${PIZZA_GAME_VERSION})`;
  return { runId: id, token, gameVersion: PIZZA_GAME_VERSION };
}
export async function authenticatedRun(runId: string, token: string) {
  await ensureGauntletSchema();
  return (
    (
      await getSql()`SELECT * FROM pizza_gauntlet_runs WHERE id=${runId} AND token_hash=${digest(token)} LIMIT 1`
    )[0] || null
  );
}
export async function checkpointRun(data: RunCheckpoint, token: string) {
  const run = await authenticatedRun(data.runId, token);
  if (!run) throw new Error("Run credentials are invalid.");
  if (run.status !== "active") throw new Error("This run is already closed.");
  if (data.sequence !== Number(run.sequence) + 1)
    throw new Error("Checkpoint sequence is stale.");
  if (
    data.stage < Number(run.stage) ||
    data.stage > Number(run.stage) + 1 ||
    data.stage > STAGES.length
  )
    throw new Error("Impossible stage progression.");
  const previous = run.stats || {},
    s = data.stats;
  if (
    data.activeSeconds < Number(run.active_seconds) ||
    data.activeSeconds - Number(run.active_seconds) > 1800
  )
    throw new Error("Impossible elapsed-time checkpoint.");
  if (
    s.ordersCompleted < Number(previous.ordersCompleted || 0) ||
    s.ordersCompleted - Number(previous.ordersCompleted || 0) > 20 ||
    s.pizzasMade < s.ordersCompleted
  )
    throw new Error("Impossible order progression.");
  if (
    !Number.isFinite(s.accuracy) ||
    s.accuracy < 0 ||
    s.accuracy > 100 ||
    s.sanity > 120 ||
    s.reputation > 120
  )
    throw new Error("Invalid run statistics.");
  const entry = {
    at: new Date().toISOString(),
    stage: data.stage,
    sequence: data.sequence,
    activeSeconds: data.activeSeconds,
    orders: s.ordersCompleted,
    accuracy: s.accuracy,
    profit: s.profit,
  };
  await getSql()`UPDATE pizza_gauntlet_runs SET stage=${data.stage},stage_orders=${data.stageOrders},sequence=${data.sequence},active_seconds=${data.activeSeconds},stats=${JSON.stringify(s)}::jsonb,checkpoints=(checkpoints||'[]'::jsonb)||${JSON.stringify([entry])}::jsonb,updated_at=NOW() WHERE id=${data.runId}`;
  return { ok: true };
}
export async function completeRun(runId: string, token: string) {
  const run = await authenticatedRun(runId, token);
  if (!run) throw new Error("Run credentials are invalid.");
  if (run.status === "won") {
    return (
      await getSql()`SELECT code,prize_type,issued_at,expires_at FROM pizza_gauntlet_rewards WHERE run_id=${runId}`
    )[0];
  }
  const stats = run.stats || {};
  if (
    Number(run.stage) !== STAGES.length ||
    Number(run.stage_orders) < STAGES.at(-1)!.ordersRequired ||
    Number(stats.ordersCompleted) <
      STAGES.reduce((n, x) => n + x.ordersRequired, 0)
  )
    throw new Error("The full campaign is not complete.");
  // Active time plus dense, monotonic checkpoints makes a browser flag alone insufficient.
  if (
    Number(run.active_seconds) < 5400 ||
    !Array.isArray(run.checkpoints) ||
    run.checkpoints.length < 18
  )
    throw new Error(
      "This run does not contain enough validated active play history.",
    );
  const rewardCode = code(),
    expires = new Date(Date.now() + PRIZE.expiresDays * 86400000).toISOString();
  await getSql()`UPDATE pizza_gauntlet_runs SET status='won',completed_at=NOW(),updated_at=NOW() WHERE id=${runId}`;
  return (
    await getSql()`INSERT INTO pizza_gauntlet_rewards(id,run_id,code,prize_type,terms,completion_stats,expires_at)VALUES(${randomUUID()},${runId},${rewardCode},${PRIZE.name},${JSON.stringify(PRIZE)}::jsonb,${JSON.stringify(stats)}::jsonb,${expires}) RETURNING code,prize_type,issued_at,expires_at`
  )[0];
}
export async function checkpointArcadeRun(
  data: {
    runId: string;
    sequence: number;
    elapsed: number;
    score: number;
    delivered: number;
    perfects: number;
    ruined: number;
  },
  token: string,
) {
  const run = await authenticatedRun(data.runId, token);
  if (!run) throw new Error("Run credentials are invalid.");
  if (run.status !== "active") throw new Error("This run is already closed.");
  if (data.sequence !== Number(run.sequence) + 1)
    throw new Error("Checkpoint sequence is stale.");
  const previous = run.stats || {},
    elapsed = Math.floor(data.elapsed),
    delivered = Math.floor(data.delivered),
    score = Math.floor(data.score),
    perfects = Math.floor(data.perfects),
    ruined = Math.floor(data.ruined);
  if (
    elapsed < Number(run.active_seconds) ||
    elapsed - Number(run.active_seconds) > 15 ||
    elapsed > 65
  )
    throw new Error("Impossible arcade elapsed time.");
  if (
    delivered < Number(previous.delivered || 0) ||
    delivered - Number(previous.delivered || 0) > 12 ||
    perfects > delivered * 3 + 6 ||
    score < 0 ||
    score > 250000 ||
    ruined < 0 ||
    ruined > 3
  )
    throw new Error("Impossible arcade progression.");
  const stats = { mode: "arcade60", score, delivered, perfects, ruined };
  const entry = {
    at: new Date().toISOString(),
    sequence: data.sequence,
    activeSeconds: elapsed,
    score,
    delivered,
    perfects,
    ruined,
  };
  await getSql()`UPDATE pizza_gauntlet_runs SET sequence=${data.sequence},active_seconds=${elapsed},stats=${JSON.stringify(stats)}::jsonb,checkpoints=(checkpoints||'[]'::jsonb)||${JSON.stringify([entry])}::jsonb,updated_at=NOW() WHERE id=${data.runId}`;
  return { ok: true };
}
export async function completeArcadeRun(
  data: {
    runId: string;
    score: number;
    delivered: number;
    perfects: number;
    ruined: number;
  },
  token: string,
) {
  const run = await authenticatedRun(data.runId, token);
  if (!run) throw new Error("Run credentials are invalid.");
  if (run.status === "won")
    return (
      await getSql()`SELECT code,prize_type,issued_at,expires_at FROM pizza_gauntlet_rewards WHERE run_id=${data.runId}`
    )[0];
  const wallSeconds =
      (Date.now() - new Date(String(run.started_at)).getTime()) / 1000,
    stats = run.stats || {},
    checks = Array.isArray(run.checkpoints) ? run.checkpoints.length : 0;
  if (wallSeconds < 55 || Number(run.active_seconds) < 55 || checks < 5)
    throw new Error("The 60-second shift has not been validated yet.");
  if (
    data.ruined > 2 ||
    Number(stats.ruined) > 2 ||
    data.delivered < 6 ||
    data.delivered !== Number(stats.delivered) ||
    data.score !== Number(stats.score)
  )
    throw new Error("This arcade result is not prize eligible.");
  const rewardCode = code(),
    expires = new Date(Date.now() + PRIZE.expiresDays * 86400000).toISOString(),
    finalStats = {
      ...stats,
      score: data.score,
      delivered: data.delivered,
      perfects: data.perfects,
      ruined: data.ruined,
    };
  await getSql()`UPDATE pizza_gauntlet_runs SET status='won',stats=${JSON.stringify(finalStats)}::jsonb,completed_at=NOW(),updated_at=NOW() WHERE id=${data.runId}`;
  return (
    await getSql()`INSERT INTO pizza_gauntlet_rewards(id,run_id,code,prize_type,terms,completion_stats,expires_at)VALUES(${randomUUID()},${data.runId},${rewardCode},${PRIZE.name},${JSON.stringify(PRIZE)}::jsonb,${JSON.stringify(finalStats)}::jsonb,${expires}) RETURNING code,prize_type,issued_at,expires_at`
  )[0];
}
export async function recordArcadeLoss(
  data: {
    runId: string;
    score: number;
    delivered: number;
    perfects: number;
    ruined: number;
  },
  token: string,
) {
  const run = await authenticatedRun(data.runId, token);
  if (!run || run.status !== "active") return { ok: false };
  const stats = {
    mode: "arcade60",
    score: Math.max(0, Math.floor(data.score)),
    delivered: Math.max(0, Math.floor(data.delivered)),
    perfects: Math.max(0, Math.floor(data.perfects)),
    ruined: Math.max(1, Math.floor(data.ruined)),
  };
  await getSql()`UPDATE pizza_gauntlet_runs SET status='lost',stats=${JSON.stringify(stats)}::jsonb,active_seconds=LEAST(60,GREATEST(active_seconds,EXTRACT(EPOCH FROM(NOW()-started_at))::int)),updated_at=NOW(),completed_at=NOW() WHERE id=${data.runId}`;
  return { ok: true };
}
export async function leaderboard() {
  await ensureGauntletSchema();
  return getSql()`SELECT player_name,status,game_version,completed_at,active_seconds,COALESCE((stats->>'score')::numeric,(stats->>'profit')::numeric,0) score,COALESCE((stats->>'delivered')::int,(stats->>'pizzasMade')::int,0) pizzas_made,COALESCE((stats->>'perfects')::int,0) perfects,COALESCE((stats->>'highestCombo')::int,0) highest_combo FROM pizza_gauntlet_runs WHERE status IN('won','lost') ORDER BY CASE WHEN status='won' THEN 1 ELSE 0 END DESC,COALESCE((stats->>'delivered')::int,(stats->>'pizzasMade')::int,0) DESC,COALESCE((stats->>'score')::numeric,(stats->>'profit')::numeric,0) DESC,completed_at ASC NULLS LAST LIMIT 50`;
}
export async function findRewards(query: string) {
  await ensureGauntletSchema();
  const q = `%${query.trim()}%`;
  return getSql()`SELECT reward.*,run.player_name,run.active_seconds FROM pizza_gauntlet_rewards reward JOIN pizza_gauntlet_runs run ON run.id=reward.run_id WHERE ${query.trim() === ""} OR reward.code ILIKE ${q} OR run.player_name ILIKE ${q} ORDER BY reward.issued_at DESC LIMIT 50`;
}
export async function redeemReward(
  codeValue: string,
  actor: string,
  note: string,
) {
  await ensureGauntletSchema();
  const rows =
    await getSql()`UPDATE pizza_gauntlet_rewards SET redeemed_at=NOW(),redeemed_by=${actor},redemption_note=${note.slice(0, 300)} WHERE code=${codeValue.trim().toUpperCase()} AND redeemed_at IS NULL AND(expires_at IS NULL OR expires_at>NOW()) RETURNING *`;
  if (!rows[0])
    throw new Error("Code is invalid, expired, or already redeemed.");
  return rows[0];
}
