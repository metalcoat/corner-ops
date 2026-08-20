import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getEmployeeSession, type EmployeeSession } from "@/lib/employee-auth";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingAddressSchema } from "@/lib/ordering-address-schema";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
import { cornerOpsBaseUrl } from "@/lib/transactional-email";
import { get, put } from "@/lib/storage";

export const DELIVERY_STATUSES = ["ASSIGNED","READY_FOR_DRIVER","PICKED_UP","EN_ROUTE","ARRIVED","DELIVERED","NO_CONTACT","DELIVERY_FAILED","RETURNED","CANCELLED"] as const;
export type DriverDeliveryStatus = typeof DELIVERY_STATUSES[number];
export type DriverActor = EmployeeSession & { manager: boolean; driver: boolean };
export type CustomerTrackingView={token_id:string;expires_at:string;delivery_id:string;status:string;delivered_at:string|null;updated_at:string;display_number:string;order_status:string;proof_id:string|null;proof_captured_at:string|null;location:{latitude:number;longitude:number;accuracyMeters:number|null;capturedAt:string;approximate:true}|null};

const transitions: Record<DriverDeliveryStatus, DriverDeliveryStatus[]> = {
  ASSIGNED:["READY_FOR_DRIVER","PICKED_UP","CANCELLED"], READY_FOR_DRIVER:["PICKED_UP","CANCELLED"],
  PICKED_UP:["EN_ROUTE","RETURNED","DELIVERY_FAILED"], EN_ROUTE:["ARRIVED","NO_CONTACT","DELIVERED","DELIVERY_FAILED","RETURNED"],
  ARRIVED:["NO_CONTACT","DELIVERED","DELIVERY_FAILED","RETURNED"], NO_CONTACT:["DELIVERED","DELIVERY_FAILED","RETURNED"],
  DELIVERY_FAILED:["RETURNED","ASSIGNED"], DELIVERED:[], RETURNED:[], CANCELLED:[],
};

