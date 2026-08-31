import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingHardwareSchema } from "@/lib/ordering-hardware-schema";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { sendTransactionalEmail } from "@/lib/transactional-email";

export type CustomerDisplayPayload = {
  schemaVersion: number;
  updatedAt: string;
  orderId?: string;
  checkId?: string | null;
  receiptPrinterId?: string;
  serviceType: string;
  lines: Array<{id:string;name:string;variantName:string;quantity:number;modifiers:string[];lineTotalCents:number}>;
  subtotalCents: number;
  totalCents: number;
  amountDueCents?: number;
  paymentStatus?: string;
  status: string;
  orderNumber: string;
  customerEmail?: string;
};

let schemaPromise: Promise<void> | null = null;
export function ensureCustomerDisplaySchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await ensureOrderingHardwareSchema();
    await ensureOrderingCustomerSchema();
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_customer_display_sessions (
      business TEXT NOT NULL, station_key TEXT NOT NULL, order_id UUID REFERENCES ordering_orders(id) ON DELETE SET NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb, response JSONB NOT NULL DEFAULT '{}'::jsonb,
      response_version INTEGER NOT NULL DEFAULT 0, response_handled_version INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '12 hours',
      PRIMARY KEY (business, station_key)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_customer_checkout_responses (
      id UUID PRIMARY KEY, business TEXT NOT NULL, station_key TEXT NOT NULL, order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
      response_type TEXT NOT NULL CHECK(response_type IN ('tip','signature','receipt')),
      details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_customer_checkout_response_order_idx ON ordering_customer_checkout_responses(order_id,created_at)`;
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function key(value: unknown) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(result)) throw new Error("Enter a valid customer-display station key.");
  return result;
}

export async function publishCustomerDisplay(stationKey: string, payload: CustomerDisplayPayload) {
  await ensureCustomerDisplaySchema();
  const station = key(stationKey), sql = getSql();
  const valid = (await sql`SELECT id FROM ordering_payment_stations WHERE business='Corner Deli' AND station_key=${station} AND active=TRUE`)[0];
  if (!valid) throw new Error("This station key is not assigned in Settings → Hardware.");
  const orderId = payload.orderId || null;
  if(orderId){
    const order=(await sql`SELECT orders.email_snapshot,orders.customer_id,customers.email customer_email FROM ordering_orders orders LEFT JOIN ordering_customers customers ON customers.id=orders.customer_id WHERE orders.id=${orderId} AND orders.business='Corner Deli'`)[0];
    if(order)payload.customerEmail=String(order.email_snapshot||order.customer_email||"");
    if(!payload.lines.length){
      const items=await sql`SELECT id,item_name_snapshot,variant_name_snapshot,quantity,line_total_cents FROM ordering_order_items WHERE order_id=${orderId} AND cancelled_quantity<quantity ORDER BY sort_order,created_at,id`;
      const modifiers=items.length?await sql`SELECT order_item_id,option_name_snapshot,quantity FROM ordering_order_item_modifiers WHERE order_item_id=ANY(${items.map(item=>String(item.id))}::uuid[]) AND selection_state IN('selected','extra') ORDER BY print_order_snapshot,created_at,id`:[];
      payload.lines=items.map(item=>({id:String(item.id),name:String(item.item_name_snapshot),variantName:String(item.variant_name_snapshot||""),quantity:Number(item.quantity)-Number(item.cancelled_quantity||0),modifiers:modifiers.filter(modifier=>String(modifier.order_item_id)===String(item.id)).map(modifier=>`${Number(modifier.quantity)>1?`${modifier.quantity}× `:""}${modifier.option_name_snapshot}`),lineTotalCents:Number(item.line_total_cents)}));
    }
  }
  const existing = (await sql`SELECT order_id,response,response_version,response_handled_version FROM ordering_customer_display_sessions WHERE business='Corner Deli' AND station_key=${station}`)[0];
  const sameOrder = orderId && String(existing?.order_id || "") === orderId;
  await sql`INSERT INTO ordering_customer_display_sessions(business,station_key,order_id,payload,response,response_version,response_handled_version,updated_at,expires_at)
    VALUES('Corner Deli',${station},${orderId}::uuid,${JSON.stringify(payload)}::jsonb,'{}'::jsonb,0,0,NOW(),NOW()+INTERVAL '12 hours')
    ON CONFLICT(business,station_key) DO UPDATE SET order_id=EXCLUDED.order_id,payload=EXCLUDED.payload,
      response=CASE WHEN ${sameOrder} THEN ordering_customer_display_sessions.response ELSE '{}'::jsonb END,
      response_version=CASE WHEN ${sameOrder} THEN ordering_customer_display_sessions.response_version ELSE 0 END,
      response_handled_version=CASE WHEN ${sameOrder} THEN ordering_customer_display_sessions.response_handled_version ELSE 0 END,
      updated_at=NOW(),expires_at=EXCLUDED.expires_at`;
  return getCustomerDisplay(station);
}

export async function getCustomerDisplay(stationKey: string) {
  await ensureCustomerDisplaySchema();
  const station = key(stationKey), sql = getSql();
  const row = (await sql`SELECT session.*,station.name station_name FROM ordering_customer_display_sessions session JOIN ordering_payment_stations station ON station.business=session.business AND station.station_key=session.station_key AND station.active=TRUE WHERE session.business='Corner Deli' AND session.station_key=${station} AND session.expires_at>NOW()`)[0];
  if (!row) return null;
  const completion=row.order_id?(await sql`SELECT response_type,details FROM ordering_customer_checkout_responses WHERE order_id=${row.order_id} AND station_key=${station} ORDER BY created_at DESC`):[];
  return { stationKey: station, stationName: row.station_name, payload: row.payload, response: row.response, responseVersion: Number(row.response_version), handledVersion: Number(row.response_handled_version), signatureCaptured:completion.some(item=>item.response_type==='signature'),receiptCompleted:completion.some(item=>item.response_type==='receipt') };
}

export async function submitCustomerDisplayResponse(stationKey:string, input:Record<string,unknown>) {
  await ensureCustomerDisplaySchema();
  const station=key(stationKey),sql=getSql(),session=(await sql`SELECT * FROM ordering_customer_display_sessions WHERE business='Corner Deli' AND station_key=${station} AND expires_at>NOW()`)[0];
  if(!session?.order_id)throw new Error("No active checkout is connected to this display.");
  const action=String(input.action||"");
  if(action==="tip"){
    const tipCents=Number(input.tipCents);
    if(!Number.isSafeInteger(tipCents)||tipCents<0||tipCents>100000)throw new Error("Enter a valid tip.");
    const response={action,tipCents,requestId:randomUUID(),submittedAt:new Date().toISOString()};
    await sql`UPDATE ordering_customer_display_sessions SET response=${JSON.stringify(response)}::jsonb,response_version=response_version+1,updated_at=NOW() WHERE business='Corner Deli' AND station_key=${station}`;
    await sql`INSERT INTO ordering_customer_checkout_responses(id,business,station_key,order_id,response_type,details) VALUES(${randomUUID()},'Corner Deli',${station},${session.order_id},'tip',${JSON.stringify(response)}::jsonb)`;
    return {ok:true};
  }
  if(action==="signature"){
    const signature=String(input.signature||"");
    if(signature.length<20||signature.length>120000||!signature.startsWith("data:image/png;base64,"))throw new Error("Please sign before continuing.");
    await sql`INSERT INTO ordering_customer_checkout_responses(id,business,station_key,order_id,response_type,details) VALUES(${randomUUID()},'Corner Deli',${station},${session.order_id},'signature',${JSON.stringify({signature,capturedAt:new Date().toISOString()})}::jsonb)`;
    return {ok:true};
  }
  if(action==="receipt"){
    const method=String(input.method||"");
    if(!['email','print','none'].includes(method))throw new Error("Choose email, print, or no receipt.");
    const order=(await sql`SELECT orders.*,customers.email customer_email FROM ordering_orders orders LEFT JOIN ordering_customers customers ON customers.id=orders.customer_id WHERE orders.id=${session.order_id} AND orders.business='Corner Deli'`)[0];
    if(!order||order.payment_status!=="paid")throw new Error("The payment must finish before selecting a receipt.");
    const details:Record<string,unknown>={method,completedAt:new Date().toISOString()};
    if(method==="email"){
      const email=String(input.email||order.email_snapshot||order.customer_email||"").trim().toLowerCase();
      if(!/^\S+@\S+\.\S+$/.test(email))throw new Error("Enter a valid receipt email.");
      const sent=await sendTransactionalEmail({to:email,subject:`Corner Deli receipt #${order.display_number}`,text:["Corner Deli",`Receipt #${order.display_number}`,`Order total: $${(Number(order.total_cents)/100).toFixed(2)}`,`Paid: $${(Number(order.paid_cents)/100).toFixed(2)}`,"", "Thank you for your order."].join("\n"),idempotencyKey:`customer-receipt-${order.id}`});
      if(sent.sent!==1)throw new Error(sent.failures[0]||"Receipt email is not configured.");
      details.email=email;
      await sql`UPDATE ordering_orders SET email_snapshot=${email} WHERE id=${order.id}`;
      if(order.customer_id&&!order.customer_email)await sql`UPDATE ordering_customers SET email=${email},updated_at=NOW() WHERE id=${order.customer_id}`;
    }
    if(method==="print"){
      const printerId=String((session.payload||{}).receiptPrinterId||"");
      const pending=(await sql`SELECT id,payload FROM ordering_print_jobs WHERE order_id=${order.id} AND purpose='paid_receipt' AND payload->>'customerReceiptPending'='true' ORDER BY created_at DESC LIMIT 1`)[0],id=String(pending?.id||randomUUID());
      if(pending)await sql`UPDATE ordering_print_jobs SET status='queued',event_subtype='customer_requested',error_message='',payload=(payload-'customerReceiptPending')||${JSON.stringify({receiptPrinterId:printerId})}::jsonb WHERE id=${id}`;
      else await sql`INSERT INTO ordering_print_jobs(id,business,order_id,purpose,event_subtype,status,actor_type,actor_id,error_message,payload) VALUES(${id},'Corner Deli',${order.id},'paid_receipt','customer_requested','queued','customer','customer-display','',${JSON.stringify({heading:'PAID RECEIPT',orderNumber:String(order.display_number),customerName:`${order.first_name_snapshot||''} ${order.last_name_snapshot||''}`.trim(),serviceType:order.service_type,totalPaidCents:Number(order.paid_cents),remainingDueCents:0,receiptPrinterId:printerId})}::jsonb)`;
      await dispatchOrderPrintJobs(String(order.id),'Corner Deli',{includeKitchenProduction:false,jobId:id});
      details.printJobId=id;
    }
    if(method!=="print")await sql`UPDATE ordering_print_jobs SET status='succeeded',event_subtype=${method==='email'?'customer_emailed':'customer_declined'},completed_at=NOW(),error_message='',payload=payload-'customerReceiptPending' WHERE order_id=${order.id} AND purpose='paid_receipt' AND payload->>'customerReceiptPending'='true'`;
    await sql`INSERT INTO ordering_customer_checkout_responses(id,business,station_key,order_id,response_type,details) VALUES(${randomUUID()},'Corner Deli',${station},${order.id},'receipt',${JSON.stringify(details)}::jsonb)`;
    await sql`UPDATE ordering_customer_display_sessions SET response=${JSON.stringify({action:'complete',method})}::jsonb,response_version=response_version+1,response_handled_version=response_version+1,updated_at=NOW() WHERE business='Corner Deli' AND station_key=${station}`;
    return {ok:true,method};
  }
  throw new Error("Unknown customer-display action.");
}

export async function markCustomerDisplayHandled(stationKey:string,version:number){await ensureCustomerDisplaySchema();const station=key(stationKey);await getSql()`UPDATE ordering_customer_display_sessions SET response_handled_version=GREATEST(response_handled_version,${version}) WHERE business='Corner Deli' AND station_key=${station}`;}
