import assert from "node:assert/strict";
import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { playRushReplay } from "../tests/fixtures/pizza-rush-replay";

if (!process.env.VALIDATION_DATABASE_URL || process.env.ORDERING_AUDIT_DATABASE !== "1") throw new Error("An explicitly isolated audit database is required.");
process.env.DATABASE_URL = process.env.VALIDATION_DATABASE_URL;
process.env.DATABASE_DRIVER = "postgres";

async function main() {
  const game = await import("../src/lib/pizza-gauntlet/server");
  const { getSql } = await import("../src/lib/db");
  const { consumeRateLimit } = await import("../src/lib/rate-limit");
  const { POST } = await import("../src/app/api/pizza-gauntlet/run/route");
  const sql = getSql(), runs: string[] = [];
  const startIp = `audit-${randomUUID()}`, startKey = createHash("sha256").update(`ip:${startIp}`).digest("hex");
  const create = async () => { const run = await game.startRun("Audit pizza player"); runs.push(run.runId); return run; };
  const ready = async () => {
    let run = await create(), replay = playRushReplay(run.seed);
    for (let attempt=0; replay.state!=="won" && attempt<20; attempt++) { run=await create(); replay=playRushReplay(run.seed); }
    assert.equal(replay.state,"won"); assert.ok(replay.stats.delivered>=40);
    const stats = replay.stats;
    await sql`UPDATE pizza_gauntlet_runs SET started_at=NOW()-INTERVAL '111 seconds',active_seconds=110,sequence=11,stats=${JSON.stringify({mode:"arcade60",...stats})}::jsonb,checkpoints=${JSON.stringify(Array.from({length:11},(_,index)=>({sequence:index+1})))}::jsonb WHERE id=${run.runId}`;
    return {...run,stats,replay:replay.actions};
  };
  const result = (run: Awaited<ReturnType<typeof ready>>) => ({runId:run.runId,...run.stats,replay:run.replay});
  try {
    const run = await ready();
    const scope=`audit-pizza-${run.runId}`;
    const limit = () => consumeRateLimit([{scope,discriminator:"daily",maxFailures:1,windowSeconds:86400,blockSeconds:86400}]);
    const results = await Promise.all(Array.from({length:8},()=>game.completeArcadeRun(result(run),run.token,limit)));
    assert.ok(results.every((reward)=>reward.code === results[0].code));
    assert.equal((await sql`SELECT COUNT(*)::int count FROM pizza_gauntlet_rewards WHERE run_id=${run.runId}`)[0].count,1);
    assert.equal(Number((await sql`SELECT attempts FROM security_rate_limits WHERE scope=${scope}`)[0].attempts),1);
    await sql`DELETE FROM security_rate_limits WHERE scope=${scope}`;
    await game.redeemReward(results[0].code,"audit","test");
    await assert.rejects(()=>game.redeemReward(results[0].code,"audit","again"),/already redeemed/);

    const lost = await ready();
    for (const invalid of [{score:1e100},{delivered:1e100},{perfects:1e100},{ruined:1e100},{score:1.5}]) {
      await assert.rejects(()=>game.recordArcadeLoss({...result(lost),...invalid},lost.token),/Invalid arcade/);
    }
    await game.recordArcadeLoss({...result(lost),ruined:3},lost.token);
    await assert.rejects(()=>game.completeArcadeRun(result(lost),lost.token),/already closed/);
    // Older malicious submissions must not overflow PostgreSQL's integer cast.
    await sql`UPDATE pizza_gauntlet_runs SET stats='{"delivered":1e100,"perfects":1e100,"highestCombo":1e100}'::jsonb WHERE id=${lost.runId}`;
    await game.leaderboard();
    const mismatch = await ready();
    await assert.rejects(()=>game.completeArcadeRun({...result(mismatch),perfects:999},mismatch.token),/not prize eligible/);
    let quotaCalled=false;
    await assert.rejects(()=>game.completeArcadeRun({...result(mismatch),replay:undefined},mismatch.token,async()=>{quotaCalled=true}),/replay/);
    assert.equal(quotaCalled,false);
    await assert.rejects(()=>game.completeRun(mismatch.runId,mismatch.token),/older game/);
    await assert.rejects(()=>game.completeArcadeRun(result(mismatch),mismatch.token,async()=>{throw new Error("Quota rejected")}),/Quota rejected/);
    assert.equal((await sql`SELECT status FROM pizza_gauntlet_runs WHERE id=${mismatch.runId}`)[0].status,"active");
    const early = await ready();
    await sql`UPDATE pizza_gauntlet_runs SET active_seconds=100 WHERE id=${early.runId}`;
    await assert.rejects(()=>game.completeArcadeRun(result(early),early.token),/full pizza-station shift/);

    const checkpointRun = await create();
    await sql`UPDATE pizza_gauntlet_runs SET started_at=NOW()-INTERVAL '20 seconds' WHERE id=${checkpointRun.runId}`;
    const checkpoint = {runId:checkpointRun.runId,sequence:1,elapsed:10,score:100,delivered:2,perfects:0,ruined:0};
    await assert.rejects(()=>game.checkpointArcadeRun({...checkpoint,elapsed:0},checkpointRun.token),/elapsed time/);
    const blocker = new Client({connectionString:process.env.DATABASE_URL});
    await blocker.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM pizza_gauntlet_runs WHERE id=$1 FOR UPDATE",[checkpointRun.runId]);
    const requests = Promise.allSettled([game.checkpointArcadeRun(checkpoint,checkpointRun.token),game.checkpointArcadeRun(checkpoint,checkpointRun.token)]);
    await new Promise((resolve)=>setTimeout(resolve,100));
    await blocker.query("COMMIT"); await blocker.end();
    const settled = await requests;
    assert.equal(settled.filter((result)=>result.status==="fulfilled").length,1);
    assert.equal((await sql`SELECT jsonb_array_length(checkpoints) count FROM pizza_gauntlet_runs WHERE id=${checkpointRun.runId}`)[0].count,1);
    for (const invalid of [{score:NaN},{perfects:-1},{delivered:Infinity},{ruined:-1}]) {
      await assert.rejects(()=>game.checkpointArcadeRun({...checkpoint,sequence:2,...invalid},checkpointRun.token),/Invalid arcade/);
    }
    await assert.rejects(()=>game.checkpointArcadeRun({...checkpoint,sequence:2,elapsed:25},checkpointRun.token),/elapsed time/);
    await assert.rejects(()=>game.checkpointArcadeRun({...checkpoint,sequence:2},checkpointRun.token),/elapsed time/);
    await assert.rejects(()=>game.checkpointArcadeRun({...checkpoint,sequence:2,elapsed:20,score:50},checkpointRun.token),/progression/);
    await sql`UPDATE pizza_gauntlet_runs SET sequence=11,active_seconds=110 WHERE id=${checkpointRun.runId}`;
    await assert.rejects(()=>game.checkpointArcadeRun({...checkpoint,sequence:12,elapsed:110},checkpointRun.token),/too many checkpoints/);
    for (let attempt=0; attempt<61; attempt++) {
      const response = await POST(new Request("http://audit.test/api/pizza-gauntlet/run", {method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":startIp},body:JSON.stringify({action:"start",playerName:"Audit restart throttle"})}));
      const body = await response.json();
      if (body.runId) runs.push(String(body.runId));
      assert.equal(response.status,attempt<60?201:429);
    }
    console.log(JSON.stringify({ concurrentRewardRequests:8,singlePrizeBudgetCharge:true,seededGameplayReplayRequired:true,singleUseRedemption:true,closedAndTamperedResultsRejected:true,fullShiftRequired:true,checkpointRaceRejected:true,invalidStatisticsRejected:true,zeroProgressCheckpointsRejected:true,restartThrottle:true }));
  } finally {
    await sql`DELETE FROM security_rate_limits WHERE scope='pizza-gauntlet-start' AND discriminator_hash=${startKey}`;
    for (const runId of runs) { await sql`DELETE FROM pizza_gauntlet_rewards WHERE run_id=${runId}`; await sql`DELETE FROM pizza_gauntlet_runs WHERE id=${runId}`; }
  }
}
main().then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(1)});