export async function ensureDriverDeliverySchema() {
  await ensureOrderingPosSchema();
  await ensureOrderingAddressSchema();
  const sql=getSql();
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS business TEXT`;
  await sql`ALTER TABLE ordering_delivery_assignments ALTER COLUMN driver_employee_id DROP NOT NULL`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS en_route_at TIMESTAMPTZ`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS status_note TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`UPDATE ordering_delivery_assignments d SET business=o.business FROM ordering_orders o WHERE o.id=d.order_id AND d.business IS NULL`;
  await sql`UPDATE ordering_delivery_assignments SET status=CASE status WHEN 'assigned' THEN 'ASSIGNED' WHEN 'out_for_delivery' THEN 'EN_ROUTE' WHEN 'delivered' THEN 'DELIVERED' WHEN 'failed' THEN 'DELIVERY_FAILED' WHEN 'returned' THEN 'RETURNED' WHEN 'cancelled' THEN 'CANCELLED' ELSE status END`;
  await sql`ALTER TABLE ordering_delivery_assignments DROP CONSTRAINT IF EXISTS ordering_delivery_assignments_status_check`;
  await sql`ALTER TABLE ordering_delivery_assignments ADD CONSTRAINT ordering_delivery_assignments_status_check CHECK(status IN ('ASSIGNED','READY_FOR_DRIVER','PICKED_UP','EN_ROUTE','ARRIVED','DELIVERED','NO_CONTACT','DELIVERY_FAILED','RETURNED','CANCELLED'))`;
  await sql`CREATE INDEX IF NOT EXISTS ordering_delivery_assignments_driver_idx ON ordering_delivery_assignments(driver_employee_id,status,updated_at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS ordering_delivery_audit(
    id UUID PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE, employee_id UUID REFERENCES employees(id),
    device_session_id UUID, action TEXT NOT NULL, previous_status TEXT, new_status TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS ordering_delivery_tracking_sessions(
    id UUID PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE,
    driver_id UUID NOT NULL REFERENCES employees(id), device_session_id UUID, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stopped_at TIMESTAMPTZ, stop_reason TEXT NOT NULL DEFAULT '')`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_delivery_tracking_active_idx ON ordering_delivery_tracking_sessions(delivery_id) WHERE stopped_at IS NULL`;
  await sql`CREATE TABLE IF NOT EXISTS ordering_delivery_locations(
    id UUID PRIMARY KEY, tracking_session_id UUID NOT NULL REFERENCES ordering_delivery_tracking_sessions(id) ON DELETE CASCADE,
    delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE, driver_id UUID NOT NULL REFERENCES employees(id),
    device_session_id UUID, client_event_id TEXT NOT NULL, captured_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    latitude NUMERIC(10,7) NOT NULL, longitude NUMERIC(10,7) NOT NULL, accuracy_meters NUMERIC(9,2), metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE(driver_id,client_event_id))`;
  await sql`CREATE TABLE IF NOT EXISTS ordering_delivery_proofs(
    id UUID PRIMARY KEY, order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
    delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE, employee_id UUID NOT NULL REFERENCES employees(id),
    storage_reference TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, captured_at TIMESTAMPTZ NOT NULL,
    latitude NUMERIC(10,7), longitude NUMERIC(10,7), accuracy_meters NUMERIC(9,2), proof_type TEXT NOT NULL,
    employee_note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS ordering_delivery_tracking_tokens(
    id UUID PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, token_value TEXT NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`ALTER TABLE ordering_delivery_tracking_tokens ADD COLUMN IF NOT EXISTS token_value TEXT NOT NULL DEFAULT ''`;
  await sql`CREATE TABLE IF NOT EXISTS ordering_delivery_customer_notifications(
    id UUID PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES ordering_delivery_assignments(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE, tracking_token_id UUID REFERENCES ordering_delivery_tracking_tokens(id),
    channel TEXT NOT NULL, destination TEXT NOT NULL, classification TEXT NOT NULL DEFAULT 'transactional', payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ, failed_at TIMESTAMPTZ, failure TEXT NOT NULL DEFAULT '')`;
}

export async function driverActor(): Promise<DriverActor | null> {
  const session=await getEmployeeSession(); if(!session)return null;
  await ensureDriverDeliverySchema();
  const row=(await getSql()`SELECT active,role_group,COALESCE(pos_role,'employee') pos_role FROM employees WHERE id=${session.employeeId} AND business=${session.business}`)[0];
  if(!row?.active)return null;
  await getSql()`UPDATE employee_app_sessions SET last_seen_at=NOW() WHERE id=${session.deviceSessionId}`.catch(()=>undefined);
  return {...session,roleGroup:row.role_group,posRole:row.pos_role,manager:["manager","owner"].includes(String(row.pos_role)),driver:row.role_group==="Driver"};
}

function permitted(actor:DriverActor,delivery:{driver_employee_id?:string|null}) { return actor.manager||delivery.driver_employee_id===actor.employeeId; }
async function audit(deliveryId:string,orderId:string,actor:DriverActor,action:string,previous:string|null,next:string|null,details:unknown={}){await getSql()`INSERT INTO ordering_delivery_audit(id,delivery_id,order_id,employee_id,device_session_id,action,previous_status,new_status,details)VALUES(${randomUUID()},${deliveryId},${orderId},${actor.employeeId},${actor.deviceSessionId},${action},${previous},${next},${JSON.stringify(details)}::jsonb)`}

export async function listDriverDeliveries(actor:DriverActor,input:{query?:string;dispatch?:boolean}){
  await ensureDriverDeliverySchema();const q=String(input.query||"").trim(),digits=q.replace(/\D/g,""),like=`%${q}%`,digitLike=`%${digits}%`;
  return getSql()`SELECT d.id delivery_id,d.status delivery_status,d.driver_employee_id assigned_employee_id,d.assigned_at,d.updated_at delivery_updated_at,
    o.id order_id,o.display_number,o.status order_status,o.payment_status,o.service_type,o.timing_mode,o.scheduled_for,o.created_at,
    COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),'Guest') customer_name,o.phone_snapshot delivery_phone,
    a.formatted_address delivery_address,a.line2 delivery_unit,a.delivery_notes_snapshot delivery_notes,a.latitude destination_latitude,a.longitude destination_longitude,
    e.name driver_name,e.position driver_position
    FROM ordering_delivery_assignments d JOIN ordering_orders o ON o.id=d.order_id JOIN ordering_order_delivery_addresses a ON a.order_id=o.id
    LEFT JOIN employees e ON e.id=d.driver_employee_id
    WHERE d.business=${actor.business} AND o.service_type IN('delivery','no_contact_delivery')
      AND (${actor.manager&&Boolean(input.dispatch)} OR d.driver_employee_id=${actor.employeeId})
      AND (${q}='' OR o.display_number ILIKE ${like} OR o.first_name_snapshot ILIKE ${like} OR o.last_name_snapshot ILIKE ${like} OR trim(o.first_name_snapshot||' '||o.last_name_snapshot) ILIKE ${like} OR regexp_replace(o.phone_snapshot,'[^0-9]','','g') LIKE ${digitLike} OR a.formatted_address ILIKE ${like})
      AND (d.status NOT IN('DELIVERED','RETURNED','CANCELLED') OR d.updated_at>NOW()-INTERVAL '24 hours') ORDER BY COALESCE(o.scheduled_for,o.created_at),o.created_at`;
}

export async function syncDeliveryAssignments(business:"Corner Deli"|"Tiki"){await ensureDriverDeliverySchema();const sql=getSql();await sql`INSERT INTO ordering_delivery_assignments(id,order_id,business,status,assigned_by) SELECT gen_random_uuid(),o.id,o.business,CASE WHEN o.status='ready' THEN 'READY_FOR_DRIVER' ELSE 'ASSIGNED' END,'driver-pwa' FROM ordering_orders o JOIN ordering_order_delivery_addresses a ON a.order_id=o.id WHERE o.business=${business} AND o.service_type IN('delivery','no_contact_delivery') AND o.status NOT IN('draft','completed','cancelled') AND NOT EXISTS(SELECT 1 FROM ordering_delivery_assignments d WHERE d.order_id=o.id AND d.status NOT IN('DELIVERED','RETURNED','CANCELLED'))`;await sql`UPDATE ordering_delivery_assignments d SET status='READY_FOR_DRIVER',updated_at=NOW() FROM ordering_orders o WHERE o.id=d.order_id AND d.business=${business} AND o.status='ready' AND d.status='ASSIGNED'`}
export async function ensureDeliveriesForOrders(actor:DriverActor){if(actor.manager)await syncDeliveryAssignments(actor.business)}

export async function assignDelivery(actor:DriverActor,deliveryId:string,employeeId:string){if(!actor.manager)throw new Error("Dispatcher access required.");await ensureDriverDeliverySchema();return withTransaction(async()=>{const sql=getSql(),d=(await sql`SELECT * FROM ordering_delivery_assignments WHERE id=${deliveryId} AND business=${actor.business} FOR UPDATE`)[0];if(!d)throw new Error("Delivery not found.");const employee=(await sql`SELECT id,name,role_group FROM employees WHERE id=${employeeId} AND business=${actor.business} AND active=TRUE`)[0];if(!employee||employee.role_group!=="Driver")throw new Error("Choose an active driver.");const previous=d.driver_employee_id?String(d.driver_employee_id):null;await sql`UPDATE ordering_delivery_assignments SET driver_employee_id=${employeeId},assigned_at=NOW(),status=CASE WHEN status='DELIVERY_FAILED' THEN 'ASSIGNED' ELSE status END,updated_at=NOW() WHERE id=${deliveryId}`;await audit(deliveryId,String(d.order_id),actor,previous?"reassigned":"assigned",String(d.status),String(d.status),{previousEmployeeId:previous,employeeId});return{ok:true}})}

export async function revokeDeliveryTracking(actor:DriverActor,deliveryId:string){if(!actor.manager)throw new Error("Dispatcher access required.");await ensureDriverDeliverySchema();const rows=await getSql()`UPDATE ordering_delivery_tracking_tokens SET revoked_at=NOW() WHERE delivery_id=${deliveryId} AND revoked_at IS NULL RETURNING order_id`;if(rows[0])await audit(deliveryId,String(rows[0].order_id),actor,"tracking_token_revoked",null,null,{});return{ok:true,revoked:rows.length}}

export async function changeDeliveryStatus(actor:DriverActor,deliveryId:string,next:DriverDeliveryStatus,note=""){
  await ensureDriverDeliverySchema();return withTransaction(async()=>{const sql=getSql(),d=(await sql`SELECT d.*,o.service_type FROM ordering_delivery_assignments d JOIN ordering_orders o ON o.id=d.order_id WHERE d.id=${deliveryId} AND d.business=${actor.business} FOR UPDATE OF d`)[0];if(!d)throw new Error("Delivery not found.");if(!permitted(actor,d))throw new Error("This delivery is not assigned to you.");const current=String(d.status) as DriverDeliveryStatus;if(!transitions[current]?.includes(next))throw new Error(`Delivery cannot move from ${current} to ${next}.`);if(next==="DELIVERED"&&d.service_type==="no_contact_delivery"&&!Number((await sql`SELECT COUNT(*) count FROM ordering_delivery_proofs WHERE delivery_id=${deliveryId} AND proof_type='no_contact'`)[0]?.count))throw new Error("A no-contact proof photo is required before completion.");await sql`UPDATE ordering_delivery_assignments SET status=${next},status_note=${note.slice(0,500)},picked_up_at=CASE WHEN ${next}='PICKED_UP' THEN NOW() ELSE picked_up_at END,en_route_at=CASE WHEN ${next}='EN_ROUTE' THEN NOW() ELSE en_route_at END,arrived_at=CASE WHEN ${next}='ARRIVED' THEN NOW() ELSE arrived_at END,delivered_at=CASE WHEN ${next}='DELIVERED' THEN NOW() ELSE delivered_at END,failed_at=CASE WHEN ${next}='DELIVERY_FAILED' THEN NOW() ELSE failed_at END,returned_at=CASE WHEN ${next}='RETURNED' THEN NOW() ELSE returned_at END,cancelled_at=CASE WHEN ${next}='CANCELLED' THEN NOW() ELSE cancelled_at END,updated_at=NOW() WHERE id=${deliveryId}`;
    let trackingUrl:string|undefined;if(next==="EN_ROUTE"){const trackingId=randomUUID(),raw=randomBytes(32).toString("base64url"),tokenId=randomUUID();await sql`INSERT INTO ordering_delivery_tracking_sessions(id,delivery_id,driver_id,device_session_id)VALUES(${trackingId},${deliveryId},${actor.employeeId},${actor.deviceSessionId}) ON CONFLICT DO NOTHING`;await sql`INSERT INTO ordering_delivery_tracking_tokens(id,delivery_id,order_id,token_hash,token_value,expires_at)VALUES(${tokenId},${deliveryId},${d.order_id},${createHash("sha256").update(raw).digest("hex")},${raw},NOW()+INTERVAL '30 days')`;trackingUrl=`${cornerOpsBaseUrl()}/track/${raw}`;await audit(deliveryId,String(d.order_id),actor,"tracking_started",current,next,{})}
    if(["DELIVERED","DELIVERY_FAILED","RETURNED"].includes(next)){await sql`UPDATE ordering_delivery_tracking_sessions SET stopped_at=NOW(),stop_reason=${next} WHERE delivery_id=${deliveryId} AND stopped_at IS NULL`;await audit(deliveryId,String(d.order_id),actor,"tracking_stopped",current,next,{reason:next})}
    await audit(deliveryId,String(d.order_id),actor,next.toLowerCase(),current,next,{note:note.slice(0,500)});
    if(next==="DELIVERED"){let token=(await sql`SELECT id,token_value FROM ordering_delivery_tracking_tokens WHERE delivery_id=${deliveryId} AND revoked_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`)[0];if(!token){const raw=randomBytes(32).toString("base64url"),tokenId=randomUUID();await sql`INSERT INTO ordering_delivery_tracking_tokens(id,delivery_id,order_id,token_hash,token_value,expires_at)VALUES(${tokenId},${deliveryId},${d.order_id},${createHash("sha256").update(raw).digest("hex")},${raw},NOW()+INTERVAL '30 days')`;token={id:tokenId,token_value:raw}}trackingUrl=`${cornerOpsBaseUrl()}/track/${token.token_value}`;const order=(await sql`SELECT display_number,phone_snapshot FROM ordering_orders WHERE id=${d.order_id}`)[0],time=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",minute:"2-digit"}).format(new Date()),payload=`Corner Deli: Your order #${order.display_number} was delivered at ${time}. View delivery confirmation: ${trackingUrl}`;await sql`INSERT INTO ordering_delivery_customer_notifications(id,delivery_id,order_id,tracking_token_id,channel,destination,payload)VALUES(${randomUUID()},${deliveryId},${d.order_id},${token.id},'sms',${String(order.phone_snapshot||"")},${payload})`;await audit(deliveryId,String(d.order_id),actor,"customer_notification_queued",next,next,{channel:"sms"})}
    return{ok:true,status:next,trackingUrl};
  })
}

export async function recordLocation(actor:DriverActor,deliveryId:string,input:{clientEventId:string;capturedAt:string;latitude:number;longitude:number;accuracy?:number;metadata?:unknown}){await ensureDriverDeliverySchema();const sql=getSql(),d=(await sql`SELECT * FROM ordering_delivery_assignments WHERE id=${deliveryId} AND business=${actor.business}`)[0];if(!d||!permitted(actor,d))throw new Error("This delivery is not assigned to you.");if(!["EN_ROUTE","ARRIVED","NO_CONTACT"].includes(String(d.status)))throw new Error("Location is accepted only during an active delivery.");const tracking=(await sql`SELECT id FROM ordering_delivery_tracking_sessions WHERE delivery_id=${deliveryId} AND driver_id=${actor.employeeId} AND stopped_at IS NULL`)[0];if(!tracking)throw new Error("Tracking session is not active.");const lat=Number(input.latitude),lng=Number(input.longitude),accuracy=Number(input.accuracy);if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lng)||lng < -180||lng > 180)throw new Error("Invalid location.");await sql`INSERT INTO ordering_delivery_locations(id,tracking_session_id,delivery_id,driver_id,device_session_id,client_event_id,captured_at,latitude,longitude,accuracy_meters,metadata)VALUES(${randomUUID()},${tracking.id},${deliveryId},${actor.employeeId},${actor.deviceSessionId},${input.clientEventId.slice(0,100)},${new Date(input.capturedAt)},${lat},${lng},${Number.isFinite(accuracy)?accuracy:null},${JSON.stringify(input.metadata||{})}::jsonb) ON CONFLICT(driver_id,client_event_id)DO NOTHING`;return{ok:true}}

export async function captureProof(actor:DriverActor,deliveryId:string,file:File,input:{capturedAt:string;latitude?:number;longitude?:number;accuracy?:number;proofType:string;note?:string}){await ensureDriverDeliverySchema();if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size<1||file.size>10_000_000)throw new Error("Choose a JPEG, PNG, or WebP photo up to 10 MB.");const sql=getSql(),d=(await sql`SELECT * FROM ordering_delivery_assignments WHERE id=${deliveryId} AND business=${actor.business}`)[0];if(!d||!permitted(actor,d))throw new Error("This delivery is not assigned to you.");if(["DELIVERED","RETURNED","CANCELLED"].includes(String(d.status)))throw new Error("This delivery no longer accepts proof.");const id=randomUUID(),extension=file.type==="image/png"?"png":file.type==="image/webp"?"webp":"jpg",stored=await put(`delivery-proof/${d.order_id}/${id}.${extension}`,await file.arrayBuffer(),{access:"private"});await sql`INSERT INTO ordering_delivery_proofs(id,order_id,delivery_id,employee_id,storage_reference,mime_type,size_bytes,captured_at,latitude,longitude,accuracy_meters,proof_type,employee_note)VALUES(${id},${d.order_id},${deliveryId},${actor.employeeId},${stored.url},${file.type},${file.size},${new Date(input.capturedAt)},${Number.isFinite(Number(input.latitude))?Number(input.latitude):null},${Number.isFinite(Number(input.longitude))?Number(input.longitude):null},${Number.isFinite(Number(input.accuracy))?Number(input.accuracy):null},${input.proofType.slice(0,40)},${String(input.note||"").slice(0,500)})`;await audit(deliveryId,String(d.order_id),actor,"proof_captured",String(d.status),String(d.status),{proofId:id,proofType:input.proofType});return{ok:true,proofId:id}}

