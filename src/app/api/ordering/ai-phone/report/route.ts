import { randomUUID } from "node:crypto";
import { orderingManagerActor,isAuthorizationResponse } from "@/lib/ordering-route-auth";
import { ensureOrderingAiSchema } from "@/lib/ordering-ai-schema";
import { getSql } from "@/lib/db";
import { recordAiRegression } from "@/lib/ordering-ai-regressions";

export const runtime="nodejs";

export async function GET(){
  const actor=await orderingManagerActor("Corner Deli");if(isAuthorizationResponse(actor))return actor;await ensureOrderingAiSchema();const sql=getSql();
  const [summary,latency,recent]=await Promise.all([
    sql`SELECT COUNT(*)::int calls,COUNT(order_id)::int orders,COUNT(*)FILTER(WHERE state IN('handoff_pending','human'))::int handoffs,ROUND(AVG(EXTRACT(EPOCH FROM(COALESCE(ended_at,NOW())-started_at))))::int avg_call_seconds FROM ordering_call_sessions WHERE business='Corner Deli' AND started_at>NOW()-INTERVAL '7 days'`,
    sql`SELECT metric,COUNT(*)::int samples,ROUND(AVG(duration_ms))::int average_ms,ROUND(percentile_cont(0.5)WITHIN GROUP(ORDER BY duration_ms))::int median_ms,ROUND(percentile_cont(0.95)WITHIN GROUP(ORDER BY duration_ms))::int p95_ms FROM ordering_ai_latency_samples WHERE business='Corner Deli' AND created_at>NOW()-INTERVAL '7 days' GROUP BY metric ORDER BY metric`,
    sql`SELECT call.id,call.three_cx_call_id call_id,call.caller_phone,call.state,call.operating_mode,call.selected_model,call.started_at,call.ended_at,orders.display_number,orders.status order_status,orders.total_cents,COALESCE((SELECT jsonb_agg(jsonb_build_object('speaker',segment.speaker,'transcript',segment.transcript,'at',segment.completed_at)ORDER BY segment.completed_at)FROM ordering_call_transcript_segments segment WHERE segment.call_id=call.three_cx_call_id),'[]'::jsonb) transcript,review.rating review_rating FROM ordering_call_sessions call LEFT JOIN ordering_orders orders ON orders.id=call.order_id LEFT JOIN ordering_call_reviews review ON review.business=call.business AND review.call_id=call.three_cx_call_id WHERE call.business='Corner Deli' AND call.started_at>NOW()-INTERVAL '7 days' ORDER BY call.started_at DESC LIMIT 50`,
  ]);
  return Response.json({summary:summary[0],latency,recent});
}

export async function PUT(request:Request){
  const actor=await orderingManagerActor("Corner Deli");if(isAuthorizationResponse(actor))return actor;await ensureOrderingAiSchema();
  const body=await request.json(),callId=String(body.callId||""),rating=String(body.rating||""),allowed=["good","needs_review","ai_error","customer_error","menu_rule_problem","employee_follow_up"];
  if(!callId||!allowed.includes(rating))return Response.json({error:"A call and valid review rating are required."},{status:400});
  const call=(await getSql()`SELECT order_id FROM ordering_call_sessions WHERE business='Corner Deli' AND three_cx_call_id=${callId}`)[0];if(!call)return Response.json({error:"Call not found."},{status:404});
  await getSql()`INSERT INTO ordering_call_reviews(id,business,call_id,order_id,rating,notes,expected_order,ai_order,differences,reviewed_by)VALUES(${randomUUID()},'Corner Deli',${callId},${call.order_id||null},${rating},${String(body.notes||"").slice(0,2000)},${JSON.stringify(body.expectedOrder||{})}::jsonb,${JSON.stringify(body.aiOrder||{})}::jsonb,${JSON.stringify(body.differences||[])}::jsonb,${actor.id})ON CONFLICT(business,call_id)DO UPDATE SET rating=EXCLUDED.rating,notes=EXCLUDED.notes,expected_order=EXCLUDED.expected_order,ai_order=EXCLUDED.ai_order,differences=EXCLUDED.differences,reviewed_by=EXCLUDED.reviewed_by,updated_at=NOW()`;
  if(["ai_error","menu_rule_problem"].includes(rating)){const expected=body.expectedOrder&&typeof body.expectedOrder==="object"?body.expectedOrder:{};await recordAiRegression({business:"Corner Deli",caseType:Array.isArray(expected.items)?"order_resolution":"speech_completion",source:`review_${rating}`,callId,payload:Array.isArray(expected.items)?expected:{notes:String(body.notes||"").slice(0,500),differences:Array.isArray(body.differences)?body.differences:[]},expected:Array.isArray(expected.items)?expected:{mustNotRepeat:true}})}
  return Response.json({ok:true});
}
