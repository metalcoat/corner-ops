import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
import { orderingActor } from "@/lib/ordering-route-auth";
import { offlineOrderAlreadySubmitted } from "@/lib/pos-offline-sync-policy";

export const runtime = "nodejs";

class RelayError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

// Upstream status is preserved so the POS can tell a permanent rejection (4xx,
// parked for review) from a transient failure (5xx, retried automatically).
async function relay(request: Request, path: string, body: unknown) {
  const url = new URL(path, request.url);
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", cookie: request.headers.get("cookie") || "" }, body: JSON.stringify(body), cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new RelayError(payload?.error || `Offline sync failed at ${path}.`, response.ok ? 502 : response.status);
  return payload;
}

export async function POST(request: Request) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    const body = await request.json() as { id?: unknown; createdAt?: unknown; orderBody?: unknown; amountTenderedCents?: unknown; stationKey?: unknown };
    const mutationId = String(body.id || ""), stationKey = String(body.stationKey || "").trim().toLowerCase();
    const amount = body.amountTenderedCents == null ? null : Number(body.amountTenderedCents);
    if (!/^[0-9a-f-]{36}$/i.test(mutationId) || !body.orderBody || typeof body.orderBody !== "object") return Response.json({ error: "The offline order payload is invalid." }, { status: 400 });
    if (amount !== null && (!Number.isSafeInteger(amount) || amount <= 0)) return Response.json({ error: "The offline cash amount is invalid." }, { status: 400 });
    await ensureOrderingPosSchema();
    const sql = getSql();
    const station = stationKey ? (await sql`SELECT * FROM ordering_payment_stations WHERE business='Corner Deli' AND station_key=${stationKey} AND station_mode='payment' AND active=TRUE LIMIT 1`)[0] : undefined;
    // A payment station is only required when offline cash was tendered.
    if (!station && amount !== null) return Response.json({ error: "This station is no longer authorized to accept cash." }, { status: 409 });
    let terminal;
    if (station) {
      const terminalKey=String(station.shared_register_key||station.station_key).trim().toLowerCase(),terminalId=randomUUID();
      terminal=(await sql`INSERT INTO ordering_pos_terminals(id,business,name,terminal_key,terminal_type,location_label,allow_cash,allow_offline_cash) VALUES(${terminalId},'Corner Deli',${String(station.shared_register_key||station.name)},${terminalKey},'pos',${station.name},TRUE,TRUE) ON CONFLICT(business,terminal_key) DO UPDATE SET last_seen_at=NOW(),updated_at=NOW() RETURNING id`)[0];
    } else {
      // Unpaid orders from devices without a payment station share one non-cash terminal for idempotency bookkeeping.
      terminal=(await sql`INSERT INTO ordering_pos_terminals(id,business,name,terminal_key,terminal_type,location_label,allow_cash,allow_offline_cash) VALUES(${randomUUID()},'Corner Deli','Offline order entry','offline-unpaid','pos','Unassigned POS devices',FALSE,FALSE) ON CONFLICT(business,terminal_key) DO UPDATE SET last_seen_at=NOW(),updated_at=NOW() RETURNING id`)[0];
    }
    const register=amount===null?undefined:(await sql`SELECT id,status FROM ordering_register_sessions WHERE terminal_id=${terminal.id} AND status IN('open','counting','needs_review') ORDER BY opened_at DESC LIMIT 1`)[0];
    if (amount !== null && register?.status !== "open") return Response.json({ error: "The original register must still be open before this offline cash order can sync." }, { status: 409 });
    const existing=(await sql`SELECT * FROM ordering_offline_mutations WHERE terminal_id=${terminal.id} AND client_mutation_id=${mutationId} LIMIT 1`)[0];
    if(existing?.status==='applied')return Response.json(existing.result);
    let result=(existing?.result&&typeof existing.result==='object'?existing.result:{}) as Record<string,unknown>;
    if(!existing)await sql`INSERT INTO ordering_offline_mutations(id,business,terminal_id,client_mutation_id,mutation_type,payload,status,result,client_created_at) VALUES(${randomUUID()},'Corner Deli',${terminal.id},${mutationId},'offline_cash_order',${JSON.stringify({orderBody:body.orderBody,amountTenderedCents:amount,stationKey})}::jsonb,'received','{}'::jsonb,${String(body.createdAt||new Date().toISOString())})`;
    if(!result.orderId){const created=await relay(request,"/api/ordering/orders",{...(body.orderBody as Record<string,unknown>),idempotencyKey:mutationId});result={...result,orderId:created.order.id,displayNumber:created.order.display_number,totalCents:Number(created.order.total_cents)};await sql`UPDATE ordering_offline_mutations SET result=${JSON.stringify(result)}::jsonb WHERE terminal_id=${terminal.id} AND client_mutation_id=${mutationId}`}
    if(!result.submitted){
      // A prior attempt may have submitted without recording it; the kitchen may even have started it since.
      const current=(await sql`SELECT status FROM ordering_orders WHERE id=${String(result.orderId)} AND business='Corner Deli'`)[0];
      if(!current)return Response.json({ error: "The offline order was not found on the server. Review it manually." }, { status: 409 });
      if(current.status==="cancelled")return Response.json({ error: `Order #${String(result.displayNumber||"")} was cancelled before this offline order synced. Review it manually.` }, { status: 409 });
      if(offlineOrderAlreadySubmitted(current.status)){result={...result,submitted:true};await sql`UPDATE ordering_offline_mutations SET result=${JSON.stringify(result)}::jsonb WHERE terminal_id=${terminal.id} AND client_mutation_id=${mutationId}`}
    }
    if(!result.submitted){await relay(request,`/api/ordering/orders/${encodeURIComponent(String(result.orderId))}/submit`,{business:"Corner Deli"});result={...result,submitted:true};await sql`UPDATE ordering_offline_mutations SET result=${JSON.stringify(result)}::jsonb WHERE terminal_id=${terminal.id} AND client_mutation_id=${mutationId}`}
    // Cash payments require the till's receipt printer whenever network receipt printers exist; use the station's own.
    if(amount!==null&&!result.paid){await relay(request,`/api/ordering/orders/${encodeURIComponent(String(result.orderId))}/payments`,{business:"Corner Deli",tenderType:"cash",amountTenderedCents:amount,clientMutationId:`${mutationId}:cash`,stationKey,receiptPrinterId:station?.receipt_printer_id?String(station.receipt_printer_id):undefined});result={...result,paid:true};await sql`UPDATE ordering_offline_mutations SET result=${JSON.stringify(result)}::jsonb WHERE terminal_id=${terminal.id} AND client_mutation_id=${mutationId}`}
    await sql`UPDATE ordering_offline_mutations SET status='applied',result=${JSON.stringify(result)}::jsonb,applied_at=NOW() WHERE terminal_id=${terminal.id} AND client_mutation_id=${mutationId}`;
    await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,order_id,actor,details) VALUES(${randomUUID()},'Corner Deli','offline_order_synced',${actor.id},${terminal.id},${String(result.orderId)},${actor.name},${JSON.stringify({mutationId,clientCreatedAt:body.createdAt,cash:amount!==null})}::jsonb)`;
    return Response.json(result);
  } catch (error) {
    if (error instanceof RelayError) return Response.json({ error: error.message }, { status: error.status });
    return apiError(error);
  }
}