export async function customerTracking(token:string):Promise<CustomerTrackingView|null>{await ensureDriverDeliverySchema();const hash=createHash("sha256").update(token).digest("hex"),sql=getSql(),row=(await sql`SELECT t.id token_id,t.expires_at,d.id delivery_id,d.status,d.delivered_at,d.updated_at,o.display_number,o.status order_status,p.id proof_id,p.captured_at proof_captured_at FROM ordering_delivery_tracking_tokens t JOIN ordering_delivery_assignments d ON d.id=t.delivery_id JOIN ordering_orders o ON o.id=t.order_id LEFT JOIN LATERAL(SELECT id,captured_at FROM ordering_delivery_proofs WHERE delivery_id=d.id ORDER BY created_at DESC LIMIT 1)p ON TRUE WHERE t.token_hash=${hash} AND t.revoked_at IS NULL AND t.expires_at>NOW()`)[0] as Omit<CustomerTrackingView,"location">|undefined;if(!row)return null;const location=["EN_ROUTE","ARRIVED"].includes(String(row.status))?(await sql`SELECT latitude,longitude,accuracy_meters,captured_at FROM ordering_delivery_locations WHERE delivery_id=${row.delivery_id} ORDER BY captured_at DESC LIMIT 1`)[0]:null;return{...row,location:location?{latitude:Math.round(Number(location.latitude)*1000)/1000,longitude:Math.round(Number(location.longitude)*1000)/1000,accuracyMeters:location.accuracy_meters==null?null:Math.max(100,Number(location.accuracy_meters)),capturedAt:location.captured_at,approximate:true}:null}}
export async function customerProof(token:string,proofId:string){const tracking=await customerTracking(token);if(!tracking||tracking.proof_id!==proofId)return null;const row=(await getSql()`SELECT storage_reference,mime_type FROM ordering_delivery_proofs WHERE id=${proofId} AND delivery_id=${tracking.delivery_id}`)[0];if(!row)return null;return{object:await get(String(row.storage_reference),{access:"private"}),mimeType:String(row.mime_type)}}
