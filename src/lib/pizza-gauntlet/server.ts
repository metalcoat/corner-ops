import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { PRIZE, STAGES } from "./config";
import type { RunCheckpoint } from "./types";
import { PIZZA_GAME_VERSION } from "@/lib/games/versions";
import { CHECKPOINT_SECONDS, MAX_DELIVERED_PER_CHECKPOINT, MAX_STRIKES, MIN_DELIVERED, SHIFT_SECONDS } from "@/lib/games/pizza-rush/engine";
import { validateRushReplay } from "@/lib/games/pizza-rush/replay";

let schema: Promise<void> | null = null;
export function ensureGauntletSchema() {
  if (!schema)
    schema = (async () => {
    })();
  return schema;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const code = () =>
  `JUMBO-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
const runSeed = (runId: string, tokenHash: string) => Number.parseInt(digest(`${runId}:${tokenHash}`).slice(0, 8), 16);
async function issueReward(runId: string, sequence: number, stats: Record<string, unknown>, beforeIssue?: () => Promise<void>) {
  return withTransaction(async () => {
  const sql = getSql();
  const [run] = await sql`SELECT status,sequence FROM pizza_gauntlet_runs WHERE id=${runId} FOR UPDATE`;
  if (run?.status === "won") return (await sql`SELECT code,prize_type,issued_at,expires_at FROM pizza_gauntlet_rewards WHERE run_id=${runId}`)[0];
  if (run?.status !== "active" || Number(run.sequence) !== sequence) throw new Error("This run is closed or has changed. Retry completion after the latest checkpoint.");
  if (beforeIssue) await beforeIssue();
  const expires = new Date(Date.now() + PRIZE.expiresDays * 86400000).toISOString();
  // One statement makes the state transition and reward inseparable, including
  // insert failures and simultaneous completion requests.
  const issued = await sql`
    WITH won AS (
      UPDATE pizza_gauntlet_runs SET status='won',stats=${JSON.stringify(stats)}::jsonb,completed_at=NOW(),updated_at=NOW()
      WHERE id=${runId} AND status='active' AND sequence=${sequence} RETURNING id
    )
    INSERT INTO pizza_gauntlet_rewards(id,run_id,code,prize_type,terms,completion_stats,expires_at)
    SELECT ${randomUUID()},id,${code()},${PRIZE.name},${JSON.stringify(PRIZE)}::jsonb,${JSON.stringify(stats)}::jsonb,${expires}::timestamptz FROM won
    RETURNING code,prize_type,issued_at,expires_at`;
  if (issued[0]) return issued[0];
  const existing = await sql`SELECT code,prize_type,issued_at,expires_at FROM pizza_gauntlet_rewards WHERE run_id=${runId}`;
  if (existing[0]) return existing[0];
  throw new Error("This run is closed or has changed. Retry completion after the latest checkpoint.");
  });
}
export async function startRun(playerName: string) {
  await ensureGauntletSchema();
  const id = randomUUID(),
    token = randomBytes(32).toString("base64url");
  await getSql()`INSERT INTO pizza_gauntlet_runs(id,token_hash,player_name,game_version)VALUES(${id},${digest(token)},${playerName.trim().slice(0, 40) || "Anonymous Cook"},${PIZZA_GAME_VERSION})`;
  return { runId: id, token, gameVersion: PIZZA_GAME_VERSION, seed: runSeed(id, digest(token)) };
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
  if (!data || !data.stats || ![data.sequence, data.stage, data.stageOrders, data.activeSeconds].every((value) => Number.isSafeInteger(value) && value >= 0)
    || ![data.stats.accuracy, data.stats.profit, data.stats.sanity, data.stats.reputation, data.stats.ordersCompleted, data.stats.pizzasMade].every(Number.isFinite)
    || Object.values(data.stats).some((value) => !Number.isFinite(value))) throw new Error("Invalid run statistics.");
  const run = await authenticatedRun(data.runId, token);
  if (!run) throw new Error("Run credentials are invalid.");
  if (run.status !== "active") throw new Error("This run is already closed.");
  if (run.game_version === PIZZA_GAME_VERSION) throw new Error("This shift requires Jumbo Rush checkpoints.");
  if (data.sequence > 128 || (Array.isArray(run.checkpoints) && run.checkpoints.length >= 128)) throw new Error("This run has too many checkpoints.");
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
    data.activeSeconds <= Number(run.active_seconds) ||
    data.activeSeconds - Number(run.active_seconds) > 1800 ||
    data.activeSeconds > (Date.now() - new Date(String(run.started_at)).getTime()) / 1000 + 2
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
  const updated = await getSql()`UPDATE pizza_gauntlet_runs SET stage=${data.stage},stage_orders=${data.stageOrders},sequence=${data.sequence},active_seconds=${data.activeSeconds},stats=${JSON.stringify(s)}::jsonb,checkpoints=(checkpoints||'[]'::jsonb)||${JSON.stringify([entry])}::jsonb,updated_at=NOW() WHERE id=${data.runId} AND status='active' AND sequence=${Number(run.sequence)} RETURNING id`;
  if (!updated[0]) throw new Error("Checkpoint sequence is stale or this run is closed.");
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
  if (run.status !== "active") throw new Error("This run is already closed.");
  throw new Error("This older game cannot verify prize eligibility. Start a new Jumbo Rush shift.");
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
  if (![data.elapsed, data.score, data.delivered, data.perfects, data.ruined].every((value) => Number.isFinite(value) && value >= 0)
    || !Number.isSafeInteger(data.sequence)) throw new Error("Invalid arcade statistics.");
  const run = await authenticatedRun(data.runId, token);
  if (!run) throw new Error("Run credentials are invalid.");
  if (run.status !== "active") throw new Error("This run is already closed.");
  if (data.sequence !== Number(run.sequence) + 1)
    throw new Error("Checkpoint sequence is stale.");
  const maxCheckpoints = Math.ceil(SHIFT_SECONDS / CHECKPOINT_SECONDS);
  if (data.sequence < 1 || data.sequence > maxCheckpoints || (Array.isArray(run.checkpoints) && run.checkpoints.length >= maxCheckpoints)) throw new Error("This shift has too many checkpoints.");
  const previous = run.stats || {},
    elapsed = Math.floor(data.elapsed),
    delivered = Math.floor(data.delivered),
    score = Math.floor(data.score),
    perfects = Math.floor(data.perfects),
    ruined = Math.floor(data.ruined);
  if (
    elapsed !== Math.min(data.sequence * CHECKPOINT_SECONDS, SHIFT_SECONDS) ||
    elapsed <= Number(run.active_seconds) ||
    elapsed - Number(run.active_seconds) > 15 ||
    elapsed > SHIFT_SECONDS ||
    elapsed > (Date.now() - new Date(String(run.started_at)).getTime()) / 1000 + 2
  )
    throw new Error("Impossible arcade elapsed time.");
  if (
    delivered < Number(previous.delivered || 0) ||
    delivered - Number(previous.delivered || 0) > MAX_DELIVERED_PER_CHECKPOINT ||
    perfects < Number(previous.perfects || 0) ||
    ruined < Number(previous.ruined || 0) ||
    score < Number(previous.score || 0) ||
    perfects > delivered * 3 + 6 ||
    score < 0 ||
    score > 250000 ||
    ruined < 0 ||
    ruined > MAX_STRIKES
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
  const updated = await getSql()`UPDATE pizza_gauntlet_runs SET sequence=${data.sequence},active_seconds=${elapsed},stats=${JSON.stringify(stats)}::jsonb,checkpoints=(checkpoints||'[]'::jsonb)||${JSON.stringify([entry])}::jsonb,updated_at=NOW() WHERE id=${data.runId} AND status='active' AND sequence=${Number(run.sequence)} RETURNING id`;
  if (!updated[0]) throw new Error("Checkpoint sequence is stale or this run is closed.");
  return { ok: true };
}
export async function completeArcadeRun(
  data: {
    runId: string;
    score: number;
    delivered: number;
    perfects: number;
    ruined: number;
    replay?: unknown;
  },
  token: string,
  beforeIssue?: () => Promise<void>,
) {
  if (![data.score, data.delivered, data.perfects, data.ruined].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid arcade statistics.");
  const run = await authenticatedRun(data.runId, token);
  if (!run) throw new Error("Run credentials are invalid.");
  if (run.status === "won")
    return (
      await getSql()`SELECT code,prize_type,issued_at,expires_at FROM pizza_gauntlet_rewards WHERE run_id=${data.runId}`
    )[0];
  if (run.status !== "active") throw new Error("This run is already closed.");
  if (run.game_version !== PIZZA_GAME_VERSION) throw new Error("Start a new Jumbo Rush shift to verify prize eligibility.");
  const wallSeconds =
      (Date.now() - new Date(String(run.started_at)).getTime()) / 1000,
    stats = run.stats || {},
    checks = Array.isArray(run.checkpoints) ? run.checkpoints.length : 0;
  if (wallSeconds < SHIFT_SECONDS - 1 || Number(run.active_seconds) < SHIFT_SECONDS || checks < Math.floor(SHIFT_SECONDS / 10))
    throw new Error("The full pizza-station shift has not been validated yet.");
  if (
    data.ruined >= MAX_STRIKES ||
    Number(stats.ruined) >= MAX_STRIKES ||
    data.delivered < MIN_DELIVERED ||
    data.delivered !== Number(stats.delivered) ||
    data.score !== Number(stats.score) ||
    data.perfects !== Number(stats.perfects) ||
    data.ruined !== Number(stats.ruined)
  )
    throw new Error("This arcade result is not prize eligible.");
  validateRushReplay(runSeed(data.runId, String(run.token_hash)), data.replay, {
    elapsed: SHIFT_SECONDS, score: data.score, delivered: data.delivered, perfects: data.perfects, ruined: data.ruined,
  });
  const finalStats = {
      ...stats,
      score: data.score,
      delivered: data.delivered,
      perfects: data.perfects,
      ruined: data.ruined,
    };
  return issueReward(data.runId, Number(run.sequence), finalStats, beforeIssue);
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
  if (![data.score, data.delivered, data.perfects, data.ruined].every((value) => Number.isSafeInteger(value) && value >= 0)
    || data.score > 250000
    || data.delivered > MAX_DELIVERED_PER_CHECKPOINT * Math.ceil(SHIFT_SECONDS / 10)
    || data.perfects > data.delivered * 3 + 6
    || data.ruined > MAX_STRIKES) throw new Error("Invalid arcade statistics.");
  const run = await authenticatedRun(data.runId, token);
  if (!run || run.status !== "active") return { ok: false };
  const stats = {
    mode: "arcade60",
    score: Math.max(0, Math.floor(data.score)),
    delivered: Math.max(0, Math.floor(data.delivered)),
    perfects: Math.max(0, Math.floor(data.perfects)),
    ruined: Math.max(1, Math.floor(data.ruined)),
  };
  await getSql()`UPDATE pizza_gauntlet_runs SET status='lost',stats=${JSON.stringify(stats)}::jsonb,active_seconds=LEAST(${SHIFT_SECONDS},GREATEST(active_seconds,EXTRACT(EPOCH FROM(NOW()-started_at))::int)),updated_at=NOW(),completed_at=NOW() WHERE id=${data.runId} AND status='active'`;
  return { ok: true };
}
export async function leaderboard() {
  await ensureGauntletSchema();
  return getSql()`SELECT player_name,status,game_version,completed_at,active_seconds,COALESCE((stats->>'score')::numeric,(stats->>'profit')::numeric,0) score,COALESCE((stats->>'delivered')::numeric,(stats->>'pizzasMade')::numeric,0) pizzas_made,COALESCE((stats->>'perfects')::numeric,0) perfects,COALESCE((stats->>'highestCombo')::numeric,0) highest_combo FROM pizza_gauntlet_runs WHERE status IN('won','lost') ORDER BY CASE WHEN status='won' THEN 1 ELSE 0 END DESC,COALESCE((stats->>'delivered')::numeric,(stats->>'pizzasMade')::numeric,0) DESC,COALESCE((stats->>'score')::numeric,(stats->>'profit')::numeric,0) DESC,completed_at ASC NULLS LAST LIMIT 50`;
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
